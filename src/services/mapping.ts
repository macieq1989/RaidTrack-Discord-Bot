export type RaidPayload = {
  raidId: string;
  raidTitle: string;       // EXACT title from addon
  difficulty: 'NORMAL' | 'HEROIC' | 'MYTHIC' | string;
  startAt: number;         // unix seconds
  notes?: string;
  caps?: { tank?: number; healer?: number; melee?: number; ranged?: number };
};

export function clampEmbedTitle(t: string): string {
  return t.length > 256 ? t.slice(0, 253) + '...' : t;
}
export function clampEventTitle(t: string): string {
  const LIMIT = 100; // safety for scheduled events
  return t.length > LIMIT ? t.slice(0, LIMIT - 3) + '...' : t;
}
