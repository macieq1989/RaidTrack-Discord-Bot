// src/services/raidSignup.ts
import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuInteraction, EmbedBuilder, Guild,
} from 'discord.js';
import { prisma } from '../util/prisma.js';
import { classSpecEmoji } from './profileIcons.js';
import type { PlayerEntry, SignupsGrouped } from './rosterImage.js';

import {
  getPlayerProfile, upsertPlayerProfile, listClasses, listSpecs, isValidClassSpec,
} from './playerProfile.js';

export type RoleKey = 'TANK'|'HEALER'|'MELEE'|'RANGED'|'MAYBE'|'ABSENT';

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
 * Load signups and enrich with:
 * - class/spec from PlayerProfile
 * - display name: profile alias -> guild displayName -> stored username
 *
 * Pass Guild object (preferred) to also resolve displayName in bulk.
 */
// --- replace the whole loadSignups with this version ---
export async function loadSignups(
  raidId: string,
  guildOrId?: Guild | string
): Promise<Array<{ userId: string; username: string; role: RoleKey; classKey?: string; specKey?: string }>> {
  const rows = await prisma.signup.findMany({
    where: { raidId },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return [];

  const guildId  = typeof guildOrId === 'string' ? guildOrId : guildOrId?.id;
  const guildObj = typeof guildOrId === 'object' ? (guildOrId as Guild) : undefined;

  // 1) Profiles (only fields that exist in schema)
  let pmap = new Map<string, { classKey?: string; specKey?: string }>();
  if (guildId) {
    const ids = Array.from(new Set(rows.map(r => r.userId)));
    const profiles = await prisma.playerProfile.findMany({
      where: { guildId, userId: { in: ids } },
      select: { userId: true, classKey: true, specKey: true }, // <-- only existing fields
    });
    pmap = new Map(profiles.map(p => [p.userId, { classKey: p.classKey ?? undefined, specKey: p.specKey ?? undefined }]));
  }

  // 2) Guild display names (bulk; no .values() anywhere)
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

  // 3) Compose output
  return rows.map(r => {
    const prof = pmap.get(r.userId);
    const name = display.get(r.userId) || r.username; // server nickname fallback
    return {
      userId: r.userId,
      username: name,
      role: normalizeRole(r.role),
      classKey: prof?.classKey,
      specKey: prof?.specKey,
    };
  });
}


/** Group into role buckets for the roster image (if used elsewhere) */
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

function fmtPlayers(arr: Array<{username: string; classKey?: string; specKey?: string; role: RoleKey}>): string {
  if (!arr.length) return '—';
  return arr.map(p => {
    const icon = (p.classKey && p.specKey) ? classSpecEmoji(p.classKey, p.specKey, p.role) : '•';
    return `${icon} ${p.username}`;
  }).join('\n');
}

export function buildSignupEmbed(
  meta: { raidId: string; raidTitle: string; difficulty: string; startAt: number; endAt: number; notes?: string },
  caps: { tank?: number; healer?: number; melee?: number; ranged?: number } | undefined,
  signups: Array<{ userId: string; username: string; role: RoleKey; classKey?: string; specKey?: string }>
) {
  const groups: Record<RoleKey, typeof signups> = {
    TANK: [], HEALER: [], MELEE: [], RANGED: [], MAYBE: [], ABSENT: [],
  };
  for (const s of signups) groups[s.role]?.push(s);

  const embed = new EmbedBuilder()
    .setTitle(meta.raidTitle)
    .setDescription(meta.notes || '')
    .addFields(
      { name: 'Difficulty', value: meta.difficulty || '—', inline: true },
      { name: 'Start', value: `<t:${meta.startAt}:F> (<t:${meta.startAt}:R>)`, inline: true },
      { name: 'End',   value: `<t:${meta.endAt}:t>`, inline: true },
    )
    .addFields(
      { name: `${ROLE_ICONS.TANK} Tank (${groups.TANK.length}${caps?.tank ? `/${caps.tank}` : ''})`, value: fmtPlayers(groups.TANK.map(u => ({...u, role: 'TANK'}))), inline: true },
      { name: `${ROLE_ICONS.HEALER} Healer (${groups.HEALER.length}${caps?.healer ? `/${caps.healer}` : ''})`, value: fmtPlayers(groups.HEALER.map(u => ({...u, role: 'HEALER'}))), inline: true },
      { name: `${ROLE_ICONS.MELEE} Melee (${groups.MELEE.length}${caps?.melee ? `/${caps.melee}` : ''})`, value: fmtPlayers(groups.MELEE.map(u => ({...u, role: 'MELEE'}))), inline: true },
    )
    .addFields(
      { name: `${ROLE_ICONS.RANGED} Ranged (${groups.RANGED.length}${caps?.ranged ? `/${caps.ranged}` : ''})`, value: fmtPlayers(groups.RANGED.map(u => ({...u, role: 'RANGED'}))), inline: true },
      { name: `${ROLE_ICONS.MAYBE} Maybe (${groups.MAYBE.length})`, value: fmtPlayers(groups.MAYBE.map(u => ({...u, role: 'MAYBE'}))), inline: true },
      { name: `${ROLE_ICONS.ABSENT} Absent (${groups.ABSENT.length})`, value: fmtPlayers(groups.ABSENT.map(u => ({...u, role: 'ABSENT'}))), inline: true },
    )
    .setFooter({ text: `RaidID: ${meta.raidId}` })
    .setColor(getDifficultyColor(meta.difficulty));

  return embed;
}

// ---------- BUTTONS / ROWS ----------

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
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`signup:changeRole:${raidId}`).setLabel('Change role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`profile:change:${raidId}`).setLabel('Change class/spec').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`signup:role:${raidId}:ABSENT`).setLabel('Leave').setStyle(ButtonStyle.Danger),
  );
}

export function rowsForRaid(raidId: string) {
  return [roleButtonsRow(raidId), changeRoleRow(raidId)];
}

// ---------- INTERACTIONS ----------

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

  const parts = i.customId.split(':'); // signup:role:RAIDID:ROLE  /  signup:changeRole:RAIDID
  const kind = parts[1];

  if (kind === 'changeRole') {
    await i.reply({ content: 'Pick your new role:', components: [roleButtonsRow(parts[2])], ephemeral: true });
    return true;
  }

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

  // IMPORTANT: pass Guild object to get guild display names
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
  // hard clear any old image so the "purple box" never comes back
  // @ts-ignore
  embed.setImage?.(null);

  const components = rowsForRaid(raidId);

  const msg = await (ch as any).messages?.fetch?.(raid.messageId).catch(() => null);
  if (msg) {
    await msg.edit({ embeds: [embed], components, attachments: [] }).catch(() => {});
  }
}
