import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export type LootKeyInput = {
  timestamp?: number;
  id?: number;
  player?: string;
  itemId?: string | number;
  gp?: number;
  boss?: string;
  time?: string; // fallback
};

export function makeLootKey(x: LootKeyInput): string {
  // prefer timestamp; fallback to id; w ostateczności time string
  const tsPart =
    Number.isFinite(x.timestamp as number) && (x.timestamp as number) > 0
      ? String(x.timestamp)
      : (Number.isFinite(x.id as number) ? String(x.id) : (x.time ?? "0"));

  const player = (x.player ?? "").trim().toLowerCase();
  const itemId = x.itemId != null ? String(x.itemId) : "";
  const gp = Number.isFinite(x.gp as number) ? String(x.gp) : "";
  const boss = (x.boss ?? "").trim().toLowerCase();

  // stała kolejność pól – deterministyczny klucz
  return `${tsPart}|${player}|${itemId}|${gp}|${boss}`;
}

/** Zwraca tylko te klucze, których jeszcze nie ma w DB. */
export async function filterNewLootKeys(keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  const existing = await prisma.lootPost.findMany({
    where: { lootKey: { in: keys } },
    select: { lootKey: true },
  });
  const existingSet = new Set(existing.map(e => e.lootKey));
  return keys.filter(k => !existingSet.has(k));
}

/** Zapisz zestaw kluczy po udanym publishu (idempotentnie). */
export async function saveLootKeys(keys: string[]): Promise<void> {
  if (!keys.length) return;

  // Idempotentnie: dla każdego klucza upsert (create jeśli nie ma, update pusty jeśli już jest)
  await prisma.$transaction(
    keys.map((k) =>
      prisma.lootPost.upsert({
        where: { lootKey: k },
        update: {},                 // nic nie zmieniamy, ważne że nie rzuci na duplikacie
        create: { lootKey: k },
      })
    )
  );
}


