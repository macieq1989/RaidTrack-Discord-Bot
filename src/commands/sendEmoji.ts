// src/commands/sendEmoji.ts
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  GuildTextBasedChannel,
  PermissionsBitField,
} from 'discord.js';
import { cfg } from '../config.js';

function toEmojiToken(name: string, raw?: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^<a?:[^:>]+:\d+>$/.test(v)) return v;               // already a token
  const m = /^a:(\d+)$/.exec(v); if (m) return `<a:${name}:${m[1]}>`; // animated
  if (/^\d+$/.test(v)) return `<:${name}:${v}>`;            // static by ID
  return null;
}

function buildToken(input: string): string | null {
  const txt = input.trim();

  // 1) full token pasted
  if (/^<a?:[^:>]+:\d+>$/.test(txt)) return txt;

  // 2) numeric ID or a:ID
  if (/^\d+$/.test(txt)) return `<:_:${txt}>`;
  if (/^a:\d+$/.test(txt)) return `<a:_:${txt.slice(2)}>`; // animated ID

  // 3) key from cfg.customEmoji (e.g. "paladin_retribution")
  const key = txt.toLowerCase().replace(/\s+|-/g, '_');
  const raw = cfg.customEmoji?.[key];
  return toEmojiToken(key, raw);
}

export const data = new SlashCommandBuilder()
  .setName('send-emoji')
  .setDescription('Send an external emoji to this channel')
  .addStringOption(o =>
    o.setName('input')
      .setDescription('Key from map, numeric ID (a:ID for animated), or full token <...>')
      .setRequired(true),
  );

export async function execute(i: ChatInputCommandInteraction) {
  const input = i.options.getString('input', true);

  if (!i.inGuild()) {
    await i.reply({ content: 'Guild-only command.', ephemeral: true });
    return;
  }

  // Fetch the channel as a *guild text-based* channel (has send + permissionsFor)
  const fetched = await i.guild!.channels.fetch(i.channelId).catch(() => null);
  if (!fetched || !fetched.isTextBased()) {
    await i.reply({ content: 'This channel is not text-based.', ephemeral: true });
    return;
  }
  const ch = fetched as GuildTextBasedChannel;

  // Build token
  const token = buildToken(input);
  if (!token) {
    await i.reply({ content: `❌ Cannot build emoji token from: \`${input}\``, ephemeral: true });
    return;
  }

  // Check perms in this channel
  const me = i.guild!.members.me!;
  const perms = ch.permissionsFor(me);
  const canExternal = perms?.has(PermissionsBitField.Flags.UseExternalEmojis) ?? false;

  await ch.send({ content: token });
  await i.reply({
    content: `✅ Sent: ${token}${canExternal ? '' : '\n⚠️ This channel may block external emojis (Use External Emojis).'} `,
    ephemeral: true,
  });
}
