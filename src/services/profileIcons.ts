// src/services/profileIcons.ts
import { cfg } from '../config.js';

type RoleKey = 'TANK' | 'HEALER' | 'MELEE' | 'RANGED' | 'MAYBE' | 'ABSENT';

// Optional ENV override (full token). Example:
// CLASS_SPEC_EMOJI_JSON='{"PALADIN:RETRIBUTION":"<a:pal_retri:1234567890>"}'
const ENV_EMOJI: Record<string, string> = (() => {
  try { return JSON.parse(process.env.CLASS_SPEC_EMOJI_JSON ?? '{}'); }
  catch { return {}; }
})();

// Fallbacks (Unicode)
const ROLE_FALLBACK: Record<RoleKey, string> = {
  TANK:   '🛡️',
  HEALER: '✚',
  MELEE:  '⚔️',
  RANGED: '🏹',
  MAYBE:  '❔',
  ABSENT: '🚫',
};

// ---------- Normalization ----------
function normToken(s?: string) {
  return (s ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_');
}

function normClass(s?: string) {
  const t = normToken(s);
  if (t === 'deathknight') return 'death_knight';
  if (t === 'demonhunter') return 'demon_hunter';
  return t;
}

/** ENV key: "PALADIN:RETRIBUTION" (no spaces, spec with underscores) */
function envKey(classKey?: string, specKey?: string) {
  const c = (classKey ?? '').toUpperCase().replace(/[\s-]+/g, '');
  const s = (specKey ?? '').toUpperCase().replace(/[\s-]+/g, '_');
  if (!c || !s) return null;
  return `${c}:${s}`;
}

/** CFG key: "paladin_retribution" */
function cfgKey(classKey?: string, specKey?: string) {
  const c = normClass(classKey);
  const s = normToken(specKey);
  if (!c || !s) return null;
  return `${c}_${s}`;
}

/**
 * Convert a config value to a Discord emoji token:
 * - "<:name:id>" or "<a:name:id>"  -> returns as-is
 * - "a:1234567890"                 -> "<a:key:1234567890>"
 * - "1234567890"                   -> "<:key:1234567890>"
 */
function toEmojiToken(name: string, value: string): string | null {
  const v = value.trim();
  if (!v) return null;

  // Full token already provided
  if (/^<a?:[^:>]+:\d+>$/.test(v)) return v;

  // Animated marker
  const animatedMatch = /^a:(\d+)$/.exec(v);
  if (animatedMatch) return `<a:${name}:${animatedMatch[1]}>`;

  // Plain numeric ID -> static
  if (/^\d+$/.test(v)) return `<:${name}:${v}>`;

  return null;
}

function customFromConfig(key: string): string | null {
  if (!cfg.allowExternalEmoji) return null;
  const raw = cfg.customEmoji?.[key];
  if (!raw) return null;
  const token = toEmojiToken(key, raw);
  return token ?? null;
}

/**
 * Returns a string ready for message text:
 * 1) ENV override (full "<:name:id>") if present
 * 2) cfg.customEmoji["class_spec"] (ID / full token / "a:ID"), if allowed
 * 3) fallback to role Unicode
 */
export function classSpecEmoji(
  classKey?: string,
  specKey?: string,
  role?: RoleKey
): string {
  // 1) ENV has priority
  const ek = envKey(classKey, specKey);
  if (ek && ENV_EMOJI[ek]) return ENV_EMOJI[ek];

  // 2) Config mapping
  const ck = cfgKey(classKey, specKey);
  if (ck) {
    const token = customFromConfig(ck);
    if (token) return token;
  }

  // 3) Fallback
  return role ? (ROLE_FALLBACK[role] ?? '•') : '•';
}
