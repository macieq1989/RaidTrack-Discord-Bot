// src/routes/web.ts
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';
import path from 'path';
import fs from 'fs';

const webRoutes: FastifyPluginAsync = async (app) => {
  // Resolve to "<workdir>/public" (in Docker it's /app/public)
  const root = path.resolve(process.cwd(), 'public');

  if (!fs.existsSync(root)) {
    app.log.error({ root }, 'Static "public" folder not found. Create it or copy it into the image.');
    return; // bail out so we don't register broken routes
  }

  // Note: index.ts mounts this plugin with prefix "/web"
  // so "/" below becomes "/web/"
  app.register(fastifyStatic, {
    root,
    // don't set prefix here; we rely on plugin mount prefix "/web"
  });

  app.get('/', async (_req, reply) => reply.sendFile('index.html'));

  // Optional: favicon to silence 404s
  app.get('/favicon.ico', async (_req, reply) => {
    try {
      return reply.sendFile('favicon.ico');
    } catch {
      return reply.code(404).send();
    }
  });
};

export default webRoutes;
