import * as PrismaClientModule from '@prisma/client';
const bcrypt = require('bcrypt') as {
  hash: (value: string, rounds: number) => Promise<string>;
};

const prisma = new (PrismaClientModule as any).PrismaClient();

async function main() {
  const adminPassword = await bcrypt.hash('SenhaSuperSegura123', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@ligainternacontornodabola.com' },
    update: {},
    create: {
      email: 'admin@ligainternacontornodabola.com',
      name: 'Administrador Master',
      password: '@123456',
      role: 'ADMIN', // Atribuição explícita de Admin
    },
  });

  console.log({ admin });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
