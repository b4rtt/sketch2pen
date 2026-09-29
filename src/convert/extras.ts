// Extra nodes that reproduce Sketch features pen.dev has no property for: several borders with different widths,
// dashed borders, line-end markers (arrows) and shadow spread. Each extra node sits exactly over its layer.
import type { PenEffect, PenFill, PenNode } from '../pen/types.ts';
import type { Layer } from '../sketch/types.ts';
import { apply, parsePoint, penTransform, r2, r3, rotateCCW, type Pt } from '../util/geom.ts';
import { combine, difference, intersect, offsetShape, strokeOutline, transformPath, type Cap, type Join, type PathShape } from '../util/pathops.ts';
import type { Context } from './context.ts';
import type { ParentInfo } from './layers.ts';
import { flipMatrix } from './path.ts';
import { blendMode, convertPaint, hexColor, paintValue } from './style.ts';

const CAPS: Record<number, Cap> = { 0: 'butt', 1: 'round', 2: 'square' };
const JOINS: Record<number, Join> = { 0: 'miter', 1: 'round', 2: 'bevel' };

/** Positions an extra node exactly over its layer (geometry in the layer box, flips baked like paths). */
export function placeOver(layer: Layer, node: PenNode, parent: ParentInfo, baked = true): PenNode {
  const f = { ...layer.frame, x: layer.frame.x + parent.dx, y: layer.frame.y + parent.dy };
  const t = penTransform(f, layer.rotation ?? 0, !!layer.isFlippedHorizontal, !!layer.isFlippedVertical, baked);
  node.x = r2(t.x);
  node.y = r2(t.y);
  if (t.rotation) node.rotation = r2(t.rotation);
  if (!baked && layer.isFlippedHorizontal) node.flipX = true;
  if (!baked && layer.isFlippedVertical) node.flipY = true;
  if (parent.layout !== 'none') node.layoutPosition = 'absolute';
  if (layer.isVisible === false) node.enabled = false;
  const opacity = layer.style?.contextSettings?.opacity ?? 1;
  if (opacity < 0.999) node.opacity = r3(opacity);
  return node;
}

function pathNode(id: string, name: string, shape: PathShape, w: number, h: number, fill: PenFill | PenFill[] | undefined): PenNode {
  return {
    type: 'path',
    id,
    name,
    geometry: shape.d || 'M0 0',
    viewBox: [0, 0, Math.max(r3(w), 0.01), Math.max(r3(h), 0.01)],
    width: Math.max(r2(w), 0.01),
    height: Math.max(r2(h), 0.01),
    ...(fill !== undefined ? { fill } : {}),
    ...(shape.fillRule === 'evenodd' ? { fillRule: 'evenodd' as const } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Borders
// ---------------------------------------------------------------------------------------------

/**
 * pen.dev nodes have one stroke width/alignment and no dashes. The node keeps the first border group; other groups
 * become stroke-only copies on top, dashed borders become filled outlines of the dashes.
 */
export function borderExtras(ctx: Context, layer: Layer, node: PenNode, outline: PathShape | null, parent: ParentInfo, where: string): PenNode[] {
  const style = layer.style;
  const borders = (style?.borders ?? []).filter((b) => b.isEnabled && b.thickness > 0);
  if (!borders.length) return [];
  const { width: w, height: h } = layer.frame;
  const open = layer._class === 'shapePath' && layer.isClosed === false;
  const dash = (style?.borderOptions?.dashPattern ?? []).filter((v) => v >= 0);
  const dashed = dash.some((v) => v > 0);
  const groups: { thickness: number; position: number; paints: PenFill[] }[] = [];
  for (const b of borders) {
    const position = open ? 0 : b.position;
    const paint = convertPaint(ctx, b, w, h, where);
    if (!paint) continue;
    const last = groups[groups.length - 1];
    if (last && last.thickness === b.thickness && last.position === position) last.paints.push(paint);
    else groups.push({ thickness: b.thickness, position, paints: [paint] });
  }
  if (!groups.length || (!dashed && groups.length === 1)) return [];
  const cap = CAPS[style?.borderOptions?.lineCapStyle ?? 0] ?? 'butt';
  const join = JOINS[style?.borderOptions?.lineJoinStyle ?? 0] ?? 'miter';
  const align = (p: number) => (({ 0: 'center', 1: 'inner', 2: 'outer' }) as const)[p as 0 | 1 | 2] ?? 'center';
  const out: PenNode[] = [];

  if (dashed) {
    if (!outline) {
      ctx.report.warn('dashed-border', 'Dashed border on this kind of layer drawn solid', where);
      return [];
    }
    delete node.stroke;
    delete node.strokeWidth;
    delete node.strokeAlignment;
    delete node.strokeLinecap;
    delete node.strokeLinejoin;
    if (dash.length > 2) ctx.report.warn('dash-pattern', 'Dash patterns with more than one dash/gap pair use their first pair', where);
    groups.forEach((g, gi) => {
      let s = strokeOutline(outline, g.position === 0 ? g.thickness : g.thickness * 2, cap, join, [dash[0]!, dash[1] ?? dash[0]!]);
      if (s && g.position === 1) s = intersect(s, outline);
      if (s && g.position === 2) s = difference(s, outline);
      if (!s?.d) return;
      out.push(placeOver(layer, pathNode(ctx.ids.for(layer.do_objectID, `#dash${gi}`), `${layer.name} (dashed border)`, s, w, h, paintValue(g.paints)), parent));
    });
    return out;
  }

  // several solid borders with different widths / positions
  const first = groups[0]!;
  node.stroke = paintValue(first.paints);
  node.strokeWidth = r3(first.thickness);
  node.strokeAlignment = align(first.position);
  groups.slice(1).forEach((g, gi) => {
    const copy: PenNode = {
      type: node.type,
      id: ctx.ids.for(layer.do_objectID, `#border${gi + 1}`),
      name: `${layer.name} (border ${gi + 2})`,
      width: node.width,
      height: node.height,
      stroke: paintValue(g.paints),
      strokeWidth: r3(g.thickness),
      strokeAlignment: align(g.position),
      ...(node.cornerRadius !== undefined ? { cornerRadius: node.cornerRadius } : {}),
      ...(node.geometry ? { geometry: node.geometry, viewBox: node.viewBox } : {}),
      ...(node.fillRule ? { fillRule: node.fillRule } : {}),
      ...(node.strokeLinecap ? { strokeLinecap: node.strokeLinecap } : {}),
      ...(node.strokeLinejoin ? { strokeLinejoin: node.strokeLinejoin } : {}),
    };
    if (typeof copy.width !== 'number' || typeof copy.height !== 'number') {
      copy.width = Math.max(r2(w), 0.01);
      copy.height = Math.max(r2(h), 0.01);
    }
    out.push(placeOver(layer, copy, parent, node.type === 'path'));
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Line markers (arrows). Geometry measured from Sketch renders at stroke widths 1–8.
// ---------------------------------------------------------------------------------------------

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt, k = 1): Pt => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const norm = (v: Pt): Pt => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};
const fmt = (p: Pt) => `${r3(p.x)} ${r3(p.y)}`;
const poly = (pts: Pt[], closed = true) => `M${pts.map(fmt).join('L')}${closed ? 'Z' : ''}`;

function circle(c: Pt, r: number): string {
  const k = 0.5522847498 * r;
  return (
    `M${fmt({ x: c.x + r, y: c.y })}` +
    `C${fmt({ x: c.x + r, y: c.y + k })} ${fmt({ x: c.x + k, y: c.y + r })} ${fmt({ x: c.x, y: c.y + r })}` +
    `C${fmt({ x: c.x - k, y: c.y + r })} ${fmt({ x: c.x - r, y: c.y + k })} ${fmt({ x: c.x - r, y: c.y })}` +
    `C${fmt({ x: c.x - r, y: c.y - k })} ${fmt({ x: c.x - k, y: c.y - r })} ${fmt({ x: c.x, y: c.y - r })}` +
    `C${fmt({ x: c.x + k, y: c.y - r })} ${fmt({ x: c.x + r, y: c.y - k })} ${fmt({ x: c.x + r, y: c.y })}Z`
  );
}

function square(c: Pt, dir: Pt, half: number): string {
  const n = { x: -dir.y, y: dir.x };
  return poly([add(add(c, dir, half), n, half), add(add(c, dir, -half), n, half), add(add(c, dir, -half), n, -half), add(add(c, dir, half), n, -half)]);
}

/** Marker shape at `p` for a line ending in direction `dir` (pointing away from the line). */
function markerShape(type: number, p: Pt, dir: Pt, w: number): PathShape | null {
  const n = { x: -dir.y, y: dir.x };
  const size = 2.5 * w + 1.5; // outer half size of circles and squares
  switch (type) {
    case 1: {
      // open arrow: 30° arms stroked with the line width, miter tip slightly past the end point
      const tip = add(p, dir, 0.2 * w);
      const len = 4.6 * w + 4;
      const back = { x: -dir.x, y: -dir.y };
      const a1 = add(tip, apply(rotateCCW(30), back), len);
      const a2 = add(tip, apply(rotateCCW(-30), back), len);
      return strokeOutline({ d: poly([a1, tip, a2], false), fillRule: 'nonzero' }, w, 'butt', 'miter');
    }
    case 2: {
      const length = 5 * w + 4;
      const half = 2.5 * w + 2;
      const base = add(p, dir, -length);
      return { d: poly([p, add(base, n, half), add(base, n, -half)]), fillRule: 'nonzero' };
    }
    case 3: {
      const half = 2 * w + 2;
      return { d: poly([add(add(p, dir, w / 2), n, half), add(add(p, dir, -w / 2), n, half), add(add(p, dir, -w / 2), n, -half), add(add(p, dir, w / 2), n, -half)]), fillRule: 'nonzero' };
    }
    case 4:
      return { d: circle(p, size) + circle(p, size - w), fillRule: 'evenodd' };
    case 5:
      return { d: circle(p, size), fillRule: 'nonzero' };
    case 6:
      return { d: square(p, dir, size) + square(p, dir, size - w), fillRule: 'evenodd' };
    case 7:
      return { d: square(p, dir, size), fillRule: 'nonzero' };
    default:
      return null;
  }
}

/** Start/end markers of open paths as one filled path above the line. */
export function markerExtras(ctx: Context, layer: Layer, parent: ParentInfo, where: string): PenNode[] {
  const start = layer.style?.startMarkerType ?? 0;
  const end = layer.style?.endMarkerType ?? 0;
  if (!start && !end) return [];
  const pts = layer.points ?? [];
  const border = (layer.style?.borders ?? []).find((b) => b.isEnabled && b.thickness > 0);
  if (layer._class !== 'shapePath' || layer.isClosed !== false || pts.length < 2 || !border) return [];
  const { width: W, height: H } = layer.frame;
  const m = flipMatrix(layer);
  const P = (s: string) => apply(m, { x: parsePoint(s).x * W, y: parsePoint(s).y * H });
  const first = pts[0]!;
  const second = pts[1]!;
  const last = pts[pts.length - 1]!;
  const beforeLast = pts[pts.length - 2]!;
  const shapes: PathShape[] = [];
  if (start) {
    const p = P(first.point);
    const s = markerShape(start, p, norm(sub(p, P(first.hasCurveFrom ? first.curveFrom : second.point))), border.thickness);
    if (s?.d) shapes.push(s);
  }
  if (end) {
    const p = P(last.point);
    const s = markerShape(end, p, norm(sub(p, P(last.hasCurveTo ? last.curveTo : beforeLast.point))), border.thickness);
    if (s?.d) shapes.push(s);
  }
  if (!shapes.length) return [];
  const merged = shapes.length === 1 ? shapes[0]! : (combine(shapes[0]!, shapes.slice(1).map((shape) => ({ shape, op: 'union' as const }))) ?? shapes[0]!);
  const paint = convertPaint(ctx, { ...border, fillType: border.fillType === 1 ? 0 : border.fillType, color: border.fillType === 1 ? border.gradient.stops[0]?.color ?? border.color : border.color }, W, H, where);
  return [placeOver(layer, pathNode(ctx.ids.for(layer.do_objectID, '#markers'), `${layer.name} (line ends)`, merged, W, H, paint ?? undefined), parent)];
}

// ---------------------------------------------------------------------------------------------
// Shadow spread: pen.dev ignores `spread`, so such shadows become a blurred shape behind the layer.
// ---------------------------------------------------------------------------------------------

export function spreadShadowExtras(ctx: Context, layer: Layer, node: PenNode, outline: PathShape | null, parent: ParentInfo, where: string): PenNode[] {
  const shadows = (layer.style?.shadows ?? []).filter((s) => s.isEnabled && !s.isInnerShadow && s.spread);
  if (!shadows.length) return [];
  if (!outline) {
    ctx.report.warn('shadow-spread', 'Shadow spread on this kind of layer is not supported by pen.dev – drawn without spread', where);
    return [];
  }
  const { width: w, height: h } = layer.frame;
  // offsets are in canvas axes; bring them into the rotated layer box
  const t = penTransform(layer.frame, layer.rotation ?? 0, !!layer.isFlippedHorizontal, !!layer.isFlippedVertical, true);
  const out: PenNode[] = [];
  shadows.forEach((s, i) => {
    const off = apply(rotateCCW(-t.rotation), { x: s.offsetX, y: s.offsetY });
    const grown = offsetShape(outline, s.spread);
    const shape = transformPath(grown, [1, 0, 0, 1, off.x, off.y]);
    if (!shape.d) return;
    const hex = hexColor(s.color, s.contextSettings?.opacity ?? 1);
    const bm = blendMode(s.contextSettings?.blendMode);
    const shadowNode = pathNode(ctx.ids.for(layer.do_objectID, `#shadow${i}`), `${layer.name} (shadow)`, shape, w, h, bm ? { type: 'color', color: hex, blendMode: bm } : hex);
    if (s.blurRadius) shadowNode.effect = { type: 'blur', radius: r2(s.blurRadius) };
    out.push(placeOver(layer, shadowNode, parent));
  });
  // drop the emulated shadows from the node's own effects
  const keep = (e: PenEffect) => !(e.type === 'shadow' && shadows.some((s) => r2(s.offsetX) === e.offset?.x && r2(s.offsetY) === e.offset?.y && (e.spread ?? 0) === r2(s.spread)));
  const effects = node.effect === undefined ? [] : Array.isArray(node.effect) ? node.effect : [node.effect];
  const left = effects.filter(keep);
  if (left.length) node.effect = left.length === 1 ? left[0] : left;
  else delete node.effect;
  return out;
}
