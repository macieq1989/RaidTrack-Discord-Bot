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

// pomocnicze — ucinanie/pad do width
function safeCell(txt: string, width: number, align: "left" | "right" = "left"): string {
  if (txt.length > width) {
    return align === "left"
      ? txt.slice(0, width - 1) + "…"
      : "…" + txt.slice(txt.length - (width - 1));
  }
  return align === "left" ? txt.padEnd(width) : txt.padStart(width);
}

// kompaktowanie dużych liczb
function formatNum(n: number, width: number): string {
  if (!Number.isFinite(n)) return "?".padStart(width);
  let s: string;
  if (Math.abs(n) >= 1e9) s = (n / 1e9).toFixed(1) + "B";
  else if (Math.abs(n) >= 1e6) s = (n / 1e6).toFixed(1) + "M";
  else if (Math.abs(n) >= 1e3) s = (n / 1e3).toFixed(1) + "k";
  else s = n.toString();

  return safeCell(s, width, "right");
}

function buildCodeBlock(entries: EpgpEntry[]) {
  const nameW = 16;
  const numW = 8;

  const top =
    "┌" +
    "─".repeat(nameW) +
    "┬" +
    "─".repeat(numW) +
    "┬" +
    "─".repeat(numW) +
    "┬" +
    "─".repeat(numW) +
    "┐";

  const header =
    "│" +
    safeCell("Name", nameW) +
    "│" +
    safeCell("EP", numW, "right") +
    "│" +
    safeCell("GP", numW, "right") +
    "│" +
    safeCell("PR", numW, "right") +
    "│";

  const sep =
    "├" +
    "─".repeat(nameW) +
    "┼" +
    "─".repeat(numW) +
    "┼" +
    "─".repeat(numW) +
    "┼" +
    "─".repeat(numW) +
    "┤";

  const bottom =
    "└" +
    "─".repeat(nameW) +
    "┴" +
    "─".repeat(numW) +
    "┴" +
    "─".repeat(numW) +
    "┴" +
    "─".repeat(numW) +
    "┘";

  const sorted = [...entries].sort((a, b) => {
    const pra = a.ep / Math.max(1, a.gp);
    const prb = b.ep / Math.max(1, b.gp);
    if (prb !== pra) return prb - pra;
    if (b.ep !== a.ep) return b.ep - a.ep;
    return (a.username || "").localeCompare(b.username || "");
  });

  const toLine = (e: EpgpEntry, rank?: number) => {
    const pr = e.ep / Math.max(1, e.gp);
    let name = e.username ?? "";
    if (rank === 1) name = "¹ " + name;
    else if (rank === 2) name = "² " + name;
    else if (rank === 3) name = "³ " + name;
    return (
      "│" +
      safeCell(name, nameW) +
      "│" +
      formatNum(Math.round(e.ep), numW) +
      "│" +
      formatNum(Math.round(e.gp), numW) +
      "│" +
      safeCell(pr.toFixed(2), numW, "right") +
      "│"
    );
  };

  const budget = 4096 - 6;
  const lines: string[] = [top, header, sep];
  let used = top.length + header.length + sep.length + 3;
  let shown = 0;

  for (let i = 0; i < sorted.length; i++) {
    const row = toLine(sorted[i], i + 1);
    if (used + row.length + 1 > budget) break;
    lines.push(row);
    used += row.length + 1;
    shown++;
  }

  lines.push(bottom);

  const body = "```\n" + lines.join("\n") + "\n```";
  return { body, shown, total: sorted.length };
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
  const footerText = `${marker} • ${shown}/${total} shown${shown < total ? " (truncated)" : ""}`;

  const embed = new EmbedBuilder()
    .setTitle("EPGP")
    .setDescription(body)
    .setColor(0x9b59b6) // fioletowy epicki
    .setTimestamp(new Date())
    .setFooter({ text: footerText });

  const existing = await findExistingBoardMessage(channel, marker);
  if (existing) {
    await existing
      .edit({ content: null, embeds: [embed], components: [], attachments: [] })
      .catch(() => {});
    return existing.id as string;
  } else {
    const msg = await (channel as any).send({ embeds: [embed] }).catch(() => null);
    return msg?.id ?? null;
  }
}
