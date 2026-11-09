import "server-only";
import nodemailer from "nodemailer";
import { ConfigurationError, emailSetting, requiredSetting } from "./config";
import { createRegistrationPdf, type RegistrationWithPartners } from "./pdf";
import { RegistrationEmailError, type EmailRecipient } from "./email-error";

export async function sendRegistrationEmail(
  registration: RegistrationWithPartners,
  confirm: (recipient: EmailRecipient) => Promise<void>,
) {
  const recipients: EmailRecipient[] = [];
  if (!registration.emailSentAt) recipients.push("organization");
  if (!registration.athleteEmailSentAt) recipients.push("athlete");
  if (!recipients.length) return [];
  let stage: "configuration" | "pdf" | "smtp" = "configuration";
  try {
    const port = Number(requiredSetting("SMTP_PORT"));
    const secure = requiredSetting("SMTP_SECURE");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigurationError("SMTP_PORT");
    if (secure !== "true" && secure !== "false") throw new ConfigurationError("SMTP_SECURE");
    const from = emailSetting("SMTP_FROM");
    const to = emailSetting("REGISTRATION_EMAIL");
    const host = requiredSetting("SMTP_HOST");
    const user = requiredSetting("SMTP_USER");
    const pass = requiredSetting("SMTP_PASS");
    stage = "pdf";
    const pdf = await createRegistrationPdf(registration);
    stage = "smtp";
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: secure === "true",
      requireTLS: secure === "false" && process.env.NODE_ENV === "production",
      auth: { user, pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
    });
    const outcomes = await Promise.all(recipients.map(async (recipient) => {
      const destination = recipient === "organization" ? to : registration.email;
      try {
        const info = await transporter.sendMail({
          from, to: destination,
          messageId: recipient === "organization"
            ? `<registration-${registration.id}@${from.split("@")[1]}>`
            : `<registration-${registration.id}-athlete@${from.split("@")[1]}>`,
          subject: `Inscrição Futevolei 2026 - ${registration.id}`,
          text: recipient === "organization"
            ? "Nova inscrição registrada. O PDF segue em anexo. Status: pagamento pendente. Este envio não confirma pagamento."
            : "Sua inscrição foi registrada. O PDF com seus dados segue em anexo. Status: pagamento pendente. Este envio não confirma pagamento.",
          attachments: [{ filename: `inscricao-${registration.id}.pdf`, content: pdf, contentType: "application/pdf" }],
        });
        if (!info.accepted.some((address: string) => address.toLowerCase() === destination.toLowerCase())) {
          throw new Error("Servidor SMTP não aceitou o destinatário.");
        }
      } catch (error) {
        return new RegistrationEmailError("smtp", error, recipient);
      }
      try {
        await confirm(recipient);
      } catch (error) {
        return new RegistrationEmailError("confirmation", error, recipient);
      }
      return null;
    }));
    return outcomes.filter((error) => error !== null);
  } catch (error) {
    throw new RegistrationEmailError(stage, error);
  }
}
