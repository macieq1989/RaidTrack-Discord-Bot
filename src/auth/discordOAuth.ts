// Simple Discord OAuth2 helper (Authorization Code) + JWT session
import { cfg } from '../config.js';
import { SignJWT, jwtVerify } from 'jose';

const DISCORD_API = 'https://discord.com/api';

export function buildAuthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: cfg.oauth.clientId,
    response_type: 'code',
    redirect_uri: cfg.oauth.redirectUri,
    scope: cfg.oauth.scopes.join(' '),
    prompt: 'consent',
    state
  });
  return `${DISCORD_API}/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(code: string) {
  const body = new URLSearchParams({
    client_id: cfg.oauth.clientId,
    client_secret: cfg.oauth.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.oauth.redirectUri
  });
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return res.json() as Promise<{ access_token: string; token_type: string; expires_in: number; scope: string; refresh_token?: string }>;
}

export async function fetchUser(accessToken: string) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error('failed to fetch @me');
  return res.json() as Promise<{ id: string; username: string; global_name?: string; avatar?: string }>;
}

export async function fetchMember(accessToken: string, guildId: string) {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null; // brak uprawnień lub nie jest członkiem
  return res.json() as Promise<{ user: { id: string }, roles: string[] }>;
}

// --- JWT session ---
const enc = new TextEncoder();
const secretKey = enc.encode(cfg.sessionSecret);

export async function createSessionJwt(payload: object, ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(secretKey);
}

export async function verifySessionJwt(token: string) {
  const { payload } = await jwtVerify(token, secretKey);
  return payload;
}
