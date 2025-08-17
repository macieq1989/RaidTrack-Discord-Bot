// src/services/epgpBoard.ts
import {
  Guild,
  TextBasedChannel,
  EmbedBuilder,
} from 'discord.js';
import { cfg } from '../config.js';

export type EpgpEntry = {
  userId?: string;  // optional
  username: string;
  ep: number;
  gp: number;
};

const EPGP_MARKER = 'EPGP_BOARD_V1';

function resolveFallbackChannelId(): string {
  return cfg.fallbackChannel;
}

function findWidthName(entries: EpgpEntry[], min = 10, max = 22) {
  let w = min;
  for (const e of entries) w = Math.max(w, (e.username ?? '').length);
  return Math.min(w, max);
}

function fmtInt(n: number) {
  return Math.round(n).toString();
}

function prOf(e: EpgpEntry) {
  return e.ep / Math.max(1, e.gp);
}

function medal(idx: number) {
  return idx === 0 ? '🥇 ' : idx === 1 ? '🥈 ' : idx === 2 ? '🥉 ' : '';
}

function buildCodeBlock(entries: EpgpEntry[]) {
  const nameW = findWidthName(entries, 10, 22);

  // sort: PR desc, EP desc, name asc
  const sorted = [...entries].sort((a, b) => {
    const pra = prOf(a);
    const prb = prOf(b);
    if (prb !== pra) return prb - pra;
    if (b.ep !== a.ep) return b.ep - a.ep;
    return (a.username || '').localeCompare(b.username || '');
  });

  // header + separators (monospace-friendly)
  const hdrName = 'Name'.padEnd(nameW);
  const hdr = `${hdrName}  ${'EP'.padStart(6)}  ${'GP'.padStart(6)}  ${'PR'.padStart(6)}`;
  const line = '─'.repeat(hdr.length);
  const topLine = `┌${line}┐`;
  const botLine = `└${line}┘`;

  const toRow = (e: EpgpEntry, i: number) => {
    const pr = prOf(e);
    const nm = (e.username ?? '').slice(0, nameW);
    const nameCol = `${medal(i)}${nm}`.slice(0, nameW + 2).padEnd(nameW + 2); // +2 bo medal może dodać znak
    return (
      `${nameCol}${fmtInt(e.ep).padStart(6)}  ${fmtInt(e.gp).padStart(6)}  ${pr.toFixed(2).padStart(6)}`
    );
  };

  // limit rows (ENV override)
  const MAX_ROWS = Math.max(1, Number(process.env.EPGP_MAX_ROWS ?? 20));
  const shown = Math.min(sorted.length, MAX_ROWS);

  const lines: string[] = [];
  lines.push(topLine);
  lines.push(hdr);
  lines.push('│' + ' '.repeat(hdr.length) + '│'); // small spacer line (visual padding)
  for (let i = 0; i < shown; i++) {
    const row = toRow(sorted[i], i);
    lines.push(row);
  }
  lines.push(botLine);

  // code block + note about truncation (outside the block)
  const bodyBlock = '```\n' + lines.join('\n') + '\n```';
  const truncated = shown < sorted.length;

  return {
    bodyBlock,
    shown,
    total: sorted.length,
    truncated,
  };
}

async function findExistingBoardMessage(channel: TextBasedChannel, marker: string) {
  const me = (channel.client as any).user?.id;
  if (!me) return null;

  const msgs = await (channel as any).messages?.fetch({ limit: 50 }).catch(() => null);
  if (!msgs) return null;

  for (const [, m] of msgs) {
    if (m.author?.id !== me) continue;
    const emb = m.embeds?.[0];
    const footer = emb?.footer?.text || '';
    if (footer.includes(marker)) return m;
  }
  return null;
}

/**
 * Publish or update the EPGP board in the fallback channel.
 * If boardId differs (new "revision"), a NEW message is posted instead of editing the old one.
 */
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

  const { bodyBlock, shown, total, truncated } = buildCodeBlock(entries);

  const marker = opts?.boardId ? `${EPGP_MARKER}:${opts.boardId}` : EPGP_MARKER;

  // Friendly footer text
  const footerText = `${marker} • ${shown}/${total} shown${truncated ? ' (truncated)' : ''}`;

  // Human line with relative time (Discord renders it nicely)
  const nowSec = Math.floor(Date.now() / 1000);
  const humanWhen = `Updated <t:${nowSec}:R>`;

  const embed = new EmbedBuilder()
    .setTitle('EPGP')
    .setDescription(`${bodyBlock}\n_${humanWhen}_`)
    .setColor(0x2ecc71) // subtle green to suggest "synced/ok"
    .setTimestamp(new Date())
    .setFooter({ text: footerText });

  // Edit only if we find a message with the SAME marker (same boardId).
  const existing = await findExistingBoardMessage(channel, marker);
  if (existing) {
    await existing.edit({ content: null, embeds: [embed], components: [], attachments: [] }).catch(() => {});
    return existing.id as string;
  } else {
    const msg = await (channel as any).send({ embeds: [embed] }).catch(() => null);
    return msg?.id ?? null;
  }
}
