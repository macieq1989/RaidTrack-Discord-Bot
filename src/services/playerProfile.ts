// src/services/playerProfile.ts
import { prisma } from '../util/prisma.js';

export const CLASS_SPECS: Record<string, string[]> = {
  WARRIOR: ['ARMS','FURY','PROTECTION'],
  PALADIN: ['HOLY','PROTECTION','RETRIBUTION'],
  HUNTER:  ['BEAST_MASTERY','MARKSMANSHIP','SURVIVAL'],
  ROGUE:   ['ASSASSINATION','OUTLAW','SUBTLETY'],
  PRIEST:  ['DISCIPLINE','HOLY','SHADOW'],
  DEATHKNIGHT: ['BLOOD','FROST','UNHOLY'],
  SHAMAN:  ['ELEMENTAL','ENHANCEMENT','RESTORATION'],
  MAGE:    ['ARCANE','FIRE','FROST'],
  WARLOCK: ['AFFLICTION','DEMONOLOGY','DESTRUCTION'],
  MONK:    ['BREWMASTER','MISTWEAVER','WINDWALKER'],
  DRUID:   ['BALANCE','FERAL','GUARDIAN','RESTORATION'],
  DEMONHUNTER: ['HAVOC','VENGEANCE'],
  EVOKER:  ['DEVASTATION','PRESERVATION','AUGMENTATION'],
};

export type WowClass = keyof typeof CLASS_SPECS;
export type WowSpec = string;

export function isValidClassSpec(cls: string, spec: string): boolean {
  const C = String(cls || '').toUpperCase().replace(/\s+/g,'');
  const S = String(spec || '').toUpperCase().replace(/\s+/g,'_');
  return !!CLASS_SPECS[C]?.includes(S);
}

export function listClasses(): WowClass[] {
  return Object.keys(CLASS_SPECS) as WowClass[];
}

export function listSpecs(cls: string): string[] {
  const C = String(cls || '').toUpperCase().replace(/\s+/g,'');
  return CLASS_SPECS[C] ?? [];
}

export async function getPlayerProfile(guildId: string, userId: string) {
  return prisma.playerProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
  });
}

export async function upsertPlayerProfile(
  guildId: string,
  userId: string,
  classKey: string,
  specKey: string
) {
  const C = classKey.toUpperCase().replace(/\s+/g,'');
  const S = specKey.toUpperCase().replace(/\s+/g,'_');
  if (!isValidClassSpec(C, S)) throw new Error(`Invalid class/spec: ${classKey}/${specKey}`);
  return prisma.playerProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, classKey: C, specKey: S },
    update: { classKey: C, specKey: S },
  });
}
