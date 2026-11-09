import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adapter: vi.fn(),
  client: vi.fn(),
  hash: vi.fn(),
  upsert: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("dotenv/config", () => ({}));
vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(options: unknown) {
      mocks.adapter(options);
    }
  },
}));
vi.mock("../src/generated/prisma/client", () => ({
  PrismaClient: class {
    user = { upsert: mocks.upsert };
    $disconnect = mocks.disconnect;

    constructor(options: unknown) {
      mocks.client(options);
    }
  },
}));
vi.mock("bcrypt", () => ({ default: { hash: mocks.hash } }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/seed_test");
  vi.stubEnv("SEED_ADMIN_PASSWORD", "test-only-password");
  mocks.hash.mockResolvedValue("hashed-password");
  mocks.upsert.mockResolvedValue({});
  mocks.disconnect.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("seed do administrador", () => {
  it("usa o adapter PostgreSQL e salva o hash sem atualizar usuarios existentes", async () => {
    await import("../prisma/seed");

    expect(mocks.adapter).toHaveBeenCalledWith({
      connectionString: "postgresql://localhost/seed_test",
    });
    expect(mocks.client).toHaveBeenCalledWith({
      adapter: expect.any(Object),
    });
    expect(mocks.hash).toHaveBeenCalledWith("test-only-password", 10);
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { email: "admin@ligainternacontornodabola.com" },
      update: {},
      create: {
        email: "admin@ligainternacontornodabola.com",
        name: "Administrador Master",
        password: "hashed-password",
        role: "ADMIN",
      },
    });
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith("Seed do administrador concluido.");
  });

  it.each(["DATABASE_URL", "SEED_ADMIN_PASSWORD"])(
    "rejeita %s ausente antes de conectar ao banco",
    async (setting) => {
      vi.stubEnv(setting, "");

      await expect(import("../prisma/seed")).rejects.toThrow(`${setting} obrigatoria`);

      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
    },
  );

  it("propaga falhas de persistencia e fecha a conexao", async () => {
    mocks.upsert.mockRejectedValue(new Error("database unavailable"));

    await expect(import("../prisma/seed")).rejects.toThrow("database unavailable");

    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("propaga falhas de hash sem gravar e fecha a conexao", async () => {
    mocks.hash.mockRejectedValue(new Error("hash failed"));

    await expect(import("../prisma/seed")).rejects.toThrow("hash failed");

    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  });
});
