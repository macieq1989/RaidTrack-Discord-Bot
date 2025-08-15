// src/routes/web.ts
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const webRoutes: FastifyPluginAsync = async (app) => {
  app.register(fastifyStatic, {
    root: path.join(__dirname, '../../public'),
  });

  app.get('/', async (_req, reply) => {
    return reply.sendFile('index.html');
  });
};

export default webRoutes;
