import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { z } from 'zod';
import { publishOrUpdateRaid } from '../services/publishRaid.js';

const RaidSchema = z.object({
  raidId: z.string().min(1),
  raidTitle: z.string().min(1),
  difficulty: z.string().min(1),
  startAt: z.number().int().positive(),
  notes: z.string().optional(),
  caps: z.object({
    tank: z.number().int().nonnegative().optional(),
    healer: z.number().int().nonnegative().optional(),
    melee: z.number().int().nonnegative().optional(),
    ranged: z.number().int().nonnegative().optional()
  }).optional()
});

export const data = new SlashCommandBuilder()
  .setName('rt')
  .setDescription('RaidTrack utilities')
  .addSubcommand(sub =>
    sub.setName('import')
      .setDescription('Import raid JSON exported from RaidTrack addon')
      .addStringOption(o => o.setName('json').setDescription('Raw JSON payload').setRequired(true))
  )
  .setDefaultMemberPermissions(0n); // officers only → ustaw rolami w runtime

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return interaction.reply({ content: 'Guild only.', ephemeral: true });

  const json = interaction.options.getString('json', true);
  let payload;
  try {
    payload = RaidSchema.parse(JSON.parse(json));
  } catch (e: any) {
    return interaction.reply({ content: 'Invalid JSON: ' + e.message, ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const res = await publishOrUpdateRaid(interaction.guild, payload);
  return interaction.editReply(`Raid imported → message ${res.messageId} in <#${res.channelId}>`);
}
