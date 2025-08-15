// src/services/mapping.ts

export type Difficulty = 'NORMAL' | 'HEROIC' | 'MYTHIC' | string;

export type RaidPayload = {
  raidId: string;
  raidTitle: string;        // EXACT title from addon
  difficulty: Difficulty;
  startAt: number;          // unix seconds
  endAt?: number;           // unix seconds (optional; fallback set in publisher)
  notes?: string;
  caps?: { tank?: number; healer?: number; melee?: number; ranged?: number };
};

export const DISCORD_LIMITS = {
  EMBED_TITLE: 256,
  EVENT_NAME: 100,
  EMBED_DESC: 4096,
} as const;

function clampText(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

export function clampEmbedTitle(t: string): string {
  return clampText(String(t ?? ''), DISCORD_LIMITS.EMBED_TITLE);
}

export function clampEventTitle(t: string): string {
  return clampText(String(t ?? ''), DISCORD_LIMITS.EVENT_NAME);
}

/** Optional helper if you ever clamp descriptions (4096 chars) */
export function clampDescription(s?: string): string | undefined {
  if (!s) return undefined;
  return clampText(s, DISCORD_LIMITS.EMBED_DESC);
}

/** Normalize difficulty to uppercase + common aliases */
export function normalizeDifficultyLabel(s?: string): Difficulty {
  const x = String(s || '').trim().toLowerCase();
  if (!x) return 'NORMAL';
  if (x.startsWith('myth')) return 'MYTHIC';
  if (x.startsWith('hero') || x === 'hc') return 'HEROIC';
  // traktujemy „normal”, „norm”, a także „10/25 Player”, „lfr” jako NORMAL na potrzeby routingu
  return 'NORMAL';
}

/** derive difficulty from selectedDifficulty or from bosses EP sums */
export function deriveDifficultyFromPresetConfig(cfg?: {
  selectedDifficulty?: string;
  bosses?: Record<string, Record<string, number>>;
}): Difficulty {
  if (!cfg) return 'NORMAL';

  if (cfg.selectedDifficulty) {
    return normalizeDifficultyLabel(cfg.selectedDifficulty);
  }

  // fallback: zsumuj EP per diff w 'bosses'
  let sumN = 0, sumH = 0, sumM = 0;
  const bosses = cfg.bosses || {};
  for (const boss of Object.values(bosses)) {
    // boss: { Normal: 23, Heroic: 0, Mythic: 0, ... }
    for (const [k, v] of Object.entries(boss || {})) {
      const n = Number(v) || 0;
      const key = k.trim().toLowerCase();
      if (key.startsWith('myth')) sumM += n;
      else if (key.startsWith('hero')) sumH += n;
      else if (key.startsWith('norm') || key.includes('player') || key === 'lfr') sumN += n;
    }
  }
  if (sumM > 0) return 'MYTHIC';
  if (sumH > 0) return 'HEROIC';
  return 'NORMAL';
}

/** Ensure we keep unix seconds as an integer >= 0 */
export function toUnixSeconds(n: number | string | Date): number {
  if (n instanceof Date) return Math.floor(n.getTime() / 1000);
  const x = typeof n === 'string' ? Number(n) : n;
  return Math.max(0, Math.floor(Number.isFinite(x as number) ? (x as number) : 0));
}
