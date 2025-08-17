// src/services/publishRaid.ts
import {
  Guild,
  TextBasedChannel,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
} from 'discord.js';
import { cfg } from '../config.js';
import { clampEventTitle, RaidPayload } from './mapping.js';
import { prisma } from '../util/prisma.js';
import { buildSignupEmbed, rowsForRaid, loadSignups } from './raidSignup.js';

const parseBool = (v: any) => /^(1|true|yes|y)$/i.test(String(v ?? '').trim());
const CREATE_EVENTS = parseBool(process.env.RAID_CREATE_EVENTS ?? 'true');
const FUTURE_LEEWAY_SEC = Number(process.env.RAID_EVENT_LEEWAY_SEC ?? 300);
const DEFAULT_DURATION_SEC = Number(process.env.RAID_EVENT_DEFAULT_DURATION_SEC ?? 3 * 3600);


function resolveChannelId(diff: string): string {
  const key = (diff || '').toUpperCase();
  const map = cfg.channelRouting as Record<string, string>;
  return map[key] || cfg.fallbackChannel;
}

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

  // create/update; write status ONLY if provided by payload (SV is source of truth)
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
      ...(payload.status ? { status: payload.status } : {}),
    },
    update: {
      raidTitle: payload.raidTitle,
      difficulty: payload.difficulty,
      startAt: new Date(startSec * 1000),
      endAt: new Date(endSec * 1000),
      notes: payload.notes ?? '',
      channelId: chId,
      ...(payload.status ? { status: payload.status } : {}),
    },
  });

  // message
  let messageId: string | null = raid.messageId ?? null;
  if (messageId) {
    const msg = await (channel as any).messages?.fetch?.(messageId).catch(() => null);
    if (!msg) messageId = null;
  }
  if (!messageId) {
    const sent = await (channel as any).send({ content: '⏳ Preparing raid embed…' }).catch(() => null);
    if (sent) messageId = sent.id;
  }

  // scheduled event
let eventId: string | null = raid.scheduledEventId ?? null;
const eventName = clampEventTitle(payload.raidTitle);

if (CREATE_EVENTS) {
  try {
    // Always compute a safe future start for Discord API (at least now+60s)
    const now = Math.floor(Date.now() / 1000);
    const minFutureStart = now + 60;
    const safeStartSec = Math.max(startSec, minFutureStart);
    const safeEndSec = Math.max(endSec, safeStartSec + 60); // ensure end > start

    if (eventId) {
      const ev = await guild.scheduledEvents.fetch(eventId).catch(() => null);
      if (ev) {
        await ev.edit({
          name: eventName,
          scheduledStartTime: new Date(safeStartSec * 1000),
          scheduledEndTime: new Date(safeEndSec * 1000),
          description: payload.notes || '',
        }).catch((e: any) => {
          console.warn('[events] edit failed:', e?.message ?? e);
        });
      } else {
        eventId = null; // stale id -> recreate
      }
    }
    if (!eventId) {
      const ev = await guild.scheduledEvents.create({
        name: eventName,
        scheduledStartTime: new Date(safeStartSec * 1000),
        scheduledEndTime: new Date(safeEndSec * 1000),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: 'In-game (WoW)' },
        description: payload.notes || '',
      }).catch((e: any) => {
        console.warn('[events] create failed:', e?.message ?? e);
        return null;
      });
      if (ev) eventId = ev.id;
    }
  } catch (e: any) {
    console.warn('[events] unexpected error:', e?.message ?? e);
  }
}


  await prisma.raid.update({
    where: { raidId: payload.raidId },
    data: { messageId, scheduledEventId: eventId },
  });

  // fetch fresh status (after potential update)
  const fresh = await prisma.raid.findUnique({
    where: { raidId: payload.raidId },
    select: { status: true, scheduledEventId: true },
  });
  const raidStatus = fresh?.status;

  // --- NEW: if raid ended -> mark event as Completed
  if (raidStatus === 'ENDED' && fresh?.scheduledEventId) {
    try {
      const ev = await guild.scheduledEvents.fetch(fresh.scheduledEventId).catch(() => null);
      if (
        ev &&
        ev.status !== GuildScheduledEventStatus.Completed &&
        ev.status !== GuildScheduledEventStatus.Canceled
      ) {
        await ev.edit({
          status: GuildScheduledEventStatus.Completed,
          scheduledEndTime: new Date(), // close now
        }).catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  // allowSignups: DB/SV wins if status present; fallback = time
  const allowSignups =
    typeof raidStatus === 'string' ? raidStatus === 'CREATED' : (Math.floor(Date.now() / 1000) < startSec);

  const signupsFlat = await loadSignups(payload.raidId, guild);
  const embed = buildSignupEmbed(
    {
      raidId: payload.raidId,
      raidTitle: payload.raidTitle,
      difficulty: payload.difficulty,
      startAt: startSec,
      endAt: endSec,
      notes: payload.notes,
      status: raidStatus,
    },
    payload.caps,
    signupsFlat,
  ).setColor(getDifficultyColor(payload.difficulty));

  const components = rowsForRaid(payload.raidId, { allowSignups });

  if (messageId) {
    const msg = await (channel as any).messages?.fetch?.(messageId).catch(() => null);
    if (msg) {
      await msg.edit({ content: null, embeds: [embed], components, attachments: [] }).catch(() => {});
    } else {
      await (channel as any).send({ embeds: [embed], components }).catch(() => null);
    }
  }

  return { channelId: chId, messageId, eventId };
}
