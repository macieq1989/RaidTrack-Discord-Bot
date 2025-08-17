import { EmbedBuilder, TextChannel } from "discord.js";
import type { Client } from "discord.js";
import { cfg } from "../config.js";

export type LootEntry = {
  id?: number;
  player?: string;
  item?: string;      // WoW link/string e.g. |cffa335ee|Hitem:194308...|h[Manic Grieftorch]|h|r  lub |cnIQ4:|Hitem:...
  boss?: string;
  gp?: number;
  time?: string;      // e.g. 13:25:57
  timestamp?: number; // unix seconds
};

/** Extract {id, name, qualityColor} from WoW itemlink or itemstring. */
function parseItemMeta(item: string | undefined) {
  const res: { id?: string; name?: string; color?: number } = {};
  if (!item) return res;

  // 1) name in [...]:  |h[Item Name]|h
  const nameMatch = item.match(/\|h\[([^\]]+)\]\|h/);
  if (nameMatch) res.name = nameMatch[1];

  // 2) itemId from Hitem:xxxx
  const idMatch = item.match(/Hitem:(\d+)/i);
  if (idMatch) res.id = idMatch[1];

  // 3) color: classic style |cffAABBCC...  or DF style |cnIQ4:
  // Map qualities: 5=legendary, 4=epic, 3=rare, 2=uncommon, else=white/gray
  const classicHex = item.match(/\|cff([0-9a-fA-F]{6})/);
  if (classicHex) {
    res.color = parseInt(classicHex[1], 16);
  } else {
    const q = item.match(/\|cn?IQ(\d)\:/i); // IQ4 -> epic, IQ5 -> legendary
    if (q) {
      const qn = Number(q[1]);
      const map: Record<number, number> = {
        6: 0x00ccff, // artifact-ish (fallback)
        5: 0xff8000, // legendary
        4: 0xa335ee, // epic
        3: 0x0070dd, // rare
        2: 0x1eff00, // uncommon
        1: 0xffffff, // common
        0: 0x9d9d9d, // poor
      };
      res.color = map[qn] ?? 0xa335ee;
    }
  }

  return res;
}

/** Build wowhead link from itemId (no region suffix to keep it simple). */
function wowheadUrl(itemId?: string) {
  return itemId ? `https://www.wowhead.com/item=${itemId}` : undefined;
}

/** Format pojedynczy wpis loot jako field (lewa/prawa kolumna) */
function formatLootField(e: LootEntry) {
  const meta = parseItemMeta(e.item);
  const name = meta.name ?? "Unknown Item";
  const link = wowheadUrl(meta.id);
  const player = e.player ?? "Unknown";
  const boss = e.boss && e.boss !== "Auction" ? e.boss : "Auction";
  const gp = Number.isFinite(e.gp as number) ? e.gp : undefined;
  const ts = Number(e.timestamp ?? 0);

  const date = ts ? new Date(ts * 1000).toLocaleString("pl-PL") : (e.time ?? "");

  // left = kto + item
  const left = `**${player}**\n${link ? `[${name}](${link})` : name}`;
  // right = boss + gp + czas
  const rightParts: string[] = [];
  if (boss) rightParts.push(`**${boss}**`);
  if (gp != null) rightParts.push(`GP: ${gp}`);
  if (date) rightParts.push(date);

  return { left, right: rightParts.join("\n") };
}

export async function publishLootBatch(client: Client, entries: LootEntry[]) {
  if (!entries?.length) return;

  const channel = await client.channels.fetch(cfg.lootChannel);
  if (!channel || !(channel instanceof TextChannel)) {
    console.error("[loot] CH_LOOT is not a valid text channel");
    return;
  }

  const list = entries
    .filter(e => e && (e.item || e.player))
    .sort((a, b) => (Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0)));

  if (!list.length) return;

  const bestColor =
    list
      .map(e => parseItemMeta(e.item).color)
      .filter((c): c is number => typeof c === "number")
      .sort((a, b) => b - a)[0] ?? 0xa335ee;

  // budujemy pola (fieldy)
  const fields = list.flatMap(e => {
    const f = formatLootField(e);
    return [
      { name: f.left, value: f.right, inline: true },
    ];
  });

  const firstTs = list[0]?.timestamp;
  const lastTs = list[list.length - 1]?.timestamp;
  const timeRange =
    firstTs && lastTs && firstTs !== lastTs
      ? `${new Date(firstTs * 1000).toLocaleString("pl-PL")} – ${new Date(lastTs * 1000).toLocaleString("pl-PL")}`
      : (firstTs ? new Date(firstTs * 1000).toLocaleString("pl-PL") : "");

  const embed = new EmbedBuilder()
    .setTitle("Loot updates")
    .addFields(fields)
    .setColor(bestColor)
    .setFooter({ text: timeRange || "Loot feed" });

  await channel.send({ embeds: [embed] });
}
