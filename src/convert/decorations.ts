// Underline and strikethrough. pen.dev keeps both properties on text but does not draw them, so they are drawn as
// thin shapes where Sketch (CoreText) puts them: the underline centred on the font's underline position, the
// strikethrough at half the x-height, both with the font's underline thickness – measured by the CoreText helper on
// the lines pen.dev renders.
import type { PenFill, PenNode } from '../pen/types.ts';
import type { Layer } from '../sketch/types.ts';
import { r2, r3 } from '../util/geom.ts';
import type { Context } from './context.ts';
import type { ParentInfo } from './layers.ts';
import { colorOrVariable, convertFills, paintValue } from './style.ts';
import { rawRuns, textSizing } from './text.ts';

const ALIGN: Record<number, 'left' | 'center' | 'right' | 'justify'> = { 0: 'left', 1: 'right', 2: 'center', 3: 'justify', 4: 'left' };

/**
 * Shapes drawing the underlines / strikethroughs of a converted text layer (`node` is the text node or the frame a
 * mixed-style text became; `dx` is how far the converter moved it from Sketch's frame).
 */
export function textDecorations(ctx: Context, layer: Layer, node: PenNode, parent: ParentInfo, dx: number, where: string): PenNode[] {
  const lines = ctx.textLines.get(layer.do_objectID);
  const metrics = ctx.textMetrics.get(layer.do_objectID);
  if (!lines?.some((l) => l.deco?.length) || !metrics) {
    ctx.report.warn('text-decoration', 'Underline / strikethrough kept on the text but not drawn – pen.dev does not draw them and measuring them needs the macOS CoreText helper', where);
    return [];
  }
  if (layer.rotation || layer.isFlippedHorizontal || layer.isFlippedVertical) {
    ctx.report.warn('text-decoration', 'Underline / strikethrough on a rotated or mirrored text kept on the text but not drawn (pen.dev does not draw them)', where);
    return [];
  }
  const runs = rawRuns(layer);
  const spans: [number, number][] = [];
  let pos = 0;
  for (const r of runs) {
    spans.push([pos, pos + r.text.length]);
    pos += r.text.length;
  }
  const fullText = runs.map((r) => r.text).join('');
  const lineHeightOf = (i: number) => {
    const p = runs[i]?.attrs.paragraphStyle;
    const m = metrics[i]!;
    return p?.maximumLineHeight || p?.minimumLineHeight || m.ascent + m.descent + m.leading;
  };
  const paraSpacing = Math.max(0, ...runs.map((r) => r.attrs.paragraphStyle?.paragraphSpacing ?? 0));
  const spaced = paraSpacing > 0 && fullText.includes('\n');

  // vertical layout of the lines, as pen.dev stacks them
  const rows = lines.map((line) => {
    const inLine = spans.map((s, i) => (s[0] < line.start + line.length && s[1] > line.start ? i : -1)).filter((i) => i >= 0);
    return { line, height: Math.max(...inLine.map(lineHeightOf), 0) };
  });
  const tops: number[] = [];
  let y = 0;
  rows.forEach((row, k) => {
    tops.push(y);
    y += row.height;
    if (spaced && fullText[row.line.start + row.line.length - 1] === '\n' && k < rows.length - 1) y += paraSpacing;
  });
  const sizing = textSizing(layer);
  const vAlignKey = layer.style?.textStyle?.verticalAlignment ?? layer.style?.textStyle?.encodedAttributes?.textStyleVerticalAlignmentKey ?? 0;
  const boxHeight = layer.frame.height;
  const yOffset = sizing.growth === 'fixed-width-height' ? (vAlignKey === 1 ? (boxHeight - y) / 2 : vAlignKey === 2 ? boxHeight - y : 0) : 0;

  // horizontal alignment of every line inside the box pen.dev renders
  const align = node.type === 'text' ? (node.textAlign ?? 'left') : (ALIGN[runs[0]?.attrs.paragraphStyle?.alignment ?? 0] ?? 'left');
  const boxWidth = typeof node.width === 'number' ? node.width : sizing.growth === 'auto' ? Math.max(...lines.map((l) => l.pen)) : layer.frame.width;

  const layerFill = layer.style?.fills?.some((f) => f.isEnabled) ? paintValue(convertFills(ctx, layer.style!.fills, layer.frame.width, layer.frame.height, where)) : undefined;
  const paintOf = (i: number): PenFill | PenFill[] => layerFill ?? colorOrVariable(ctx, runs[i]!.attrs.MSAttributedStringColorAttribute ?? { red: 0, green: 0, blue: 0, alpha: 1 });

  // one shape per paint, with every stretch as a rectangle
  const groups = new Map<string, { paint: PenFill | PenFill[]; kinds: Set<string>; rects: [number, number, number, number][] }>();
  rows.forEach((row, k) => {
    const { line, height } = row;
    const lineX = align === 'center' ? (boxWidth - line.pen) / 2 : align === 'right' ? boxWidth - line.pen : 0;
    for (const d of line.deco ?? []) {
      const m = metrics[d.run]!;
      const lh = lineHeightOf(d.run);
      // runs are bottom-aligned in their line; glyphs sit centred in their line height
      const baseline = yOffset + tops[k]! + (height - lh) + (lh - (m.ascent + m.descent)) / 2 + m.ascent;
      const centre = d.kind === 'u' ? baseline - m.underlinePosition : baseline - m.xHeight / 2;
      // Sketch draws the line with at least one device pixel on retina screens
      const thickness = Math.max(0.5, Math.ceil(m.underlineThickness * 2 - 1e-6) / 2);
      const paint = paintOf(d.run);
      const key = JSON.stringify(paint);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { paint, kinds: new Set(), rects: [] }));
      g.kinds.add(d.kind);
      g.rects.push([dx + lineX + d.x0, centre - thickness / 2, d.x1 - d.x0, thickness]);
    }
  });

  const out: PenNode[] = [];
  let gi = 0;
  for (const g of groups.values()) {
    const x0 = Math.min(...g.rects.map((r) => r[0]));
    const y0 = Math.min(...g.rects.map((r) => r[1]));
    const x1 = Math.max(...g.rects.map((r) => r[0] + r[2]));
    const y1 = Math.max(...g.rects.map((r) => r[1] + r[3]));
    const d = g.rects.map(([x, y, w, h]) => `M${r3(x - x0)} ${r3(y - y0)}h${r3(w)}v${r3(h)}h${r3(-w)}Z`).join('');
    const label = g.kinds.size > 1 ? 'underline and strikethrough' : g.kinds.has('u') ? 'underline' : 'strikethrough';
    const shape: PenNode = {
      type: 'path',
      id: ctx.ids.for(layer.do_objectID, `#deco${gi++}`),
      name: `${layer.name} (${label})`,
      geometry: d,
      viewBox: [0, 0, Math.max(r3(x1 - x0), 0.01), Math.max(r3(y1 - y0), 0.01)],
      x: r2(layer.frame.x + parent.dx + x0),
      y: r2(layer.frame.y + parent.dy + y0),
      width: Math.max(r2(x1 - x0), 0.01),
      height: Math.max(r2(y1 - y0), 0.01),
      fill: g.paint,
    };
    if (parent.layout !== 'none') shape.layoutPosition = 'absolute';
    if (node.enabled === false) shape.enabled = false;
    if (node.opacity !== undefined) shape.opacity = node.opacity;
    out.push(shape);
  }
  return out;
}
