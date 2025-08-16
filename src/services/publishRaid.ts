// src/services/publishRaid.ts
import {
  Guild,
  TextBasedChannel,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  AttachmentBuilder,
} from 'discord.js';
import path from 'path';
import fs from 'fs/promises';

import { cfg } from '../config.js';
import { clampEventTitle, RaidPayload } from './mapping.js';
import { prisma } from '../util/prisma.js';
import { buildSignupEmbed, rowsForRaid, loadSignups, toGroupedSignups } from './raidSignup.js';
import { buildRosterImage } from './rosterImage.js';

const CREATE_EVENTS = String(process.env.RAID_CREATE_EVENTS ?? 'true') === 'true';
const FUTURE_LEEWAY_SEC = Number(process.env.RAID_EVENT_LEEWAY_SEC ?? 300);
const DEFAULT_DURATION_SEC = Number(process.env.RAID_EVENT_DEFAULT_DURATION_SEC ?? 3 * 3600);

// Resolve channel based on difficulty
function resolveChannelId(diff: string): string {
  const key = (diff || '').toUpperCase();
  const map = cfg.channelRouting as Record<string, string>;
  return map[key] || cfg.fallbackChannel;
}

// Map difficulty -> color + local icon filename
function getDifficultyMeta(diffRaw: string | undefined) {
  const diff = (diffRaw || '').toUpperCase();
  const COLORS: Record<string, number> = {
    LFR: 0x1abc9c,
    NORMAL: 0x2ecc71,
    HEROIC: 0xe67e22,
    MYTHIC: 0xe74c3c,
  };
  const ICONS: Record<string, string> = {
    LFR: 'diff_lfr.png',
    NORMAL: 'diff_normal.png',
    HEROIC: 'diff_heroic.png',
    MYTHIC: 'diff_mythic.png',
  };
  return {
    color: COLORS[diff] ?? 0x5865f2,
    iconFile: ICONS[diff] ?? null,
  };
}

async function tryBuildDiffIconAttachment(diffRaw: string | undefined) {
  const { iconFile } = getDifficultyMeta(diffRaw);
  if (!iconFile) return null;

  // Expecting files under app/assets/icons/
  const abs = path.join(process.cwd(), 'app', 'assets', 'icons', iconFile);
  try {
    const buf = await fs.readFile(abs);
    // Use a stable name so we can reference it via attachment://
    const name = 'raid-diff.png';
    return new AttachmentBuilder(buf, { name });
  } catch {
    // Icon missing in repo -> silently ignore
    return null;
  }
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

  // Embed + komponenty
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

  // Color & thumbnail from local difficulty icon
  const { color } = getDifficultyMeta(payload.difficulty);
  embed.setColor(color);

  // Collect files (roster image + optional diff icon)
  const files: AttachmentBuilder[] = [];

  // Obrazek rosteru — wymaga SignupsGrouped
  try {
    const { attachment, filename } = await buildRosterImage({
      title: payload.raidTitle,
      startAt: startSec,
      caps: payload.caps,
      signups: toGroupedSignups(signupsFlat),
      guildId: guild.id,
    });
    embed.setImage(`attachment://${filename}`);
    files.push(attachment);
  } catch {
    // brak obrazka nie powinien blokować publikacji
  }

  // Local difficulty icon as thumbnail
  const diffIcon = await tryBuildDiffIconAttachment(payload.difficulty);
  if (diffIcon) {
    // Must reference by the exact name we passed to AttachmentBuilder
    embed.setThumbnail('attachment://raid-diff.png');
    files.push(diffIcon);
  }

  const components = rowsForRaid(payload.raidId);

  // Message create/update
  let messageId: string | null = raid.messageId ?? null;

  if (messageId) {
    const msg = await (channel as any).messages?.fetch?.(messageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components, files }).catch(() => {});
    } else {
      messageId = null;
    }
  }
  if (!messageId) {
    const sent = await (channel as any).send({ embeds: [embed], components, files }).catch(() => null);
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
          await ev
            .edit({
              name: eventName,
              scheduledStartTime: new Date(startSec * 1000),
              scheduledEndTime: new Date(endSec * 1000),
              description: payload.notes || '',
            })
            .catch(() => {});
        } else {
          eventId = null;
        }
      }
      if (!eventId) {
        const ev = await guild.scheduledEvents
          .create({
            name: eventName,
            scheduledStartTime: new Date(startSec * 1000),
            scheduledEndTime: new Date(endSec * 1000),
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType: GuildScheduledEventEntityType.External,
            entityMetadata: { location: 'In-game (WoW)' },
            description: payload.notes || '',
          })
          .catch(() => null);
        if (ev) eventId = ev.id;
      }
    } catch {
      // brak uprawnień lub wyłączone eventy – ignorujemy
    }
  }

  await prisma.raid.update({
    where: { raidId: payload.raidId },
    data: { messageId, scheduledEventId: eventId },
  });

  return { channelId: chId, messageId, eventId };
}
