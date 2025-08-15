import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, Guild, TextBasedChannel, ButtonInteraction,
} from 'discord.js';
import { prisma } from '../util/prisma.js';
import { clampEmbedTitle } from './mapping.js';

export type SignupRole = 'TANK'|'HEALER'|'MELEE'|'RANGED'|'MAYBE'|'ABSENT';

export const roleEmoji: Record<SignupRole, string> = {
  TANK: '🛡️', HEALER: '✨', MELEE: '⚔️', RANGED: '🏹', MAYBE: '❓', ABSENT: '⛔',
};

export function rowsForRaid(raidId: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`raid:join:${raidId}:TANK`).setLabel('Tank').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`raid:join:${raidId}:HEALER`).setLabel('Healer').setEmoji('✨').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`raid:join:${raidId}:MELEE`).setLabel('Melee').setEmoji('⚔️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`raid:join:${raidId}:RANGED`).setLabel('Ranged').setEmoji('🏹').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`raid:join:${raidId}:MAYBE`).setLabel('Maybe').setEmoji('❓').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`raid:join:${raidId}:ABSENT`).setLabel('Absent').setEmoji('⛔').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`raid:leave:${raidId}`).setLabel('Leave').setEmoji('🚪').setStyle(ButtonStyle.Danger),
    ),
  ];
}

export async function loadSignups(raidId: string) {
  return prisma.signup.findMany({
    where: { raidId },
    orderBy: { createdAt: 'asc' },
  });
}

function formatList(items: {userId: string, username: string}[], limit = 12) {
  const pick = items.slice(0, limit);
  const rest = Math.max(0, items.length - pick.length);
  const body = pick.map(u => `• <@${u.userId}>`).join('\n') || '—';
  return rest ? `${body}\n+${rest} more…` : body;
}

export function buildSignupEmbed(
  raid: { raidId: string; raidTitle: string; difficulty: string; startAt: number; endAt?: number; notes?: string; },
  caps?: { tank?: number; healer?: number; melee?: number; ranged?: number },
  signups: { userId: string; username: string; role: string }[] = [],
) {
  const groups: Record<SignupRole, {userId:string;username:string}[]> = {
    TANK: [], HEALER: [], MELEE: [], RANGED: [], MAYBE: [], ABSENT: [],
  };
  for (const s of signups) {
    const r = (s.role || '').toUpperCase() as SignupRole;
    if (groups[r]) groups[r].push({ userId: s.userId, username: s.username });
  }

  const embed = new EmbedBuilder()
    .setTitle(clampEmbedTitle(raid.raidTitle))
    .setDescription(raid.notes || '')
    .addFields(
      { name: 'Difficulty', value: raid.difficulty || '—', inline: true },
      { name: 'Start', value: `<t:${raid.startAt}:F>`, inline: true },
      { name: 'End', value: raid.endAt ? `<t:${raid.endAt}:F>` : '—', inline: true },
    )
    .addFields(
      { name: `${roleEmoji.TANK} Tank (${groups.TANK.length}${caps?.tank ? `/${caps.tank}` : ''})`, value: formatList(groups.TANK), inline: true },
      { name: `${roleEmoji.MELEE} Melee (${groups.MELEE.length}${caps?.melee ? `/${caps.melee}` : ''})`, value: formatList(groups.MELEE), inline: true },
      { name: `${roleEmoji.RANGED} Ranged (${groups.RANGED.length}${caps?.ranged ? `/${caps.ranged}` : ''})`, value: formatList(groups.RANGED), inline: true },
    )
    .addFields(
      { name: `${roleEmoji.HEALER} Healer (${groups.HEALER.length}${caps?.healer ? `/${caps.healer}` : ''})`, value: formatList(groups.HEALER), inline: true },
      { name: `${roleEmoji.MAYBE} Maybe (${groups.MAYBE.length})`, value: formatList(groups.MAYBE), inline: true },
      { name: `${roleEmoji.ABSENT} Absence (${groups.ABSENT.length})`, value: formatList(groups.ABSENT), inline: true },
    )
    .setFooter({ text: `RaidID: ${raid.raidId}` });

  return embed;
}

// Button handler
export async function handleSignupButton(i: ButtonInteraction, guild: Guild) {
  if (!i.customId.startsWith('raid:')) return false;

  const parts = i.customId.split(':'); // raid:join:RAIDID:ROLE  | raid:leave:RAIDID
  const action = parts[1];
  const raidId = parts[2];
  const role = (parts[3] || '').toUpperCase() as SignupRole;

  const member = await guild.members.fetch(i.user.id).catch(() => null);
  const username = member?.displayName || i.user.username;

  if (action === 'leave') {
    await prisma.signup.deleteMany({ where: { raidId, userId: i.user.id } });
    await i.reply({ content: 'You have left this raid.', ephemeral: true });
  } else if (action === 'join') {
    if (!['TANK','HEALER','MELEE','RANGED','MAYBE','ABSENT'].includes(role)) {
      await i.reply({ content: 'Unknown role.', ephemeral: true }); return true;
    }
    // upsert single signup per user
    await prisma.signup.upsert({
      where: { raidId_userId: { raidId, userId: i.user.id } },
      create: { raidId, userId: i.user.id, username, role, status: 'JOINED' },
      update: { username, role, status: 'JOINED' },
    });
    await i.reply({ content: `Signed as ${role}.`, ephemeral: true });
  } else {
    return false;
  }

  // Refresh message embed
  const raid = await prisma.raid.findUnique({ where: { raidId } });
  if (!raid) return true;

  const channel = await guild.channels.fetch(raid.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !raid.messageId) return true;

  const msg = await (channel as TextBasedChannel).messages.fetch(raid.messageId).catch(() => null);
  if (!msg) return true;

  const signups = await loadSignups(raidId);
  const caps = undefined as any; // if you store caps per raid, load them here
  const embed = buildSignupEmbed(
    {
      raidId,
      raidTitle: raid.raidTitle,
      difficulty: raid.difficulty,
      startAt: Math.floor(raid.startAt.getTime()/1000),
      endAt: raid.endAt ? Math.floor(raid.endAt.getTime()/1000) : undefined,
      notes: raid.notes || undefined,
    },
    caps,
    signups,
  );

  await msg.edit({ embeds: [embed] });
  return true;
}
