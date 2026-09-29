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

export interface TextLine {
  start: number;
  length: number;
  /** width in Sketch (CoreText, automatic optical size) */
  sketch: number;
  /** width the same line takes in pen.dev */
  pen: number;
}

export interface CoreTextResults {
  glyphs: Map<string, GlyphOutline>;
  /** Sketch text layer id → Sketch's line breaks with widths */
  lines: Map<string, TextLine[]>;
  available: boolean;
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
  runs: { text: string; font: string; size: number; kerning?: number; weight?: number }[];
}

export function runCoreText(sketch: SketchFile, fonts: FontResolver): CoreTextResults {
  const result: CoreTextResults = { glyphs: new Map(), lines: new Map(), available: false };
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
      // auto-width texts only matter when centred / right-aligned: they grow from their anchor in Sketch
      const auto = textSizing(l).growth === 'auto';
      const alignment = l.attributedString?.attributes?.[0]?.attributes.paragraphStyle?.alignment ?? 0;
      if (auto && alignment !== 1 && alignment !== 2) return;
      const runs = rawRuns(l).map(({ text, attrs }) => {
        const f = attrs.MSAttributedStringFontAttribute?.attributes;
        const ps = f?.name ?? 'Helvetica';
        const instance = ps.includes('_') ? fonts.resolve(ps) : null;
        return {
          text,
          font: ps.split('_')[0]!,
          size: f?.size ?? 12,
          ...(attrs.kerning ? { kerning: attrs.kerning } : {}),
          ...(instance ? { weight: instance.weight } : {}),
        };
      });
      if (!runs.length) return;
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
    const out = JSON.parse(r.stdout) as { glyphs: GlyphOutline[]; layouts: { lines: TextLine[] }[] };
    glyphList.forEach((g, i) => {
      const o = out.glyphs[i];
      if (o?.d) result.glyphs.set(glyphKey(g.font, g.size, g.text), o);
    });
    layoutIds.forEach((id, i) => {
      const lines = out.layouts[i]?.lines;
      if (lines?.length) result.lines.set(id, lines);
    });
    result.available = true;
    return result;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
