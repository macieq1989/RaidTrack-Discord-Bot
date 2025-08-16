// src/services/raidSignup.ts
import {
  ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuInteraction, EmbedBuilder, Guild,
} from 'discord.js';
import { prisma } from '../util/prisma.js';
import { classSpecEmoji } from './profileIcons.js';
import { queueRosterRefresh } from './rosterRefresh.js';
import type { PlayerEntry, SignupsGrouped } from './rosterImage.js';

import {
  getPlayerProfile, upsertPlayerProfile, listClasses, listSpecs, isValidClassSpec,
} from './playerProfile.js';

export type RoleKey = 'TANK'|'HEALER'|'MELEE'|'RANGED'|'MAYBE'|'ABSENT';

// ---------- Public API used by publishRaid.ts ----------

const DEFAULT_DURATION_SEC = Number(process.env.RAID_EVENT_DEFAULT_DURATION_SEC ?? 3 * 3600);

export function normalizeRole(role: string): RoleKey {
  const u = (role ?? '').toUpperCase();
  if (u === 'TANK' || u === 'HEALER' || u === 'MELEE' || u === 'RANGED' || u === 'MAYBE' || u === 'ABSENT') {
    return u as RoleKey;
  }
  return 'MAYBE';
}

// 1) wczytanie zapisów do embeda
export async function loadSignups(raidId: string): Promise<Array<{ userId: string; username: string; role: RoleKey }>> {
  const rows = await prisma.signup.findMany({
    where: { raidId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(r => ({
    userId: r.userId,
    username: r.username,
    role: normalizeRole(r.role),
  }));
}

/**
 * Zamiana płaskiej listy na strukturę dla rendererka obrazka:
 * { tank: PlayerEntry[], healer: PlayerEntry[], melee: PlayerEntry[], ranged: PlayerEntry[] }
 * (klasa/spec są opcjonalne – jeśli masz w PlayerProfile, można je kiedyś dociągać tutaj).
 */
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
      default: /* MAYBE/ABSENT pomijamy w obrazku */ break;
    }
  }
  return grouped;
}

// 2) budowa embeda (nagłówek + listy roli)
export function buildSignupEmbed(
  meta: { raidId: string; raidTitle: string; difficulty: string; startAt: number; endAt: number; notes?: string },
  caps: { tank?: number; healer?: number; melee?: number; ranged?: number } | undefined,
  signups: Array<{ userId: string; username: string; role: RoleKey }>
) {
  const groups: Record<RoleKey, string[]> = {
    TANK: [], HEALER: [], MELEE: [], RANGED: [], MAYBE: [], ABSENT: [],
  };
  for (const s of signups) {
    groups[s.role]?.push(s.username);
  }

  const fmt = (arr: string[]) => arr.length ? arr.map(n => `• ${n}`).join('\n') : '—';

  const embed = new EmbedBuilder()
    .setTitle(meta.raidTitle)
    .setDescription(meta.notes || '')
    .addFields(
      { name: 'Difficulty', value: meta.difficulty || '—', inline: true },
      { name: 'Start', value: `<t:${meta.startAt}:F> (<t:${meta.startAt}:R>)`, inline: true },
      { name: 'End',   value: `<t:${meta.endAt}:t>`, inline: true },
    )
    .addFields(
      { name: `🛡️ Tank (${groups.TANK.length}${caps?.tank ? `/${caps.tank}` : ''})`, value: fmt(groups.TANK), inline: true },
      { name: `✚ Healer (${groups.HEALER.length}${caps?.healer ? `/${caps.healer}` : ''})`, value: fmt(groups.HEALER), inline: true },
      { name: `⚔️ Melee (${groups.MELEE.length}${caps?.melee ? `/${caps.melee}` : ''})`, value: fmt(groups.MELEE), inline: true },
    )
    .addFields(
      { name: `🏹 Ranged (${groups.RANGED.length}${caps?.ranged ? `/${caps.ranged}` : ''})`, value: fmt(groups.RANGED), inline: true },
      { name: `❔ Maybe (${groups.MAYBE.length})`, value: fmt(groups.MAYBE), inline: true },
      { name: `🚫 Absent (${groups.ABSENT.length})`, value: fmt(groups.ABSENT), inline: true },
    )
    .setFooter({ text: `RaidID: ${meta.raidId}` });

  return embed;
}

// 3) przyciski/wiersze do wiadomości raidu
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
    new ButtonBuilder().setCustomId(`signup:role:${raidId}:ABSENT`).setLabel('Leave').setStyle(ButtonStyle.Danger),
  );
}

export function rowsForRaid(raidId: string) {
  return [roleButtonsRow(raidId), changeRoleRow(raidId)];
}

// ---------- Interaction handlers (button + select) ----------

export async function handleSignupButton(i: ButtonInteraction, guild: Guild) {
  if (!i.customId.startsWith('signup:')) return false;

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

    // profile check
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
    // ⬇️ używamy Guild z argumentu, nie i.guild
    await queueRosterRefresh(guild, raidId);

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

// ---------- Private helpers ----------

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
  guild: Guild,
  raidId: string,
  role: RoleKey,
  classKey: string,
  specKey: string,
  updateMessage = false
) {
  await prisma.signup.upsert({
    where: { raidId_userId: { raidId, userId: i.user.id } },
    create: { raidId, userId: i.user.id, username: i.user.username, role },
    update: { role },
  });

  const emoji = classSpecEmoji(classKey, specKey, role);
  await i.reply({
    content: `${emoji} Saved: **${role}** for **${i.user.username}** (${classKey}/${specKey}).`,
    ephemeral: true,
  });
}

export async function refreshSignupMessage(guild: Guild, raidId: string) {
  const raid = await prisma.raid.findUnique({ where: { raidId } });
  if (!raid?.channelId || !raid?.messageId) return;

  const ch = await guild.channels.fetch(raid.channelId).catch(() => null);
  if (!ch || !(ch as any).isTextBased?.()) return;
  const channel = ch as any;

  const startSec = Math.floor(raid.startAt.getTime() / 1000);
  const endDate  = raid.endAt ?? new Date(raid.startAt.getTime() + DEFAULT_DURATION_SEC * 1000);
  const endSec   = Math.floor(endDate.getTime() / 1000);

  const signups = await loadSignups(raidId);
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
  const components = rowsForRaid(raidId);

  const msg = await (ch as any).messages?.fetch?.(raid.messageId).catch(() => null);
  if (msg) {
    await msg.edit({ embeds: [embed], components }).catch(() => {});
  }
}
