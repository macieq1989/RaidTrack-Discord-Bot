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
export function normalizeDifficulty(d: string): string {
  const v = (d || '').trim().toUpperCase();
  if (v === 'N' || v === 'NORMAL') return 'NORMAL';
  if (v === 'H' || v === 'HEROIC') return 'HEROIC';
  if (v === 'M' || v === 'MYTHIC') return 'MYTHIC';
  return v; // pass-through for presets like "SUNWEL" etc.
}

/** Ensure we keep unix seconds as an integer >= 0 */
export function toUnixSeconds(n: number | string | Date): number {
  if (n instanceof Date) return Math.floor(n.getTime() / 1000);
  const x = typeof n === 'string' ? Number(n) : n;
  return Math.max(0, Math.floor(Number.isFinite(x as number) ? (x as number) : 0));
}
