// src/services/eventInterest.ts
import { Guild } from 'discord.js';
import { prisma } from '../util/prisma.js';

function userRoute(guildId: string, eventId: string, userId: string) {
  return `/guilds/${guildId}/scheduled-events/${eventId}/users/${userId}` as `/${string}`;
}
function usersRoute(guildId: string, eventId: string, params?: Record<string, string | number | boolean>) {
  const base = `/guilds/${guildId}/scheduled-events/${eventId}/users` as `/${string}`;
  if (!params) return base;
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  return `${base}?${qs.toString()}` as `/${string}`;
}

async function verifyInterested(guild: Guild, eventId: string, userId: string): Promise<boolean> {
  try {
    // 100 wystarczy do testów; przy większych eventach dorób paginację po 'after'
    const route = usersRoute(guild.id, eventId, { limit: 100, with_member: false });
    const res = (await guild.client.rest.get(route)) as any[];
    if (!Array.isArray(res)) return false;
    return res.some(u => (u?.user?.id ?? u?.user_id) === userId);
  } catch (e: any) {
    console.warn('[events] verify failed:', e?.status ?? '', e?.message ?? e);
    return false;
  }
}

/** Dodaj/usuń "Interested" na evencie skojarzonym z raidem. Wymaga MANAGE_EVENTS. */
export async function setEventInterestByRaidId(
  guild: Guild,
  raidId: string,
  userId: string,
  interested: boolean
): Promise<boolean> {
  const raid = await prisma.raid.findUnique({
    where: { raidId },
    select: { scheduledEventId: true },
  });
  const eventId = raid?.scheduledEventId;
  if (!eventId) return false;

  const route = userRoute(guild.id, eventId, userId);

  try {
    if (interested) {
      await guild.client.rest.put(route, { auth: true, passThroughBody: true });
    } else {
      await guild.client.rest.delete(route, { auth: true, passThroughBody: true });
    }
  } catch (err: any) {
    // to nam powie dokładnie co nie pasi po stronie Discorda
    console.warn(
      `[events] interested ${interested ? 'PUT' : 'DELETE'} failed:`,
      err?.status ?? err?.code ?? '',
      err?.rawError ?? err?.message ?? err
    );
    return false;
  }

  const ok = await verifyInterested(guild, eventId, userId);
  if (!ok) console.warn('[events] verification failed: user not present on event after request');
  return ok;
}
