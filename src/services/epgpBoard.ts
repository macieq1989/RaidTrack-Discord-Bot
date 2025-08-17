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

function buildCodeBlock(entries: EpgpEntry[]) {
  const nameW = findWidthName(entries, 10, 22);
  const header =
    'Name'.padEnd(nameW) +
    '  ' + 'EP'.padStart(6) +
    '  ' + 'GP'.padStart(6) +
    '  ' + 'PR'.padStart(6);

  const toLine = (e: EpgpEntry) => {
    const pr = e.ep / Math.max(1, e.gp);
    const name = (e.username ?? '').slice(0, nameW);
    return (
      name.padEnd(nameW) +
      '  ' + String(Math.round(e.ep)).padStart(6) +
      '  ' + String(Math.round(e.gp)).padStart(6) +
      '  ' + pr.toFixed(2).padStart(6)
    );
  };

  // sort: PR desc, EP desc, name asc
  const sorted = [...entries].sort((a, b) => {
    const pra = a.ep / Math.max(1, a.gp);
    const prb = b.ep / Math.max(1, b.gp);
    if (prb !== pra) return prb - pra;
    if (b.ep !== a.ep) return b.ep - a.ep;
    return (a.username || '').localeCompare(b.username || '');
  });

  // buduj treść w limicie 4096 (odejmij 6 znaków na ```\n...\n```)
  const budget = 4096 - 6;
  const lines: string[] = [header];
  let used = header.length + 1;
  let shown = 0;

  for (const e of sorted) {
    const row = toLine(e);
    if (used + row.length + 1 > budget) break;
    lines.push(row);
    used += row.length + 1;
    shown++;
  }

  const body = '```\n' + lines.join('\n') + '\n```';
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

  const { body, shown, total } = buildCodeBlock(entries);

  const marker = opts?.boardId ? `${EPGP_MARKER}:${opts.boardId}` : EPGP_MARKER;
  const footerText = `${marker} • ${shown}/${total} shown${shown < total ? ' (truncated)' : ''}`;

  const embed = new EmbedBuilder()
    .setTitle('EPGP')
    .setDescription(body)
    .setColor(0x5865f2)
    .setTimestamp(new Date())
    .setFooter({ text: footerText });

  // Edytujemy tylko jeśli znajdziemy wiadomość z **tym samym markerem** (czyli tym samym boardId).
  // Gdy boardId jest nowe → nie ma dopasowania → tworzymy nową wiadomość.
  const existing = await findExistingBoardMessage(channel, marker);
  if (existing) {
    await existing.edit({ content: null, embeds: [embed], components: [], attachments: [] }).catch(() => {});
    return existing.id as string;
  } else {
    const msg = await (channel as any).send({ embeds: [embed] }).catch(() => null);
    return msg?.id ?? null;
  }
}
