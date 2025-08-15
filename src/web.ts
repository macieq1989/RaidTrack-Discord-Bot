// src/web.ts
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import { publishOrUpdateRaid } from './services/publishRaid.js';
import { cfg } from './config.js';
import { z } from 'zod';
import { getSVPollerStatus } from './services/svPoller.js';
import type { Client, Guild } from 'discord.js';
import {
  buildAuthUrl,
  exchangeCodeForToken,
  fetchUser,
  fetchMember,
  createSessionJwt,
  verifySessionJwt,
} from './auth/discordOAuth.js';

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
  } catch {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/login');
  }
}

// HTML helpers
const baseHtml = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Ctext y='50%25' x='50%25' dominant-baseline='middle' text-anchor='middle' font-size='42'%3ERT%3C/text%3E%3C/svg%3E">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-black text-slate-100">
  <div class="absolute inset-0 bg-[radial-gradient(1000px_600px_at_20%_10%,rgba(56,189,248,0.15),transparent),radial-gradient(800px_500px_at_80%_0%,rgba(147,51,234,0.15),transparent)] pointer-events-none"></div>
  <main class="relative mx-auto max-w-3xl px-6 py-16">
    ${body}
  </main>
</body>
</html>`;

const card = (content: string) => `
<section class="backdrop-blur-xl bg-white/5 border border-white/10 shadow-2xl rounded-3xl p-8">
  ${content}
</section>
`;

export function createWebServer(client: Client): FastifyInstance {
  const app = Fastify({ logger: true });

  // Plugins
  app.register(rateLimit, { max: 30, timeWindow: '1 minute' });
  if (!cfg.sessionSecret) {
    app.log.warn('SESSION secret is not set. Cookies will not be signed securely.');
  }
  app.register(cookie, { secret: cfg.sessionSecret || undefined, hook: 'onRequest' });

  // Health
  app.get('/health', async () => ({ ok: true }));
  app.get('/api/sv-status', async () => getSVPollerStatus());


  // Landing (pretty)
  app.get('/', async (_req, reply) => {
    const body = `
      <div class="flex items-center gap-3 mb-8">
        <div class="size-10 rounded-2xl bg-cyan-500/20 border border-cyan-400/30 grid place-items-center">
          <span class="text-cyan-300 font-bold">RT</span>
        </div>
        <h1 class="text-3xl md:text-4xl font-semibold tracking-tight">RaidTrack Discord Bot</h1>
      </div>
      ${card(`
        <p class="text-slate-300 leading-relaxed">
          Keep your WoW raid data in sync with Discord. Import runs, display EPGP or loot, and manage your raid timeline.
        </p>
        <div class="mt-8 flex flex-wrap gap-3">
          <a href="/login" class="inline-flex items-center gap-2 rounded-2xl px-5 py-3 bg-cyan-500/90 hover:bg-cyan-400 text-black font-medium transition">
            <svg xmlns="http://www.w3.org/2000/svg" class="size-5" viewBox="0 0 24 24" fill="currentColor"><path d="M13 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3Zm1 4v5l4 2"/></svg>
            Sign in with Discord
          </a>
          <a href="/web/" class="inline-flex items-center gap-2 rounded-2xl px-5 py-3 bg-white/10 hover:bg-white/20 border border-white/15 transition">
            Open Web UI
          </a>
          <a href="/health" class="inline-flex items-center gap-2 rounded-2xl px-5 py-3 bg-white/10 hover:bg-white/20 border border-white/15 transition">
            Health
          </a>
        </div>
        <div class="mt-6 text-sm text-slate-400">
          <p>Guild allowlist: ${cfg.allowedGuildId ? `<code class="bg-black/40 px-2 py-1 rounded">${cfg.allowedGuildId}</code>` : '<em>disabled</em>'}</p>
        </div>
      `)}
      <p class="mt-6 text-xs text-slate-500">© ${new Date().getFullYear()} RaidTrack</p>
    `;
    return reply.type('text/html').send(baseHtml('RaidTrack', body));
  });

  // OAuth start
  app.get('/login', async (_req, reply) => {
    const state = Math.random().toString(36).slice(2);
    reply.setCookie('rt_state', state, { path: '/', httpOnly: true, sameSite: 'lax' });
    return reply.redirect(buildAuthUrl(state));
  });

  // OAuth callback
  app.get('/oauth/callback', async (req, reply) => {
    const q = req.query as any;
    const state = req.cookies?.['rt_state'];
    if (!q?.code || !state || q.state !== state) return reply.code(400).send('Invalid state');
    reply.clearCookie('rt_state');

    const token = await exchangeCodeForToken(q.code);
    const user = await fetchUser(token.access_token);

    let isOfficer = false;
    if (cfg.allowedGuildId) {
      const member = await fetchMember(token.access_token, cfg.allowedGuildId);
      if (member && Array.isArray((member as any).roles)) {
        isOfficer = cfg.officerRoleId ? (member as any).roles.includes(cfg.officerRoleId) : true;
      }
    } else {
      isOfficer = true;
    }

    const jwt = await createSessionJwt(
      { sub: user.id, username: user.username, isOfficer },
      60 * 60 * 8 // 8h
    );

    const secureCookie =
      typeof cfg.publicUrl === 'string' && cfg.publicUrl.startsWith('https://');

    reply.setCookie(SESSION_COOKIE, jwt, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: !!secureCookie,
    });

    return reply.redirect('/panel');
  });

  app.get('/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/');
  });

  // Officer panel (pretty + gated)
  app.get('/panel', { preHandler: authGuard }, async (req, reply) => {
    if (!req.user?.isOfficer) return reply.code(403).send('Forbidden');

    const body = `
      <div class="flex items-center gap-3 mb-8">
        <div class="size-10 rounded-2xl bg-emerald-500/20 border border-emerald-400/30 grid place-items-center">
          <span class="text-emerald-300 font-bold">RT</span>
        </div>
        <h1 class="text-3xl md:text-4xl font-semibold tracking-tight">RaidTrack Panel</h1>
      </div>
      ${card(`
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p class="text-slate-300">Signed in as</p>
            <p class="font-medium">${req.user.username} <span class="text-slate-400">(${req.user.id})</span></p>
          </div>
          <div class="flex gap-2">
            <a href="/web/" class="rounded-xl px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/15 transition">Open Web UI</a>
            <a href="/logout" class="rounded-xl px-4 py-2 bg-white/10 hover:bg-white/20 border border-white/15 transition">Log out</a>
          </div>
        </div>
        <hr class="my-6 border-white/10" />
        <div class="grid gap-4 md:grid-cols-2">
          <a href="/health" class="rounded-2xl p-5 bg-black/30 border border-white/10 hover:bg-black/40 transition">
            <h3 class="font-semibold">Health</h3>
            <p class="text-slate-400 text-sm mt-1">Service status endpoint</p>
          </a>
          <a href="/web/" class="rounded-2xl p-5 bg-black/30 border border-white/10 hover:bg-black/40 transition">
            <h3 class="font-semibold">Web UI</h3>
            <p class="text-slate-400 text-sm mt-1">Import JSON, browse raids, EPGP & loot</p>
          </a>
        </div>
      `)}
      <p class="mt-6 text-xs text-slate-500">© ${new Date().getFullYear()} RaidTrack</p>
    `;
    return reply.type('text/html').send(baseHtml('RaidTrack Panel', body));
  });

  // API (protected via header key for uploaders)
  app.post('/api/ingest', async (req, reply) => {
    const apiKey = req.headers['x-api-key'];
    const allowedKeyA = cfg.sessionSecret || '';
    const allowedKeyB = (cfg as any)?.oauth?.clientSecret || '';

    if (apiKey !== allowedKeyA && apiKey !== allowedKeyB) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const schema = z.object({
      guildId: z.string(),
      raid: z.object({
        raidId: z.string(),
        raidTitle: z.string(),
        difficulty: z.string(),
        startAt: z.number(),
        notes: z.string().optional(),
      }),
    });

    let body: z.infer<typeof schema>;
    try {
      body = schema.parse(req.body);
    } catch (e: any) {
      return reply.status(400).send({ error: 'invalid_payload', details: e?.errors || String(e) });
    }

    const guild: Guild = await client.guilds.fetch(body.guildId);
    await publishOrUpdateRaid(guild, body.raid as any);
    return reply.send({ ok: true });
  });

  return app;
}
