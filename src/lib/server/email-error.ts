import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { ConfigurationError } from "./config";

type EmailStage = "configuration" | "pdf" | "smtp" | "confirmation";
export type EmailRecipient = "organization" | "athlete";

export class RegistrationEmailError extends Error {
  constructor(public readonly stage: EmailStage, cause: unknown, public readonly recipient?: EmailRecipient) {
    super("Falha no envio do PDF da inscrição.", { cause });
  }
}

const errorCodes = new Set([
  "ENOENT", "EACCES", "EAUTH", "ECONNECTION", "ECONNREFUSED", "ECONNRESET",
  "ETIMEDOUT", "ETIMEOUT", "EDNS", "ENOTFOUND", "EAI_AGAIN", "ESOCKET",
  "ETLS", "EPROTOCOL", "EENVELOPE", "EMESSAGE", "ESTREAM",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER",
]);
const commands = new Set([
  "CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "AUTH LOGIN", "AUTH PLAIN",
  "AUTH XOAUTH2", "MAIL FROM", "RCPT TO", "DATA",
]);
const settings = new Set([
  "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS",
  "SMTP_FROM", "REGISTRATION_EMAIL",
]);

export function logRegistrationEmailError(error: unknown, stage: EmailStage) {
  const cause = error instanceof RegistrationEmailError ? error.cause : error;
  const failedStage = error instanceof RegistrationEmailError ? error.stage : stage;
  const details = [
    `etapa ${failedStage}`,
    cause instanceof ConfigurationError ? "ConfigurationError"
      : cause instanceof Prisma.PrismaClientKnownRequestError ? "PrismaClientKnownRequestError"
        : cause instanceof Error ? "Error" : "UnknownError",
  ];
  if (error instanceof RegistrationEmailError && error.recipient) {
    details.push(`destinatário ${error.recipient}`);
  }
  if (cause instanceof ConfigurationError && settings.has(cause.setting)) {
    details.push(`configuração ${cause.setting}`);
  }
  if (cause instanceof Error) {
    if ("code" in cause && typeof cause.code === "string"
      && (errorCodes.has(cause.code)
        || (cause instanceof Prisma.PrismaClientKnownRequestError && /^P\d{4}$/.test(cause.code)))) {
      details.push(`código ${cause.code}`);
    }
    if ("responseCode" in cause && typeof cause.responseCode === "number"
      && Number.isInteger(cause.responseCode) && cause.responseCode >= 200 && cause.responseCode <= 599) {
      details.push(`SMTP ${cause.responseCode}`);
    }
    if ("command" in cause && typeof cause.command === "string" && commands.has(cause.command)) {
      details.push(`comando ${cause.command}`);
    }
  }
  console.error(`[registration-email] ${details.join("; ")}.`);
}
