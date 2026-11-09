-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password" VARCHAR(128) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairOfPlayers" (
    "id" TEXT NOT NULL,
    "player1Id" TEXT,
    "registrationId" TEXT,
    "categoryId" VARCHAR(30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PairOfPlayers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Registration" (
    "id" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "fullName" VARCHAR(150) NOT NULL,
    "nickname" VARCHAR(80) NOT NULL,
    "address" VARCHAR(300) NOT NULL,
    "trainingPlace" VARCHAR(150) NOT NULL,
    "birthDate" DATE NOT NULL,
    "phone" VARCHAR(20),
    "email" VARCHAR(254) NOT NULL,
    "stages" TEXT[],
    "categories" TEXT[],
    "pairOfPlayersId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "emailStatus" "EmailStatus" NOT NULL DEFAULT 'PENDING',
    "emailLeaseAt" TIMESTAMP(3),
    "emailSentAt" TIMESTAMP(3),
    "athleteEmailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RequestBucket_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PairOfPlayers_registrationId_categoryId_key" ON "PairOfPlayers"("registrationId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Registration_requestId_key" ON "Registration"("requestId");

-- CreateIndex
CREATE INDEX "RequestBucket_expiresAt_idx" ON "RequestBucket"("expiresAt");

-- AddForeignKey
ALTER TABLE "PairOfPlayers" ADD CONSTRAINT "PairOfPlayers_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_pairOfPlayersId_fkey" FOREIGN KEY ("pairOfPlayersId") REFERENCES "PairOfPlayers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
