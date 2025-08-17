import { EmbedBuilder, TextChannel } from "discord.js";
import { cfg } from "../config.js";
import type { Client } from "discord.js";

// loot entry z SV
export type LootEntry = {
  id: number;
  player: string;
  item: string;
  boss: string;
  gp: number;
  time: string;
  timestamp: number;
};

// helper do generowania linku wowhead z itemStringa
function getWowheadLink(item: string): string {
  const match = item.match(/Hitem:(\d+)/);
  if (!match) return "";
  const itemId = match[1];
  return `https://www.wowhead.com/item=${itemId}`;
}

export async function publishLoot(client: Client, loot: LootEntry) {
  try {
    const channel = await client.channels.fetch(cfg.lootChannel);
    if (!channel || !(channel instanceof TextChannel)) {
      console.error("CH_LOOT is not a valid text channel");
      return;
    }

    const wowhead = getWowheadLink(loot.item);

    const embed = new EmbedBuilder()
      .setTitle(`${loot.player} received loot!`)
      .addFields(
        { name: "Item", value: `[${loot.item}](${wowhead})`, inline: false },
        { name: "Boss", value: loot.boss, inline: true },
        { name: "GP Cost", value: loot.gp.toString(), inline: true },
      )
      .setFooter({ text: `Time: ${loot.time}` })
      .setColor(0xdaa520);

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Failed to publish loot", err);
  }
}
