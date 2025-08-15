import Fastify from 'fastify';
import rateLimit from 'fastify-rate-limit';
import { cfg } from './config.js';
import { publishOrUpdateRaid } from './services/publishRaid.js';
import { z } from 'zod';

export function createWebServer(client: any) {
  const app = Fastify({ logger: true });

  app.register(rateLimit, { max: 20, timeWindow: '1 minute' });

  app.get('/health', async () => ({ ok: true }));

  // Optional: automated ingest (Pro mode)
  app.post('/api/ingest', async (req, reply) => {
    if (req.headers['x-api-key'] !== cfg.ingestKey) return reply.status(401).send({ error: 'unauthorized' });
    const schema = z.object({
      guildId: z.string(),
      raid: z.object({
        raidId: z.string(),
        raidTitle: z.string(),
        difficulty: z.string(),
        startAt: z.number()
      })
    });
    const body = schema.parse(req.body);
    const guild = await client.guilds.fetch(body.guildId);
    await publishOrUpdateRaid(guild, body.raid as any);
    return reply.send({ ok: true });
  });

  return app;
}
