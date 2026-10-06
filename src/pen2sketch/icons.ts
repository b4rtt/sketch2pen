// Icon-library nodes (lucide, feather, Material Symbols, Phosphor): pen.dev draws them from the libraries' SVGs.
// The converter loads the same SVGs (cached) and draws them as vector shapes.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface IconShape {
  d: string;
  stroke: boolean;
  strokeWidth: number;
  cap: number;
  join: number;
  evenOdd: boolean;
}

export interface IconSvg {
  viewBox: { x: number; y: number; w: number; h: number };
  shapes: IconShape[];
}

/** CDN url of an icon's SVG, or null for an unknown library. */
export function iconUrl(library: string, name: string, weight?: number): string | null {
  const lib = library.trim().toLowerCase();
  const icon = encodeURIComponent(name.trim());
  if (!icon) return null;
  if (lib === 'lucide') return `https://cdn.jsdelivr.net/npm/lucide-static@latest/icons/${icon}.svg`;
  if (lib === 'feather') return `https://cdn.jsdelivr.net/npm/feather-icons@4/dist/icons/${icon}.svg`;
  const material = /^material symbols (outlined|rounded|sharp)$/.exec(lib);
  if (material) {
    const w = Math.min(700, Math.max(100, Math.round((weight ?? 400) / 100) * 100));
    return `https://cdn.jsdelivr.net/npm/@material-symbols/svg-${w}@latest/${material[1]}/${icon}.svg`;
  }
  if (lib === 'phosphor') {
    const w = weight ?? 400;
    const style = w <= 150 ? 'thin' : w <= 300 ? 'light' : w <= 500 ? 'regular' : 'bold';
    return `https://cdn.jsdelivr.net/npm/@phosphor-icons/core@2/assets/${style}/${icon}${style === 'regular' ? '' : `-${style}`}.svg`;
  }
  return null;
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

/** Downloads (or reads from the cache) icon SVGs. */
export async function loadIcons(urls: string[], cacheDir: string, download: boolean): Promise<Map<string, IconSvg | null>> {
  const out = new Map<string, IconSvg | null>();
  await Promise.all(
    [...new Set(urls)].map(async (url) => {
      const file = join(cacheDir, 'icons', url.replace(/^https:\/\/cdn\.jsdelivr\.net\/npm\//, '').replace(/[^A-Za-z0-9._@-]+/g, '_'));
      let text: string | null = null;
      if (existsSync(file)) text = readFileSync(file, 'utf8');
      else if (download) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
          if (res.ok) {
            text = await res.text();
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(`${file}.part`, text);
            renameSync(`${file}.part`, file);
          }
        } catch {
          text = null;
        }
      }
      out.set(url, text ? parseIconSvg(text) : null);
    }),
  );
  return out;
}
