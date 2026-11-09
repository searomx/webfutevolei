import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { ConfigurationError } from "@/lib/server/config";
import { sendRegistrationEmail } from "@/lib/server/email";
import { logRegistrationEmailError, RegistrationEmailError } from "@/lib/server/email-error";
import type { RegistrationWithPartners } from "@/lib/server/pdf";
import { registerAthlete } from "@/lib/server/registrations";

const mocks = vi.hoisted(() => ({
  pdf: vi.fn(),
  sendMail: vi.fn(),
  createTransport: vi.fn(),
  transaction: vi.fn(),
  updateMany: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("@/lib/server/pdf", () => ({ createRegistrationPdf: mocks.pdf }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.createTransport } }));
vi.mock("@/lib/server/db", () => ({
  getDb: () => ({
    $transaction: mocks.transaction,
    registration: { updateMany: mocks.updateMany, findUniqueOrThrow: mocks.findUniqueOrThrow },
  }),
}));

const registration: RegistrationWithPartners = {
  id: "registration-id",
  requestId: "00000000-0000-4000-8000-000000000001",
  fingerprint: "fingerprint",
  fullName: "Atleta Teste",
  nickname: "",
  address: "Rua de Teste, 100",
  trainingPlace: "Arena Teste",
  birthDate: new Date("2000-01-01T00:00:00.000Z"),
  phone: null,
  email: "athlete@example.org",
  stages: [],
  categories: ["masculino-c"],
  pairOfPlayersId: null,
  categoryPartners: [],
  amountCents: 6000,
  paymentStatus: "PENDING",
  emailStatus: "PENDING",
  emailLeaseAt: null,
  emailSentAt: null,
  athleteEmailSentAt: null,
  createdAt: new Date("2026-11-06T12:00:00.000Z"),
  updatedAt: new Date("2026-11-06T12:00:00.000Z"),
};
let saved: RegistrationWithPartners;
const athlete = {
  fullName: registration.fullName, nickname: "", address: registration.address,
  trainingPlace: registration.trainingPlace, birthDate: "2000-01-01",
  phone: "", email: registration.email, stages: [], categories: ["masculino-c" as const], partners: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  for (const [name, value] of Object.entries({
    SMTP_HOST: "smtp.example.org", SMTP_PORT: "587", SMTP_SECURE: "false",
    SMTP_USER: "test-user", SMTP_PASS: "test-password",
    SMTP_FROM: "sender@example.org", REGISTRATION_EMAIL: "organization@example.org",
  })) vi.stubEnv(name, value);
  mocks.pdf.mockResolvedValue(Buffer.from("test-pdf"));
  mocks.sendMail.mockImplementation(async ({ to }: { to: string }) => ({ accepted: [to] }));
  mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
  saved = { ...registration };
  mocks.transaction.mockImplementation(async () => ({ ...saved }));
  mocks.findUniqueOrThrow.mockImplementation(async () => ({ ...saved }));
  mocks.updateMany.mockImplementation(async ({ data }: { data: Partial<RegistrationWithPartners> }) => {
    saved = { ...saved, ...data };
    return { count: 1 };
  });
  mocks.confirm.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("etapas do envio do PDF", () => {
  it("identifica configuração inválida sem gerar PDF nem abrir conexão", async () => {
    vi.stubEnv("SMTP_HOST", "");
    await expect(sendRegistrationEmail(registration, mocks.confirm)).rejects.toMatchObject({
      stage: "configuration", cause: { setting: "SMTP_HOST" },
    });
    expect(mocks.pdf).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it("identifica falha de PDF e preserva o erro original", async () => {
    const cause = Object.assign(new Error("Caminho privado"), { code: "ENOENT" });
    mocks.pdf.mockRejectedValue(cause);
    await expect(sendRegistrationEmail(registration, mocks.confirm)).rejects.toMatchObject({ stage: "pdf", cause });
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("identifica rejeição SMTP e preserva os códigos técnicos", async () => {
    const cause = Object.assign(new Error("Resposta privada"), {
      code: "EAUTH", responseCode: 535, command: "AUTH PLAIN",
    });
    mocks.sendMail.mockRejectedValue(cause);
    await expect(sendRegistrationEmail(registration, mocks.confirm)).resolves.toMatchObject([
      { stage: "smtp", cause, recipient: "organization" },
      { stage: "smtp", cause, recipient: "athlete" },
    ]);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("identifica destinatário não aceito como falha SMTP", async () => {
    mocks.sendMail.mockResolvedValue({ accepted: [] });
    await expect(sendRegistrationEmail(registration, mocks.confirm)).resolves.toMatchObject([
      { stage: "smtp", recipient: "organization" }, { stage: "smtp", recipient: "athlete" },
    ]);
  });

  it("preserva envio, anexo, TLS e destinatário em produção", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(sendRegistrationEmail(registration, mocks.confirm)).resolves.toEqual([]);
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      port: 587, secure: false, requireTLS: true,
    }));
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: "organization@example.org",
      attachments: [{
        filename: "inscricao-registration-id.pdf",
        content: Buffer.from("test-pdf"), contentType: "application/pdf",
      }],
    }));
    expect(mocks.sendMail).toHaveBeenCalledTimes(2);
    expect(mocks.pdf).toHaveBeenCalledOnce();
    const [organizationMail, athleteMail] = mocks.sendMail.mock.calls.map(([mail]) => mail);
    expect(athleteMail.to).toBe("athlete@example.org");
    expect(organizationMail.to).toBe("organization@example.org");
    expect(organizationMail.messageId).not.toBe(athleteMail.messageId);
    expect(athleteMail).not.toHaveProperty("cc");
    expect(athleteMail).not.toHaveProperty("bcc");
    expect(mocks.confirm.mock.calls).toEqual([["organization"], ["athlete"]]);
  });

  it("não gera PDF nem envia e-mail quando ambos já foram confirmados", async () => {
    await expect(sendRegistrationEmail({
      ...registration, emailSentAt: new Date(), athleteEmailSentAt: new Date(),
    }, mocks.confirm)).resolves.toEqual([]);
    expect(mocks.pdf).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it.each(["organization", "athlete"] as const)("pula o envio já confirmado para %s", async (recipient) => {
    await sendRegistrationEmail({
      ...registration,
      emailSentAt: recipient === "organization" ? new Date() : null,
      athleteEmailSentAt: recipient === "athlete" ? new Date() : null,
    }, mocks.confirm);
    expect(mocks.sendMail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      to: recipient === "organization" ? registration.email : "organization@example.org",
    }));
  });
});

describe("diagnóstico seguro do envio", () => {
  it("registra etapa e códigos permitidos, sem resposta SMTP ou mensagem completa", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error("senha e destinatário privados"), {
      code: "EAUTH", responseCode: 535, command: "AUTH PLAIN", response: "Resposta privada",
    });
    logRegistrationEmailError(new RegistrationEmailError("smtp", error), "confirmation");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "[registration-email] etapa smtp; Error; código EAUTH; SMTP 535; comando AUTH PLAIN.",
    );
  });

  it("omite metadados arbitrários e nomes de erro personalizados", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error("Informação privada"), {
      name: "Nome privado", code: "Código privado", command: "AUTH senha", responseCode: 999,
    });
    logRegistrationEmailError(new RegistrationEmailError("pdf", error), "confirmation");
    expect(log).toHaveBeenCalledExactlyOnceWith("[registration-email] etapa pdf; Error.");
  });

  it("registra apenas o nome da configuração permitida", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    logRegistrationEmailError(
      new RegistrationEmailError("configuration", new ConfigurationError("SMTP_PASS")), "confirmation",
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "[registration-email] etapa configuration; ConfigurationError; configuração SMTP_PASS.",
    );
  });

  it("identifica falha Prisma na confirmação sem expor metadados", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Prisma.PrismaClientKnownRequestError("Dados privados", {
      code: "P2022", clientVersion: "test", meta: { column: "Coluna privada" },
    });
    logRegistrationEmailError(error, "confirmation");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "[registration-email] etapa confirmation; PrismaClientKnownRequestError; código P2022.",
    );
  });
});

describe("preservação da inscrição e do reenvio", () => {
  it("informa a falha parcial e reenvia apenas para a organização", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.sendMail.mockRejectedValueOnce(Object.assign(new Error("Falha privada"), { code: "ETIMEDOUT" }));
    const result = await registerAthlete(registration.requestId, athlete);
    expect(result).toMatchObject({
      id: registration.id, amountCents: 6000, emailStatus: "FAILED",
      emailDeliveries: { organization: "PENDING", athlete: "SENT" },
    });
    expect(result.message).toContain("para a organização ainda não foi confirmado");
    expect(mocks.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { emailStatus: "FAILED", emailLeaseAt: null },
    }));
    expect(log).toHaveBeenCalledWith("[registration-email] etapa smtp; Error; destinatário organization; código ETIMEDOUT.");
    mocks.sendMail.mockClear();
    const retry = await registerAthlete(registration.requestId, athlete);
    expect(retry).toMatchObject({ id: registration.id, emailStatus: "SENT" });
    expect(mocks.sendMail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: "organization@example.org" }));
  });

  it("preserva confirmação da organização quando somente o envio ao atleta falha", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.sendMail.mockImplementationOnce(async () => ({ accepted: ["organization@example.org"] }))
      .mockRejectedValueOnce(new Error("Falha SMTP"));
    const result = await registerAthlete(registration.requestId, athlete);
    expect(result.emailDeliveries).toEqual({ organization: "SENT", athlete: "PENDING" });
    expect(result.message).toContain("para você ainda não foi confirmado");
    mocks.sendMail.mockClear();
    const retry = await registerAthlete(registration.requestId, athlete);
    expect(retry.emailStatus).toBe("SENT");
    expect(mocks.sendMail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: registration.email }));
  });

  it("não envia novamente após confirmação completa", async () => {
    await registerAthlete(registration.requestId, athlete);
    mocks.sendMail.mockClear();
    const retry = await registerAthlete(registration.requestId, athlete);
    expect(retry.emailStatus).toBe("SENT");
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("retorna envio em andamento sem abrir outra conexão se a reserva já está ocupada", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await registerAthlete(registration.requestId, athlete)).toMatchObject({ emailStatus: "SENDING" });
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("consulta novamente sem repetir e-mails se somente a finalização do status falhar", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.updateMany.mockImplementation(async ({ data }: { data: Partial<RegistrationWithPartners> }) => {
      if (data.emailStatus === "SENT") throw new Error("Falha na finalização.");
      saved = { ...saved, ...data };
      return { count: 1 };
    });
    const result = await registerAthlete(registration.requestId, athlete);
    expect(result.emailStatus).toBe("FAILED");
    expect(result.emailDeliveries).toEqual({ organization: "SENT", athlete: "SENT" });
    expect(result.message).toContain("sem reenviar os e-mails");
    mocks.updateMany.mockImplementation(async ({ data }: { data: Partial<RegistrationWithPartners> }) => {
      saved = { ...saved, ...data };
      return { count: 1 };
    });
    mocks.sendMail.mockClear();
    mocks.pdf.mockClear();
    expect((await registerAthlete(registration.requestId, athlete)).emailStatus).toBe("SENT");
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();
  });

  it("distingue falha de confirmação após o SMTP aceitar o PDF", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Dados privados", { code: "P2022", clientVersion: "test" }),
    );
    expect(await registerAthlete(registration.requestId, athlete)).toMatchObject({ emailStatus: "FAILED" });
    expect(mocks.sendMail).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "[registration-email] etapa confirmation; PrismaClientKnownRequestError; destinatário organization; código P2022.",
    );
  });
});
