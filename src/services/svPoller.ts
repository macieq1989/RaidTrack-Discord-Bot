// src/services/svPoller.ts
import fs from 'fs/promises';
import path from 'path';
import type { Client, Guild } from 'discord.js';
import { publishOrUpdateRaid } from './publishRaid.js';

export type SVPollerStatus = {
  filePath: string;
  key: string;
  intervalMs: number;
  lastCheck?: string;
  lastChange?: string;
  lastError?: string;
  lastProcessedCount?: number;
};

const status: SVPollerStatus = {
  filePath: '',
  key: '',
  intervalMs: 60000,
};

function unescapeLuaQuotedString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function extractJson(content: string, key: string): any | null {
  // Matches: key = "...."  OR  key = [[ ... ]]
  const re = new RegExp(`${key}\\s*=\\s*(?:"((?:\\\\.|[^"\\\\])*)"|\\[\\[([\\s\\S]*?)\\]\\])`);
  const m = content.match(re);
  if (!m) return null;
  const raw = m[1] != null ? unescapeLuaQuotedString(m[1]) : (m[2] ?? '');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

export function startSavedVariablesPoller(
  client: Client,
  opts: { filePath: string; key: string; intervalMs?: number }
) {
  const filePath = path.resolve(opts.filePath);
  const key = opts.key;
  const intervalMs = Math.max(5_000, opts.intervalMs ?? 60_000);

  status.filePath = filePath;
  status.key = key;
  status.intervalMs = intervalMs;

  let lastSig = '';

  async function tick() {
    status.lastCheck = new Date().toISOString();

    let st;
    try {
      st = await fs.stat(filePath);
    } catch (e: any) {
      status.lastError = `stat failed: ${e.message}`;
      return;
    }

    const sig = `${st.mtimeMs}:${st.size}`;
    if (sig === lastSig) return; // no change
    lastSig = sig;
    status.lastChange = new Date().toISOString();

    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (e: any) {
      status.lastError = `read failed: ${e.message}`;
      return;
    }

    let payload: any;
    try {
      payload = extractJson(text, key);
      if (!payload) {
        status.lastError = `key "${key}" not found or empty`;
        return;
      }
    } catch (e: any) {
      status.lastError = `parse failed: ${e.message}`;
      return;
    }

    try {
      let count = 0;
      if (Array.isArray(payload)) {
        for (const item of payload) {
          if (!item?.guildId || !item?.raid) continue;
          const guild: Guild = await client.guilds.fetch(String(item.guildId));
          await publishOrUpdateRaid(guild, item.raid as any);
          count++;
        }
      } else if (payload?.guildId && payload?.raid) {
        const guild: Guild = await client.guilds.fetch(String(payload.guildId));
        await publishOrUpdateRaid(guild, payload.raid as any);
        count = 1;
      } else {
        throw new Error('Unsupported data shape; expected {guildId, raid} or an array.');
      }

      status.lastProcessedCount = count;
      status.lastError = undefined;
      console.log(`[SV] processed ${count} entr${count === 1 ? 'y' : 'ies'} from ${filePath}`);
    } catch (e: any) {
      status.lastError = `publish failed: ${e.message}`;
      console.error('[SV] publish error:', e);
    }
  }

  const timer = setInterval(tick, intervalMs);
  // initial run
  tick().catch(() => {});
  return {
    stop() { clearInterval(timer); },
  };
}

export function getSVPollerStatus(): SVPollerStatus {
  return { ...status };
}
