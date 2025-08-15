import { PrismaClient } from '@prisma/client';
export const prisma = new PrismaClient({ log: ['warn', 'error'] });
process.on('beforeExit', async () => { try { await prisma.$disconnect(); } catch { } });
