// CoreText pre-pass (macOS). One call of the native helper (native/coretext.swift) that
//  • outlines private-use glyph texts (SF Symbols, icon fonts) – pen.dev would show empty boxes;
//  • lays out fixed-width texts exactly like Sketch and measures each line with pen.dev's metrics
//    (variable fonts at their default optical size), so text boxes can keep Sketch's line breaks.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SketchFile } from '../sketch/reader.ts';
import { walkLayers } from '../sketch/reader.ts';
import type { Layer } from '../sketch/types.ts';
import type { FontResolver } from './fonts.ts';
import { rawRuns, textSizing } from './text.ts';

export interface GlyphOutline {
  d: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An underlined ('u') or struck-through ('s') stretch of a line, as x offsets in pen.dev's rendering of the line. */
export interface TextDeco {
  run: number;
  kind: 'u' | 's';
  x0: number;
  x1: number;
}

export interface TextLine {
  start: number;
  length: number;
  /** width in Sketch (CoreText, automatic optical size) */
  sketch: number;
  /** width the same line takes in pen.dev */
  pen: number;
  deco?: TextDeco[];
}

/** Vertical metrics (points, y up from the baseline) of the font pen.dev renders a run with. */
export interface FontMetrics {
  ascent: number;
  descent: number;
  leading: number;
  underlinePosition: number;
  underlineThickness: number;
  xHeight: number;
}

export interface CoreTextResults {
  glyphs: Map<string, GlyphOutline>;
  /** Sketch text layer id → Sketch's line breaks with widths */
  lines: Map<string, TextLine[]>;
  /** Sketch text layer id → metrics per text run (only for texts with underline / strikethrough) */
  metrics: Map<string, FontMetrics[]>;
  /** Sketch text layer id → extra letter spacing per text run that keeps Sketch's widths in pen.dev */
  tracking: Map<string, number[]>;
  available: boolean;
}

/**
 * pen.dev renders a shipped font with another file (an SF optical cut) or at the default optical size of a variable
 * font – Sketch's letter widths are then restored with letter spacing. Google Fonts are left alone: pen.dev loads its
 * own copy, which may not match the local file.
 */
function compensable(resolved: ReturnType<FontResolver['resolve']>, penFont: string | undefined): boolean {
  if (resolved.source !== 'local' && resolved.source !== 'embedded') return false;
  return !!penFont || !!resolved.face?.axes.some((a) => a.tag === 'opsz');
}

/** Whether a text layer has underlined or struck-through runs. */
export function isDecorated(layer: Layer): boolean {
  return rawRuns(layer).some(({ attrs }) => !!attrs.underlineStyle || !!attrs.strikethroughStyle);
}

export function hasPrivateUse(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000) return true;
  }
  return false;
}

export function glyphKey(font: string, size: number, text: string): string {
  return `${font}|${size}|${text}`;
}

/** The glyph text of a layer (only single-font layers are outlined). */
export function glyphRequest(layer: Layer): { font: string; size: number; text: string } | null {
  if (layer._class !== 'text') return null;
  const text = layer.attributedString?.string ?? '';
  if (!text || !hasPrivateUse(text)) return null;
  const f = layer.attributedString?.attributes?.[0]?.attributes.MSAttributedStringFontAttribute?.attributes ?? layer.style?.textStyle?.encodedAttributes.MSAttributedStringFontAttribute?.attributes;
  if (!f) return null;
  return { font: f.name, size: f.size, text };
}

const SOURCE = join(import.meta.dir, '../../native/coretext.swift');

/** Finds the helper binary: next to the executable (release builds), or built once per source version with swiftc. */
function helperPath(): string | null {
  const bundled = join(dirname(process.execPath), 'sketch2pen-coretext');
  if (existsSync(bundled)) return bundled;
  if (existsSync(SOURCE)) {
    const version = Bun.hash(readFileSync(SOURCE)).toString(36);
    const cached = join(homedir(), 'Library/Caches/sketch2pen', `sketch2pen-coretext-${version}`);
    if (existsSync(cached)) return cached;
    mkdirSync(dirname(cached), { recursive: true });
    const partial = `${cached}.${process.pid}`; // renamed when complete, so an interrupted build is never used
    const r = spawnSync('swiftc', ['-O', SOURCE, '-o', partial], { encoding: 'utf8' });
    if (r.status === 0 && existsSync(partial)) {
      renameSync(partial, cached);
      return cached;
    }
    rmSync(partial, { force: true });
  }
  // no compiler: fall back to a helper from `bun run build`
  const built = join(import.meta.dir, '../../dist/sketch2pen-coretext');
  return existsSync(built) ? built : null;
}

interface LayoutRequest {
  width: number;
  runs: { text: string; font: string; size: number; kerning?: number; weight?: number; penFont?: string; underline?: boolean; strike?: boolean; compensate?: boolean }[];
}

export function runCoreText(sketch: SketchFile, fonts: FontResolver): CoreTextResults {
  const result: CoreTextResults = { glyphs: new Map(), lines: new Map(), metrics: new Map(), tracking: new Map(), available: false };
  if (process.platform !== 'darwin') return result;

  const glyphReqs = new Map<string, { font: string; size: number; text: string }>();
  const layoutIds: string[] = [];
  const layouts: LayoutRequest[] = [];
  const visit = (root: Layer) =>
    walkLayers(root, (l) => {
      if (l._class !== 'text') return;
      const g = glyphRequest(l);
      if (g) {
        glyphReqs.set(glyphKey(g.font, g.size, g.text), g);
        return;
      }
      const auto = textSizing(l).growth === 'auto';
      const alignment = l.attributedString?.attributes?.[0]?.attributes.paragraphStyle?.alignment ?? 0;
      const runs = rawRuns(l).map(({ text, attrs }) => {
        const f = attrs.MSAttributedStringFontAttribute?.attributes;
        const ps = f?.name ?? 'Helvetica';
        const size = f?.size ?? 12;
        const font = ps.split('_')[0]!;
        const resolved = fonts.resolve(ps, size);
        // pen.dev renders another font file than Sketch's (e.g. an SF optical cut): measure its lines with that file
        const penFont = resolved.face && resolved.face.postscriptName !== font && resolved.face.postscriptName !== ps ? resolved.face.postscriptName : undefined;
        return {
          text,
          font,
          size,
          ...(attrs.kerning ? { kerning: attrs.kerning } : {}),
          ...(ps.includes('_') ? { weight: resolved.weight } : {}),
          ...(penFont ? { penFont } : {}),
          ...(attrs.underlineStyle ? { underline: true } : {}),
          ...(attrs.strikethroughStyle ? { strike: true } : {}),
          ...(compensable(resolved, penFont) ? { compensate: true } : {}),
        };
      });
      if (!runs.length) return;
      // auto-width texts only matter when centred / right-aligned (they grow from their anchor in Sketch), when
      // underlines / strikethroughs have to be drawn or when their letter spacing has to be compensated
      if (auto && alignment !== 1 && alignment !== 2 && !runs.some((r) => r.underline || r.strike || r.compensate)) return;
      layoutIds.push(l.do_objectID);
      layouts.push({ width: auto ? 100_000 : l.frame.width, runs });
    });
  sketch.pages.forEach(visit);
  for (const f of sketch.document.foreignSymbols ?? []) if (f.symbolMaster) visit(f.symbolMaster);
  if (!glyphReqs.size && !layouts.length) return { ...result, available: true };

  const helper = helperPath();
  if (!helper) return result;
  // Sketch renders with the fonts embedded in the document – give CoreText the same files.
  const tmp = mkdtempSync(join(tmpdir(), 'sketch2pen-fonts-'));
  try {
    const fontFiles = fonts.embeddedFiles().map((name, i) => {
      const p = join(tmp, `${i}.font`);
      writeFileSync(p, sketch.files.get(name)!);
      return p;
    });
    const glyphList = [...glyphReqs.values()];
    const r = spawnSync(helper, [], {
      input: JSON.stringify({ fonts: fontFiles, glyphs: glyphList, layouts }),
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.status !== 0) return result;
    const out = JSON.parse(r.stdout) as { glyphs: GlyphOutline[]; layouts: { lines: TextLine[]; metrics?: FontMetrics[]; tracking?: number[] }[] };
    glyphList.forEach((g, i) => {
      const o = out.glyphs[i];
      if (o?.d) result.glyphs.set(glyphKey(g.font, g.size, g.text), o);
    });
    layoutIds.forEach((id, i) => {
      const lines = out.layouts[i]?.lines;
      if (lines?.length) result.lines.set(id, lines);
      const metrics = out.layouts[i]?.metrics;
      if (metrics?.length) result.metrics.set(id, metrics);
      const tracking = out.layouts[i]?.tracking;
      if (tracking?.length) result.tracking.set(id, tracking);
    });
    result.available = true;
    return result;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
