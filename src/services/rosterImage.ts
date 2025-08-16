// src/services/rosterImage.ts
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { AttachmentBuilder } from 'discord.js';
import { prisma } from '../util/prisma.js';

export type RoleKey = 'TANK'|'HEALER'|'MELEE'|'RANGED'|'MAYBE'|'ABSENT';

export type PlayerEntry = {
  userId: string;
  displayName: string;
  classKey?: string;
  specKey?: string;
};

export type SignupsGrouped = {
  tank: PlayerEntry[];
  healer: PlayerEntry[];
  melee: PlayerEntry[];
  ranged: PlayerEntry[];
};

export type RawSignup = { userId: string; username: string; role: RoleKey };
export type RaidCaps = { tank?: number; healer?: number; melee?: number; ranged?: number };

const ASSET_ICON_DIR = process.env.ASSET_ICON_DIR || '/app/assets/icons';
const ICON_OFFLINE_ONLY = String(process.env.ICON_OFFLINE_ONLY ?? 'true') === 'true';

async function fileExists(p: string) {
  try { await fs.access(p); return true; } catch { return false; }
}

function localIconCandidates(cls?: string, spec?: string) {
  const c = (cls || '').toLowerCase();
  const s = (spec || '').toLowerCase();
  if (!c || !s) return [];
  return [
    `rt_${c}_${s}.png`,
    `${c}_${s}.png`,
    `${c}-${s}.png`,
  ].map(f => path.join(ASSET_ICON_DIR, f));
}

async function loadIconForProfile(cls?: string, spec?: string): Promise<Buffer> {
  // 1) spróbuj znaleźć lokalny plik class+spec
  for (const p of localIconCandidates(cls, spec)) {
    if (await fileExists(p)) return fs.readFile(p);
  }
  // 2) fallback: sama klasa (np. rt_paladin.png)
  if (cls) {
    const alt = path.join(ASSET_ICON_DIR, `rt_${cls.toLowerCase()}.png`);
    if (await fileExists(alt)) return fs.readFile(alt);
  }
  // 3) zawsze wracamy pustą (przezroczystą) ikonkę
  return sharp({
    create: { width: 48, height: 48, channels: 4, background: { r:0, g:0, b:0, alpha:0 } }
  }).png().toBuffer();
}


const CLASS_COLOR: Record<string, string> = {
  warrior: '#C79C6E',
  paladin: '#F58CBA',
  hunter: '#ABD473',
  rogue: '#FFF569',
  priest: '#FFFFFF',
  death_knight: '#C41F3B',
  shaman: '#0070DE',
  mage: '#40C7EB',
  warlock: '#8787ED',
  monk: '#00FF96',
  druid: '#FF7D0A',
  demon_hunter: '#A330C9',
  evoker: '#33937F',
};

function svgText(label: string, width: number, height: number, fill = '#E5E7EB', size = 18) {
  const esc = label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <style>.t{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,'Noto Sans',sans-serif;font-weight:600;fill:${fill};font-size:${size}px;}</style>
      <text x="0" y="${Math.round(height*0.7)}" class="t">${esc}</text>
    </svg>`
  );
}

function svgHeader(label: string, width: number, accent = '#64748B') {
  const esc = label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="28">
      <rect x="0" y="20" width="${width}" height="2" fill="${accent}" />
      <style>.h{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,'Noto Sans',sans-serif;font-weight:700;fill:#CBD5E1;font-size:15px;}</style>
      <text x="0" y="16" class="h">${esc}</text>
    </svg>`
  );
}

function prettySpec(s?: string) {
  if (!s) return '';
  return s.replace(/_/g,' ').replace(/\b\w/g, m => m.toUpperCase());
}

async function groupRawSignups(raw: RawSignup[], guildId?: string): Promise<SignupsGrouped> {
  const grouped: SignupsGrouped = { tank: [], healer: [], melee: [], ranged: [] };
  let profileMap: Record<string, { classKey?: string; specKey?: string }> = {};
  if (guildId && raw.length) {
    const ids = Array.from(new Set(raw.map(r => r.userId)));
    const prof = await prisma.playerProfile.findMany({
      where: { guildId, userId: { in: ids } },
      select: { userId: true, classKey: true, specKey: true },
    });
    profileMap = Object.fromEntries(
      prof.map(p => [p.userId, { classKey: p.classKey || undefined, specKey: p.specKey || undefined }])
    );
  }
  const push = (key: keyof SignupsGrouped, r: RawSignup) => {
    const prof = profileMap[r.userId] || {};
    grouped[key].push({
      userId: r.userId,
      displayName: r.username,
      classKey: prof.classKey,
      specKey: prof.specKey,
    });
  };
  for (const r of raw) {
    switch (r.role) {
      case 'TANK':   push('tank', r); break;
      case 'HEALER': push('healer', r); break;
      case 'MELEE':  push('melee', r); break;
      case 'RANGED': push('ranged', r); break;
    }
  }
  return grouped;
}

function isGrouped(x: any): x is SignupsGrouped {
  return x && typeof x === 'object' && Array.isArray(x.tank);
}

export async function buildRosterImage(params: {
  title: string;
  startAt: number;
  caps?: RaidCaps;
  signups: SignupsGrouped | RawSignup[];
  guildId?: string;
}): Promise<{ attachment: AttachmentBuilder; filename: string }> {
  const { title, startAt, caps } = params;
  const signupsGrouped: SignupsGrouped = isGrouped(params.signups)
    ? params.signups
    : await groupRawSignups(params.signups as RawSignup[], params.guildId);

  const W = 1024, P = 24;
  const COLS = ['tank','healer','melee','ranged'] as const;
  const gap = 16;
  const colW = Math.floor((W - P*2 - gap*(COLS.length-1)) / COLS.length);
  const rowH = 64, headerH = 72, subH = 28;
  const counts = {
    tank: signupsGrouped.tank.length,
    healer: signupsGrouped.healer.length,
    melee: signupsGrouped.melee.length,
    ranged: signupsGrouped.ranged.length,
  };
  const maxRows = Math.max(...Object.values(counts), 1);
  const H = headerH + subH + maxRows*rowH + P*2;

  const base = sharp({ create: { width: W, height: H, channels: 4, background: { r:2,g:6,b:23,alpha:1 } } }).png();
  const composites: sharp.OverlayOptions[] = [];

  // nagłówek
  const titleSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W-P*2}" height="${headerH}">
      <style>
        .tt{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,'Noto Sans';font-weight:700;fill:#E2E8F0;font-size:26px;}
        .sd{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,'Noto Sans';font-weight:500;fill:#94A3B8;font-size:16px;}
      </style>
      <text x="0" y="28" class="tt">${title.replace(/&/g,'&amp;')}</text>
      <text x="0" y="54" class="sd">&lt;t:${startAt}:F&gt;</text>
    </svg>`
  );
  composites.push({ input: titleSvg, top: P, left: P });

  // kolumny
  const headers: Record<typeof COLS[number], string> = {
    tank:   `Tanks ${counts.tank}${caps?.tank?'/'+caps.tank:''}`,
    healer: `Healers ${counts.healer}${caps?.healer?'/'+caps.healer:''}`,
    melee:  `Melee ${counts.melee}${caps?.melee?'/'+caps.melee:''}`,
    ranged: `Ranged ${counts.ranged}${caps?.ranged?'/'+caps.ranged:''}`,
  };

  const startY = P + headerH;
  for (let idx=0; idx<COLS.length; idx++) {
    const role = COLS[idx];
    const left = P + idx*(colW+gap);
    composites.push({ input: svgHeader(headers[role], colW), top: startY, left });

    const list = signupsGrouped[role];
    for (let i=0;i<list.length;i++){
      const entry = list[i];
      const top = startY + subH + i*rowH + 8;

      const iconBuf = await loadIconForProfile(entry.classKey, entry.specKey);
      const icon = await sharp(iconBuf).resize(48,48).png().toBuffer();
      composites.push({ input: icon, top, left });

      const color = CLASS_COLOR[entry.classKey || ''] || '#E5E7EB';
      const label = `${entry.displayName}${entry.specKey ? '  •  ' + prettySpec(entry.specKey) : ''}`;
      composites.push({ input: svgText(label, colW-56, 48, color, 18), top: top+16, left: left+56 });
    }
  }

  const buf = await base.composite(composites).png().toBuffer();
  const filename = `raid_roster_${Date.now()}.png`;
  const attachment = new AttachmentBuilder(buf, { name: filename });
  return { attachment, filename };
}
