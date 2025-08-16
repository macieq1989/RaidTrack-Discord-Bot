// src/services/profileIcons.ts
import { cfg } from '../config.js';

type RoleKey = 'TANK' | 'HEALER' | 'MELEE' | 'RANGED' | 'MAYBE' | 'ABSENT';

// Optional ENV override (full token). Example:
// CLASS_SPEC_EMOJI_JSON='{"PALADIN:RETRIBUTION":"<:pal_retri:1234567890>"}'
const ENV_EMOJI: Record<string, string> = (() => {
  try { return JSON.parse(process.env.CLASS_SPEC_EMOJI_JSON ?? '{}'); }
  catch { return {}; }
})();

// Role fallbacks (Unicode)
const ROLE_FALLBACK: Record<RoleKey, string> = {
  TANK:   '🛡️',
  HEALER: '✚',
  MELEE:  '⚔️',
  RANGED: '🏹',
  MAYBE:  '❔',
  ABSENT: '🚫',
};

// ---- Normalization helpers ----
function normalizeToken(s?: string) {
  return (s ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

function normalizeClassKey(s?: string) {
  const t = normalizeToken(s);
  if (t === 'deathknight') return 'death_knight';
  if (t === 'demonhunter') return 'demon_hunter';
  return t;
}

/** "PALADIN:RETRIBUTION" for ENV key */
function envKey(classKey?: string, specKey?: string) {
  const c = (classKey ?? '').toUpperCase().replace(/[\s-]+/g, '');
  const s = (specKey ?? '').toUpperCase().replace(/[\s-]+/g, '_');
  if (!c || !s) return null;
  return `${c}:${s}`;
}

/** "paladin_retribution" for cfg.customEmoji */
function cfgKey(classKey?: string, specKey?: string) {
  const c = normalizeClassKey(classKey);
  const s = normalizeToken(specKey);
  if (!c || !s) return null;
  return `${c}_${s}`;
}

function customFromConfig(key: string): string | null {
  if (!cfg.allowExternalEmoji) return null;
  const id = cfg.customEmoji?.[key];
  if (!id) return null;
  // Use the key as the emoji "name". Discord renders by ID; name is mostly cosmetic.
  return `<:${key}:${id}>`;
}

/**
 * Returns a string ready to be embedded in message text:
 * - ENV override (full "<:name:id>") if provided
 * - custom emoji from cfg.customEmoji (by "class_spec" -> id), if allowed
 * - role fallback (Unicode)
 */
export function classSpecEmoji(
  classKey?: string,
  specKey?: string,
  role?: RoleKey
): string {
  // 1) ENV override takes precedence
  const ek = envKey(classKey, specKey);
  if (ek && ENV_EMOJI[ek]) return ENV_EMOJI[ek];

  // 2) Config mapping "class_spec" -> id
  const ck = cfgKey(classKey, specKey);
  if (ck) {
    const token = customFromConfig(ck);
    if (token) return token;
  }

  // 3) Fallback to role emoji (Unicode) or a dot
  return role ? (ROLE_FALLBACK[role] ?? '•') : '•';
}
