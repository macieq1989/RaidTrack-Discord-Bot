// src/services/eventInterest.ts
import { Guild } from 'discord.js';
import { prisma } from '../util/prisma.js';

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

  // Build the REST route explicitly so TS sees it as `/${string}`
  const route = `/guilds/${guild.id}/scheduled-events/${eventId}/users/${userId}` as `/${string}`;

  try {
    if (interested) {
      await guild.client.rest.put(route);     // mark as Interested
    } else {
      await guild.client.rest.delete(route);  // remove Interested
    }
    return true;
  } catch (err) {
    console.warn('setEventInterest error:', (err as any)?.message ?? err);
    return false;
  }
}
