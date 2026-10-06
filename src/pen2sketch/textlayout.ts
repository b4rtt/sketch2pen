// Text measurement and line breaking as pen.dev does it: advances and kerning of the font file, letter spacing after
// every character, greedy wrapping at spaces and hyphens, the font's own line height unless one is set.
import type { FontMetrics } from '../util/fontmetrics.ts';

export interface TextStyle {
  metrics?: FontMetrics;
  size: number;
  letterSpacing: number;
  /** multiple of the font size; undefined → the font's natural line height */
  lineHeight?: number;
}

export interface TextLine {
  /** offsets into the content (UTF-16) */
  start: number;
  end: number;
  width: number;
}

export interface TextLayout {
  lines: TextLine[];
  /** widest line */
  width: number;
  height: number;
  /** line height in px */
  lineHeight: number;
}

const FALLBACK = { ascender: 0.95, descender: 0.25, lineGap: 0 };

function isWide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff);
}

/** Width of a character the font does not have (pen.dev falls back to another font). */
function fallbackAdvance(cp: number): number {
  if (cp === 0x20 || cp === 0xa0) return 0.27;
  if (isWide(cp)) return 1;
  if (cp >= 0x300 && cp <= 0x36f) return 0; // combining marks
  return 0.56;
}

/** Natural line height of a font in px. */
export function naturalLineHeight(style: TextStyle): number {
  const v = style.metrics?.vertical ?? FALLBACK;
  // summed after scaling, like pen.dev: 25.5 px can come out as 25.499… and round down
  return v.ascender * style.size + v.descender * style.size + v.lineGap * style.size;
}

export function lineHeightPx(style: TextStyle): number {
  return style.lineHeight !== undefined && style.lineHeight > 0 ? style.lineHeight * style.size : naturalLineHeight(style);
}

/** Width of a single line of text (no wrapping); trailing spaces included. */
export function measure(text: string, style: TextStyle): number {
  const m = style.metrics;
  let width = 0;
  let prev = -1;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x200b || cp === 0xfeff || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue; // zero-width
    if (m && m.hasGlyph(cp)) {
      const g = m.glyph(cp);
      if (prev >= 0) width += m.kerning(prev, g) * style.size;
      width += m.advance(g) * style.size;
      prev = g;
    } else {
      width += fallbackAdvance(cp) * style.size;
      prev = -1;
    }
    width += style.letterSpacing;
  }
  return width;
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '　';

/** Break opportunities of a paragraph: after runs of spaces, after hyphens and dashes between letters, around CJK. */
function tokens(para: string): string[] {
  const out: string[] = [];
  let cur = '';
  const chars = [...para];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    cur += c;
    const next = chars[i + 1];
    if (next === undefined) break;
    const cp = c.codePointAt(0)!;
    const breakAfter = (isSpace(c) && !isSpace(next)) || ((c === '-' || c === '–' || c === '—' || c === '/') && !isSpace(next) && cur.trim().length > 1) || isWide(cp) || isWide(next.codePointAt(0)!);
    if (breakAfter) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

const trimEnd = (s: string) => s.replace(/[ \t　]+$/, '');

/**
 * Lays out text like pen.dev: paragraphs at "\n", greedy wrapping when `maxWidth` is given. Words wider than the box
 * are broken between characters.
 */
export function layoutText(content: string, style: TextStyle, maxWidth?: number): TextLayout {
  const lh = lineHeightPx(style);
  const lines: TextLine[] = [];
  let offset = 0;
  const limit = maxWidth === undefined ? Infinity : maxWidth + 0.01;
  for (const para of content.split('\n')) {
    if (limit === Infinity || measure(trimEnd(para), style) <= limit) {
      lines.push({ start: offset, end: offset + para.length, width: measure(trimEnd(para), style) });
    } else {
      let line = '';
      let lineStart = offset;
      let pos = offset;
      const flush = () => {
        lines.push({ start: lineStart, end: lineStart + line.length, width: measure(trimEnd(line), style) });
        lineStart += line.length;
        line = '';
      };
      for (const tok of tokens(para)) {
        if (line && measure(trimEnd(line + tok), style) > limit) flush();
        if (!line && measure(trimEnd(tok), style) > limit) {
          // a word wider than the box: break it between characters
          for (const ch of tok) {
            if (line && measure(trimEnd(line + ch), style) > limit) flush();
            line += ch;
          }
        } else line += tok;
        pos += tok.length;
      }
      if (line || lineStart === offset) flush();
      void pos;
    }
    offset += para.length + 1;
  }
  const width = Math.max(0, ...lines.map((l) => l.width));
  return { lines, width, height: lines.length * lh, lineHeight: lh };
}

/** The box pen.dev reports for laid-out text: whole pixels, each line as tall as the rounded line height. */
export function penTextBox(layout: TextLayout): { width: number; height: number } {
  return { width: Math.ceil(layout.width - 1e-3), height: layout.lines.length * Math.round(layout.lineHeight) };
}
