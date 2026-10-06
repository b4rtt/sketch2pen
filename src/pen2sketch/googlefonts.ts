// Google Fonts as pen.dev renders them. pen.dev loads each family's variable font and draws it at the font's default
// axis values – the default optical size of DM Sans is 9, for example, while Google's static fonts are cut at 14.
// The converter downloads static instances at exactly those axis values: Sketch renders them like pen.dev, and the
// layout measures the same advances.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GOOGLE_FONT_FAMILIES } from '../data/google-fonts.ts';

export interface GoogleFamily {
  family: string;
  /** variable axes (tag, min, max) – empty for static families */
  axes: { tag: string; min: number; max: number; defaultValue: number }[];
  /** available static styles, e.g. "400", "700i" */
  fonts: string[];
}

const METADATA_URL = 'https://fonts.google.com/metadata/fonts';
const MAX_AGE = 30 * 24 * 3600 * 1000;

function writeAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.part`, data);
  renameSync(`${path}.part`, path);
}

async function get(url: string, timeout = 30_000): Promise<Response | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': '' }, signal: AbortSignal.timeout(timeout) });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

/** Default axis values from a font's fvar table. */
export function fvarDefaults(data: Uint8Array): Record<string, number> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = v.getUint16(4);
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const tag = String.fromCharCode(v.getUint8(r), v.getUint8(r + 1), v.getUint8(r + 2), v.getUint8(r + 3));
    if (tag !== 'fvar') continue;
    const o = v.getUint32(r + 8);
    const axesOffset = v.getUint16(o + 4);
    const count = v.getUint16(o + 8);
    const size = v.getUint16(o + 10);
    const out: Record<string, number> = {};
    for (let a = 0; a < count; a++) {
      const p = o + axesOffset + a * size;
      const t = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
      out[t] = v.getInt32(p + 8) / 65536;
    }
    return out;
  }
  return {};
}

/** css2 API axis order: lower-case tags first, then upper-case, each alphabetical. */
function cssAxisOrder(a: string, b: string): number {
  const la = a === a.toLowerCase();
  const lb = b === b.toLowerCase();
  if (la !== lb) return la ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export class GoogleFonts {
  private meta: Map<string, GoogleFamily> | null = null;
  private defaults: Record<string, Record<string, number>> = {};
  private defaultsFile: string;

  constructor(
    private dir: string,
    private download: boolean,
  ) {
    this.defaultsFile = join(dir, 'axis-defaults.json');
    try {
      this.defaults = JSON.parse(readFileSync(this.defaultsFile, 'utf8'));
    } catch {
      this.defaults = {};
    }
  }

  private async metadata(): Promise<Map<string, GoogleFamily>> {
    if (this.meta) return this.meta;
    const file = join(this.dir, 'metadata.json');
    let list: GoogleFamily[] | null = null;
    const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < MAX_AGE;
    if (fresh || (existsSync(file) && !this.download)) {
      try {
        list = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        list = null;
      }
    }
    if (!list && this.download) {
      const res = await get(METADATA_URL, 60_000);
      if (res) {
        const text = await res.text();
        try {
          const json = JSON.parse(text.slice(text.indexOf('{'))) as { familyMetadataList: { family: string; axes?: GoogleFamily['axes']; fonts?: Record<string, unknown> }[] };
          list = json.familyMetadataList.map((f) => ({ family: f.family, axes: f.axes ?? [], fonts: Object.keys(f.fonts ?? {}) }));
          writeAtomic(file, JSON.stringify(list));
        } catch {
          list = null;
        }
      }
      if (!list && existsSync(file)) {
        try {
          list = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          list = null;
        }
      }
    }
    this.meta = new Map((list ?? GOOGLE_FONT_FAMILIES.map((family) => ({ family, axes: [], fonts: [] }))).map((f) => [f.family.toLowerCase(), f]));
    return this.meta;
  }

  async family(name: string): Promise<GoogleFamily | undefined> {
    return (await this.metadata()).get(name.trim().toLowerCase());
  }

  /** Default values of the variable font pen.dev renders (from the font file in the google/fonts repository). */
  private async axisDefaults(fam: GoogleFamily, italic: boolean): Promise<Record<string, number>> {
    const key = `${fam.family}|${italic ? 'i' : 'n'}`;
    if (this.defaults[key]) return this.defaults[key]!;
    const fallback = Object.fromEntries(fam.axes.map((a) => [a.tag, a.defaultValue]));
    if (!fam.axes.some((a) => a.tag !== 'wght') || !this.download) return fallback;
    const dirName = fam.family.toLowerCase().replace(/[^a-z0-9]/g, '');
    const fileBase = fam.family.replace(/[^A-Za-z0-9]/g, '');
    const axes = fam.axes.map((a) => a.tag).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',');
    const name = `${fileBase}${italic ? '-Italic' : ''}[${axes}].ttf`;
    for (const license of ['ofl', 'apache', 'ufl']) {
      const res = await get(`https://raw.githubusercontent.com/google/fonts/main/${license}/${dirName}/${encodeURIComponent(name)}`);
      if (!res) continue;
      try {
        const defaults = { ...fallback, ...fvarDefaults(new Uint8Array(await res.arrayBuffer())) };
        this.defaults[key] = defaults;
        writeAtomic(this.defaultsFile, JSON.stringify(this.defaults));
        return defaults;
      } catch {
        break;
      }
    }
    return fallback;
  }

  /** The weight pen.dev draws for a requested weight (variable range, or the nearest static style). */
  async weightFor(name: string, weight: number, italic: boolean): Promise<number> {
    const fam = await this.family(name);
    if (!fam) return weight;
    const wght = fam.axes.find((a) => a.tag === 'wght');
    if (wght) return Math.min(wght.max, Math.max(wght.min, weight));
    const styles = fam.fonts.filter((s) => s.endsWith('i') === italic).map((s) => parseInt(s, 10));
    const pool = styles.length ? styles : fam.fonts.map((s) => parseInt(s, 10));
    if (!pool.length) return weight;
    return pool.reduce((best, w) => {
      const score = (x: number) => Math.abs(x - weight) + ((weight <= 400 && x > weight) || (weight >= 500 && x < weight) ? 1000 : 0);
      return score(w) < score(best) ? w : best;
    });
  }

  /** A static TrueType instance of the face pen.dev renders (cached). */
  async face(name: string, weight: number, italic: boolean): Promise<Uint8Array | null> {
    const fam = await this.family(name);
    if (!fam) return null;
    const hasItalic = !fam.fonts.length || fam.fonts.some((s) => s.endsWith('i')) || fam.axes.some((a) => a.tag === 'ital' || a.tag === 'slnt');
    const ital = italic && hasItalic;
    const w = await this.weightFor(fam.family, weight, ital);
    const axes = fam.axes.length ? await this.axisDefaults(fam, ital) : {};
    const values: Record<string, number> = { ...axes, wght: w };
    if (!fam.axes.some((a) => a.tag === 'wght') && !fam.axes.length) delete values.wght;
    const tags = Object.keys(values).sort(cssAxisOrder);
    const fileTag = tags.map((t) => `${t}${values[t]}`).join('_') || `w${w}`;
    const file = join(this.dir, fam.family.replace(/[^A-Za-z0-9]+/g, '-'), `${fileTag}${ital ? '-i' : ''}.ttf`);
    if (existsSync(file)) return new Uint8Array(readFileSync(file));
    if (!this.download) return null;
    const allTags = ['ital', ...tags].sort(cssAxisOrder);
    const all: Record<string, number> = { ...values, ital: ital ? 1 : 0 };
    const spec = fam.axes.length || tags.length ? `:${allTags.join(',')}@${allTags.map((t) => all[t]).join(',')}` : `:ital,wght@${ital ? 1 : 0},${w}`;
    let res = await get(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam.family).replace(/%20/g, '+')}${spec}`, 15_000);
    // families without the requested axes in the css2 API: ask for the plain weight
    if (!res) res = await get(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam.family).replace(/%20/g, '+')}:ital,wght@${ital ? 1 : 0},${w}`, 15_000);
    if (!res) return null;
    const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/.exec(await res.text())?.[1];
    if (!url) return null;
    const font = await get(url);
    if (!font) return null;
    const data = new Uint8Array(await font.arrayBuffer());
    writeAtomic(file, data);
    return data;
  }
}
