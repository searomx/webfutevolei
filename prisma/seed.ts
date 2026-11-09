import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcrypt";
import { PrismaClient } from "../src/generated/prisma/client";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!connectionString) throw new Error("DATABASE_URL obrigatoria para executar o seed.");
  if (!password) throw new Error("SEED_ADMIN_PASSWORD obrigatoria para executar o seed.");

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    const adminPassword = await bcrypt.hash(password, 10);

    await prisma.user.upsert({
      where: { email: "admin@ligainternacontornodabola.com" },
      update: {},
      create: {
        email: "admin@ligainternacontornodabola.com",
        name: "Administrador Master",
        password: "@adminmaster2026",
        role: "ADMIN",
      },
    });

    console.log("Seed do administrador concluido.");
  } finally {
    await prisma.$disconnect();
  }
}

await main();
