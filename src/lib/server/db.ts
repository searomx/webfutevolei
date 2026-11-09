import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { requiredSetting } from "./config";

const globalDb = globalThis as typeof globalThis & { futevoleiDb?: PrismaClient };

export function getDb() {
  if (!globalDb.futevoleiDb) {
    const adapter = new PrismaPg({
      connectionString: requiredSetting("DATABASE_URL"),
      max: 5,
      connectionTimeoutMillis: 5000,
    });
    globalDb.futevoleiDb = new PrismaClient({ adapter });
  }
  return globalDb.futevoleiDb;
}
