// Fonts for the Sketch document. pen.dev renders Google Fonts by name and fonts shipped with the .pen file; Sketch
// renders installed fonts and fonts embedded in the .sketch file. Every font a text uses is resolved to a face file
// (shipped with the .pen, downloaded from Google Fonts, or installed) – it is measured for the layout and embedded so
// Sketch renders the same typeface.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { facesFromBytes, googleFamily, installedFonts, penFamilyName, weightFromStyle, type FontFace } from '../convert/fonts.ts';
import { localPath, type PenFile } from '../pen/reader.ts';
import { FontMetrics } from '../util/fontmetrics.ts';
import { GoogleFonts } from './googlefonts.ts';
import type { Report } from './report.ts';

export type FontSource = 'document' | 'google' | 'local' | 'missing';
export type EmbedMode = 'all' | 'document' | 'none';

export interface FaceFile {
  data: Uint8Array;
  faceIndex: number;
  face: FontFace;
  /** file name for the Sketch font reference */
  fileName: string;
  origin: Exclude<FontSource, 'missing'>;
}

export interface FontChoice {
  family: string;
  weight: number;
  italic: boolean;
  /** PostScript name Sketch refers to the face by (a named instance of a variable font: its instance name) */
  postscriptName: string;
  source: FontSource;
  file?: FaceFile;
  metrics?: FontMetrics;
  /** the variable font is drawn at another weight than its default instance (measured approximately) */
  variable?: boolean;
  /** whether the face file is embedded in the .sketch document */
  embed: boolean;
}

const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

/** CSS font-weight value ("normal", "bold", "600", "semibold") → number. */
export function parseWeight(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.min(1000, value));
  const s = String(value ?? '').trim().toLowerCase();
  if (!s || s === 'normal' || s === 'regular') return 400;
  if (s === 'bold') return 700;
  if (s === 'lighter') return 300;
  if (s === 'bolder') return 700;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return Math.max(1, Math.min(1000, n));
  return weightFromStyle(s);
}

/** Conventional PostScript name of a face nobody has (e.g. "Brand Sans" 600 italic → "BrandSans-SemiBoldItalic"). */
export function guessPostscriptName(family: string, weight: number, italic: boolean): string {
  const w = WEIGHT_NAMES[Math.round(weight / 100) * 100] ?? 'Regular';
  const style = italic ? (w === 'Regular' ? 'Italic' : `${w}Italic`) : w;
  return `${family.replace(/[^A-Za-z0-9]/g, '')}-${style}`;
}

/** CSS font matching: the closest weight (preferring the matching direction), matching style first. */
function pickFace<T extends { weight: number; italic: boolean; range?: [number, number] }>(faces: T[], weight: number, italic: boolean): T | undefined {
  const styled = faces.filter((f) => f.italic === italic);
  const pool = styled.length ? styled : faces;
  let best: T | undefined;
  let bestScore = Infinity;
  for (const f of pool) {
    let d: number;
    if (f.range && weight >= f.range[0] && weight <= f.range[1]) d = 0;
    else {
      const w = f.range ? (weight < f.range[0] ? f.range[0] : f.range[1]) : f.weight;
      d = Math.abs(w - weight);
      // CSS: below 400 prefer lighter, above 500 prefer heavier
      if ((weight <= 400 && w > weight) || (weight >= 500 && w < weight)) d += 1000;
    }
    if (d < bestScore) {
      bestScore = d;
      best = f;
    }
  }
  return best;
}

export function cacheDir(): string {
  if (process.env.SKETCH2PEN_CACHE) return process.env.SKETCH2PEN_CACHE;
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library/Caches/sketch2pen');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'sketch2pen');
  return join(process.env.XDG_CACHE_HOME ?? join(home, '.cache'), 'sketch2pen');
}

interface DocEntry {
  family: string;
  weight: number;
  range?: [number, number];
  italic: boolean;
  file: FaceFile;
}

export interface FontLibraryOptions {
  embed: EmbedMode;
  /** download Google Fonts that are not cached yet */
  download: boolean;
  /** font folders to scan for installed fonts (defaults to the platform's) */
  dirs?: string[];
}

export class FontLibrary {
  private docFonts: DocEntry[] = [];
  private installed: { family: string; weight: number; italic: boolean; range?: [number, number]; face: FontFace; path: string }[] | null = null;
  private google = new Map<string, FaceFile | null>(); // "family|weight|italic" → downloaded face
  private choices = new Map<string, FontChoice>();
  private metricsCache = new Map<FaceFile, FontMetrics>();
  /** every face the document uses (for the Sketch font references) */
  readonly used = new Map<string, FontChoice>();

  constructor(
    private pen: PenFile,
    private options: FontLibraryOptions,
    private report: Report,
  ) {
    for (const f of pen.doc.fonts ?? []) {
      const url = String(f.url ?? '');
      const path = localPath(pen.dir, url);
      if (!path || !existsSync(path)) {
        report.warn('missing-font-file', 'Font shipped with the document is missing', `${f.name} (${url})`);
        continue;
      }
      const data = new Uint8Array(readFileSync(path));
      const faces = facesFromBytes(data);
      const face = faces[0];
      if (!face) continue;
      const range = Array.isArray(f.weight) ? (f.weight as [number, number]) : undefined;
      const wght = face.axes.find((a) => a.tag === 'wght');
      this.docFonts.push({
        family: f.name,
        weight: typeof f.weight === 'number' ? f.weight : (wght?.def ?? face.weight),
        range: range ?? (wght ? [wght.min, wght.max] : undefined),
        italic: f.style === 'italic' || face.italic,
        file: { data, faceIndex: 0, face, fileName: path.split(/[\\/]/).pop()!, origin: 'document' },
      });
    }
  }

  private googleKey(family: string, weight: number, italic: boolean): string {
    return `${family.toLowerCase()}|${weight}|${italic ? 1 : 0}`;
  }

  /** Downloads (or loads from the cache) the Google Fonts faces the document uses. */
  async prepare(requests: { family: string; weight: number; italic: boolean }[]): Promise<void> {
    const google = new GoogleFonts(join(cacheDir(), 'google-fonts'), this.options.download);
    const todo = new Map<string, { family: string; weight: number; italic: boolean }>();
    for (const r of requests) {
      if (this.docFonts.some((d) => d.family.toLowerCase() === r.family.toLowerCase())) continue;
      const g = googleFamily(r.family) ?? (await google.family(r.family))?.family;
      if (!g) continue;
      todo.set(this.googleKey(g, r.weight, r.italic), { ...r, family: g });
    }
    const results = await Promise.all(
      [...todo.entries()].map(async ([key, r]) => {
        const data = await google.face(r.family, r.weight, r.italic);
        return [key, data ? this.faceFile(data, 'google') : null] as const;
      }),
    );
    for (const [key, file] of results) this.google.set(key, file);
  }

  private faceFile(data: Uint8Array, origin: FaceFile['origin']): FaceFile | null {
    const face = facesFromBytes(data)[0];
    if (!face) return null;
    return { data, faceIndex: 0, face, fileName: `${face.postscriptName}.ttf`, origin };
  }

  private installedIndex() {
    if (!this.installed) {
      this.installed = installedFonts(this.options.dirs).map(({ face, file }) => {
        const wght = face.axes.find((a) => a.tag === 'wght');
        return { family: penFamilyName(face), weight: face.weight, italic: face.italic, range: wght ? ([wght.min, wght.max] as [number, number]) : undefined, face, path: file.path };
      });
    }
    return this.installed;
  }

  metrics(file: FaceFile): FontMetrics | undefined {
    let m = this.metricsCache.get(file);
    if (!m) {
      try {
        m = new FontMetrics(file.data, file.faceIndex);
      } catch {
        return undefined;
      }
      this.metricsCache.set(file, m);
    }
    return m;
  }

  /** Name Sketch uses for a weight of a variable font: the closest named instance. */
  private variableName(face: FontFace, weight: number, italic: boolean): string {
    const instances = (face.instances ?? []).map((i) => ({ ...i, weight: i.coords.wght ?? weightFromStyle(i.subfamily), italic: /italic/i.test(i.subfamily) || (i.coords.ital ?? 0) >= 0.5 }));
    const inst = pickFace(instances, weight, italic);
    return inst?.postscriptName ?? face.postscriptName;
  }

  resolve(familyIn: string, weight: number, italic: boolean): FontChoice {
    const family = familyIn.trim() || 'Inter';
    const key = `${family.toLowerCase()}|${weight}|${italic}`;
    let choice = this.choices.get(key);
    if (!choice) {
      choice = this.lookup(family, weight, italic);
      if (choice.file) choice.metrics = this.metrics(choice.file);
      this.choices.set(key, choice);
      if (choice.source === 'missing') this.report.warn('missing-font', 'Font not available (not shipped with the document, not a Google font, not installed) – Sketch will ask for it; the layout uses approximate metrics', `${family} ${weight}${italic ? ' italic' : ''}`);
      if (choice.variable) this.report.warn('variable-font', 'Variable font used at a weight between its named instances – Sketch uses the closest instance', `${family} ${weight}`);
    }
    this.used.set(`${choice.postscriptName}|${choice.file?.fileName ?? ''}`, choice);
    return choice;
  }

  private lookup(family: string, weight: number, italic: boolean): FontChoice {
    const lower = family.toLowerCase();
    const base = { family, weight, italic };
    // 1. fonts shipped with the .pen document
    const docs = this.docFonts.filter((d) => d.family.toLowerCase() === lower);
    const doc = pickFace(docs, weight, italic);
    if (doc) {
      const face = doc.file.face;
      const isVar = face.axes.some((a) => a.tag === 'wght');
      const ps = isVar ? this.variableName(face, weight, italic) : face.postscriptName;
      const inst = face.instances?.find((i) => i.postscriptName === ps);
      return { ...base, postscriptName: ps, source: 'document', file: doc.file, embed: this.options.embed !== 'none', variable: isVar && !!inst && Math.abs((inst.coords.wght ?? weight) - weight) > 1 };
    }
    // 2. Google Fonts – pen.dev loads them by name
    const g = googleFamily(family);
    const file = this.google.get(this.googleKey(g ?? family, weight, italic));
    if (file) return { ...base, family: g ?? family, postscriptName: file.face.postscriptName, source: 'google', file, embed: this.options.embed !== 'none' };
    // 3. installed fonts
    const local = pickFace(this.installedIndex().filter((f) => f.family.toLowerCase() === lower || f.face.family.toLowerCase() === lower), weight, italic);
    if (local) {
      const data = new Uint8Array(readFileSync(local.path));
      const file: FaceFile = { data, faceIndex: local.face.faceIndex, face: local.face, fileName: local.path.split(/[\\/]/).pop()!, origin: 'local' };
      const isVar = !!local.range;
      const ps = isVar ? this.variableName(local.face, weight, italic) : local.face.postscriptName;
      return { ...base, postscriptName: ps, source: 'local', file, embed: this.options.embed === 'all' && !local.face.collection };
    }
    return { ...base, family: g ?? family, postscriptName: guessPostscriptName(g ?? family, weight, italic), source: 'missing', embed: false };
  }
}
