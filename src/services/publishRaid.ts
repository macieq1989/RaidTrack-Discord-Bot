import {
  Guild,
  TextBasedChannel,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
} from 'discord.js';

import { cfg } from '../config.js';
import { clampEventTitle, RaidPayload } from './mapping.js';
import { prisma } from '../util/prisma.js';
import { buildSignupEmbed, rowsForRaid, loadSignups } from './raidSignup.js';

const CREATE_EVENTS = String(process.env.RAID_CREATE_EVENTS ?? 'true') === 'true';
const FUTURE_LEEWAY_SEC = Number(process.env.RAID_EVENT_LEEWAY_SEC ?? 300);
const DEFAULT_DURATION_SEC = Number(process.env.RAID_EVENT_DEFAULT_DURATION_SEC ?? 3 * 3600);

// Resolve channel based on difficulty
function resolveChannelId(diff: string): string {
  const key = (diff || '').toUpperCase();
  const map = cfg.channelRouting as Record<string, string>;
  return map[key] || cfg.fallbackChannel;
}

// Map difficulty -> color
function getDifficultyColor(diffRaw: string | undefined) {
  const diff = (diffRaw || '').toUpperCase();
  const COLORS: Record<string, number> = {
    LFR: 0x1abc9c,
    NORMAL: 0x2ecc71,
    HEROIC: 0xe67e22,
    MYTHIC: 0xe74c3c,
  };
  return COLORS[diff] ?? 0x5865f2;
}

export async function publishOrUpdateRaid(guild: Guild, payload: RaidPayload) {
  const chId = resolveChannelId(payload.difficulty);
  const fetched = await guild.channels.fetch(chId).catch(() => null);
  const isText = (fetched as any)?.isTextBased?.() === true;
  if (!fetched || !isText) throw new Error(`No access to text channel ${chId}`);
  const channel = fetched as TextBasedChannel;

  const nowSec = Math.floor(Date.now() / 1000);
  let startSec = Number(payload.startAt || (nowSec + FUTURE_LEEWAY_SEC));
  let endSec = payload.endAt != null ? Number(payload.endAt) : (startSec + DEFAULT_DURATION_SEC);
  if (!Number.isFinite(startSec) || startSec <= 0) startSec = nowSec + FUTURE_LEEWAY_SEC;
  if (!Number.isFinite(endSec) || endSec <= startSec) endSec = startSec + DEFAULT_DURATION_SEC;

  const isPast = startSec < (nowSec + FUTURE_LEEWAY_SEC);

  // DB upsert
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

  // Embed + components
  const signupsFlat = await loadSignups(payload.raidId, guild.id);
  const embed = buildSignupEmbed(
    {
      raidId: payload.raidId,
      raidTitle: payload.raidTitle,
      difficulty: payload.difficulty,
      startAt: startSec,
      endAt: endSec,
      notes: payload.notes,
    },
    payload.caps,
    signupsFlat,
  );
  embed.setColor(getDifficultyColor(payload.difficulty));

  const components = rowsForRaid(payload.raidId);

  // Message create/update (no images/attachments)
  let messageId: string | null = raid.messageId ?? null;

  if (messageId) {
    const msg = await (channel as any).messages?.fetch?.(messageId).catch(() => null);
    if (msg) {
      await msg.edit({
        embeds: [embed],
        components,
        attachments: [], // ensure old attachments are cleared if existed
      }).catch(() => {});
    } else {
      messageId = null;
    }
  }
  if (!messageId) {
    const sent = await (channel as any).send({
      embeds: [embed],
      components,
    }).catch(() => null);
    if (sent) messageId = sent.id;
  }

  // Scheduled event (future only)
  let eventId: string | null = raid.scheduledEventId ?? null;
  const eventName = clampEventTitle(payload.raidTitle);

  if (CREATE_EVENTS && !isPast) {
    try {
      if (eventId) {
        const ev = await guild.scheduledEvents.fetch(eventId).catch(() => null);
        if (ev) {
          await ev.edit({
            name: eventName,
            scheduledStartTime: new Date(startSec * 1000),
            scheduledEndTime: new Date(endSec * 1000),
            description: payload.notes || '',
          }).catch(() => {});
        } else {
          eventId = null;
        }
      }
      if (!eventId) {
        const ev = await guild.scheduledEvents.create({
          name: eventName,
          scheduledStartTime: new Date(startSec * 1000),
          scheduledEndTime: new Date(endSec * 1000),
          privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
          entityType: GuildScheduledEventEntityType.External,
          entityMetadata: { location: 'In-game (WoW)' },
          description: payload.notes || '',
        }).catch(() => null);
        if (ev) eventId = ev.id;
      }
    } catch {
      // ignore permission errors / disabled events
    }
  }

  await prisma.raid.update({
    where: { raidId: payload.raidId },
    data: { messageId, scheduledEventId: eventId },
  });

  return { channelId: chId, messageId, eventId };
}
