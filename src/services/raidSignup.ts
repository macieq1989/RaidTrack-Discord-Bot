// src/services/raidSignup.ts
import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuInteraction, EmbedBuilder, Guild,
} from 'discord.js';
import { prisma } from '../util/prisma.js';
import { classSpecEmoji } from './profileIcons.js';
import type { PlayerEntry, SignupsGrouped } from './rosterImage.js';
import { cfg } from '../config.js';

import {
  getPlayerProfile, upsertPlayerProfile, listClasses, listSpecs, isValidClassSpec,
} from './playerProfile.js';

export type RoleKey = 'TANK'|'HEALER'|'MELEE'|'RANGED'|'MAYBE'|'ABSENT';

// ---------- normalizacja + emoji helpery ----------
function normToken(s?: string) {
  return (s ?? '').toLowerCase().trim().replace(/\s+|-/g, '_');
}
function normClass(s?: string) {
  const t = normToken(s);
  if (t === 'deathknight') return 'death_knight';
  if (t === 'demonhunter') return 'demon_hunter';
  return t;
}
const SPEC_ALIASES: Record<string, string> = {
  retri: 'retribution',
  retributions: 'retribution',
  prot: 'protection',
  disc: 'discipline',
  bm: 'beast_mastery',
  mm: 'marksmanship',
  marks: 'marksmanship',
  surv: 'survival',
  enh: 'enhancement',
  ele: 'elemental',
  resto: 'restoration',
  destro: 'destruction',
  affli: 'affliction',
  demo: 'demonology',
  arc: 'arcane',
};
function normSpec(s?: string) {
  let t = normToken(s);
  if (SPEC_ALIASES[t]) t = SPEC_ALIASES[t];
  return t;
}
function keyFor(cls?: string, spec?: string) {
  const c = normClass(cls);
  const s = normSpec(spec);
  return c && s ? `${c}_${s}` : null;
}
function toEmojiToken(name: string, value: string): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (/^<a?:[^:>]+:\d+>$/.test(v)) return v;               // pełny token
  const m = /^a:(\d+)$/.exec(v); if (m) return `<a:${name}:${m[1]}>`; // anim
  if (/^\d+$/.test(v)) return `<:${name}:${v}>`;            // statyczne ID
  return null;
}
/** Zamienia ':class_spec:' -> '<:class_spec:ID>' jeśli mamy ID w cfg.customEmoji */
function ensureEmojiToken(maybe: string, cls?: string, spec?: string): string {
  if (/^:[^:]+:$/.test((maybe ?? '').trim())) {
    const k = keyFor(cls, spec);
    const raw = k ? cfg.customEmoji?.[k] : undefined;
    const tok = raw ? toEmojiToken(k!, raw) : null;
    if (tok) return tok;
  }
  return maybe;
}

// ---------- stałe / kolor trudności ----------
const DEFAULT_DURATION_SEC = Number(process.env.RAID_EVENT_DEFAULT_DURATION_SEC ?? 3 * 3600);

function getDifficultyColor(diffRaw?: string) {
  const diff = (diffRaw || '').toUpperCase();
  const COLORS: Record<string, number> = {
    LFR: 0x1abc9c,
    NORMAL: 0x2ecc71,
    HEROIC: 0xe67e22,
    MYTHIC: 0xe74c3c,
  };
  return COLORS[diff] ?? 0x5865f2;
}

export function normalizeRole(role: string): RoleKey {
  const u = (role ?? '').toUpperCase();
  if (u === 'TANK' || u === 'HEALER' || u === 'MELEE' || u === 'RANGED' || u === 'MAYBE' || u === 'ABSENT') {
    return u as RoleKey;
  }
  return 'MAYBE';
}

/**
 * Wczytuje zapisy + (opcjonalnie) profil i serwerowe wyświetlane nazwy.
 * Dodatkowo zwraca createdAtSec do użycia jako „kiedy” przy graczu.
 */
export async function loadSignups(
  raidId: string,
  guildOrId?: Guild | string
): Promise<Array<{ userId: string; username: string; role: RoleKey; classKey?: string; specKey?: string; createdAtSec?: number }>> {
  const rows = await prisma.signup.findMany({
    where: { raidId },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return [];

  const guildId  = typeof guildOrId === 'string' ? guildOrId : guildOrId?.id;
  const guildObj = typeof guildOrId === 'object' ? (guildOrId as Guild) : undefined;

  // Profile (pola z aktualnego schematu)
  let pmap = new Map<string, { classKey?: string; specKey?: string }>();
  if (guildId) {
    const ids = Array.from(new Set(rows.map(r => r.userId)));
    const profiles = await prisma.playerProfile.findMany({
      where: { guildId, userId: { in: ids } },
      select: { userId: true, classKey: true, specKey: true },
    });
    pmap = new Map(profiles.map(p => [p.userId, { classKey: p.classKey ?? undefined, specKey: p.specKey ?? undefined }]));
  }

  // Wyświetlane nazwy z gildii (bulk)
  const display = new Map<string, string>();
  if (guildObj) {
    const uniqueIds = Array.from(new Set(rows.map(r => r.userId)));
    const results = await Promise.allSettled(uniqueIds.map(id => guildObj.members.fetch(id)));
    for (const res of results) {
      if (res.status === 'fulfilled') {
        const m = res.value;
        if (m?.id && m.displayName) display.set(m.id, m.displayName);
      }
    }
  }

  // Compose output
  return rows.map(r => {
    const prof = pmap.get(r.userId);
    const name = display.get(r.userId) || r.username; // serwerowy nick lub zapasowo z DB
    return {
      userId: r.userId,
      username: name,
      role: normalizeRole(r.role),
      classKey: prof?.classKey,
      specKey: prof?.specKey,
      createdAtSec: Math.floor(r.createdAt.getTime() / 1000),
    };
  });
}

/** Group for potential roster image usage */
export function toGroupedSignups(
  list: Array<{ userId: string; username: string; role: RoleKey; classKey?: string; specKey?: string; }>
): SignupsGrouped {
  const grouped: SignupsGrouped = { tank: [], healer: [], melee: [], ranged: [] };
  for (const s of list) {
    const entry: PlayerEntry = {
      userId: s.userId,
      displayName: s.username,
      classKey: s.classKey,
      specKey: s.specKey,
    };
    switch (s.role) {
      case 'TANK':   grouped.tank.push(entry);   break;
      case 'HEALER': grouped.healer.push(entry); break;
      case 'MELEE':  grouped.melee.push(entry);  break;
      case 'RANGED': grouped.ranged.push(entry); break;
      default: break;
    }
  }
  return grouped;
}

// ---------- EMBED ----------

const ROLE_ICONS: Record<RoleKey,string> = {
  TANK:   '🛡️',
  HEALER: '✨',
  MELEE:  '⚔️',
  RANGED: '🏹',
  MAYBE:  '❔',
  ABSENT: '🚫',
};

type PlayerLine = { username: string; classKey?: string; specKey?: string; role: RoleKey; createdAtSec?: number };

function fmtPlayers(arr: PlayerLine[]): string {
  if (!arr.length) return '—';
  return arr.map(p => {
    let icon = '•';
    if (p.classKey && p.specKey) {
      const raw = classSpecEmoji(p.classKey, p.specKey, p.role);
      icon = ensureEmojiToken(raw, p.classKey, p.specKey);
    }
    const when = p.createdAtSec ? ` — <t:${p.createdAtSec}:R>` : '';
    return `${icon} ${p.username}${when}`;
  }).join('\n');
}

export function buildSignupEmbed(
  meta: { raidId: string; raidTitle: string; difficulty: string; startAt: number; endAt: number; notes?: string },
  caps: { tank?: number; healer?: number; melee?: number; ranged?: number } | undefined,
  signups: Array<{ userId: string; username: string; role: RoleKey; classKey?: string; specKey?: string; createdAtSec?: number }>
) {
  const groups: Record<RoleKey, typeof signups> = {
    TANK: [], HEALER: [], MELEE: [], RANGED: [], MAYBE: [], ABSENT: [],
  };
  for (const s of signups) groups[s.role]?.push(s);

  const now = Math.floor(Date.now() / 1000);
  const status =
    now < meta.startAt ? 'created' :
    now >= meta.startAt && now < meta.endAt ? 'started' :
    'ended';

  const committed = groups.TANK.length + groups.HEALER.length + groups.MELEE.length + groups.RANGED.length;
  const maybes = groups.MAYBE.length;

  const cleanNotes = (meta.notes || '').replace(/^\s*status:.*$/gmi, '').trim();

  // globalna kolejność zapisu
  const ordered = [...signups]
    .sort((a, b) => (a.createdAtSec ?? 0) - (b.createdAtSec ?? 0))
    .map((s, idx) => [s.userId, idx + 1]) as Array<[string, number]>;
  const orderMap = new Map<string, number>(ordered);

  const HEADER_LINE = '────────────';

  const fmtPlayers = (arr: typeof signups, role: RoleKey) => {
    const out: string[] = [HEADER_LINE];           // ZAWSZE podkreślenie jako 1. linia
    if (!arr.length) {
      out.push('—');
      return out.join('\n');
    }
    for (const p of arr) {
      let icon = '•';
      if (p.classKey && p.specKey) {
        const raw = classSpecEmoji(p.classKey, p.specKey, role);
        icon = ensureEmojiToken(raw, p.classKey, p.specKey);
      }
      const idx = orderMap.get(p.userId);
      const pos = typeof idx === 'number' ? `  **#${idx}**` : '';
      out.push(`${icon} ${p.username}${pos}`);
    }
    return out.join('\n');
  };

  const embed = new EmbedBuilder()
    .setTitle(`${meta.raidTitle.toUpperCase()} (${status})`)
    .setDescription(
      [cleanNotes, `👥 **${committed}+${maybes}**`].filter(Boolean).join('\n')
    )
    .addFields(
      { name: 'Difficulty', value: meta.difficulty || '—', inline: true },
      { name: 'Start', value: `<t:${meta.startAt}:f>\n(<t:${meta.startAt}:R>)`, inline: true }, // bez dnia tygodnia; "ago" w 2. linii
      { name: 'End',   value: `<t:${meta.endAt}:t>`, inline: true },
      { name: '\u200B', value: '\u200B' }, // mały odstęp między metadanymi a kolumnami ról
    )
    .addFields(
      { name: `🛡️ Tank (${groups.TANK.length}${caps?.tank ? `/${caps.tank}` : ''})`, value: fmtPlayers(groups.TANK, 'TANK'), inline: true },
      { name: `✨ Healer (${groups.HEALER.length}${caps?.healer ? `/${caps.healer}` : ''})`, value: fmtPlayers(groups.HEALER, 'HEALER'), inline: true },
      { name: `⚔️ Melee (${groups.MELEE.length}${caps?.melee ? `/${caps.melee}` : ''})`, value: fmtPlayers(groups.MELEE, 'MELEE'), inline: true },
    )
    // SPACER między pierwszym wierszem ról a drugim (Tank/Healer/Melee vs Ranged/Maybe/Absent)
    .addFields({ name: '\u200B', value: '\u200B' })
    .addFields(
      { name: `🏹 Ranged (${groups.RANGED.length}${caps?.ranged ? `/${caps.ranged}` : ''})`, value: fmtPlayers(groups.RANGED, 'RANGED'), inline: true },
      { name: `❔ Maybe (${groups.MAYBE.length})`, value: fmtPlayers(groups.MAYBE, 'MAYBE'), inline: true },
      { name: `🚫 Absent (${groups.ABSENT.length})`, value: fmtPlayers(groups.ABSENT, 'ABSENT'), inline: true },
    )
    .setFooter({ text: `RaidID: ${meta.raidId}` })
    .setColor(getDifficultyColor(meta.difficulty));

  return embed;
}



// ---------- BUTTONS / ROWY ----------

export function roleButtonsRow(raidId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`signup:role:${raidId}:TANK`).setLabel('Tank').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`signup:role:${raidId}:HEALER`).setLabel('Healer').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`signup:role:${raidId}:MELEE`).setLabel('Melee').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`signup:role:${raidId}:RANGED`).setLabel('Ranged').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`signup:role:${raidId}:MAYBE`).setLabel('Maybe').setStyle(ButtonStyle.Secondary),
  );
}

export function changeRoleRow(raidId: string): ActionRowBuilder<ButtonBuilder> {
  // Usuwamy „Change role” — dublował wybór ról powyżej
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`profile:change:${raidId}`).setLabel('Change class/spec').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`signup:role:${raidId}:ABSENT`).setLabel('Leave').setStyle(ButtonStyle.Danger),
  );
}

export function rowsForRaid(raidId: string) {
  return [roleButtonsRow(raidId), changeRoleRow(raidId)];
}

// ---------- INTERAKCJE ----------

export async function handleSignupButton(i: ButtonInteraction, guild: Guild) {
  if (!i.customId.startsWith('signup:') && !i.customId.startsWith('profile:change:')) return false;

  // explicit change class/spec
  if (i.customId.startsWith('profile:change:')) {
    const raidId = i.customId.split(':')[2];
    const current = await prisma.signup.findUnique({
      where: { raidId_userId: { raidId, userId: i.user.id } },
      select: { role: true },
    });
    const roleKey = normalizeRole(current?.role || 'MAYBE');
    await i.reply({
      content: 'Pick your **class**:',
      components: [classSelectRow(raidId, roleKey)],
      ephemeral: true,
    });
    return true;
  }

  const parts = i.customId.split(':'); // signup:role:RAIDID:ROLE
  const kind = parts[1];

  if (kind === 'role') {
    const raidId = parts[2];
    const role = (parts[3] as RoleKey) || 'MAYBE';
    if (!raidId) {
      await i.reply({ content: 'Cannot resolve raid context.', ephemeral: true });
      return true;
    }

    const profile = await getPlayerProfile(guild.id, i.user.id);
    if (!profile) {
      await i.reply({
        content: `First time here! Pick your **class**:`,
        components: [classSelectRow(raidId, role)],
        ephemeral: true,
      });
      return true;
    }

    await upsertSignupWithProfile(i, guild, raidId, role, profile.classKey, profile.specKey);
    await refreshSignupMessage(guild, raidId);
    return true;
  }

  return false;
}

export async function handleProfileSelect(i: StringSelectMenuInteraction, guild: Guild) {
  if (!i.customId.startsWith('profile:')) return false;
  // profile:class:RAIDID:ROLE   or   profile:spec:RAIDID:ROLE:CLASS
  const [, kind, raidId, role, cls] = i.customId.split(':');

  if (kind === 'class') {
    const pickedClass = i.values?.[0];
    if (!pickedClass) return true;
    await i.update({
      content: `Class: **${pickedClass}** selected. Now choose **spec**:`,
      components: [specSelectRow(raidId, role as RoleKey, pickedClass)],
    });
    return true;
  }

  if (kind === 'spec') {
    const pickedSpec = i.values?.[0];
    const pickedClass = cls!;
    const roleKey = (role as RoleKey) ?? 'MAYBE';

    if (!pickedClass || !pickedSpec || !isValidClassSpec(pickedClass, pickedSpec)) {
      await i.reply({ content: `Invalid class/spec. Try again.`, ephemeral: true });
      return true;
    }

    await upsertPlayerProfile(guild.id, i.user.id, pickedClass, pickedSpec);
    await upsertSignupWithProfile(i, guild, raidId, roleKey, pickedClass, pickedSpec, true);
    await refreshSignupMessage(guild, raidId);
    return true;
  }

  return false;
}

// ---------- Helpers ----------

function classSelectRow(raidId: string, forRole: RoleKey) {
  const classes = listClasses();
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`profile:class:${raidId}:${forRole}`)
    .setPlaceholder('Choose your class')
    .addOptions(classes.map(c => ({ label: c, value: c })));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function specSelectRow(raidId: string, forRole: RoleKey, classKey: string) {
  const specs = listSpecs(classKey);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`profile:spec:${raidId}:${forRole}:${classKey}`)
    .setPlaceholder(`Choose spec for ${classKey}`)
    .addOptions(specs.map(s => ({ label: s, value: s })));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

async function upsertSignupWithProfile(
  i: ButtonInteraction | StringSelectMenuInteraction,
  _guild: Guild,
  raidId: string,
  role: RoleKey,
  classKey?: string,
  specKey?: string,
  _updateMessage = false
) {
  await prisma.signup.upsert({
    where: { raidId_userId: { raidId, userId: i.user.id } },
    create: { raidId, userId: i.user.id, username: i.user.username, role },
    update: { role },
  });

  const emoji = (classKey && specKey) ? classSpecEmoji(classKey, specKey, role) : '✅';
  await i.reply({
    content: `${emoji} Saved: **${role}** for **${i.user.username}**${classKey && specKey ? ` (${classKey}/${specKey}).` : '.'}`,
    ephemeral: true,
  });
}

export async function refreshSignupMessage(guild: Guild, raidId: string) {
  const raid = await prisma.raid.findUnique({ where: { raidId } });
  if (!raid?.channelId || !raid?.messageId) return;

  const ch = await guild.channels.fetch(raid.channelId).catch(() => null);
  if (!ch || !(ch as any).isTextBased?.()) return;

  const startSec = Math.floor(raid.startAt.getTime() / 1000);
  const endDate  = raid.endAt ?? new Date(raid.startAt.getTime() + DEFAULT_DURATION_SEC * 1000);
  const endSec   = Math.floor(endDate.getTime() / 1000);

  // przekaż Guild — dostaniemy displayName'y
  const signups = await loadSignups(raidId, guild);

  const embed = buildSignupEmbed(
    {
      raidId,
      raidTitle: raid.raidTitle,
      difficulty: raid.difficulty,
      startAt: startSec,
      endAt: endSec,
      notes: raid.notes || undefined,
    },
    undefined,
    signups
  );
  embed.setColor(getDifficultyColor(raid.difficulty));
  // twarde czyszczenie obrazka – zero „fioletowego boxa”
  // @ts-ignore
  embed.setImage?.(null);

  const components = rowsForRaid(raidId);

  const msg = await (ch as any).messages?.fetch?.(raid.messageId).catch(() => null);
  if (msg) {
    await msg.edit({ embeds: [embed], components, attachments: [] }).catch(() => {});
  }
}
