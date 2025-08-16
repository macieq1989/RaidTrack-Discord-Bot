// src/services/profileIcons.ts
import { cfg } from '../config.js';
type RoleKey = 'TANK'|'HEALER'|'MELEE'|'RANGED'|'MAYBE'|'ABSENT';

const ROLE_FALLBACK: Record<RoleKey,string> = {
  TANK:'🛡️', HEALER:'✚', MELEE:'⚔️', RANGED:'🏹', MAYBE:'❔', ABSENT:'🚫',
};

function norm(s?: string){ return (s??'').toLowerCase().trim().replace(/\s+|-/g,'_'); }
function normClass(s?: string){ const t=norm(s); if(t==='deathknight')return'death_knight'; if(t==='demonhunter')return'demon_hunter'; return t; }
function keyFor(cls?: string,spec?: string){ const c=normClass(cls), s=norm(spec); return c&&s?`${c}_${s}`:null; }

function toEmojiToken(name: string, value: string): string | null {
  const v=(value??'').trim();
  if(!v) return null;
  if(/^<a?:[^:>]+:\d+>$/.test(v)) return v;           // full token
  const m=/^a:(\d+)$/.exec(v); if(m) return `<a:${name}:${m[1]}>`; // animated
  if(/^\d+$/.test(v)) return `<:${name}:${v}>`;        // static by id
  return null;
}

export function classSpecEmoji(classKey?: string, specKey?: string, role?: RoleKey): string {
  const k = keyFor(classKey, specKey);
  if (k && cfg.allowExternalEmoji) {
    const raw = cfg.customEmoji?.[k];
    const tok = raw ? toEmojiToken(k, raw) : null;
    if (tok) return tok;
  }
  return role ? (ROLE_FALLBACK[role] ?? '•') : '•';
}
