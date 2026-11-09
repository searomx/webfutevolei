ALTER TABLE "Registration" ADD COLUMN "athleteEmailSentAt" TIMESTAMP(3);

-- Existing confirmations refer only to the organization.
UPDATE "Registration"
SET "emailSentAt" = COALESCE("emailSentAt", "updatedAt"),
    "emailStatus" = 'PENDING'
WHERE "emailStatus" = 'SENT';
