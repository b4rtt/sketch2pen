import type { PenFill, PenNode } from '../pen/types.ts';
import type { Layer, StringAttribute, TextAttributes } from '../sketch/types.ts';
import { r2, r3 } from '../util/geom.ts';
import type { Context } from './context.ts';
import { colorOrVariable, convertFills, paintValue } from './style.ts';

type Align = 'left' | 'center' | 'right' | 'justify';

interface RunStyle {
  fontFamily: string;
  fontWeight: string;
  fontStyle?: string;
  fontSize: number;
  fill?: PenFill | PenFill[];
  letterSpacing?: number;
  lineHeight?: number;
  underline?: boolean;
  strikethrough?: boolean;
}

interface Run {
  text: string;
  style: RunStyle;
  key: string;
  lineHeightPx: number;
  /** pen.dev renders this run with a substitute font */
  substituted: boolean;
}

const ALIGN: Record<number, Align> = { 0: 'left', 1: 'right', 2: 'center', 3: 'justify', 4: 'left' };

function transform(text: string, attrs: TextAttributes): string {
  const t = attrs.MSAttributedStringTextTransformAttribute;
  if (t === 1) return text.toUpperCase();
  if (t === 2) return text.toLowerCase();
  return text;
}

function runStyle(ctx: Context, attrs: TextAttributes, layerFill: PenFill | PenFill[] | undefined, tracking = 0): { style: RunStyle; lineHeightPx: number; substituted: boolean } {
  const font = attrs.MSAttributedStringFontAttribute?.attributes;
  const size = font?.size ?? 12;
  const resolved = ctx.fonts.resolve(font?.name ?? 'Inter-Regular', size);
  const para = attrs.paragraphStyle;
  const lh = para?.maximumLineHeight || para?.minimumLineHeight || 0;
  const style: RunStyle = {
    fontFamily: resolved.family,
    fontWeight: String(resolved.weight),
    fontSize: r2(size),
    fill: layerFill ?? colorOrVariable(ctx, attrs.MSAttributedStringColorAttribute ?? { red: 0, green: 0, blue: 0, alpha: 1 }),
  };
  if (resolved.italic) style.fontStyle = 'italic';
  const spacing = (attrs.kerning ?? 0) + tracking;
  if (Math.abs(spacing) >= 0.005) style.letterSpacing = r3(spacing);
  if (lh) style.lineHeight = r3(lh / size);
  if (attrs.underlineStyle) style.underline = true;
  if (attrs.strikethroughStyle) style.strikethrough = true;
  return { style, lineHeightPx: lh || size * 1.21, substituted: resolved.source === 'substituted' };
}

/** Text runs as displayed (line separators normalised, text transforms applied); shared with the CoreText pre-pass. */
export function rawRuns(layer: Layer): { text: string; attrs: TextAttributes }[] {
  const as = layer.attributedString;
  // length-preserving normalisation keeps attribute ranges valid
  const str = (as?.string ?? '').replace(/[\u2028\u2029]/g, '\n').replace(/\r/g, ' ');
  const attrs: StringAttribute[] = as?.attributes?.length
    ? as.attributes
    : [{ location: 0, length: str.length, attributes: layer.style?.textStyle?.encodedAttributes ?? {} }];
  const out: { text: string; attrs: TextAttributes }[] = [];
  for (const a of attrs) {
    const text = transform(str.slice(a.location, a.location + a.length), a.attributes);
    if (text) out.push({ text, attrs: a.attributes });
  }
  return out;
}

function splitRuns(ctx: Context, layer: Layer, layerFill: PenFill | PenFill[] | undefined): Run[] {
  const runs: Run[] = [];
  const tracking = ctx.textTracking.get(layer.do_objectID) ?? [];
  for (const [i, { text, attrs }] of rawRuns(layer).entries()) {
    const { style, lineHeightPx, substituted } = runStyle(ctx, attrs, layerFill, tracking[i]);
    const key = JSON.stringify(style);
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.text += text;
    else runs.push({ text, style, key, lineHeightPx, substituted });
  }
  if (!runs.length) {
    const { style, lineHeightPx, substituted } = runStyle(ctx, layer.style?.textStyle?.encodedAttributes ?? {}, layerFill);
    runs.push({ text: '', style, key: JSON.stringify(style), lineHeightPx, substituted });
  }
  return runs;
}

/** Splits runs into paragraphs (at \n), keeping per-paragraph run lists. */
function paragraphs(runs: Run[]): Run[][] {
  const out: Run[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) out.push([]);
      if (part) out[out.length - 1]!.push({ ...run, text: part });
    });
  }
  return out;
}

export interface TextSizing {
  /** 'auto' (fit), 'fixed-width' or 'fixed-width-height' */
  growth: 'auto' | 'fixed-width' | 'fixed-width-height';
  /** width fills the parent stack */
  fillWidth: boolean;
}

export function textSizing(layer: Layer): TextSizing {
  let hs = layer.horizontalSizing;
  let vs = layer.verticalSizing;
  if (hs === undefined && layer.textBehaviour !== undefined) {
    hs = layer.textBehaviour === 0 ? 1 : 0;
    vs = layer.textBehaviour === 2 ? 0 : 1;
  }
  if (hs === 1) return { growth: 'auto', fillWidth: false };
  return { growth: vs === 1 ? 'fixed-width' : 'fixed-width-height', fillWidth: hs === 2 };
}

export interface TextResult {
  node: PenNode;
  /** ids of the text nodes (several when a mixed-style text had to be split) */
  textIds: string[];
}

/**
 * Converts a Sketch text layer. pen.dev text nodes carry a single style, so texts with several styles are
 * split into paragraphs/runs laid out with flex frames when that can be done without re-flowing lines.
 */
export function convertText(ctx: Context, layer: Layer, id: string, where: string, inLayout: boolean): TextResult {
  ctx.report.stats.texts++;
  const fills = layer.style?.fills?.some((f) => f.isEnabled)
    ? paintValue(convertFills(ctx, layer.style!.fills, layer.frame.width, layer.frame.height, where))
    : undefined;
  const runs = splitRuns(ctx, layer, fills);
  const para0 = layer.attributedString?.attributes?.[0]?.attributes.paragraphStyle ?? layer.style?.textStyle?.encodedAttributes?.paragraphStyle;
  const align: Align = ALIGN[para0?.alignment ?? 0] ?? 'left';
  const vAlignRaw = layer.style?.textStyle?.verticalAlignment ?? layer.style?.textStyle?.encodedAttributes?.textStyleVerticalAlignmentKey ?? 0;
  const vAlign = (['top', 'middle', 'bottom'] as const)[vAlignRaw] ?? 'top';
  const sizing = textSizing(layer);
  const { width: w, height: h } = layer.frame;

  const base = (nodeId: string, run: Run, text: string): PenNode => ({
    type: 'text',
    id: nodeId,
    name: layer.name,
    content: text,
    ...run.style,
  });

  const applySizing = (node: PenNode): PenNode => {
    node.textGrowth = sizing.growth;
    if (sizing.growth !== 'auto') {
      node.width = sizing.fillWidth && inLayout ? 'fill_container' : r2(w);
      if (align !== 'left') node.textAlign = align;
    }
    if (sizing.growth === 'fixed-width-height') {
      node.height = r2(h);
      if (vAlign !== 'top') node.textAlignVertical = vAlign;
    }
    if (sizing.growth === 'auto') delete node.textGrowth;
    return node;
  };

  // Sketch's own line breaks (CoreText) with pen.dev's line widths, when the helper is available. Widths are only
  // meaningful when pen.dev renders the same font file (not for substituted fonts).
  const breaks = ctx.textLines.get(layer.do_objectID);
  const measured = runs.every((r) => !r.substituted) ? breaks : undefined;
  const penWidth = measured ? Math.max(...measured.map((l) => l.pen)) : 0;
  /** Widens a fixed-width box so pen.dev (slightly different metrics) keeps Sketch's line breaks. */
  const widen = (node: PenNode) => {
    if (typeof node.width !== 'number' || !measured) return;
    const need = penWidth + 0.5;
    if (need <= w + 0.25) return;
    const extra = need - w;
    node.width = r2(need);
    (node as PenNode & { _dx?: number })._dx = align === 'center' ? -extra / 2 : align === 'right' ? -extra : 0;
  };

  /** Auto-width texts grow from their alignment anchor in Sketch: keep the frame's centre / right edge. */
  const anchor = (node: PenNode) => {
    if (sizing.growth !== 'auto' || !measured || inLayout || align === 'left' || align === 'justify') return;
    const dx = align === 'center' ? (w - penWidth) / 2 : w - penWidth;
    if (Math.abs(dx) > 0.25) (node as PenNode & { _dx?: number })._dx = dx;
  };

  // pen.dev has no paragraph spacing: texts that use it become one text layer per paragraph with a gap.
  const paraSpacing = Math.max(0, ...rawRuns(layer).map((r) => r.attrs.paragraphStyle?.paragraphSpacing ?? 0));
  const fullText = runs.map((r) => r.text).join('');
  const spaced = paraSpacing > 0 && fullText.includes('\n');

  // Single style – the common case.
  if (runs.length === 1 && !spaced) {
    const run = runs[0]!;
    const node = applySizing(base(id, run, run.text));
    if (measured) {
      widen(node);
      anchor(node);
    } else guardSingleLine(node, run, w, h, align, inLayout);
    return { node, textIds: [id] };
  }

  const paras = paragraphs(runs);
  const maxLh = Math.max(...runs.map((r) => r.lineHeightPx));
  const lineCount = Math.max(1, Math.round(h / maxLh));
  const noWrap = sizing.growth === 'auto' || (breaks ? breaks.length <= paras.length : lineCount <= paras.length);
  const mixedPara = paras.some((p) => new Set(p.map((r) => r.key)).size > 1);
  const flexAlign = align === 'center' ? 'center' : align === 'right' ? 'end' : 'start';
  const column = (nodeId: string, name: string, children: PenNode[], gap: number, width: PenNode['width']): PenNode => ({
    type: 'frame',
    id: nodeId,
    name,
    layout: 'vertical',
    gap: r2(gap),
    ...(flexAlign !== 'start' ? { alignItems: flexAlign } : {}),
    width,
    children,
  });
  const outerWidth: PenNode['width'] = sizing.growth === 'auto' ? 'fit_content' : sizing.fillWidth && inLayout ? 'fill_container' : r2(w);

  if (mixedPara && !noWrap) {
    if (breaks) {
      // Rebuild Sketch's lines one by one – every run keeps its own style.
      ctx.report.warn('rich-lines', 'Text with several styles inside a paragraph split into lines exactly where Sketch wraps them (pen.dev has no inline formatting)', where);
      const textIds: string[] = [];
      const bounds: { start: number; run: Run }[] = [];
      let pos = 0;
      for (const r of runs) {
        bounds.push({ start: pos, run: r });
        pos += r.text.length;
      }
      const groups: PenNode[][] = [[]];
      breaks.forEach((line, li) => {
        const rid = ctx.ids.for(layer.do_objectID, `#l${li}`);
        const slices: { run: Run; text: string }[] = [];
        for (const b of bounds) {
          const from = Math.max(line.start, b.start);
          const to = Math.min(line.start + line.length, b.start + b.run.text.length);
          if (to > from) slices.push({ run: b.run, text: b.run.text.slice(from - b.start, to - b.start) });
        }
        const endsParagraph = fullText[line.start + line.length - 1] === '\n';
        // drop the paragraph break and trailing spaces that CoreText keeps at line ends
        while (slices.length) {
          const last = slices[slices.length - 1]!;
          last.text = last.text.replace(/[\n\s]+$/, '');
          if (last.text) break;
          slices.pop();
        }
        let row: PenNode;
        if (!slices.length) {
          textIds.push(rid);
          row = { ...base(rid, runs[0]!, ' '), name: `${layer.name} (empty line)` };
        } else if (slices.length === 1) {
          textIds.push(rid);
          row = { ...base(rid, slices[0]!.run, slices[0]!.text), name: `${layer.name} – line ${li + 1}` };
        } else {
          row = { type: 'frame', id: rid, name: `${layer.name} – line ${li + 1}`, layout: 'horizontal', gap: 0, alignItems: 'end' };
          row.children = slices.map((sl, si) => {
            const tid = ctx.ids.for(layer.do_objectID, `#l${li}r${si}`);
            textIds.push(tid);
            return base(tid, sl.run, sl.text);
          });
        }
        groups[groups.length - 1]!.push(row);
        if (endsParagraph && spaced) groups.push([]);
      });
      const children = spaced
        ? groups.filter((g) => g.length).map((g, gi) => column(ctx.ids.for(layer.do_objectID, `#g${gi}`), `${layer.name} – paragraph ${gi + 1}`, g, 0, 'fit_content'))
        : groups[0]!;
      const node = column(id, layer.name, children, spaced ? paraSpacing : 0, outerWidth);
      return { node, textIds };
    }
    // Without CoreText we cannot reproduce per-run styles on wrapped lines: keep the dominant style.
    ctx.report.warn('mixed-text', 'Text with several styles in a wrapped paragraph – the dominant style was used (pen.dev has no inline formatting)', where);
    const byKey = new Map<string, number>();
    for (const r of runs) byKey.set(r.key, (byKey.get(r.key) ?? 0) + r.text.length);
    const dominant = runs.find((r) => r.key === [...byKey.entries()].sort((a, b) => b[1] - a[1])[0]![0])!;
    const node = applySizing(base(id, dominant, fullText));
    widen(node);
    return { node, textIds: [id] };
  }

  // Split: a vertical stack of paragraphs, each either one text or a horizontal row of runs.
  const textIds: string[] = [];
  const children: PenNode[] = paras.map((para, pi) => {
    const pid = ctx.ids.for(layer.do_objectID, `#p${pi}`);
    if (!para.length) {
      const run = runs[0]!;
      textIds.push(pid);
      return { ...base(pid, run, ' '), name: `${layer.name} (empty line)` };
    }
    if (para.length === 1 || new Set(para.map((r) => r.key)).size === 1) {
      const run = para[0]!;
      const node = base(pid, run, para.map((r) => r.text).join(''));
      if (sizing.growth !== 'auto') {
        node.textGrowth = 'fixed-width';
        node.width = 'fill_container';
        if (align !== 'left') node.textAlign = align;
      }
      textIds.push(pid);
      return node;
    }
    const row: PenNode = { type: 'frame', id: pid, name: `${layer.name} – line ${pi + 1}`, layout: 'horizontal', gap: 0, alignItems: 'end' };
    row.children = para.map((run, ri) => {
      const rid = ctx.ids.for(layer.do_objectID, `#p${pi}r${ri}`);
      textIds.push(rid);
      return base(rid, run, run.text);
    });
    return row;
  });
  if (runs.length > 1) ctx.report.warn('split-text', 'Text with several styles split into one text layer per paragraph/run (pen.dev has no inline formatting)', where);
  if (spaced) ctx.report.warn('paragraph-spacing', 'Paragraph spacing reproduced with one text layer per paragraph', where);
  const frame = column(id, layer.name, children, spaced ? paraSpacing : 0, outerWidth);
  widen(frame);
  return { node: frame, textIds };
}

/**
 * Fallback without CoreText: single-line fixed-width texts can wrap in pen.dev when its font metrics are a hair
 * wider than Sketch's. Give them a little slack and compensate the position so the alignment stays the same.
 */
function guardSingleLine(node: PenNode, run: Run, w: number, h: number, align: Align, inLayout: boolean): void {
  if (inLayout || node.textGrowth !== 'fixed-width' || node.content?.includes('\n')) return;
  if (h > run.lineHeightPx * 1.5) return;
  const slack = Math.max(4, Math.round(run.style.fontSize * 0.3));
  node.width = r2(w + slack);
  (node as PenNode & { _dx?: number })._dx = align === 'center' ? -slack / 2 : align === 'right' ? -slack : 0;
}
