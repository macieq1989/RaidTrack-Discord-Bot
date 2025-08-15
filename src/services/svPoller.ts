// src/services/svPoller.ts
import fs from 'fs/promises';
import type { Client, Guild } from 'discord.js';
import { publishOrUpdateRaid } from './publishRaid.js';
import { cfg } from '../config.js';

export type SVPollerStatus = {
  filePath: string;
  key: string;
  intervalMs: number;
  lastCheck?: string;
  lastChange?: string;
  lastError?: string;
  lastProcessedCount?: number;
  mode?: 'json' | 'lua';
};

const status: SVPollerStatus = {
  filePath: '',
  key: '',
  intervalMs: 60000,
};

// default duration for endAt when SV does not provide "ended"
const DEFAULT_DURATION_SEC = Number(process.env.RAID_EVENT_DEFAULT_DURATION_SEC ?? 3 * 3600);

function unescapeLuaQuotedString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function escapeRegExp(lit: string) {
  return lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Try JSON export under a given SV key: supports key = "..." and ["key"] = "..." (or [[ ... ]]) */
function tryExtractJsonExport(content: string, key: string): any | null {
  const k = escapeRegExp(key);
  const re = new RegExp(
    `(?:\\[\\s*["']${k}["']\\s*\\]|\\b${k}\\b)\\s*=\\s*(?:"((?:\\\\.|[^"\\\\])*)"|\\[\\[([\\s\\S]*?)\\]\\])`
  );
  const m = content.match(re);
  if (!m) return null;
  const raw = m[1] != null ? unescapeLuaQuotedString(m[1]) : (m[2] ?? '');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

/** Lightweight reader for RaidTrackDB.raidInstances from Lua SavedVariables */
function extractRaidInstancesFromLua(content: string): Array<Record<string, any>> {
  // Accept both: raidInstances = { ... }  and  ["raidInstances"] = { ... }
  const reKey = /(?:\[\s*["']raidInstances["']\s*\]|\braidInstances\b)\s*=\s*{/;
  const m = reKey.exec(content);
  if (!m) return [];

  // position right after the opening '{' of the value
  let i = (m.index ?? 0) + m[0].length;

  // Find the matching closing '}' for the raidInstances block (brace counting)
  let depth = 1;
  let end = i;
  for (; end < content.length; end++) {
    const ch = content[end];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end++; break; }
    }
  }
  const block = content.slice(i, end - 1); // inner of raidInstances { ... }

  // Within the block, each top-level `{ ... }` is a raid entry. Collect them.
  const raids: string[] = [];
  let j = 0;
  while (j < block.length) {
    while (j < block.length && /[\s,]/.test(block[j])) j++;
    if (j >= block.length) break;
    if (block[j] !== '{') { j++; continue; }

    let d = 1;
    let k = j + 1;
    for (; k < block.length; k++) {
      const ch2 = block[k];
      if (ch2 === '{') d++;
      else if (ch2 === '}') {
        d--;
        if (d === 0) { k++; break; }
      }
    }
    raids.push(block.slice(j + 1, k - 1)); // inner of single raid { ... }
    j = k;
  }

  // Parse simple key/value pairs like ["name"] = "x", ["id"]=123,
  const parsed: Array<Record<string, any>> = [];
  for (const rb of raids) {
    const obj: Record<string, any> = {};
    // Match ["key"] = value  OR  key = value
    const kvRe = /(?:\[\s*"?(?<k1>[A-Za-z0-9_]+)"?\s*\]|\b(?<k2>[A-Za-z_]\w*))\s*=\s*(?<v>[^,\n]+)\s*,?/g;
    let m2: RegExpExecArray | null;
    while ((m2 = kvRe.exec(rb)) !== null) {
      const key = (m2.groups?.k1 || m2.groups?.k2 || '').trim();
      let vRaw = (m2.groups?.v || '').trim();

      // Trim possible trailing comments
      vRaw = vRaw.replace(/--.*$/, '').trim();

      // Convert Lua literals to JS
      let value: any;
      if (vRaw.startsWith('"')) {
        const str = vRaw.replace(/^"/, '').replace(/"$/, '');
        value = unescapeLuaQuotedString(str);
      } else if (/^(true|false)$/i.test(vRaw)) {
        value = /^true$/i.test(vRaw);
      } else if (/^nil$/i.test(vRaw)) {
        value = null;
      } else if (/^[0-9]+(?:\.[0-9]+)?$/.test(vRaw)) {
        value = Number(vRaw);
      } else {
        // unsupported nested table or unknown literal; skip
        continue;
      }
      obj[key] = value;
    }
    if (Object.keys(obj).length) parsed.push(obj);
  }

  return parsed;
}

/** Map a minimal raid object from Lua -> our ingest format */
function mapLuaRaidToIngest(raid: Record<string, any>) {
  // fields seen: id, name, started, ended, status, preset, scheduledAt, scheduledDate
  const raidId = String(raid.id ?? raid.name ?? `rt-${Date.now()}`);
  const raidTitle = String(raid.name ?? 'Raid');
  const difficulty = String(raid.preset ?? 'Normal');
  const startAt = Number(raid.started ?? raid.scheduledAt ?? 0);

  // ensure endAt for Discord external events
  const endAt =
    raid.ended != null
      ? Number(raid.ended)
      : (startAt ? startAt + DEFAULT_DURATION_SEC : undefined);

  const notesParts: string[] = [];
  if (raid.status) notesParts.push(`status:${raid.status}`);
  if (raid.scheduledDate) notesParts.push(`date:${raid.scheduledDate}`);
  if (raid.ended) notesParts.push(`ended:${raid.ended}`);
  const notes = notesParts.join(' | ') || undefined;

  return { raidId, raidTitle, difficulty, startAt, endAt, notes };
}

export function startSavedVariablesPoller(
  client: Client,
  opts: { filePath: string; key: string; intervalMs?: number }
) {
  const filePath = opts.filePath;
  const key = opts.key;
  const intervalMs = Math.max(5_000, opts.intervalMs ?? Number(process.env.SV_POLL_MS || 60_000));
  const defaultGuildId =
    process.env.GUILD_ID_DEFAULT ||
    (cfg as any)?.guildId ||
    (cfg as any)?.allowedGuildId ||
    '';

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
    status.lastError = undefined;

    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (e: any) {
      status.lastError = `read failed: ${e.message}`;
      return;
    }

    // Mode A: JSON export under SV key
    try {
      const json = tryExtractJsonExport(text, key);
      if (json) {
        status.mode = 'json';
        let count = 0;
        if (Array.isArray(json)) {
          for (const item of json) {
            if (!item?.guildId || !item?.raid) continue;
            const guild: Guild = await client.guilds.fetch(String(item.guildId));
            await publishOrUpdateRaid(guild, item.raid as any);
            count++;
          }
        } else if (json?.guildId && json?.raid) {
          const guild: Guild = await client.guilds.fetch(String(json.guildId));
          await publishOrUpdateRaid(guild, json.raid as any);
          count = 1;
        } else {
          throw new Error('Unsupported JSON shape; expected {guildId, raid} or an array.');
        }
        status.lastProcessedCount = count;
        return;
      }
    } catch (e: any) {
      // fallthrough to Lua parser
      status.lastError = `json parse failed: ${e.message}`;
    }

    // Mode B: Lua RaidTrackDB.raidInstances
    try {
      status.mode = 'lua';
      const raids = extractRaidInstancesFromLua(text);
      if (!raids.length) {
        status.lastError = 'raidInstances not found or empty in Lua SV';
        return;
      }

      if (!defaultGuildId) {
        status.lastError =
          'no default guildId (set GUILD_ID_DEFAULT or cfg.guildId/allowedGuildId)';
        return;
      }

      let count = 0;
      for (const r of raids) {
        const payload = mapLuaRaidToIngest(r);
        if (!payload.startAt) continue; // basic sanity
        const guild: Guild = await client.guilds.fetch(String(defaultGuildId));
        await publishOrUpdateRaid(guild, payload as any);
        count++;
      }
      status.lastProcessedCount = count;
      if (!count) status.lastError = 'no valid raids mapped from Lua SV';
    } catch (e: any) {
      status.lastError = `lua parse/publish failed: ${e.message}`;
    }
  }

  const timer = setInterval(tick, intervalMs);
  // initial run
  tick().catch(() => {});
  return { stop() { clearInterval(timer); } };
}

export function getSVPollerStatus(): SVPollerStatus {
  return { ...status };
}
