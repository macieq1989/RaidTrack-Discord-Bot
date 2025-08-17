// src/services/epgpBoard.ts
import {
  Guild,
  TextBasedChannel,
  EmbedBuilder,
} from "discord.js";
import { cfg } from "../config.js";

export type EpgpEntry = {
  userId?: string; // optional
  username: string;
  ep: number;
  gp: number;
};

const EPGP_MARKER = "EPGP_BOARD_V1";

function resolveFallbackChannelId(): string {
  return cfg.fallbackChannel;
}

function findWidthName(entries: EpgpEntry[], min = 8, max = 22) {
  let w = min;
  for (const e of entries) w = Math.max(w, (e.username ?? "").length + 2); // +2 na emoji 🥇
  return Math.min(w, max);
}

function buildCodeBlock(entries: EpgpEntry[]) {
  const nameW = findWidthName(entries, 10, 22);
  const colW = { EP: 6, GP: 6, PR: 7 };

  // ✅ pad ma właściwy typ tablicy unii
  const makeRow = (cols: string[], widths: number[], pad: ("L" | "R")[] = []) => {
    return (
      "│ " +
      cols
        .map((c, i) =>
          (pad[i] === "L" ? c.padStart(widths[i]) : c.padEnd(widths[i]))
        )
        .join(" │ ") +
      " │"
    );
  };

  const header = makeRow(
    ["Name", "EP", "GP", "PR"],
    [nameW, colW.EP, colW.GP, colW.PR],
    ["R", "L", "L", "L"]
  );

  const sep =
    "├" +
    "─".repeat(nameW + 2) +
    "┼" +
    "─".repeat(colW.EP + 2) +
    "┼" +
    "─".repeat(colW.GP + 2) +
    "┼" +
    "─".repeat(colW.PR + 2) +
    "┤";

  const top =
    "┌" +
    "─".repeat(nameW + 2) +
    "┬" +
    "─".repeat(colW.EP + 2) +
    "┬" +
    "─".repeat(colW.GP + 2) +
    "┬" +
    "─".repeat(colW.PR + 2) +
    "┐";

  const bottom =
    "└" +
    "─".repeat(nameW + 2) +
    "┴" +
    "─".repeat(colW.EP + 2) +
    "┴" +
    "─".repeat(colW.GP + 2) +
    "┴" +
    "─".repeat(colW.PR + 2) +
    "┘";

  // sort: PR desc, EP desc, name asc
  const sorted = [...entries].sort((a, b) => {
    const pra = a.ep / Math.max(1, a.gp);
    const prb = b.ep / Math.max(1, b.gp);
    if (prb !== pra) return prb - pra;
    if (b.ep !== a.ep) return b.ep - a.ep;
    return (a.username || "").localeCompare(b.username || "");
  });

  const medals = ["🥇", "🥈", "🥉"];

  const rows = sorted.map((e, i) => {
    const pr = e.ep / Math.max(1, e.gp);
    const medal = i < 3 ? medals[i] + " " : "";
    const name = (medal + (e.username ?? "")).slice(0, nameW);
    return makeRow(
      [name, String(Math.round(e.ep)), String(Math.round(e.gp)), pr.toFixed(2)],
      [nameW, colW.EP, colW.GP, colW.PR],
      ["R", "L", "L", "L"]
    );
  });

  const lines = [top, header, sep, ...rows, bottom];
  const body = "```\n" + lines.join("\n") + "\n```";

  return { body, shown: sorted.length, total: sorted.length };
}

async function findExistingBoardMessage(channel: TextBasedChannel, marker: string) {
  const me = (channel.client as any).user?.id;
  if (!me) return null;

  const msgs = await (channel as any).messages?.fetch({ limit: 50 }).catch(() => null);
  if (!msgs) return null;

  for (const [, m] of msgs) {
    if (m.author?.id !== me) continue;
    const emb = m.embeds?.[0];
    const footer = emb?.footer?.text || "";
    if (footer.includes(marker)) return m;
  }
  return null;
}

export async function publishEPGPBoard(
  guild: Guild,
  entries: EpgpEntry[],
  opts?: { boardId?: string }
) {
  const chId = resolveFallbackChannelId();
  const fetched = await guild.channels.fetch(chId).catch(() => null);
  const isText = (fetched as any)?.isTextBased?.() === true;
  if (!fetched || !isText) throw new Error(`No access to fallback text channel ${chId}`);
  const channel = fetched as TextBasedChannel;

  const { body, shown, total } = buildCodeBlock(entries);

  const marker = opts?.boardId ? `${EPGP_MARKER}:${opts.boardId}` : EPGP_MARKER;
  const footerText = `${marker} • ${shown}/${total} shown`;

  const embed = new EmbedBuilder()
    .setTitle("EPGP")
    .setDescription(body)
    .setColor(0x9b59b6) // epic purple
    .setTimestamp(new Date())
    .setFooter({ text: footerText });

  const existing = await findExistingBoardMessage(channel, marker);
  if (existing) {
    await existing.edit({ content: null, embeds: [embed], components: [], attachments: [] }).catch(() => {});
    return existing.id as string;
  } else {
    const msg = await (channel as any).send({ embeds: [embed] }).catch(() => null);
    return msg?.id ?? null;
  }
}
