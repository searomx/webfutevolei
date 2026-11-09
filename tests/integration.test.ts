import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { PDFDocument } from "pdf-lib";
import { getDb } from "@/lib/server/db";
import { POST } from "@/app/api/registrations/route";
import { registrationResultSchema, registrationSchema } from "@/lib/registration";

const messages: Buffer[] = [];
let failEmail = false;
let failRecipient: string | undefined;
const smtp = new SMTPServer({
  disabledCommands: ["STARTTLS"],
  allowInsecureAuth: true,
  onAuth(auth, _session, callback) {
    if (auth.username !== "test-user" || auth.password !== "test-password") {
      return callback(new Error("Credenciais de teste inválidas."));
    }
    callback(null, { user: "test-user" });
  },
  onRcptTo(address, _session, callback) {
    if (address.address === failRecipient) {
      return callback(Object.assign(new Error("Destinatário rejeitado no teste."), { responseCode: 550 }));
    }
    callback();
  },
  onData(stream, _session, callback) {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      if (failEmail) return callback(Object.assign(new Error("Falha SMTP simulada."), { responseCode: 550 }));
      messages.push(Buffer.concat(chunks));
      callback();
    });
    stream.on("error", callback);
  },
});

const athlete = {
  fullName: "João Atleta Teste", nickname: "Teste", address: "Rua de Teste, 100",
  trainingPlace: "Arena Teste", birthDate: "2000-02-29", phone: "(11) 99999-1234", email: "athlete@example.org",
  stages: ["Primeira", "Terceira"], categories: ["masculino-c", "misto-b"],
  partners: [
    { categoryId: "masculino-c", player1Id: "Parceiro Masculino" },
    { categoryId: "misto-b", player1Id: "Parceira Misto" },
  ],
};

function request(requestId = randomUUID(), patch = {}) {
  return new Request("http://localhost:3000/api/registrations", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ requestId, athlete: { ...athlete, ...patch }, website: "" }),
  });
}

beforeAll(async () => {
  expect(new URL(process.env.DATABASE_URL!).pathname).toBe("/futevolei_test");
  smtp.listen(0, "127.0.0.1");
  await once(smtp.server, "listening");
  const address = smtp.server.address();
  if (!address || typeof address === "string") throw new Error("Endereço SMTP de teste inválido.");
  vi.stubEnv("SMTP_HOST", "127.0.0.1");
  vi.stubEnv("SMTP_PORT", String(address.port));
  vi.stubEnv("SMTP_SECURE", "false");
  vi.stubEnv("SMTP_USER", "test-user");
  vi.stubEnv("SMTP_PASS", "test-password");
  vi.stubEnv("SMTP_FROM", "sender@example.org");
  vi.stubEnv("REGISTRATION_EMAIL", "organization@example.org");
  vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
});

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now());
  messages.length = 0;
  failEmail = false;
  failRecipient = undefined;
  await getDb().registration.deleteMany();
  await getDb().requestBucket.deleteMany();
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await new Promise<void>((resolve) => smtp.close(resolve));
  await getDb().$disconnect();
  vi.unstubAllEnvs();
});

describe("inscrição com PostgreSQL e SMTP reais isolados", () => {
  it("persiste dados, calcula valor e envia PDFs separados à organização e ao atleta", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    const result = registrationResultSchema.parse(await response.json());
    expect(result.emailStatus).toBe("SENT");
    expect(result.amountCents).toBe(10000);
    const saved = await getDb().registration.findUniqueOrThrow({ where: { id: result.id } });
    expect(saved.paymentStatus).toBe("PENDING");
    expect(saved.fullName).toBe(athlete.fullName);
    expect(saved.phone).toBe(athlete.phone);
    expect(saved.emailStatus).toBe("SENT");
    expect(saved.emailSentAt).not.toBeNull();
    expect(saved.athleteEmailSentAt).not.toBeNull();
    expect(result.emailDeliveries).toEqual({ organization: "SENT", athlete: "SENT" });
    expect(saved.birthDate.toISOString().slice(0, 10)).toBe("2000-02-29");
    expect(saved.stages).toEqual(athlete.stages);
    const partners = await getDb().pairOfPlayers.findMany({
      where: { registrationId: result.id }, orderBy: { categoryId: "asc" },
    });
    expect(partners.map(({ categoryId, player1Id }) => ({ categoryId, player1Id }))).toEqual(athlete.partners);
    expect(messages).toHaveLength(2);
    const emails = await Promise.all(messages.map((message) => simpleParser(message)));
    expect(emails.map((email) => email.to).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      .toMatchObject([
        { value: [{ address: "athlete@example.org" }] },
        { value: [{ address: "organization@example.org" }] },
      ]);
    for (const email of emails) {
      expect(email.cc).toBeUndefined();
      expect(email.bcc).toBeUndefined();
      expect(email.attachments).toHaveLength(1);
      expect(email.attachments[0].contentType).toBe("application/pdf");
    }
    expect(emails[0].messageId).not.toBe(emails[1].messageId);
    expect(emails[0].attachments[0].content).toEqual(emails[1].attachments[0].content);
    const document = await PDFDocument.load(emails[0].attachments[0].content);
    expect(document.getTitle()).toBe("Inscrição Futevolei 2026");
    expect(document.getPageCount()).toBeGreaterThan(0);
  });
  it("submissões concorrentes não duplicam inscrição nem envio", async () => {
    const id = randomUUID();
    const responses = await Promise.all([POST(request(id)), POST(request(id))]);
    expect(responses.every((response) => [200, 202].includes(response.status))).toBe(true);
    expect(await getDb().registration.count()).toBe(1);
    expect(await getDb().pairOfPlayers.count()).toBe(2);
    expect(messages).toHaveLength(2);
    const retry = await POST(request(id));
    expect(retry.status).toBe(200);
    expect(messages).toHaveLength(2);
  });
  it("não duplica parceiros no retry nem depende da ordem das categorias", async () => {
    const id = randomUUID();
    await POST(request(id));
    const response = await POST(request(id, {
      categories: [...athlete.categories].reverse(), partners: [...athlete.partners].reverse(),
    }));
    expect(response.status).toBe(200);
    expect(await getDb().pairOfPlayers.count()).toBe(2);
    expect((await POST(request(id, {
      partners: [{ categoryId: "masculino-c", player1Id: "Outro Parceiro" }],
    }))).status).toBe(409);
    expect(await getDb().pairOfPlayers.count()).toBe(2);
  });
  it("mantém compatibilidade com protocolos antigos sem parceiros", async () => {
    const id = randomUUID();
    const response = await POST(request(id, { partners: undefined }));
    const result = registrationResultSchema.parse(await response.json());
    const { partners, ...oldAthlete } = registrationSchema.parse({ ...athlete, partners: undefined });
    expect(partners).toEqual([]);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      ...oldAthlete, stages: [...oldAthlete.stages].sort(), categories: [...oldAthlete.categories].sort(),
    })).digest("hex");
    await getDb().registration.update({ where: { id: result.id }, data: { fingerprint } });
    expect((await POST(request(id, {
      partners: [{ categoryId: "masculino-c", player1Id: "" }],
    }))).status).toBe(200);
    expect(await getDb().pairOfPlayers.count()).toBe(0);
  });
  it("reverte a inscrição se a persistência dos parceiros falhar", async () => {
    await getDb().$executeRaw`
      ALTER TABLE "PairOfPlayers"
      ADD CONSTRAINT "test_reject_partner" CHECK ("player1Id" <> 'Parceiro Masculino')
    `;
    try {
      expect((await POST(request())).status).toBe(500);
      expect(await getDb().registration.count()).toBe(0);
      expect(await getDb().pairOfPlayers.count()).toBe(0);
      expect(messages).toHaveLength(0);
    } finally {
      await getDb().$executeRaw`ALTER TABLE "PairOfPlayers" DROP CONSTRAINT "test_reject_partner"`;
    }
  });
  it("preserva inscrição na falha SMTP e permite reenvio sem novo cadastro", async () => {
    const id = randomUUID();
    failEmail = true;
    const response = await POST(request(id));
    expect(response.status).toBe(202);
    const result = registrationResultSchema.parse(await response.json());
    expect(result.emailStatus).toBe("FAILED");
    expect(await getDb().registration.count()).toBe(1);
    failEmail = false;
    const retry = await POST(request(id));
    const retried = registrationResultSchema.parse(await retry.json());
    expect(retried.id).toBe(result.id);
    expect(retried.emailStatus).toBe("SENT");
    expect(messages).toHaveLength(2);
    expect(await getDb().registration.count()).toBe(1);
  });
  it.each(["organization@example.org", "athlete@example.org"])("reenvia apenas para %s após falha parcial", async (failed) => {
    const id = randomUUID();
    failRecipient = failed;
    const response = await POST(request(id));
    expect(response.status).toBe(202);
    const result = registrationResultSchema.parse(await response.json());
    expect(result.emailDeliveries).toEqual({
      organization: failed === "organization@example.org" ? "PENDING" : "SENT",
      athlete: failed === "athlete@example.org" ? "PENDING" : "SENT",
    });
    expect(messages).toHaveLength(1);
    failRecipient = undefined;
    messages.length = 0;
    expect((await POST(request(id))).status).toBe(200);
    expect(messages).toHaveLength(1);
    expect((await simpleParser(messages[0])).to).toMatchObject({ value: [{ address: failed }] });
    expect(await getDb().registration.count()).toBe(1);
  });

  it("preserva confirmação antiga da organização e envia somente a cópia do atleta", async () => {
    const id = randomUUID();
    const result = registrationResultSchema.parse(await (await POST(request(id))).json());
    const saved = await getDb().registration.findUniqueOrThrow({ where: { id: result.id } });
    await getDb().registration.update({
      where: { id: saved.id }, data: { emailStatus: "PENDING", athleteEmailSentAt: null },
    });
    messages.length = 0;
    expect((await POST(request(id))).status).toBe(200);
    expect(messages).toHaveLength(1);
    expect((await simpleParser(messages[0])).to).toMatchObject({ value: [{ address: athlete.email }] });
    expect((await getDb().registration.findUniqueOrThrow({ where: { id: saved.id } })).emailSentAt)
      .toEqual(saved.emailSentAt);
  });
  it("rejeita alteração dos dados de uma operação já registrada", async () => {
    const id = randomUUID();
    await POST(request(id));
    expect((await POST(request(id, { fullName: "Outro Atleta Teste" }))).status).toBe(409);
    expect(await getDb().registration.count()).toBe(1);
  });
  it("não aceita total informado pelo cliente nem categorias duplicadas", async () => {
    expect((await POST(request(randomUUID(), { amountCents: 1 }))).status).toBe(400);
    expect((await POST(request(randomUUID(), { categories: ["masculino-c", "masculino-c"] }))).status).toBe(400);
    expect(await getDb().registration.count()).toBe(0);
  });
  it("bloqueia origem externa, corpo excessivo e abuso de reenvio", async () => {
    const external = new Request(request(), { headers: { origin: "https://external.example.org", "content-type": "application/json" } });
    expect((await POST(external)).status).toBe(403);
    const oversized = new Request("http://localhost:3000/api/registrations", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ data: "X".repeat(17000) }),
    });
    expect((await POST(oversized)).status).toBe(413);
    const id = randomUUID();
    for (let attempt = 0; attempt < 30; attempt++) await POST(request(id));
    expect((await POST(request(id))).status).toBe(429);
    expect(messages).toHaveLength(2);
  });
});
