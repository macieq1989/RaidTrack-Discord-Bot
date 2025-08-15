import {
  EmbedBuilder,
  Guild,
  TextBasedChannel,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
} from 'discord.js';
import { cfg } from '../config.js';
import { clampEmbedTitle, clampEventTitle, RaidPayload } from './mapping.js';
import { prisma } from '../util/prisma';

// Resolve channel based on difficulty
function resolveChannelId(diff: string): string {
  const key = (diff || '').toUpperCase() as keyof typeof cfg.channelRouting;
  // @ts-ignore – cfg.channelRouting is from env; runtime-validated elsewhere
  return cfg.channelRouting[key] || cfg.fallbackChannel;
}

export async function publishOrUpdateRaid(guild: Guild, payload: RaidPayload) {
  const chId = resolveChannelId(payload.difficulty);
  const channel = (await guild.channels.fetch(chId).catch(() => null)) as TextBasedChannel | null;
  if (!channel) throw new Error(`No access to channel for difficulty ${payload.difficulty}`);

  // Upsert raid row
  const raid = await prisma.raid.upsert({
    where: { raidId: payload.raidId },
    create: {
      raidId: payload.raidId,
      raidTitle: payload.raidTitle,
      difficulty: payload.difficulty,
      startAt: new Date(payload.startAt * 1000),
      notes: payload.notes ?? '',
      channelId: chId,
    },
    update: {
      raidTitle: payload.raidTitle,
      difficulty: payload.difficulty,
      startAt: new Date(payload.startAt * 1000),
      notes: payload.notes ?? '',
      channelId: chId,
    },
  });

  const embed = new EmbedBuilder()
    .setTitle(clampEmbedTitle(payload.raidTitle)) // EXACT title from addon
    .setDescription(payload.notes || '')
    .addFields(
      { name: 'Difficulty', value: payload.difficulty || '—', inline: true },
      { name: 'Start', value: `<t:${payload.startAt}:F> (<t:${payload.startAt}:R>)`, inline: true },
    )
    .setFooter({ text: `RaidID: ${payload.raidId}` });

  // --- create or edit message (use null, not undefined) ---
  let messageId: string | null = raid.messageId ?? null;

  if (messageId) {
    const msg = await (channel as any).messages?.fetch?.(messageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components: [] });
    } else {
      messageId = null; // lost message → recreate
    }
  }
  if (!messageId) {
    const sent = await (channel as any).send({ embeds: [embed] });
    messageId = sent.id;
  }

  // --- scheduled event (optional but nice) ---
  let eventId: string | null = raid.scheduledEventId ?? null;
  const eventName = clampEventTitle(payload.raidTitle);
  const start = new Date(payload.startAt * 1000);

  if (eventId) {
    const ev = await guild.scheduledEvents.fetch(eventId).catch(() => null);
    if (ev) {
      await ev.edit({
        name: eventName,
        scheduledStartTime: start,
        description: payload.notes || '',
      });
    } else {
      eventId = null;
    }
  }
  if (!eventId) {
    const ev = await guild.scheduledEvents.create({
      name: eventName,
      scheduledStartTime: start,
      entityType: GuildScheduledEventEntityType.External,
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityMetadata: { location: 'Raid' },
      description: payload.notes || '',
    });
    eventId = ev.id;
  }

  // Persist resolved IDs (string | null)
  await prisma.raid.update({
    where: { raidId: payload.raidId },
    data: { messageId, scheduledEventId: eventId },
  });

  return { channelId: chId, messageId, eventId };
}
