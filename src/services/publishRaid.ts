import {
  EmbedBuilder,
  Guild,
  TextBasedChannel,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
} from 'discord.js';
import { cfg } from '../config.js';
import { clampEmbedTitle, clampEventTitle, RaidPayload } from './mapping.js';
import { prisma } from '../util/prisma.js';

// Behaviour toggles / timing (ENV with sensible defaults)
const CREATE_EVENTS = String(process.env.RAID_CREATE_EVENTS ?? 'true') === 'true';
const FUTURE_LEEWAY_SEC = Number(process.env.RAID_EVENT_LEEWAY_SEC ?? 300);       // 5 min
const DEFAULT_DURATION_SEC = Number(process.env.RAID_EVENT_DEFAULT_DURATION_SEC ?? 3 * 3600); // 3h

// Resolve channel based on difficulty
function resolveChannelId(diff: string): string {
  const key = (diff || '').toUpperCase() as keyof typeof cfg.channelRouting;
  // @ts-ignore cfg.channelRouting comes from env at runtime
  return cfg.channelRouting[key] || cfg.fallbackChannel;
}

export async function publishOrUpdateRaid(guild: Guild, payload: RaidPayload) {
  // ---- Resolve channel
  const chId = resolveChannelId(payload.difficulty);
  const ch = await guild.channels.fetch(chId).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    throw new Error(`No access to text channel for difficulty ${payload.difficulty} (id=${chId})`);
  }
  const channel = ch as TextBasedChannel;

  // ---- Normalize times
  const nowSec = Math.floor(Date.now() / 1000);
  let startSec = Number(payload.startAt || (nowSec + FUTURE_LEEWAY_SEC));
  let endSec = payload.endAt != null ? Number(payload.endAt) : (startSec + DEFAULT_DURATION_SEC);
  if (!Number.isFinite(startSec) || startSec <= 0) startSec = nowSec + FUTURE_LEEWAY_SEC;
  if (!Number.isFinite(endSec) || endSec <= startSec) endSec = startSec + DEFAULT_DURATION_SEC;

  const isPast = startSec < (nowSec + FUTURE_LEEWAY_SEC);

  // ---- Upsert DB row
  const raid = await prisma.raid.upsert({
    where: { raidId: payload.raidId },
    create: {
      raidId: payload.raidId,
      raidTitle: payload.raidTitle,
      difficulty: payload.difficulty,
      startAt: new Date(startSec * 1000),
      endAt: new Date(endSec * 1000),
      notes: payload.notes ?? '',
      channelId: chId,
    },
    update: {
      raidTitle: payload.raidTitle,
      difficulty: payload.difficulty,
      startAt: new Date(startSec * 1000),
      endAt: new Date(endSec * 1000),
      notes: payload.notes ?? '',
      channelId: chId,
    },
  });

  // ---- Build embed
  const embed = new EmbedBuilder()
    .setTitle(clampEmbedTitle(payload.raidTitle))
    .setDescription(payload.notes || '')
    .addFields(
      { name: 'Difficulty', value: payload.difficulty || '—', inline: true },
      { name: 'Start', value: `<t:${startSec}:F> (<t:${startSec}:R>)`, inline: true },
      { name: 'End', value: `<t:${endSec}:F> (<t:${endSec}:R>)`, inline: true },
    )
    .setFooter({ text: `RaidID: ${payload.raidId}` });

  // ---- Create or edit the announcement message
  let messageId: string | null = raid.messageId ?? null;
  if (messageId) {
    const msg = await (channel as any).messages?.fetch?.(messageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components: [] });
    } else {
      messageId = null; // lost/deleted → re-send
    }
  }
  if (!messageId) {
    const sent = await (channel as any).send({ embeds: [embed] });
    messageId = sent.id;
  }

  // ---- Scheduled event (only if in the future AND enabled)
  let eventId: string | null = raid.scheduledEventId ?? null;
  const eventName = clampEventTitle(payload.raidTitle);

  if (CREATE_EVENTS && !isPast) {
    if (eventId) {
      const ev = await guild.scheduledEvents.fetch(eventId).catch(() => null);
      if (ev) {
        await ev.edit({
          name: eventName,
          scheduledStartTime: new Date(startSec * 1000),
          scheduledEndTime: new Date(endSec * 1000),
          description: payload.notes || '',
          // entityType can’t be changed post-creation; assume External already
        }).catch(() => { /* ignore partial edit failures */ });
      } else {
        eventId = null;
      }
    }
    if (!eventId) {
      const ev = await guild.scheduledEvents.create({
        name: eventName,
        scheduledStartTime: new Date(startSec * 1000),
        scheduledEndTime: new Date(endSec * 1000), // REQUIRED for External
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: 'In-game (WoW)' },
        description: payload.notes || '',
      });
      eventId = ev.id;
    }
  } else {
    // Past start or events disabled → ensure we don't keep stale eventId
    eventId = eventId ?? null;
  }

  // ---- Persist IDs
  await prisma.raid.update({
    where: { raidId: payload.raidId },
    data: { messageId, scheduledEventId: eventId },
  });

  return { channelId: chId, messageId, eventId };
}
