// src/services/profileIcons.ts
import { cfg } from '../config.js';

type RoleKey = 'TANK' | 'HEALER' | 'MELEE' | 'RANGED' | 'MAYBE' | 'ABSENT';

const ROLE_FALLBACK: Record<RoleKey, string> = {
  TANK:   '🛡️',
  HEALER: '✚',
  MELEE:  '⚔️',
  RANGED: '🏹',
  MAYBE:  '❔',
  ABSENT: '🚫',
};

// ---------- normalize ----------
function norm(s?: string) {
  return (s ?? '').toLowerCase().trim().replace(/\s+|-/g, '_');
}
function normClass(s?: string) {
  const t = norm(s);
  if (t === 'deathknight') return 'death_knight';
  if (t === 'demonhunter') return 'demon_hunter';
  return t;
}
function keyFor(classKey?: string, specKey?: string) {
  const c = normClass(classKey);
  const s = norm(specKey);
  return c && s ? `${c}_${s}` : null;
}

/** Turn config value into a Discord emoji token */
function toEmojiToken(name: string, value: string): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;

  // already a full token "<:name:id>" / "<a:name:id>"
  if (/^<a?:[^:>]+:\d+>$/.test(v)) return v;

  // "a:123..." -> animated
  const m = /^a:(\d+)$/.exec(v);
  if (m) return `<a:${name}:${m[1]}>`;

  // "123..." -> static
  if (/^\d+$/.test(v)) return `<:${name}:${v}>`;

  return null;
}

export function classSpecEmoji(
  classKey?: string,
  specKey?: string,
  role?: RoleKey
): string {
  const key = keyFor(classKey, specKey);

  if (key && cfg.allowExternalEmoji) {
    const raw = cfg.customEmoji?.[key];        // comes from EMOJI_MAP_JSON / EMOJI_MAP
    const token = raw ? toEmojiToken(key, raw) : null;
    if (token) return token;                    // always "<:name:id>" or "<a:name:id>"
  }

  // fallback (Unicode)
  return role ? (ROLE_FALLBACK[role] ?? '•') : '•';
}
