// src/services/svPoller.ts
import fs from 'fs/promises';
import type { Client, Guild } from 'discord.js';
import { publishOrUpdateRaid } from './publishRaid.js';
import { cfg } from '../config.js';
import { deriveDifficultyFromPresetConfig } from './mapping.js';
import { publishEPGPBoard } from './epgpBoard.js';

// ---------- tiny logger ----------
const dbg = (...args: any[]) => console.log('[SV]', ...args);

// ---------- Types & status normalization ----------
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

type NormalizedStatus = 'CREATED' | 'STARTED' | 'ENDED';

function normalizeStatus(raw: any): NormalizedStatus | undefined {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === 'CREATED' || s === 'STARTED' || s === 'ENDED') return s;
  // map legacy if needed:
  // if (s === 'ACTIVE') return 'STARTED';
  // if (s === 'FINISHED' || s === 'COMPLETED') return 'ENDED';
  return undefined;
}

// ---------- Internal state ----------
const status: SVPollerStatus = {
  filePath: '',
  key: '',
  intervalMs: 60000,
};

// cache of preset -> { selectedDifficulty, bosses{ boss -> { diff: value } } }
let lastPresetConfigMap: Record<
  string,
  { selectedDifficulty?: string; bosses?: Record<string, Record<string, number>> }
> = {};

const DEFAULT_DURATION_SEC = Number(process.env.RAID_EVENT_DEFAULT_DURATION_SEC ?? 3 * 3600);

// ---------- Helpers ----------
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

/** Extract RaidTrackDB.raidInstances from Lua SavedVariables */
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

/** Extract RaidTrackDB.raidPresets -> minimal config for difficulty derivation */
function extractRaidPresetsConfig(content: string): Record<
  string,
  { selectedDifficulty?: string; bosses?: Record<string, Record<string, number>> }
> {
  const result: Record<
    string,
    { selectedDifficulty?: string; bosses?: Record<string, Record<string, number>> }
  > = {};

  // find raidPresets = { ... } or ["raidPresets"] = { ... }
  const reRoot = /(?:\[\s*["']raidPresets["']\s*\]|\braidPresets\b)\s*=\s*{/;
  const m = reRoot.exec(content);
  if (!m) return result;

  let i = m.index + m[0].length;
  let depth = 1, end = i;
  for (; end < content.length; end++) {
    const ch = content[end];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end++; break; } }
  }
  const block = content.slice(i, end - 1);

  // iterate entries: ["<preset>"] = { ... }
  const entryRe = /\[\s*"([^"]+)"\s*\]\s*=\s*{/g;
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(block)) !== null) {
    const presetName = em[1].trim().toLowerCase();
    let j = em.index + em[0].length;

    // balance to end of this preset object
    let d = 1, k = j;
    for (; k < block.length; k++) {
      const ch2 = block[k];
      if (ch2 === '{') d++;
      else if (ch2 === '}') { d--; if (d === 0) { k++; break; } }
    }
    const entry = block.slice(j, k - 1);

    const cfg: { selectedDifficulty?: string; bosses?: Record<string, Record<string, number>> } = {};

    // selectedDifficulty = "Heroic"
    const dm = entry.match(/(?:\[\s*"selectedDifficulty"\s*\]|\bselectedDifficulty\b)\s*=\s*"([^"]+)"/i);
    if (dm) cfg.selectedDifficulty = dm[1].trim();

    // bosses = { ["Boss"] = { ["Heroic"]=111, ["Normal"]=0, ... }, ... }
    const bossesRoot = /(?:\[\s*"bosses"\s*\]|\bbosses\b)\s*=\s*{/i.exec(entry);
    if (bossesRoot) {
      const bosses: Record<string, Record<string, number>> = {};
      let bStart = (bossesRoot.index ?? 0) + bossesRoot[0].length;
      let bd = 1, bEnd = bStart;
      for (; bEnd < entry.length; bEnd++) {
        const ch3 = entry[bEnd];
        if (ch3 === '{') bd++;
        else if (ch3 === '}') { bd--; if (bd === 0) { bEnd++; break; } }
      }
      const bossesBlock = entry.slice(bStart, bEnd - 1);

      const bossRe = /\[\s*"([^"]+)"\s*\]\s*=\s*{/g;
      let bm: RegExpExecArray | null;
      while ((bm = bossRe.exec(bossesBlock)) !== null) {
        const bossName = bm[1];
        let bj = bm.index + bm[0].length;

        let dd = 1, bk = bj;
        for (; bk < bossesBlock.length; bk++) {
          const ch4 = bossesBlock[bk];
          if (ch4 === '{') dd++;
          else if (ch4 === '}') { dd--; if (dd === 0) { bk++; break; } }
        }
        const diffBlock = bossesBlock.slice(bj, bk - 1);

        const diffMap: Record<string, number> = {};
        const diffRe = /\[\s*"([^"]+)"\s*\]\s*=\s*([0-9]+)/g;
        let dm2: RegExpExecArray | null;
        while ((dm2 = diffRe.exec(diffBlock)) !== null) {
          diffMap[dm2[1]] = Number(dm2[2] || 0);
        }
        if (Object.keys(diffMap).length) bosses[bossName] = diffMap;

        bossRe.lastIndex = bk; // jump past this boss
      }
      if (Object.keys(bosses).length) cfg.bosses = bosses;
    }

    result[presetName] = cfg;
    entryRe.lastIndex = k; // jump past this preset
  }

  return result;
}

/** Map a minimal raid object from Lua -> our ingest format; difficulty from preset config */
function mapLuaRaidToIngest(raid: Record<string, any>) {
  // fields seen: id, name, started, ended, status, preset, scheduledAt, scheduledDate, presetName
  const raidId = String(raid.id ?? raid.name ?? `rt-${Date.now()}`);
  const raidTitle = String(raid.name ?? 'Raid');

  const presetKey = String(raid.preset ?? raid.presetName ?? '').trim().toLowerCase();
  const presetCfg =
    presetKey && lastPresetConfigMap[presetKey]
      ? lastPresetConfigMap[presetKey]
      : undefined;

  // difficulty strictly derived from preset configuration
  const difficulty = deriveDifficultyFromPresetConfig(presetCfg);

  const startAt = Number(raid.started ?? raid.scheduledAt ?? 0);

  // ensure endAt for Discord external events
  const endAt =
    raid.ended != null
      ? Number(raid.ended)
      : (startAt ? startAt + DEFAULT_DURATION_SEC : undefined);

  // normalize status if present
  const status = normalizeStatus(raid.status);

  const notesParts: string[] = [];
  if (raid.status) notesParts.push(`status:${raid.status}`);
  if (raid.scheduledDate) notesParts.push(`date:${raid.scheduledDate}`);
  if (raid.preset ?? raid.presetName) notesParts.push(`preset:${raid.preset ?? raid.presetName}`);
  if (raid.ended) notesParts.push(`ended:${raid.ended}`);
  const notes = notesParts.join(' | ') || undefined;

  return { raidId, raidTitle, difficulty, startAt, endAt, notes, status };
}

/** Extract EPGP from Lua SV:
 * RaidTrackDB = {
 *   ["epgpWipeID"] = 1755418727,
 *   ["epgp"] = { ["Alice"]={ep=124,gp=1}, ... }
 * }
 */
function extractEPGPFromLua(content: string): {
  entries: Array<{ username: string; ep: number; gp: number; userId?: string }>;
  boardId?: string;
} {
  const out: Array<{ username: string; ep: number; gp: number; userId?: string }> = [];

  // boardId = epgpWipeID (opcjonalnie)
  const wipeM = /(?:\[\s*["']epgpWipeID["']\s*\]|\bepgpWipeID\b)\s*=\s*([0-9]+)/i.exec(content);
  const boardId = wipeM ? wipeM[1] : undefined;

  // epgp = { ... } lub ["epgp"] = { ... }
  const rootRe = /(?:\[\s*["']epgp["']\s*\]|\bepgp\b)\s*=\s*{/i;
  const m = rootRe.exec(content);
  if (!m) return { entries: out, boardId };

  // wytnij blok epgp { ... }
  let i = (m.index ?? 0) + m[0].length;
  let depth = 1, end = i;
  for (; end < content.length; end++) {
    const ch = content[end];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end++; break; } }
  }
  const block = content.slice(i, end - 1);

  // iteruj ["Name"] = { ... }
  const entryRe = /\[\s*"([^"]+)"\s*\]\s*=\s*{/g;
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(block)) !== null) {
    const name = em[1];
    let j = em.index + em[0].length;

    // balans wewnętrznej tabeli
    let d = 1, k = j;
    for (; k < block.length; k++) {
      const ch2 = block[k];
      if (ch2 === '{') d++;
      else if (ch2 === '}') { d--; if (d === 0) { k++; break; } }
    }
    const inner = block.slice(j, k - 1);

    // UWAGA: obsługa ["ep"] = 124 / ["gp"] = 1 i wariantów bez nawiasów
    const epm = /(?:\[\s*["']ep["']\s*\]|\bep\b)\s*=\s*([0-9]+(?:\.[0-9]+)?)/i.exec(inner);
    const gpm = /(?:\[\s*["']gp["']\s*\]|\bgp\b)\s*=\s*([0-9]+(?:\.[0-9]+)?)/i.exec(inner);
    const um  = /(?:\[\s*["']discordId["']\s*\]|\bdiscordId\b|\buserId\b)\s*=\s*"([^"]+)"/i.exec(inner);

    const ep = epm ? Number(epm[1]) : NaN;
    const gp = gpm ? Number(gpm[1]) : NaN;

    if (Number.isFinite(ep) && Number.isFinite(gp)) {
      out.push({ username: name, ep, gp, userId: um?.[1] });
    }

    entryRe.lastIndex = k;
  }

  return { entries: out, boardId };
}


// ---------- Poller ----------
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

    // update preset->config map (raidPresets) first, for routing
    try {
      const m = extractRaidPresetsConfig(text);
      if (Object.keys(m).length) {
        lastPresetConfigMap = m;
      }
    } catch {
      // non-fatal
    }

    // Mode A: JSON export under SV key
    try {
      const json = tryExtractJsonExport(text, key);
      if (json) {
        status.mode = 'json';
        let count = 0;

        const handleOne = async (packet: any) => {
          // fallback to defaultGuildId if packet.guildId missing
          const gid = String(packet?.guildId || defaultGuildId || '').trim();
          if (!gid) {
            status.lastError = 'json: missing guildId and defaultGuildId';
            dbg('json: skip (no guildId/defaultGuildId)');
            return;
          }
          const guild: Guild = await client.guilds.fetch(gid);

          // ---- EPGP board (optional, independent from raid)
          if (packet?.epgp) {
            // normalize: accept array OR object map
            let entriesRaw = packet.epgp;
            if (entriesRaw && !Array.isArray(entriesRaw) && typeof entriesRaw === 'object') {
              entriesRaw = Object.entries(entriesRaw).map(([name, v]: any) => ({
                username: String(name),
                ep: Number(v?.ep ?? v?.EP ?? 0),
                gp: Number(v?.gp ?? v?.GP ?? 0),
                userId: v?.userId ?? v?.discordId,
              }));
            }

            const entries = (Array.isArray(entriesRaw) ? entriesRaw : [])
              .map((e: any) => ({
                username: String(e?.username ?? e?.name ?? e?.player ?? 'Unknown'),
                ep: Number(e?.ep ?? e?.EP ?? 0),
                gp: Number(e?.gp ?? e?.GP ?? 0),
                userId: e?.userId ?? e?.discordId,
              }))
              .filter((e: any) => Number.isFinite(e.ep) && Number.isFinite(e.gp));

            const boardId =
              packet?.epgpId ??
              packet?.epgp?.id ??
              packet?.epgp?.messageId ??
              packet?.boardId ??
              packet?.epgpMessageId;

            if (entries.length) {
              dbg(`json: publish EPGP (${entries.length}) boardId=${boardId ?? '—'}`);
              await publishEPGPBoard(guild, entries, { boardId }).catch((e: any) => {
                console.warn('[SV] EPGP publish failed:', e?.message ?? e);
              });
              count++;
            } else {
              dbg('json: epgp present but no valid entries');
            }
          }

          // ---- Raid publish/update (optional)
          if (packet?.raid) {
            const r = { ...packet.raid };

            // status normalize (SV is source of truth)
            const normalized = normalizeStatus(r.status ?? r.state ?? r.raidStatus);
            if (normalized) r.status = normalized; else delete r.status;

            // ensure endAt
            if (!r.endAt && r.startAt) r.endAt = Number(r.startAt) + DEFAULT_DURATION_SEC;

            // difficulty fallback from preset
            if (!r.difficulty && r.presetName) {
              const presetCfg = lastPresetConfigMap[String(r.presetName).trim().toLowerCase()];
              r.difficulty = deriveDifficultyFromPresetConfig(presetCfg);
            }

            dbg(`json: publish raid ${r.raidId ?? r.raidTitle ?? ''}`);
            await publishOrUpdateRaid(guild, r);
            count++;
          }
        };

        if (Array.isArray(json)) {
          for (const item of json) await handleOne(item);
        } else {
          await handleOne(json);
        }

        status.lastProcessedCount = count;
        if (count === 0) {
          status.lastError = 'json parsed but nothing to publish (no epgp/raid entries)';
          dbg('json: nothing published');
        }
        return;
      }
    } catch (e: any) {
      // fallthrough to Lua parser
      status.lastError = `json parse failed: ${e.message}`;
    }

    // Mode B: Lua
    try {
      status.mode = 'lua';
      let ops = 0;

      // --- EPGP (independent)
      try {
        const { entries, boardId } = extractEPGPFromLua(text);
        if (entries?.length) {
          const gid = String(
            process.env.GUILD_ID_DEFAULT ||
            (cfg as any)?.guildId ||
            (cfg as any)?.allowedGuildId || ''
          ).trim();
          if (!gid) {
            console.warn('[SV] EPGP(Lua) present but no defaultGuildId; set GUILD_ID_DEFAULT or cfg.guildId');
          } else {
            const guild: Guild = await client.guilds.fetch(gid);
            dbg(`lua: publish EPGP (${entries.length}) boardId=${boardId ?? '—'}`);
            await publishEPGPBoard(guild, entries, { boardId }).catch((e: any) => {
              console.warn('[SV] EPGP(Lua) publish failed:', e?.message ?? e);
            });
            ops++;
          }
        }
      } catch (e: any) {
        console.warn('[SV] EPGP(Lua) parse failed:', e?.message ?? e);
      }

      // --- Raids
      const raids = extractRaidInstancesFromLua(text);
      if (raids.length) {
        if (!defaultGuildId) {
          status.lastError = 'no default guildId (set GUILD_ID_DEFAULT or cfg.guildId/allowedGuildId)';
        } else {
          const guild: Guild = await client.guilds.fetch(String(defaultGuildId));
          for (const r of raids) {
            const payload = mapLuaRaidToIngest(r);
            if (!payload.startAt) {
              console.warn('[SV] skip raid (no startAt):', payload.raidId ?? payload.raidTitle);
              continue;
            }
            try {
              await publishOrUpdateRaid(guild, payload as any);
              ops++;
            } catch (e: any) {
              console.warn(`[SV] skip raid (raidId=${payload.raidId}):`, e?.message ?? e);
            }
          }
        }
      } else if (ops === 0) {
        status.lastError = 'raidInstances not found or empty in Lua SV';
      }

      status.lastProcessedCount = ops;
    } catch (e: any) {
      status.lastError = `lua parse/publish failed: ${e.message}`;
    }
  } // <-- end of tick()

  const timer = setInterval(tick, intervalMs);
  // initial run
  tick().catch(() => { });
  return { stop() { clearInterval(timer); } };
}

export function getSVPollerStatus(): SVPollerStatus {
  return { ...status };
}
