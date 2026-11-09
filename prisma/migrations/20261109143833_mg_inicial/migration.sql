/*
  Warnings:

  - Added the required column `name` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "name" VARCHAR(40) NOT NULL,
ADD COLUMN     "role" "Role" NOT NULL DEFAULT 'USER';
