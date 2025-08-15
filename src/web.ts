import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import { cfg } from './config.js';
import { publishOrUpdateRaid } from './services/publishRaid.js';
import { z } from 'zod';
import type { Client, Guild } from 'discord.js';
import { buildAuthUrl, exchangeCodeForToken, fetchUser, fetchMember, createSessionJwt, verifySessionJwt } from './auth/discordOAuth.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; username?: string; isOfficer?: boolean };
  }
}

const SESSION_COOKIE = 'rt_session';

async function authGuard(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return reply.redirect('/login');
  try {
    const payload: any = await verifySessionJwt(token);
    req.user = { id: payload.sub, username: payload.username, isOfficer: !!payload.isOfficer };
    return;
  } catch {
    reply.clearCookie(SESSION_COOKIE);
    return reply.redirect('/login');
  }
}

export function createWebServer(client: Client): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(rateLimit, { max: 30, timeWindow: '1 minute' });
  app.register(cookie, { secret: cfg.sessionSecret, hook: 'onRequest' });

  app.get('/health', async () => ({ ok: true }));

  // Landing
  app.get('/', async (_req, reply) => {
    return reply.type('text/html').send(`
      <html><body>
        <h2>RaidTrack Bot</h2>
        <p><a href="/login">Zaloguj przez Discord</a></p>
      </body></html>
    `);
  });

  // Start OAuth
  app.get('/login', async (req, reply) => {
    const state = Math.random().toString(36).slice(2);
    reply.setCookie('rt_state', state, { path: '/', httpOnly: true, sameSite: 'lax' });
    return reply.redirect(buildAuthUrl(state));
  });

  // Callback
  app.get('/oauth/callback', async (req, reply) => {
    const q = req.query as any;
    const state = req.cookies?.['rt_state'];
    if (!q.code || !state || q.state !== state) return reply.code(400).send('Invalid state');
    reply.clearCookie('rt_state');

    const token = await exchangeCodeForToken(q.code);
    const user = await fetchUser(token.access_token);

    let isOfficer = false;
    if (cfg.allowedGuildId) {
      const member = await fetchMember(token.access_token, cfg.allowedGuildId);
      if (member) {
        isOfficer = cfg.officerRoleId ? member.roles.includes(cfg.officerRoleId) : true;
      }
    } else {
      // jeśli nie podasz ALLOWED_GUILD_ID, wpuszczamy każdego zalogowanego
      isOfficer = true;
    }

    const jwt = await createSessionJwt({
      sub: user.id,
      username: user.username,
      isOfficer
    }, 60 * 60 * 8); // 8h

    reply.setCookie(SESSION_COOKIE, jwt, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.publicUrl.startsWith('https://')
    });

    return reply.redirect('/panel');
  });

  app.get('/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/');
  });

  // Prosty panel – tylko dla zalogowanych (i opcjonalnie oficerów)
  app.get('/panel', { preHandler: authGuard }, async (req, reply) => {
    if (!req.user?.isOfficer) return reply.code(403).send('Brak uprawnień');
    return reply.type('text/html').send(`
      <html><body>
        <h2>Panel RaidTrack</h2>
        <p>Zalogowany: ${req.user.username} (${req.user.id})</p>
        <ul>
          <li><a href="/health">Health</a></li>
          <li><a href="/logout">Wyloguj</a></li>
        </ul>
        <p>Tu wstawimy formularze (import JSON, lista raidów itd.).</p>
      </body></html>
    `);
  });

  // (Opcjonalnie) zablokuj /api/ingest do zalogowanych oficerów albo nadal przez klucz
  app.post('/api/ingest', async (req, reply) => {
    // obecnie nadal przez klucz API – wygodne dla uploaderów
    if (req.headers['x-api-key'] !== cfg.sessionSecret && req.headers['x-api-key'] !== cfg.oauth.clientSecret) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const schema = z.object({
      guildId: z.string(),
      raid: z.object({
        raidId: z.string(),
        raidTitle: z.string(),
        difficulty: z.string(),
        startAt: z.number(),
        notes: z.string().optional()
      })
    });
    const body = schema.parse(req.body);
    const guild: Guild = await client.guilds.fetch(body.guildId);
    await publishOrUpdateRaid(guild, body.raid as any);
    return reply.send({ ok: true });
  });

  return app;
}
