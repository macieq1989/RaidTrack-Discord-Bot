// src/services/svPoller.ts
import fs from 'fs/promises';
import type { Client, Guild } from 'discord.js';
import { publishOrUpdateRaid } from './publishRaid.js';
import { cfg } from '../config.js';
import { deriveDifficultyFromPresetConfig } from './mapping.js';
import { publishEPGPBoard } from './epgpBoard.js';
import { publishLootBatch } from "./publishLoot.js";
import { makeLootKey, filterNewLootKeys, saveLootKeys } from "./lootDedupe.js";


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

// anti-dup cache for loot
let lastLootMaxTs: number = 0; // prefer timestamp
let lastLootMaxId: number = 0; // fallback to id

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

  let i = (m.index ?? 0) + m[0].length;
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
  const block = content.slice(i, end - 1);

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
    raids.push(block.slice(j + 1, k - 1));
    j = k;
  }

  const parsed: Array<Record<string, any>> = [];
  for (const rb of raids) {
    const obj: Record<string, any> = {};
    const kvRe = /(?:\[\s*"?(?<k1>[A-Za-z0-9_]+)"?\s*\]|\b(?<k2>[A-Za-z_]\w*))\s*=\s*(?<v>[^,\n]+)\s*,?/g;
    let m2: RegExpExecArray | null;
    while ((m2 = kvRe.exec(rb)) !== null) {
      const key = (m2.groups?.k1 || m2.groups?.k2 || '').trim();
      let vRaw = (m2.groups?.v || '').trim();
      vRaw = vRaw.replace(/--.*$/, '').trim();

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

  const entryRe = /\[\s*"([^"]+)"\s*\]\s*=\s*{/g;
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(block)) !== null) {
    const presetName = em[1].trim().toLowerCase();
    let j = em.index + em[0].length;

    let d = 1, k = j;
    for (; k < block.length; k++) {
      const ch2 = block[k];
      if (ch2 === '{') d++;
      else if (ch2 === '}') { d--; if (d === 0) { k++; break; } }
    }
    const entry = block.slice(j, k - 1);

    const cfg: { selectedDifficulty?: string; bosses?: Record<string, Record<string, number>> } = {};

    const dm = entry.match(/(?:\[\s*"selectedDifficulty"\s*\]|\bselectedDifficulty\b)\s*=\s*"([^"]+)"/i);
    if (dm) cfg.selectedDifficulty = dm[1].trim();

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

        bossRe.lastIndex = bk;
      }
      if (Object.keys(bosses).length) cfg.bosses = bosses;
    }

    result[presetName] = cfg;
    entryRe.lastIndex = k;
  }

  return result;
}

/** Map a minimal raid object from Lua -> our ingest format; difficulty from preset config */
function mapLuaRaidToIngest(raid: Record<string, any>) {
  const raidId = String(raid.id ?? raid.name ?? `rt-${Date.now()}`);
  const raidTitle = String(raid.name ?? 'Raid');

  const presetKey = String(raid.preset ?? raid.presetName ?? '').trim().toLowerCase();
  const presetCfg =
    presetKey && lastPresetConfigMap[presetKey]
      ? lastPresetConfigMap[presetKey]
      : undefined;

  const difficulty = deriveDifficultyFromPresetConfig(presetCfg);
  const startAt = Number(raid.started ?? raid.scheduledAt ?? 0);
  const endAt =
    raid.ended != null
      ? Number(raid.ended)
      : (startAt ? startAt + DEFAULT_DURATION_SEC : undefined);
  const status = normalizeStatus(raid.status);

  const notesParts: string[] = [];
  if (raid.status) notesParts.push(`status:${raid.status}`);
  if (raid.scheduledDate) notesParts.push(`date:${raid.scheduledDate}`);
  if (raid.preset ?? raid.presetName) notesParts.push(`preset:${raid.preset ?? raid.presetName}`);
  if (raid.ended) notesParts.push(`ended:${raid.ended}`);
  const notes = notesParts.join(' | ') || undefined;

  return { raidId, raidTitle, difficulty, startAt, endAt, notes, status };
}

/** Extract EPGP from Lua SV */
function extractEPGPFromLua(content: string): {
  entries: Array<{ username: string; ep: number; gp: number; userId?: string }>;
  boardId?: string;
} {
  const out: Array<{ username: string; ep: number; gp: number; userId?: string }> = [];

  const wipeM = /(?:\[\s*["']epgpWipeID["']\s*\]|\bepgpWipeID\b)\s*=\s*([0-9]+)/i.exec(content);
  const boardId = wipeM ? wipeM[1] : undefined;

  const rootRe = /(?:\[\s*["']epgp["']\s*\]|\bepgp\b)\s*=\s*{/i;
  const m = rootRe.exec(content);
  if (!m) return { entries: out, boardId };

  let i = (m.index ?? 0) + m[0].length;
  let depth = 1, end = i;
  for (; end < content.length; end++) {
    const ch = content[end];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end++; break; } }
  }
  const block = content.slice(i, end - 1);

  const entryRe = /\[\s*"([^"]+)"\s*\]\s*=\s*{/g;
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(block)) !== null) {
    const name = em[1];
    let j = em.index + em[0].length;

    let d = 1, k = j;
    for (; k < block.length; k++) {
      const ch2 = block[k];
      if (ch2 === '{') d++;
      else if (ch2 === '}') { d--; if (d === 0) { k++; break; } }
    }
    const inner = block.slice(j, k - 1);

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

/** Extract lootHistory[] from Lua SV */
function extractLootHistoryFromLua(content: string): Array<{
  id?: number; player?: string; item?: string; boss?: string; gp?: number;
  time?: string; timestamp?: number;
}> {
  const result: Array<any> = [];

  // find lootHistory = { ... } or ["lootHistory"] = { ... }
  const rootRe = /(?:\[\s*["']lootHistory["']\s*\]|\blootHistory\b)\s*=\s*{/i;
  const m = rootRe.exec(content);
  if (!m) return result;

  let i = (m.index ?? 0) + m[0].length;
  let depth = 1, end = i;
  for (; end < content.length; end++) {
    const ch = content[end];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end++; break; } }
  }
  const block = content.slice(i, end - 1);

  // each entry is { ... }
  let p = 0;
  while (p < block.length) {
    while (p < block.length && /[\s,]/.test(block[p])) p++;
    if (p >= block.length) break;
    if (block[p] !== '{') { p++; continue; }

    let d = 1, q = p + 1;
    for (; q < block.length; q++) {
      const ch2 = block[q];
      if (ch2 === '{') d++;
      else if (ch2 === '}') { d--; if (d === 0) { q++; break; } }
    }
    const inner = block.slice(p + 1, q - 1);

    const obj: any = {};
    // keys like ["player"]="Macieq", ["item"]="|c...|Hitem:194308...|h[Manic Grieftorch]|h|r", ["gp"]=100, ["id"]=1, ["timestamp"]=1755433557, ["boss"]="Auction", ["time"]="13:25:57"
    const kvRe = /(?:\[\s*"?(?<k1>[A-Za-z0-9_]+)"?\s*\]|\b(?<k2>[A-Za-z_]\w*))\s*=\s*(?<v>[^,\n]+)\s*,?/g;
    let m2: RegExpExecArray | null;
    while ((m2 = kvRe.exec(inner)) !== null) {
      const key = (m2.groups?.k1 || m2.groups?.k2 || '').trim();
      let vRaw = (m2.groups?.v || '').trim();
      vRaw = vRaw.replace(/--.*$/, '').trim();

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
        continue;
      }
      obj[key] = value;
    }
    if (Object.keys(obj).length) result.push(obj);

    p = q;
  }

  return result;
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

async function maybePublishLootArray(arr: any[]) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;

  // 1) Wstępny filtr w pamięci (ts > lastLootMaxTs, albo id > lastLootMaxId)
  const fresh = arr.filter((e) => {
    const ts = Number(e?.timestamp ?? 0);
    const id = Number(e?.id ?? 0);
    if (Number.isFinite(ts) && ts > 0) return ts > lastLootMaxTs;
    return Number.isFinite(id) && id > lastLootMaxId;
  });
  if (!fresh.length) return 0;

  // 2) Sort chronologiczny
  fresh.sort((a, b) => {
    const ta = Number(a?.timestamp ?? 0);
    const tb = Number(b?.timestamp ?? 0);
    if (ta && tb) return ta - tb;
    const ia = Number(a?.id ?? 0);
    const ib = Number(b?.id ?? 0);
    return ia - ib;
  });

  // 3) Zbuduj deterministyczne klucze do dedupe w DB
  const keys = fresh.map((loot) => {
    // wyciągamy itemId z item-stringa (np. ...|Hitem:194308:...|)
    const itemStr = String(loot?.item ?? "");
    const idMatch = itemStr.match(/Hitem:(\d+)/i);
    const itemId = idMatch ? idMatch[1] : undefined;
    return makeLootKey({
      timestamp: Number(loot?.timestamp ?? 0) || undefined,
      id: Number(loot?.id ?? 0) || undefined,
      time: String(loot?.time ?? "") || undefined,
      player: String(loot?.player ?? loot?.username ?? ""),
      itemId,
      gp: Number(loot?.gp ?? 0),
      boss: String(loot?.boss ?? ""),
    });
  });

  // 4) Odfiltruj to, co już kiedyś wysłaliśmy (trwale)
  const newKeys = await filterNewLootKeys(keys);
  const newFresh = fresh.filter((_, i) => newKeys.includes(keys[i]));
  if (!newFresh.length) return 0;

  // 5) Anti-spam limit na tick
  const MAX_PER_TICK = Number(process.env.LOOT_MAX_PER_TICK ?? 12);
  const batchSrc = newFresh.slice(0, Math.max(1, MAX_PER_TICK));

  // 6) Map do LootEntry[] dla publishLootBatch
  const batch = batchSrc.map((loot) => ({
    id: Number(loot?.id ?? 0),
    player: String(loot?.player ?? loot?.username ?? "Unknown"),
    item: String(loot?.item ?? ""),
    boss: String(loot?.boss ?? ""),
    gp: Number(loot?.gp ?? 0),
    time: String(loot?.time ?? ""),
    timestamp: Number(loot?.timestamp ?? 0),
  }));

  try {
    // 7) Publikacja batcha
    await publishLootBatch(client, batch);

    // 8) Po sukcesie: zapisz klucze do DB (idempotentnie)
    const keysToSave = batchSrc.map((_, i) => newKeys[i]); // 1:1 z batchSrc kolejnością
    await saveLootKeys(keysToSave.filter(Boolean) as string[]);

    // 9) Zaktualizuj high-water-mark pamięciowy (drugi bezpiecznik)
    for (const loot of batchSrc) {
      const ts = Number(loot?.timestamp ?? 0);
      const id = Number(loot?.id ?? 0);
      if (Number.isFinite(ts) && ts > lastLootMaxTs) lastLootMaxTs = ts;
      // jeżeli ts równe, to rozstrzygaj po id
      if (ts === lastLootMaxTs && Number.isFinite(id) && id > lastLootMaxId) lastLootMaxId = id;
      if (!Number.isFinite(ts) && Number.isFinite(id) && id > lastLootMaxId) lastLootMaxId = id;
    }

    const skipped = newFresh.length - batchSrc.length;
    dbg(
      `loot: published ${batchSrc.length} entr${batchSrc.length === 1 ? "y" : "ies"}`
        + (skipped > 0 ? ` (+${skipped} pending next tick)` : "")
    );
    return batchSrc.length;
  } catch (e: any) {
    console.warn("[SV] loot batch publish failed:", e?.message ?? e);
    return 0;
  }
}



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
          const gid = String(packet?.guildId || defaultGuildId || '').trim();
          if (!gid) {
            status.lastError = 'json: missing guildId and defaultGuildId';
            dbg('json: skip (no guildId/defaultGuildId)');
            return;
          }
          const guild: Guild = await client.guilds.fetch(gid);

          // ---- EPGP board (optional)
          if (packet?.epgp) {
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

          // ---- Loot (optional, independent)
          if (packet?.lootHistory || packet?.loot) {
            const lootArr = Array.isArray(packet.lootHistory)
              ? packet.lootHistory
              : (packet.loot ? [packet.loot] : []);
            const sent = await maybePublishLootArray(lootArr);
            count += sent;
          }

          // ---- Raid publish/update (optional)
          if (packet?.raid) {
            const r = { ...packet.raid };

            const normalized = normalizeStatus(r.status ?? r.state ?? r.raidStatus);
            if (normalized) r.status = normalized; else delete r.status;

            if (!r.endAt && r.startAt) r.endAt = Number(r.startAt) + DEFAULT_DURATION_SEC;

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
          status.lastError = 'json parsed but nothing to publish (no epgp/loot/raid entries)';
          dbg('json: nothing published');
        }
        return;
      }
    } catch (e: any) {
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

      // --- Loot (independent)
      try {
        const loot = extractLootHistoryFromLua(text);
        if (loot.length) {
          const sent = await maybePublishLootArray(loot);
          ops += sent;
        }
      } catch (e: any) {
        console.warn('[SV] loot(Lua) parse failed:', e?.message ?? e);
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
