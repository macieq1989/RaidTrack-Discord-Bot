import { cfg } from '../config.js';

export type RoleKey = 'TANK' | 'HEALER' | 'MELEE' | 'RANGED' | 'MAYBE' | 'ABSENT';

const ROLE_FALLBACK: Record<RoleKey, string> = {
  TANK: '🛡️',
  HEALER: '✚',
  MELEE: '⚔️',
  RANGED: '🏹',
  MAYBE: '❔',
  ABSENT: '🚫',
};

// ---------- normalize helpers ----------
function normToken(s?: string) {
  return (s ?? '').toLowerCase().trim().replace(/\s+|-/g, '_');
}

const CLASS_ALIASES: Record<string, string> = {
  dk: 'death_knight',
  deathknight: 'death_knight',
  dh: 'demon_hunter',
  demonhunter: 'demon_hunter',
  pala: 'paladin',
  sham: 'shaman',
  lock: 'warlock',
  war: 'warrior',
  hunt: 'hunter',
};

function normClass(s?: string) {
  let t = normToken(s);
  if (CLASS_ALIASES[t]) t = CLASS_ALIASES[t];
  return t;
}

const SPEC_ALIASES: Record<string, string> = {
  ret: 'retribution',
  retri: 'retribution',
  retributions: 'retribution',
  prot: 'protection',
  disc: 'discipline',
  bm: 'beast_mastery',
  mm: 'marksmanship',
  marks: 'marksmanship',
  surv: 'survival',
  enh: 'enhancement',
  ele: 'elemental',
  resto: 'restoration',
  destro: 'destruction',
  affli: 'affliction',
  aff: 'affliction',
  demo: 'demonology',
  arc: 'arcane',
  hpala: 'holy',
  rpala: 'retribution',
  sp: 'shadow',
  spriest: 'shadow',
};

function normSpec(s?: string) {
  let t = normToken(s);
  if (SPEC_ALIASES[t]) t = SPEC_ALIASES[t];
  return t;
}

function keyFor(classKey?: string, specKey?: string) {
  const c = normClass(classKey);
  const s = normSpec(specKey);
  return c && s ? `${c}_${s}` : null;
}

// ---------- token helpers ----------
/** Convert config value to a Discord emoji token */
function toEmojiToken(name: string, value: string): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (/^<a?:[^:>]+:\d+>$/.test(v)) return v;          // full token already
  const m = /^a:(\d+)$/.exec(v);                      // "a:ID" -> animated
  if (m) return `<a:${name}:${m[1]}>`;
  if (/^\d+$/.test(v)) return `<:${name}:${v}>`;       // plain ID -> static
  return null;
}

// ---------- public API ----------
/**
 * Returns a renderable token:
 *  - custom emoji from cfg.customEmoji (ID, "a:ID", or full token)
 *  - otherwise role fallback (Unicode)
 */
export function classSpecEmoji(classKey?: string, specKey?: string, role?: RoleKey): string {
  const key = keyFor(classKey, specKey);
  if (key && cfg.allowExternalEmoji) {
    const raw = cfg.customEmoji?.[key]; // from EMOJI_MAP_JSON / EMOJI_MAP
    const token = raw ? toEmojiToken(key, raw) : null;
    if (token) return token;            // "<:name:id>" / "<a:name:id>"
  }
  return role ? (ROLE_FALLBACK[role] ?? '•') : '•';
}
