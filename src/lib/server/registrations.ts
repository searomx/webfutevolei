import "server-only";
import { createHash } from "node:crypto";
import { calculateAmount, type Athlete, type RegistrationResult } from "@/lib/registration";
import { getDb } from "./db";
import { HttpError } from "./http";
import { logRegistrationEmailError } from "./email-error";
import { sendRegistrationEmail } from "./email";
import type { RegistrationWithPartners } from "./pdf";

function emailResult(
  registration: RegistrationWithPartners,
  emailStatus: RegistrationResult["emailStatus"],
): RegistrationResult {
  const organization = registration.emailSentAt ? "SENT" : "PENDING";
  const athlete = registration.athleteEmailSentAt ? "SENT" : "PENDING";
  let message: string;
  if (emailStatus === "SENT") {
    message = "Inscrição registrada. Os e-mails com o PDF foram aceitos pelo servidor SMTP para a organização e para você. Confira sua caixa de entrada e spam. Pagamento pendente.";
  } else if (emailStatus === "SENDING") {
    message = "Inscrição salva. O envio dos PDFs está em andamento. Aguarde e consulte novamente pelo botão. Pagamento pendente.";
  } else if (organization === "SENT" && athlete === "SENT") {
    message = "Inscrição salva. Os envios do PDF para a organização e para você foram confirmados, mas não foi possível finalizar o status da operação. Use o botão para consultar novamente sem reenviar os e-mails. Pagamento pendente.";
  } else {
    const pending = organization === "SENT" ? "para você"
      : athlete === "SENT" ? "para a organização" : "para a organização e para você";
    message = `Inscrição salva. O envio do PDF ${pending} ainda não foi confirmado. Use o botão para tentar novamente apenas os envios pendentes ou contate a organização. Pagamento pendente.`;
  }
  return {
    id: registration.id, amountCents: registration.amountCents,
    emailStatus, emailDeliveries: { organization, athlete }, message,
  };
}

export async function registerAthlete(requestId: string, athlete: Athlete): Promise<RegistrationResult> {
  const db = getDb();
  const { partners: submittedPartners, ...athleteData } = athlete;
  const partners = submittedPartners.filter((partner) => partner.player1Id !== "")
    .sort((left, right) => left.categoryId.localeCompare(right.categoryId));
  const fingerprint = createHash("sha256").update(JSON.stringify({
    ...athleteData, stages: [...athlete.stages].sort(), categories: [...athlete.categories].sort(),
    ...(partners.length ? { partners } : {}),
  })).digest("hex");
  const registration = await db.$transaction(async (transaction) => {
    const created = await transaction.registration.createMany({
      data: {
        ...athleteData,
        phone: athlete.phone || null,
        requestId,
        fingerprint,
        birthDate: new Date(`${athlete.birthDate}T00:00:00.000Z`),
        amountCents: calculateAmount(athlete.categories.length),
      },
      skipDuplicates: true,
    });
    const saved = await transaction.registration.findUniqueOrThrow({ where: { requestId } });
    if (saved.fingerprint !== fingerprint) {
      throw new HttpError(409, "Esta operação já registrou outros dados. Reenvie os dados originais.");
    }
    if (created.count && partners.length) {
      await transaction.pairOfPlayers.createMany({
        data: partners.map((partner) => ({ ...partner, registrationId: saved.id })),
      });
    }
    return transaction.registration.findUniqueOrThrow({
      where: { requestId }, include: { categoryPartners: true },
    });
  });
  if (registration.emailStatus === "SENT" && registration.emailSentAt && registration.athleteEmailSentAt) {
    return emailResult(registration, "SENT");
  }
  const lease = new Date();
  const claimed = await db.registration.updateMany({
    where: {
      id: registration.id,
      OR: [
        { emailStatus: { in: ["PENDING", "FAILED"] } },
        { emailStatus: "SENDING", emailLeaseAt: { lt: new Date(lease.getTime() - 120000) } },
      ],
    },
    data: { emailStatus: "SENDING", emailLeaseAt: lease },
  });
  if (!claimed.count) {
    return emailResult(registration, "SENDING");
  }
  const ownedLease = { id: registration.id, emailStatus: "SENDING" as const, emailLeaseAt: lease };
  try {
    const current = await db.registration.findUniqueOrThrow({
      where: { id: registration.id }, include: { categoryPartners: true },
    });
    const errors = await sendRegistrationEmail(current, async (recipient) => {
      const confirmed = await db.registration.updateMany({
        where: ownedLease,
        data: recipient === "organization" ? { emailSentAt: new Date() } : { athleteEmailSentAt: new Date() },
      });
      if (confirmed.count !== 1) throw new Error("A reserva do envio foi alterada antes da confirmação.");
    });
    for (const error of errors) logRegistrationEmailError(error, "smtp");
    const saved = await db.registration.findUniqueOrThrow({
      where: { id: registration.id }, include: { categoryPartners: true },
    });
    const emailStatus = saved.emailSentAt && saved.athleteEmailSentAt ? "SENT" : "FAILED";
    const finalized = await db.registration.updateMany({
      where: ownedLease,
      data: { emailStatus, emailLeaseAt: null },
    });
    if (finalized.count !== 1) throw new Error("A reserva do envio foi alterada antes da confirmação.");
    return emailResult(saved, emailStatus);
  } catch (error) {
    logRegistrationEmailError(error, "confirmation");
    await db.registration.updateMany({
      where: ownedLease,
      data: { emailStatus: "FAILED", emailLeaseAt: null },
    });
    const saved = await db.registration.findUniqueOrThrow({
      where: { id: registration.id }, include: { categoryPartners: true },
    });
    return emailResult(saved, "FAILED");
  }
}
