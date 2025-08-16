// src/services/rosterRefresh.ts
import type { Guild } from 'discord.js';
import { prisma } from '../util/prisma.js';
import {
  loadSignups,
  toGroupedSignups,
  rowsForRaid,
  buildSignupEmbed,
  type RaidStatus,            // <-- import typu statusu
} from './raidSignup.js';
import { buildRosterImage } from './rosterImage.js';

const DEFAULT_DURATION_SEC = Number(process.env.RAID_EVENT_DEFAULT_DURATION_SEC ?? 3 * 3600);

// prosta „debounce” per raidId, żeby nie renderować obrazu przy każdym kliknięciu
const timers = new Map<string, NodeJS.Timeout>();

export function queueRosterRefresh(guild: Guild, raidId: string, delayMs = 1200) {
  const key = `${guild.id}:${raidId}`;
  const old = timers.get(key);
  if (old) clearTimeout(old);

  const t = setTimeout(() => {
    timers.delete(key);
    refreshRosterNow(guild, raidId).catch(err =>
      console.error('[rosterRefresh] refresh failed:', err)
    );
  }, delayMs);

  timers.set(key, t);
}

async function refreshRosterNow(guild: Guild, raidId: string) {
  const raid = await prisma.raid.findUnique({ where: { raidId } });
  if (!raid?.channelId || !raid?.messageId) return;

  const ch = await guild.channels.fetch(raid.channelId).catch(() => null);
  if (!ch || !(ch as any).isTextBased?.()) return;
  const channel = ch as any;

  const startSec = Math.floor(raid.startAt.getTime() / 1000);
  const endDate  = raid.endAt ?? new Date(raid.startAt.getTime() + DEFAULT_DURATION_SEC * 1000);
  const endSec   = Math.floor(endDate.getTime() / 1000);

  // status z DB = źródło prawdy
  const status: RaidStatus = (raid as any).status ?? 'CREATED';
  const allowSignups = status === 'CREATED';

  // weź wyświetlane nicki (przekazujemy Guild) + class/spec z profilu
  const signupsFlat = await loadSignups(raidId, guild);

  const embed = buildSignupEmbed(
    {
      raidId,
      raidTitle: raid.raidTitle,
      difficulty: raid.difficulty,
      startAt: startSec,
      endAt: endSec,
      notes: raid.notes || undefined,
      status, // <-- KLUCZOWE
    },
    undefined,
    signupsFlat
  );

  // spróbuj zbudować obrazek; jak się nie uda (np. brak sharp), wyślij sam embed
  let files: any[] | undefined;
  try {
    const grouped = toGroupedSignups(signupsFlat);
    const { attachment, filename } = await buildRosterImage({
      title: raid.raidTitle,
      startAt: startSec,
      caps: undefined,
      signups: grouped,
    });
    embed.setImage(`attachment://${filename}`);
    files = [attachment];
  } catch {
    // cicho pomijamy grafikę
  }

  const msg = await channel.messages?.fetch?.(raid.messageId).catch(() => null);
  if (msg) {
    await msg.edit({
      embeds: [embed],
      components: rowsForRaid(raidId, { allowSignups }), // <-- przyciski aktywne tylko gdy CREATED
      files,
    }).catch(() => {});
  }
}
