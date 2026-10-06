// Icon-library nodes. pen.dev draws them with icon fonts – lucide 0.563.0, Phosphor 1.4.2, Material Symbols (a
// Google variable font addressed by ligatures) and feather. The converter loads the same fonts (cached) and draws the
// glyph outlines as vector shapes, placed like pen.dev places them (measured against its renders): the em square
// centred on the shorter side of the box – Material Symbols at 90 % of it. Feather comes from its SVGs.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FontMetrics } from '../util/fontmetrics.ts';

export interface IconShape {
  d: string;
  stroke: boolean;
  strokeWidth: number;
  cap: number;
  join: number;
  evenOdd: boolean;
}

export interface IconSvg {
  /** coordinate space of the shapes that is fitted (centred, uniformly scaled) into the node box */
  viewBox: { x: number; y: number; w: number; h: number };
  shapes: IconShape[];
}

export interface IconRequest {
  library: string;
  name: string;
  weight?: number;
  /** drawn size (the shorter side of the box) */
  size: number;
}

const LUCIDE = 'https://unpkg.com/lucide-static@0.563.0/font';
const PHOSPHOR = 'https://unpkg.com/phosphor-icons@1.4.2/src';

export function iconKey(r: IconRequest): string {
  return `${r.library.trim().toLowerCase()}|${r.name.trim()}|${r.weight ?? ''}|${MATERIAL.test(r.library.trim().toLowerCase()) ? materialOpsz(r.size) : ''}`;
}

const MATERIAL = /^material symbols (outlined|rounded|sharp)$/;

/**
 * Optical size pen.dev draws Material Symbols at: the variable font's default (48), whatever the size. pen.dev pins an
 * older release of the font, so a few glyphs differ slightly from the current one.
 */
function materialOpsz(_size: number): number {
  return 48;
}

export function knownLibrary(library: string): boolean {
  const lib = library.trim().toLowerCase();
  return lib === 'lucide' || lib === 'feather' || lib === 'phosphor' || MATERIAL.test(lib);
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? (m[2] ?? m[3]) : undefined;
}

function num(tag: string, name: string, fallback = 0): number {
  const v = attr(tag, name);
  const n = v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

const f = (n: number) => Math.round(n * 10000) / 10000;

function ellipseD(cx: number, cy: number, rx: number, ry: number): string {
  return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
}

function rectD(x: number, y: number, w: number, h: number, rx: number, ry: number): string {
  if (!rx && !ry) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
  rx = Math.min(rx || ry, w / 2);
  ry = Math.min(ry || rx, h / 2);
  return `M${f(x + rx)} ${f(y)}H${f(x + w - rx)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w)} ${f(y + ry)}V${f(y + h - ry)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w - rx)} ${f(y + h)}H${f(x + rx)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x)} ${f(y + h - ry)}V${f(y + ry)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + rx)} ${f(y)}Z`;
}

/** The drawable elements of a simple icon SVG (no transforms, no gradients). */
export function parseIconSvg(svg: string): IconSvg | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return null;
  const vb = (attr(root, 'viewBox') ?? '').split(/[\s,]+/).map(Number);
  const viewBox = vb.length === 4 && vb.every(Number.isFinite) ? { x: vb[0]!, y: vb[1]!, w: vb[2]!, h: vb[3]! } : { x: 0, y: 0, w: num(root, 'width', 24), h: num(root, 'height', 24) };
  const inherit = (tag: string, name: string) => attr(tag, name) ?? attr(root, name);
  const shapes: IconShape[] = [];
  const body = svg.replace(/<(defs|clipPath|mask|title|desc)\b[\s\S]*?<\/\1>/gi, '');
  for (const m of body.matchAll(/<(path|circle|ellipse|rect|line|polyline|polygon)\b[^>]*>/gi)) {
    const tag = m[0];
    const kind = m[1]!.toLowerCase();
    let d = '';
    if (kind === 'path') d = attr(tag, 'd') ?? '';
    else if (kind === 'circle') d = ellipseD(num(tag, 'cx'), num(tag, 'cy'), num(tag, 'r'), num(tag, 'r'));
    else if (kind === 'ellipse') d = ellipseD(num(tag, 'cx'), num(tag, 'cy'), num(tag, 'rx'), num(tag, 'ry'));
    else if (kind === 'rect') d = rectD(num(tag, 'x'), num(tag, 'y'), num(tag, 'width'), num(tag, 'height'), num(tag, 'rx'), num(tag, 'ry'));
    else if (kind === 'line') d = `M${num(tag, 'x1')} ${num(tag, 'y1')}L${num(tag, 'x2')} ${num(tag, 'y2')}`;
    else {
      const pts = (attr(tag, 'points') ?? '').trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i + 1 < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i]} ${pts[i + 1]}`;
      if (kind === 'polygon') d += 'Z';
    }
    if (!d) continue;
    const fill = inherit(tag, 'fill');
    const stroke = inherit(tag, 'stroke');
    const opacity = attr(tag, 'opacity');
    if (opacity !== undefined && parseFloat(opacity) < 0.5) continue; // duotone backgrounds
    const stroked = !!stroke && stroke !== 'none';
    const filled = fill !== 'none' && !(stroked && fill === undefined && attr(root, 'fill') === 'none');
    const cap = inherit(tag, 'stroke-linecap');
    const joinV = inherit(tag, 'stroke-linejoin');
    const base = { d, strokeWidth: parseFloat(inherit(tag, 'stroke-width') ?? '1') || 1, cap: cap === 'round' ? 1 : cap === 'square' ? 2 : 0, join: joinV === 'round' ? 1 : joinV === 'bevel' ? 2 : 0, evenOdd: inherit(tag, 'fill-rule') === 'evenodd' };
    if (filled) shapes.push({ ...base, stroke: false });
    if (stroked) shapes.push({ ...base, stroke: true });
  }
  return shapes.length ? { viewBox, shapes } : null;
}

/** A glyph of an icon font: its outline in the em square, `scale` = share of the box the em square takes. */
function glyphIcon(font: FontMetrics, glyph: number | null, scale = 1): IconSvg | null {
  if (glyph === null || !glyph) return null;
  const d = font.outline(glyph);
  if (!d) return null;
  const em = font.unitsPerEm;
  const size = em / scale;
  // the em square spans y = −em … 0 (baseline at 0, y down); it is centred in the box
  return { viewBox: { x: (em - size) / 2, y: -em - (size - em) / 2, w: size, h: size }, shapes: [{ d, stroke: false, strokeWidth: 0, cap: 0, join: 0, evenOdd: false }] };
}

class Cache {
  constructor(
    private dir: string,
    private download: boolean,
  ) {}

  async get(url: string): Promise<Uint8Array | null> {
    const file = join(this.dir, url.replace(/^https:\/\/[^/]+\//, '').replace(/[^A-Za-z0-9._@-]+/g, '_'));
    if (existsSync(file)) return new Uint8Array(readFileSync(file));
    if (!this.download) return null;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': '' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return null;
      const data = new Uint8Array(await res.arrayBuffer());
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.part`, data);
      renameSync(`${file}.part`, file);
      return data;
    } catch {
      return null;
    }
  }

  async text(url: string): Promise<string | null> {
    const d = await this.get(url);
    return d ? new TextDecoder().decode(d) : null;
  }
}

/** Static instance of a Material Symbols family at pen.dev's axis values (cached). */
async function materialFont(cache: Cache, style: string, weight: number, opsz: number): Promise<FontMetrics | null> {
  const family = `Material Symbols ${style[0]!.toUpperCase()}${style.slice(1)}`;
  const w = Math.min(700, Math.max(100, Math.round(weight)));
  const css = await cache.text(`https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:opsz,wght,FILL,GRAD@${opsz},${w},0,0`);
  const url = css && /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/.exec(css)?.[1];
  const data = url ? await cache.get(url) : null;
  return data ? new FontMetrics(data) : null;
}

/** Loads (or reads from the cache) the icons a document uses. */
export async function loadIcons(requests: IconRequest[], cacheDir: string, download: boolean): Promise<Map<string, IconSvg | null>> {
  const cache = new Cache(join(cacheDir, 'icons'), download);
  const out = new Map<string, IconSvg | null>();
  const unique = new Map(requests.map((r) => [iconKey(r), r]));
  const lazy = <T>(load: () => Promise<T>) => {
    let p: Promise<T> | null = null;
    return () => (p ??= load());
  };
  const lucide = lazy(async () => {
    const [font, info] = await Promise.all([cache.get(`${LUCIDE}/lucide.ttf`), cache.text(`${LUCIDE}/info.json`)]);
    return font && info ? { font: new FontMetrics(font), map: JSON.parse(info) as Record<string, { encodedCode: string }> } : null;
  });
  const phosphor = lazy(async () => {
    const [font, map] = await Promise.all([cache.get(`${PHOSPHOR}/fonts/Phosphor.ttf`), cache.text(`${PHOSPHOR}/unicodesMap.json`)]);
    return font && map ? { font: new FontMetrics(font), map: JSON.parse(map) as Record<string, number> } : null;
  });
  const material = new Map<string, Promise<FontMetrics | null>>();
  await Promise.all(
    [...unique.entries()].map(async ([key, r]) => {
      const lib = r.library.trim().toLowerCase();
      const name = r.name.trim();
      let icon: IconSvg | null = null;
      try {
        if (lib === 'lucide') {
          const l = await lucide();
          const code = l?.map[name]?.encodedCode;
          if (l && code) icon = glyphIcon(l.font, l.font.glyph(parseInt(code.replace(/^\\/, ''), 16)));
        } else if (lib === 'phosphor') {
          const p = await phosphor();
          const w = r.weight ?? 400;
          const style = w <= 150 ? '-thin' : w <= 300 ? '-light' : w <= 500 ? '' : '-bold';
          const code = p?.map[`ph-${name}${style}`] ?? p?.map[`ph-${name}`];
          if (p && code) icon = glyphIcon(p.font, p.font.glyph(code));
        } else if (MATERIAL.test(lib)) {
          const style = MATERIAL.exec(lib)![1]!;
          const opsz = materialOpsz(r.size);
          const k = `${style}|${r.weight ?? 400}|${opsz}`;
          if (!material.has(k)) material.set(k, materialFont(cache, style, r.weight ?? 400, opsz));
          const font = await material.get(k)!;
          if (font) icon = glyphIcon(font, font.ligature(name), 0.9);
        } else if (lib === 'feather') {
          const svg = await cache.text(`https://cdn.jsdelivr.net/npm/feather-icons@4/dist/icons/${encodeURIComponent(name)}.svg`);
          if (svg) icon = parseIconSvg(svg);
          // pen.dev's feather font sits a little higher than the SVGs (measured: 0.2 of 24 units)
          if (icon) icon.viewBox.y += 0.2;
        }
      } catch {
        icon = null;
      }
      out.set(key, icon);
    }),
  );
  return out;
}
