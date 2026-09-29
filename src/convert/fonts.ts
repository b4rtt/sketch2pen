import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GOOGLE_FONT_FAMILIES } from '../data/google-fonts.ts';
import type { SketchFile } from '../sketch/reader.ts';

export interface FontAxis {
  tag: string;
  min: number;
  def: number;
  max: number;
}

export interface FontFace {
  postscriptName: string;
  family: string; // typographic family (name id 16) or legacy family (id 1)
  subfamily: string;
  weight: number;
  italic: boolean;
  axes: FontAxis[];
  /** index inside a .ttc/.otc collection */
  faceIndex: number;
  collection: boolean;
}

/** Where the font file of an embeddable face lives. */
export interface FontFile {
  kind: 'sketch' | 'local';
  /** archive path (fonts/<hash>) for fonts embedded in the .sketch file, file system path otherwise */
  path: string;
  faceIndex: number;
  collection: boolean;
}

export type FontSource = 'google' | 'embedded' | 'local' | 'substituted';

export interface ResolvedFont {
  /** family name used in pen.dev */
  family: string;
  weight: number;
  italic: boolean;
  source: FontSource;
  /** family as designed in Sketch */
  originalFamily: string;
  file?: FontFile;
  face?: FontFace;
}

export type EmbedMode = 'all' | 'document' | 'none';

const GOOGLE = new Map(GOOGLE_FONT_FAMILIES.map((f) => [f.toLowerCase(), f]));

export function googleFamily(family: string): string | undefined {
  return GOOGLE.get(family.trim().toLowerCase());
}

/**
 * Closest Google Fonts family for common desktop fonts pen.dev cannot load (metric-compatible where one exists:
 * Arimo ≙ Arial/Helvetica, Tinos ≙ Times, Cousine ≙ Courier, Carlito ≙ Calibri, Caladea ≙ Cambria, Gelasio ≙ Georgia).
 */
const SUBSTITUTES: Record<string, string> = {
  helvetica: 'Arimo',
  'helvetica neue': 'Arimo',
  arial: 'Arimo',
  'arial nova': 'Arimo',
  times: 'Tinos',
  'times new roman': 'Tinos',
  courier: 'Cousine',
  'courier new': 'Cousine',
  georgia: 'Gelasio',
  calibri: 'Carlito',
  cambria: 'Caladea',
  'sf pro': 'Inter',
  'sf pro text': 'Inter',
  'sf pro display': 'Inter',
  'sf pro rounded': 'Nunito',
  'sf compact': 'Inter',
  'sf ui text': 'Inter',
  'sf ui display': 'Inter',
  'system font': 'Inter',
  '.sf ns': 'Inter',
  'san francisco': 'Inter',
  'sf mono': 'Roboto Mono',
  menlo: 'Roboto Mono',
  monaco: 'Roboto Mono',
  avenir: 'Nunito Sans',
  'avenir next': 'Nunito Sans',
  futura: 'Jost',
  'proxima nova': 'Montserrat',
  gotham: 'Montserrat',
  'circular std': 'DM Sans',
  circular: 'DM Sans',
  graphik: 'Inter',
  'gill sans': 'Lato',
};

const WEIGHTS: [RegExp, number][] = [
  [/(extra|ultra)\s*black/i, 950],
  [/(extra|ultra)\s*bold/i, 800],
  [/(semi|demi)\s*bold/i, 600],
  [/(extra|ultra)\s*light/i, 200],
  [/hairline|thin/i, 100],
  [/black|heavy/i, 900],
  [/bold/i, 700],
  [/medium/i, 500],
  [/light/i, 300],
  [/regular|normal|book|roman|plain/i, 400],
];

export function weightFromStyle(style: string): number {
  for (const [re, w] of WEIGHTS) if (re.test(style)) return Math.min(w, 900);
  return 400;
}

const STYLE_WORD = /^(thin|hairline|extra|ultra|light|regular|normal|book|roman|plain|medium|semi|demi|bold|black|heavy|italic|oblique|extralight|ultralight|semibold|demibold|extrabold|ultrabold|extrablack)$/i;

/**
 * Family name for pen.dev: the typographic family plus non-weight qualifiers of the style, so that e.g. the
 * "Extended" faces of a superfamily become their own family ("Brand Sans Extended") and do not clash.
 */
export function penFamilyName(face: FontFace): string {
  const own = new Set(face.family.toLowerCase().split(/\s+/));
  const qualifiers = face.subfamily
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter((w) => w && !STYLE_WORD.test(w) && !own.has(w.toLowerCase()));
  return qualifiers.length ? `${face.family} ${qualifiers.join(' ')}` : face.family;
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  readSync(fd, buf, 0, length, offset);
  return buf;
}

function decodeName(buf: Buffer, platform: number): string {
  if (platform === 0 || platform === 3) {
    let s = '';
    for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode(buf.readUInt16BE(i));
    return s;
  }
  return buf.toString('latin1');
}

/** Reads name/OS2/fvar tables of every face in an OpenType/TrueType file or collection. */
export function readFontFaces(read: (offset: number, length: number) => Buffer): FontFace[] {
  const head = read(0, 12);
  const tag = head.toString('latin1', 0, 4);
  const offsets: number[] = [];
  const collection = tag === 'ttcf';
  if (collection) {
    const n = head.readUInt32BE(8);
    const dir = read(12, 4 * n);
    for (let i = 0; i < n; i++) offsets.push(dir.readUInt32BE(i * 4));
  } else if (tag === '\x00\x01\x00\x00' || tag === 'OTTO' || tag === 'true') {
    offsets.push(0);
  } else {
    return [];
  }
  const faces: FontFace[] = [];
  offsets.forEach((base, faceIndex) => {
    const h = read(base, 12);
    const numTables = h.readUInt16BE(4);
    const dir = read(base + 12, numTables * 16);
    const tables = new Map<string, { offset: number; length: number }>();
    for (let i = 0; i < numTables; i++) {
      tables.set(dir.toString('latin1', i * 16, i * 16 + 4), { offset: dir.readUInt32BE(i * 16 + 8), length: dir.readUInt32BE(i * 16 + 12) });
    }
    const nameT = tables.get('name');
    if (!nameT) return;
    const nb = read(nameT.offset, nameT.length);
    const count = nb.readUInt16BE(2);
    const strOff = nb.readUInt16BE(4);
    const names = new Map<number, { s: string; score: number }>();
    for (let i = 0; i < count; i++) {
      const rec = 6 + i * 12;
      const platform = nb.readUInt16BE(rec);
      const lang = nb.readUInt16BE(rec + 4);
      const id = nb.readUInt16BE(rec + 6);
      const len = nb.readUInt16BE(rec + 8);
      const off = nb.readUInt16BE(rec + 10);
      if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
      const score = platform === 3 && lang === 0x409 ? 3 : platform === 3 ? 2 : platform === 1 && lang === 0 ? 1 : 0;
      const prev = names.get(id);
      if (prev && prev.score >= score) continue;
      names.set(id, { s: decodeName(nb.subarray(strOff + off, strOff + off + len), platform), score });
    }
    const ps = names.get(6)?.s;
    if (!ps) return;
    const family = names.get(16)?.s ?? names.get(1)?.s ?? ps;
    const subfamily = names.get(17)?.s ?? names.get(2)?.s ?? 'Regular';
    const axes: FontAxis[] = [];
    const fvar = tables.get('fvar');
    if (fvar && fvar.length >= 16) {
      const fb = read(fvar.offset, fvar.length);
      const axesOffset = fb.readUInt16BE(4);
      const axisCount = fb.readUInt16BE(8);
      const axisSize = fb.readUInt16BE(10);
      for (let a = 0; a < axisCount; a++) {
        const o = axesOffset + a * axisSize;
        axes.push({ tag: fb.toString('latin1', o, o + 4), min: fb.readInt32BE(o + 4) / 65536, def: fb.readInt32BE(o + 8) / 65536, max: fb.readInt32BE(o + 12) / 65536 });
      }
    }
    let weight = weightFromStyle(subfamily);
    let italic = /italic|oblique/i.test(subfamily);
    const os2 = tables.get('OS/2');
    if (os2 && os2.length >= 64) {
      const ob = read(os2.offset, 64);
      const wc = ob.readUInt16BE(4);
      if (wc >= 100 && wc <= 1000) weight = wc;
      italic = italic || (ob.readUInt16BE(62) & 1) === 1;
    }
    faces.push({ postscriptName: ps, family, subfamily, weight, italic, axes, faceIndex, collection });
  });
  return faces;
}

export function facesFromBytes(data: Uint8Array): FontFace[] {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  try {
    return readFontFaces((o, l) => buf.subarray(o, o + l));
  } catch {
    return [];
  }
}

function facesFromFile(path: string): FontFace[] {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    return readFontFaces((o, l) => readAt(fd, o, l));
  } catch {
    return [];
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** Font folders scanned for locally installed fonts. */
export function systemFontDirs(): string[] {
  const home = homedir();
  if (process.platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', join(home, 'Library/Fonts')];
  if (process.platform === 'win32') {
    const win = process.env.WINDIR ?? 'C:\\Windows';
    return [join(win, 'Fonts'), join(process.env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'Microsoft/Windows/Fonts')];
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.fonts'), join(home, '.local/share/fonts')];
}

type Hit = { face: FontFace; file: FontFile };

function scanInstalled(dirs: string[]): Map<string, Hit> {
  const map = new Map<string, Hit>();
  const visit = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const f of entries) {
      const p = join(dir, f);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth < 3) visit(p, depth + 1);
        continue;
      }
      if (!/\.(ttf|otf|ttc|otc)$/i.test(f)) continue;
      for (const face of facesFromFile(p)) {
        if (!map.has(face.postscriptName)) map.set(face.postscriptName, { face, file: { kind: 'local', path: p, faceIndex: face.faceIndex, collection: face.collection } });
      }
    }
  };
  for (const dir of dirs) if (existsSync(dir)) visit(dir, 0);
  return map;
}

function splitCamel(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

export interface FontOptions {
  /** which fonts pen.dev cannot load itself are copied next to the .pen file */
  embed: EmbedMode;
  /** user substitutions: Sketch family (case-insensitive) → pen.dev family */
  map: Record<string, string>;
  /** font folders to scan (defaults to the platform's font folders) */
  dirs?: string[];
}

/**
 * Decides how every font of the Sketch document appears in pen.dev. pen.dev renders Google Fonts by name and fonts
 * shipped with the document; anything else is embedded from the .sketch file / this computer, or substituted.
 */
export class FontResolver {
  private installed: Map<string, Hit>;
  private embedded = new Map<string, Hit>();
  private families = new Map<string, string>(); // PS name → family from document.json fontReferences
  private cache = new Map<string, ResolvedFont>();
  private userMap: Map<string, string>;
  readonly used = new Map<string, ResolvedFont>(); // PS name → resolution, for the report

  constructor(
    sketch: SketchFile,
    private readonly options: FontOptions = { embed: 'all', map: {} },
  ) {
    this.installed = scanInstalled(options.dirs ?? systemFontDirs());
    for (const [name, data] of sketch.files) {
      if (!name.startsWith('fonts/')) continue;
      for (const face of facesFromBytes(data)) {
        this.embedded.set(face.postscriptName, { face, file: { kind: 'sketch', path: name, faceIndex: face.faceIndex, collection: face.collection } });
      }
    }
    for (const ref of sketch.document.fontReferences ?? []) {
      for (const ps of ref.postscriptNames ?? []) this.families.set(ps, ref.fontFamilyName);
    }
    this.userMap = new Map(Object.entries(options.map ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v.trim()]));
  }

  resolve(postscriptName: string): ResolvedFont {
    let res = this.cache.get(postscriptName);
    if (!res) {
      res = this.lookup(postscriptName);
      this.cache.set(postscriptName, res);
    }
    this.used.set(postscriptName, res);
    return res;
  }

  /** Archive paths of all fonts embedded in the .sketch file. */
  embeddedFiles(): string[] {
    return [...new Set([...this.embedded.values()].map((e) => e.file.path))];
  }

  private substitute(family: string, weight: number, italic: boolean): ResolvedFont {
    const key = family.trim().toLowerCase();
    const target = this.userMap.get(key) ?? SUBSTITUTES[key] ?? SUBSTITUTES[key.replace(/\s+(text|display)$/, '')] ?? 'Inter';
    return { family: googleFamily(target) ?? target, weight, italic, source: 'substituted', originalFamily: family };
  }

  private lookup(ps: string): ResolvedFont {
    // Variable-font named instances are stored as "<base PS name>_<instance>", e.g. Inter-Regular_Bold.
    const cut = ps.indexOf('_');
    const [basePs, instance] = cut > 0 ? [ps.slice(0, cut), ps.slice(cut + 1)] : [ps, undefined];
    const hit = this.embedded.get(ps) ?? this.embedded.get(basePs) ?? this.installed.get(ps) ?? this.installed.get(basePs);
    if (hit) {
      const { face, file } = hit;
      const weight = instance ? weightFromStyle(instance) : face.weight;
      const italic = instance ? /italic/i.test(instance) : face.italic;
      const family = penFamilyName(face);
      const mapped = this.userMap.get(family.toLowerCase()) ?? this.userMap.get(face.family.toLowerCase());
      if (mapped) return { family: mapped, weight, italic, source: 'substituted', originalFamily: family };
      const google = googleFamily(family);
      if (google) return { family: google, weight, italic, source: 'google', originalFamily: family };
      const embeddable = this.options.embed === 'all' || (this.options.embed === 'document' && file.kind === 'sketch');
      if (embeddable) return { family, weight, italic, source: file.kind === 'sketch' ? 'embedded' : 'local', originalFamily: family, file, face };
      return this.substitute(family, weight, italic);
    }
    const dash = basePs.indexOf('-');
    const style = instance ?? (dash > 0 ? basePs.slice(dash + 1) : 'Regular');
    const family = this.families.get(ps) ?? this.families.get(basePs) ?? splitCamel(dash > 0 ? basePs.slice(0, dash) : basePs);
    const weight = weightFromStyle(style);
    const italic = /italic|oblique/i.test(style);
    const mapped = this.userMap.get(family.toLowerCase());
    if (mapped) return { family: mapped, weight, italic, source: 'substituted', originalFamily: family };
    const google = googleFamily(family);
    if (google) return { family: google, weight, italic, source: 'google', originalFamily: family };
    return this.substitute(family, weight, italic);
  }

  /** Faces that have to ship with the .pen document. */
  documentFonts(): { family: string; face: FontFace; file: FontFile }[] {
    const out = new Map<string, { family: string; face: FontFace; file: FontFile }>();
    for (const r of this.used.values()) {
      if (!r.file || !r.face || (r.source !== 'embedded' && r.source !== 'local')) continue;
      out.set(`${r.file.path}#${r.file.faceIndex}`, { family: r.family, face: r.face, file: r.file });
    }
    return [...out.values()];
  }
}

/**
 * Extracts one face of a TrueType/OpenType collection into a standalone font file (pen.dev loads single fonts).
 */
export function extractCollectionFace(data: Uint8Array, faceIndex: number): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const base = view.getUint32(12 + faceIndex * 4);
  const numTables = view.getUint16(base + 4);
  const tables: { tag: number; checksum: number; offset: number; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const r = base + 12 + i * 16;
    tables.push({ tag: view.getUint32(r), checksum: view.getUint32(r + 4), offset: view.getUint32(r + 8), length: view.getUint32(r + 12) });
  }
  const headerSize = 12 + numTables * 16;
  let size = headerSize;
  for (const t of tables) size += (t.length + 3) & ~3;
  const out = new Uint8Array(size);
  const ov = new DataView(out.buffer);
  out.set(data.subarray(base, base + 12), 0); // sfnt version, numTables, search fields
  let cursor = headerSize;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    ov.setUint32(r, t.tag);
    ov.setUint32(r + 4, t.checksum);
    ov.setUint32(r + 8, cursor);
    ov.setUint32(r + 12, t.length);
    out.set(data.subarray(t.offset, t.offset + t.length), cursor);
    cursor += (t.length + 3) & ~3;
  });
  return out;
}
