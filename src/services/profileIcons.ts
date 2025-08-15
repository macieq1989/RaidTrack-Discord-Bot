// src/services/profileIcons.ts
type RoleKey = 'TANK' | 'HEALER' | 'MELEE' | 'RANGED' | 'MAYBE' | 'ABSENT';

// opcjonalne nadpisania emoji z ENV:
// CLASS_SPEC_EMOJI_JSON={"PALADIN:RETRIBUTION":"<:pal_retri:1234567890>"}
const ENV_EMOJI: Record<string, string> = (() => {
  try { return JSON.parse(process.env.CLASS_SPEC_EMOJI_JSON ?? '{}'); }
  catch { return {}; }
})();

// proste fallbacki gdy nie ustawisz custom emoji
const ROLE_FALLBACK: Record<RoleKey, string> = {
  TANK:   '🛡️',
  HEALER: '✚',
  MELEE:  '⚔️',
  RANGED: '🏹',
  MAYBE:  '❔',
  ABSENT: '🚫',
};

export function classSpecEmoji(
  classKey?: string,
  specKey?: string,
  role?: RoleKey
): string {
  const k = classKey && specKey
    ? `${classKey.toUpperCase().replace(/\s+/g,'')}:${specKey.toUpperCase().replace(/\s+/g,'_')}`
    : '';
  if (k && ENV_EMOJI[k]) return ENV_EMOJI[k];
  return role ? ROLE_FALLBACK[role] : '•';
}
