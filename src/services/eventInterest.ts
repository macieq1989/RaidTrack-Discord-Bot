// src/services/eventInterest.ts
import { Guild } from 'discord.js';
import { prisma } from '../util/prisma.js';

/**
 * Mark/unmark user as "Interested" on a scheduled event linked to a raid.
 * Requires the bot to have MANAGE_EVENTS permission in the guild.
 */
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

  // Explicit route so TS sees `/${string}`
  const route = `/guilds/${guild.id}/scheduled-events/${eventId}/users/${userId}` as `/${string}`;

  try {
    if (interested) {
      // Some djs setups expect an options object even with empty body
      await guild.client.rest.put(route, {}).catch((e: any) => {
        throw e;
      });
    } else {
      await guild.client.rest.delete(route).catch((e: any) => {
        throw e;
      });
    }
    return true;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const code = err?.code ?? err?.status ?? '';
    console.warn(`[events] setInterested failed (raid=${raidId}, user=${userId}):`, code, msg);
    return false;
  }
}
