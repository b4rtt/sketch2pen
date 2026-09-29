import type { PenEffect, PenFill, PenNode, Sizing } from '../pen/types.ts';
import type { Layer, Shadow } from '../sketch/types.ts';
import { apply, IDENTITY, invert, layerMatrix, penTransform, r2, r3, rotateCCW, type Matrix } from '../util/geom.ts';
import { combine, difference, innerShadowBand, intersect, offsetShape, transformPath, type BoolOp, type PathShape } from '../util/pathops.ts';
import type { Context } from './context.ts';
import { borderExtras, markerExtras, spreadShadowExtras } from './extras.ts';
import { planFlex, isFlexLayout } from './flex.ts';
import { cornerRadii, ellipsePath, flipMatrix, multiply, parentMatrix, roundedRectPath, shapePathData, smoothRectPath } from './path.ts';
import { decodeImage, encodePng } from '../util/image.ts';
import { parsePoint } from '../util/geom.ts';
import { glyphKey, glyphRequest, isDecorated } from './coretext.ts';
import { textDecorations } from './decorations.ts';
import { blendMode, colorOrVariable, convertBorders, convertEffects, convertFills, hexColor, paintValue, tintOf, tintPaint } from './style.ts';
import { convertInstance, resizedFrame } from './symbols.ts';
import { convertText, textSizing } from './text.ts';

export interface ParentInfo {
  /** layout of the pen.dev parent node */
  layout: 'none' | 'horizontal' | 'vertical';
  /** parent stack stretches children on the cross axis */
  stretch?: boolean;
  /** offset added to child positions (used when children are re-parented into mask frames) */
  dx: number;
  dy: number;
  /** breadcrumb for the report */
  path: string;
  /** Sketch tint inherited from an ancestor group/frame (hex colour) */
  tint?: string;
  /**
   * Nothing is painted below this layer inside its frame yet. Sketch draws frame content in its own layer, so
   * blend modes never mix with the frame background – for the first painted layer a blend mode is a no-op.
   */
  backdropEmpty?: boolean;
  /** Exact clip of a Sketch path mask, in the coordinate space of the Sketch parent. */
  clipPath?: PathShape;
}

export const ROOT: ParentInfo = { layout: 'none', dx: 0, dy: 0, path: '' };

const SHAPES = new Set(['rectangle', 'oval', 'shapePath', 'triangle', 'star', 'polygon']);

export function isShape(l: Layer): boolean {
  return SHAPES.has(l._class);
}

// ---------------------------------------------------------------------------------------------
// Children, masks
// ---------------------------------------------------------------------------------------------

export function convertChildren(ctx: Context, layers: Layer[], parent: ParentInfo): PenNode[] {
  const out: PenNode[] = [];
  let empty = parent.backdropEmpty ?? false;
  let i = 0;
  while (i < layers.length) {
    const layer = layers[i]!;
    const info: ParentInfo = { ...parent, backdropEmpty: empty };
    let nodes: PenNode[];
    if (layer.hasClippingMask && parent.layout === 'none') {
      let j = i + 1;
      const masked: Layer[] = [];
      while (j < layers.length && !layers[j]!.shouldBreakMaskChain && !layers[j]!.hasClippingMask) masked.push(layers[j++]!);
      nodes = convertMask(ctx, layer, masked, info);
      i = j;
    } else {
      nodes = convertLayer(ctx, layer, info);
      i++;
    }
    out.push(...nodes);
    if (nodes.length && layer.isVisible !== false) empty = false;
  }
  return out;
}

function hasVisibleStyle(l: Layer): boolean {
  const s = l.style;
  return !!(s?.fills?.some((f) => f.isEnabled) || s?.borders?.some((b) => b.isEnabled && b.thickness > 0) || s?.shadows?.some((x) => x.isEnabled));
}

/**
 * The layer whose outline clips: the mask itself, or – for a symbol instance used as a mask – the single shape its
 * master consists of, resized with the instance by Sketch's rules (shape points are relative to the shape's frame).
 */
function maskGeometry(ctx: Context, mask: Layer): Layer {
  if (mask._class !== 'symbolInstance') return mask;
  const master = ctx.masters.get(mask.symbolID ?? '')?.master;
  const visible = (master?.layers ?? []).filter((l) => l.isVisible !== false);
  const shape = visible.length === 1 ? visible[0]! : undefined;
  if (!master || !shape || !isShape(shape) || shape.rotation || shape.isFlippedHorizontal || shape.isFlippedVertical || mask.rotation) return mask;
  const mf = master.frame;
  const f = mask.frame;
  const scaled = !!mask.scale && Math.abs(mask.scale - 1) > 0.001;
  const sx = f.width / Math.max(mf.width, 1e-6);
  const sy = f.height / Math.max(mf.height, 1e-6);
  const r = scaled
    ? { x: shape.frame.x * sx, y: shape.frame.y * sy, width: shape.frame.width * sx, height: shape.frame.height * sy }
    : resizedFrame(shape, mf.width, mf.height, f.width, f.height);
  // a mirrored instance mirrors the shape's place inside it
  const x = mask.isFlippedHorizontal ? f.width - r.x - r.width : r.x;
  const y = mask.isFlippedVertical ? f.height - r.y - r.height : r.y;
  return {
    ...shape,
    do_objectID: mask.do_objectID,
    name: mask.name,
    frame: { ...f, x: f.x + x, y: f.y + y, width: r.width, height: r.height },
    rotation: mask.rotation,
    isFlippedHorizontal: mask.isFlippedHorizontal,
    isFlippedVertical: mask.isFlippedVertical,
    isVisible: mask.isVisible,
    hasClippingMask: true,
    clippingMaskMode: mask.clippingMaskMode,
  };
}

/**
 * Corner radii [tl, tr, br, bl] when the layer's outline is an axis-aligned (rounded) rectangle – also for edited
 * rectangles and paths whose extra points only lie on the rectangle's edges.
 */
export function rectangleRadii(l: Layer): [number, number, number, number] | null {
  if (l._class === 'rectangle' && !l.edited) return cornerRadii(l);
  if ((l._class !== 'rectangle' && l._class !== 'shapePath') || l.isClosed === false) return null;
  const pts = (l.points ?? []).map((q) => ({ p: parsePoint(q.point), r: q.cornerRadius || 0, curved: q.hasCurveFrom || q.hasCurveTo }));
  if (pts.length < 4 || pts.some((q) => q.curved)) return null;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => pts.findIndex((q) => near(q.p.x, x!) && near(q.p.y, y!)));
  if (corners.some((i) => i < 0)) return null;
  for (let i = 0; i < pts.length; i++) {
    if (corners.includes(i)) continue;
    const { p, r } = pts[i]!;
    if (r > 0 || !(near(p.x, 0) || near(p.x, 1) || near(p.y, 0) || near(p.y, 1))) return null;
  }
  // the corners have to follow each other along the outline (either direction)
  const order = [...corners].sort((a, b) => a - b).map((i) => corners.indexOf(i));
  const steps = order.map((c, k) => (order[(k + 1) % 4]! - c + 4) % 4);
  if (!steps.every((d) => d === 1) && !steps.every((d) => d === 3)) return null;
  if (l.style?.corners?.radii?.length) return cornerRadii(l);
  return corners.map((i) => pts[i]!.r) as [number, number, number, number];
}

/**
 * Whether a masked layer would be drawn differently when clipped by the mask's bounds instead of its outline:
 * shapes and images are clipped exactly anyway, other layers only matter where they reach past the outline.
 */
function crossesOutline(l: Layer, outline: PathShape, dx = 0, dy = 0): boolean {
  if (l.isVisible === false || isShape(l) || l._class === 'shapeGroup' || l._class === 'bitmap') return false;
  const f = l.frame;
  if (l._class === 'group' && !l.groupBehavior && !l.rotation && !l.isFlippedHorizontal && !l.isFlippedVertical) {
    return (l.layers ?? []).some((c) => crossesOutline(c, outline, dx + f.x, dy + f.y));
  }
  const x0 = dx + f.x + 0.5;
  const y0 = dy + f.y + 0.5;
  const x1 = dx + f.x + f.width - 0.5;
  const y1 = dy + f.y + f.height - 0.5;
  if (x1 <= x0 || y1 <= y0) return false;
  return !!difference({ d: `M${x0} ${y0}L${x1} ${y0}L${x1} ${y1}L${x0} ${y1}Z`, fillRule: 'nonzero' }, outline)?.d;
}

/**
 * Sketch masks clip all following siblings. pen.dev has no masks, only clipping frames, so the mask becomes a
 * clipping frame (with the mask's corner radii – exact for rectangles and circles) that contains the mask shape and
 * the masked layers. Other outlines clip vector shapes and images exactly (Skia PathOps).
 */
function convertMask(ctx: Context, mask: Layer, masked: Layer[], parent: ParentInfo): PenNode[] {
  const where = `${parent.path}/${mask.name}`;
  const geom = maskGeometry(ctx, mask);
  const f = geom.frame;
  const rectRadii = rectangleRadii(geom);
  const isRect = !!rectRadii;
  const isOval = geom._class === 'oval' && !geom.edited;
  const isCircle = isOval && Math.abs(f.width - f.height) < 0.5;

  // A shape masking a single bitmap of the same size → the shape itself with an image fill.
  if ((isRect || isOval || mask._class === 'shapePath') && mask === geom && mask.clippingMaskMode !== 1 && masked.length === 1 && masked[0]!._class === 'bitmap' && !mask.rotation) {
    const bmp = masked[0]!;
    const same = Math.abs(bmp.frame.x - f.x) < 0.6 && Math.abs(bmp.frame.y - f.y) < 0.6 && Math.abs(bmp.frame.width - f.width) < 0.6 && Math.abs(bmp.frame.height - f.height) < 0.6;
    const url = ctx.imageUrl(bmp.image?._ref);
    if (same && url && bmp.isVisible !== false) {
      const nodes = convertLayer(ctx, { ...mask, hasClippingMask: false }, parent);
      const node = nodes.find((n) => n.id === ctx.ids.for(mask.do_objectID)) ?? nodes[0];
      if (node) {
        const fills = node.fill === undefined ? [] : Array.isArray(node.fill) ? node.fill : [node.fill];
        node.fill = paintValue([...fills, { type: 'image', url, mode: 'stretch' }]);
        node.name = `${mask.name} + ${bmp.name}`;
        ctx.track(bmp, node.id);
        return nodes;
      }
    }
  }

  // Path masks: vector shapes are intersected with the mask outline exactly, everything else is clipped by its box.
  let clipPath: PathShape | undefined;
  if (!isRect && !isCircle) {
    const outline = isShape(geom) ? { d: shapePathData(geom, parentMatrix(geom)), fillRule: 'nonzero' as const } : geom._class === 'shapeGroup' ? shapeGroupPath(geom, parentMatrix(geom)) : null;
    if (outline?.d) clipPath = parent.clipPath ? (intersect(outline, parent.clipPath) ?? outline) : outline;
    if (!clipPath || (outline && masked.some((l) => crossesOutline(l, outline)))) {
      ctx.report.warn('path-mask', 'Path-shaped mask: shapes and images are clipped exactly, texts and instances reaching past the outline by the mask bounds (pen.dev only clips with frames)', where);
    }
  }
  if (mask.clippingMaskMode === 1) {
    const baked = bakeAlphaMask(ctx, geom, masked, parent, where);
    if (baked) return baked;
    ctx.report.warn('alpha-mask', 'Alpha mask approximated by the average opacity of the mask (pen.dev has no opacity masks)', where);
  }
  if (mask.rotation) ctx.report.warn('rotated-mask', 'Rotated mask clipped by its unrotated bounds', where);

  const id = ctx.ids.for(mask.do_objectID, '#mask');
  ctx.maskFrames.set(mask.do_objectID, id);
  const frame: PenNode = {
    type: 'frame',
    id,
    name: `${mask.name} (mask)`,
    x: r2(f.x + parent.dx),
    y: r2(f.y + parent.dy),
    width: r2(f.width),
    height: r2(f.height),
    layout: 'none',
    clip: true,
  };
  // circles are exact; for other ellipses the pill-shaped frame contains the ellipse, whose outline clips the shapes
  if (isOval) frame.cornerRadius = r2(Math.min(f.width, f.height) / 2);
  if (rectRadii) {
    const radii = rectRadii.map((r) => Math.max(0, Math.min(r, f.width / 2, f.height / 2)));
    if (radii.some((r) => r > 0)) frame.cornerRadius = radii.every((r) => r === radii[0]) ? r2(radii[0]!) : (radii.map(r2) as [number, number, number, number]);
  }
  if (mask.isVisible === false) frame.enabled = false;
  if (mask.clippingMaskMode === 1) {
    // pen.dev has no opacity masks: approximate a gradient alpha mask by its average opacity
    const fill = geom.style?.fills?.find((x) => x.isEnabled);
    let alpha = fill ? (fill.contextSettings?.opacity ?? 1) * (fill.fillType === 1 ? fill.gradient.stops.reduce((s, st) => s + st.color.alpha, 0) / Math.max(fill.gradient.stops.length, 1) : fill.color.alpha) : 1;
    alpha *= mask.style?.contextSettings?.opacity ?? 1;
    if (alpha < 0.99) frame.opacity = r3(alpha);
  }
  const inner: ParentInfo = { layout: 'none', dx: -f.x, dy: -f.y, path: where, tint: parent.tint, backdropEmpty: parent.backdropEmpty, clipPath: clipPath ?? parent.clipPath };
  const children: PenNode[] = [];
  // the mask layer itself is drawn too (for an instance, whatever its symbol paints)
  if ((hasVisibleStyle(mask) || mask._class === 'symbolInstance') && mask.isVisible !== false && mask.clippingMaskMode !== 1) {
    children.push(...convertLayer(ctx, { ...mask, hasClippingMask: false }, inner));
  }
  // the painted mask shape is the backdrop of the masked layers (matters for their blend modes)
  children.push(...convertChildren(ctx, masked, children.length ? { ...inner, backdropEmpty: false } : inner));
  frame.children = children;
  if (!children.length) return [];
  // Sketch composites masked content in its own layer, so blend modes only see the mask group itself.
  // A barely-translucent frame makes pen.dev isolate the group the same way.
  if (frame.opacity === undefined && usesBlendModes(masked)) frame.opacity = 0.999;
  return [frame];
}

function usesBlendModes(layers: Layer[]): boolean {
  return layers.some(
    (l) =>
      l.isVisible !== false &&
      (!!l.style?.contextSettings?.blendMode || !!l.style?.fills?.some((f) => f.isEnabled && f.contextSettings?.blendMode) || usesBlendModes(l.layers ?? [])),
  );
}

/** Opacity of a mask fill at a normalized point of the mask box (solid, linear and radial fills). */
function maskAlpha(mask: Layer, u: number, v: number): number {
  const fill = mask.style?.fills?.find((f) => f.isEnabled);
  const layerOpacity = mask.style?.contextSettings?.opacity ?? 1;
  if (!fill) return layerOpacity;
  const opacity = (fill.contextSettings?.opacity ?? 1) * layerOpacity;
  if (fill.fillType !== 1) return (fill.color?.alpha ?? 1) * opacity;
  const g = fill.gradient;
  const { width: w, height: h } = mask.frame;
  const F = parsePoint(g.from);
  const T = parsePoint(g.to);
  const dx = (T.x - F.x) * w;
  const dy = (T.y - F.y) * h;
  const px = (u - F.x) * w;
  const py = (v - F.y) * h;
  let t: number;
  if (g.gradientType === 1) {
    const a = Math.hypot(dx, dy) || 1e-6;
    const b = a * (g.elipseLength || 1);
    const along = (px * dx + py * dy) / a;
    const across = (-px * dy + py * dx) / a;
    t = Math.hypot(along / a, across / b);
  } else {
    t = (px * dx + py * dy) / (dx * dx + dy * dy || 1e-6);
  }
  t = Math.max(0, Math.min(1, t));
  const stops = [...g.stops].sort((p, q) => p.position - q.position);
  if (!stops.length) return opacity;
  if (t <= stops[0]!.position) return stops[0]!.color.alpha * opacity;
  for (let i = 1; i < stops.length; i++) {
    const s0 = stops[i - 1]!;
    const s1 = stops[i]!;
    if (t <= s1.position) {
      const k = (t - s0.position) / Math.max(s1.position - s0.position, 1e-6);
      return (s0.color.alpha + (s1.color.alpha - s0.color.alpha) * k) * opacity;
    }
  }
  return stops[stops.length - 1]!.color.alpha * opacity;
}

/**
 * Alpha masks (e.g. an image fading out) have no pen.dev equivalent. When a rectangle/oval alpha mask covers a single
 * unrotated image, the mask's opacity is baked into a new PNG – exact, and the layer stays an image.
 */
function bakeAlphaMask(ctx: Context, mask: Layer, masked: Layer[], parent: ParentInfo, where: string): PenNode[] | null {
  const bmp = masked[0];
  if (masked.length !== 1 || !bmp || bmp._class !== 'bitmap' || bmp.isVisible === false) return null;
  if (mask.rotation || bmp.rotation || mask.isFlippedHorizontal || mask.isFlippedVertical || bmp.isFlippedHorizontal || bmp.isFlippedVertical) return null;
  const rectRadii = rectangleRadii(mask);
  const isOval = mask._class === 'oval' && !mask.edited;
  if (!rectRadii && !isOval) return null;
  const ref = bmp.image?._ref;
  const bytes = ref ? (ctx.sketch.files.get(ref) ?? ctx.sketch.files.get(`${ref}.png`)) : undefined;
  const img = bytes ? decodeImage(bytes) : null;
  if (!img) return null;
  const mf = mask.frame;
  const bf = bmp.frame;
  const radii = rectRadii ?? [0, 0, 0, 0];
  const inside = (x: number, y: number) => {
    if (x < 0 || y < 0 || x > mf.width || y > mf.height) return false;
    if (isOval) return ((x - mf.width / 2) / (mf.width / 2)) ** 2 + ((y - mf.height / 2) / (mf.height / 2)) ** 2 <= 1;
    const r = x < mf.width / 2 ? (y < mf.height / 2 ? radii[0] : radii[3]) : y < mf.height / 2 ? radii[1] : radii[2];
    if (!r) return true;
    const cx = x < r ? r : x > mf.width - r ? mf.width - r : x;
    const cy = y < r ? r : y > mf.height - r ? mf.height - r : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const out = new Uint8Array(img.data);
  for (let py = 0; py < img.height; py++) {
    for (let px = 0; px < img.width; px++) {
      const x = bf.x + ((px + 0.5) / img.width) * bf.width - mf.x;
      const y = bf.y + ((py + 0.5) / img.height) * bf.height - mf.y;
      const a = inside(x, y) ? maskAlpha(mask, x / mf.width, y / mf.height) : 0;
      const i = (py * img.width + px) * 4 + 3;
      out[i] = Math.round(out[i]! * a);
    }
  }
  const key = `generated/${ctx.ids.for(mask.do_objectID, '#alpha')}.png`;
  ctx.sketch.files.set(key, encodePng({ ...img, data: out }));
  return convertLayer(ctx, { ...bmp, name: `${bmp.name} (${mask.name})`, image: { _ref: key } }, parent);
}

// ---------------------------------------------------------------------------------------------
// Common properties
// ---------------------------------------------------------------------------------------------

function axisSizing(layer: Layer, axis: 'h' | 'v', parent: ParentInfo, fitMeansContent: boolean): Sizing {
  const size = axis === 'h' ? layer.frame.width : layer.frame.height;
  const sizing = axis === 'h' ? layer.horizontalSizing : layer.verticalSizing;
  const inLayout = parent.layout !== 'none' && !layer.flexItem?.ignoreLayout;
  if (inLayout) {
    const cross = (parent.layout === 'vertical') === (axis === 'h');
    if (sizing === 2 || (cross && parent.stretch)) return 'fill_container';
  }
  if (fitMeansContent && sizing === 1) return 'fit_content';
  return r2(size);
}

/** Position, rotation, flips, visibility, opacity – shared by all node types. */
function applyCommon(ctx: Context, layer: Layer, node: PenNode, parent: ParentInfo, opts: { bakedFlip?: boolean } = {}): void {
  node.name = layer.name;
  if (layer.isVisible === false) node.enabled = false;
  const opacity = layer.style?.contextSettings?.opacity ?? 1;
  if (opacity < 0.999) node.opacity = r3(opacity);

  const inLayout = parent.layout !== 'none';
  const absolute = inLayout && !!layer.flexItem?.ignoreLayout;
  if (absolute) node.layoutPosition = 'absolute';
  const flipH = !!layer.isFlippedHorizontal;
  const flipV = !!layer.isFlippedVertical;
  const baked = !!opts.bakedFlip;
  const f = { ...layer.frame, x: layer.frame.x + parent.dx, y: layer.frame.y + parent.dy };
  const t = penTransform(f, layer.rotation ?? 0, flipH, flipV, baked);
  if (!inLayout || absolute) {
    node.x = r2(t.x);
    node.y = r2(t.y);
  } else if (!baked && (flipH || flipV)) {
    ctx.report.warn('flip-in-stack', 'Mirrored layer inside a stack – its position may be off', `${parent.path}/${layer.name}`);
  }
  if (t.rotation) node.rotation = r2(t.rotation);
  if (!baked && flipH) node.flipX = true;
  if (!baked && flipV) node.flipY = true;
  const bm = layer.style?.contextSettings?.blendMode;
  if (bm && !parent.backdropEmpty) {
    // pen.dev has blend modes on paints only – push the layer blend mode down to the fills.
    const mode = blendMode(bm);
    const fills = node.fill === undefined ? [] : Array.isArray(node.fill) ? node.fill : [node.fill];
    if (mode && fills.length) {
      node.fill = paintValue(fills.map((p): PenFill => (typeof p === 'string' ? { type: 'color', color: p, blendMode: mode } : { ...p, blendMode: p.blendMode ?? mode })));
    } else {
      ctx.report.warn('layer-blend', 'Layer blend mode on a layer without fills cannot be converted', `${parent.path}/${layer.name}`);
    }
  }
}

/** Recolours a node's own paints with an inherited Sketch tint. */
function applyTint(node: PenNode, tint: string | undefined): void {
  if (!tint) return;
  const recolor = (v: PenNode['fill']) => {
    if (v === undefined) return v;
    return paintValue((Array.isArray(v) ? v : [v]).map((p) => tintPaint(p, tint)));
  };
  if (node.type === 'text' || node.type === 'path' || node.type === 'rectangle' || node.type === 'ellipse' || node.type === 'frame') {
    if (node.fill !== undefined) node.fill = recolor(node.fill);
    if (node.stroke !== undefined) node.stroke = recolor(node.stroke);
  }
  if (node.type === 'frame' && node.layout === 'vertical' && node.children?.every((c) => c.type === 'text' || c.type === 'frame')) {
    // split mixed-style text: recolour its runs
    const walk = (n: PenNode) => {
      if (n.type === 'text' && n.fill !== undefined) n.fill = recolor(n.fill);
      n.children?.forEach(walk);
    };
    node.children.forEach(walk);
  }
}

function applyEffects(ctx: Context, layer: Layer, node: PenNode, where: string): Shadow[] {
  const { effects, innerShadows } = convertEffects(ctx, layer.style, where);
  if (effects.length) node.effect = effects.length === 1 ? effects[0] : effects;
  // pen.dev only blurs the backdrop of shapes that have some fill – Sketch blurs fill-less shapes too.
  if (effects.some((e) => e.type === 'background_blur') && node.fill === undefined && node.type !== 'group' && node.type !== 'ref' && node.type !== 'text') {
    node.fill = '#FFFFFF01';
  }
  return innerShadows;
}

// ---------------------------------------------------------------------------------------------
// Inner shadows (pen.dev 1.2 still draws `inner` shadows of paths as outer ones, so they are emulated)
// ---------------------------------------------------------------------------------------------

function layerOutline(layer: Layer): PathShape | null {
  if (isShape(layer)) return { d: shapePathData(layer, flipMatrix(layer)), fillRule: layer.style?.windingRule === 1 ? 'evenodd' : 'nonzero' };
  if (layer._class === 'shapeGroup') return shapeGroupPath(layer, flipMatrix(layer));
  return null;
}

/**
 * Emulates inner shadows. Blur-less, spread-less shadows on rectangles become per-side inner strokes (exact),
 * everything else becomes an overlay path "shape − shifted shape" (optionally blurred).
 */
function emulateInnerShadows(ctx: Context, layer: Layer, node: PenNode, shadows: Shadow[], parent: ParentInfo, where: string): PenNode[] {
  if (!shadows.length) return [];
  const extra: PenNode[] = [];
  const rectLike = node.type === 'rectangle' || node.type === 'frame';
  shadows.forEach((s, i) => {
    const hex = hexColor(s.color, s.contextSettings?.opacity ?? 1);
    const bm = blendMode(s.contextSettings?.blendMode);
    const color: PenFill = bm ? { type: 'color', color: hex, blendMode: bm } : hex;
    if (rectLike && !s.blurRadius && !s.spread && node.stroke === undefined && i === shadows.length - 1) {
      const sw: Record<string, number> = {};
      if (s.offsetY > 0) sw.top = r2(s.offsetY);
      if (s.offsetY < 0) sw.bottom = r2(-s.offsetY);
      if (s.offsetX > 0) sw.left = r2(s.offsetX);
      if (s.offsetX < 0) sw.right = r2(-s.offsetX);
      if (!Object.keys(sw).length) return;
      node.stroke = color;
      node.strokeWidth = sw;
      node.strokeAlignment = 'inner';
      ctx.innerShadowTargets.set(`${layer.do_objectID}:${i}`, { id: node.id, prop: 'stroke' });
      return;
    }
    const outline = nodeOutline(layer, node);
    if (!outline) {
      ctx.report.warn('inner-shadow-skip', 'Inner shadow on this kind of layer cannot be emulated – skipped', where);
      return;
    }
    // shadow offsets are in canvas axes; bring them into the (rotated) layer box
    const rot = penTransform(layer.frame, layer.rotation ?? 0, !!layer.isFlippedHorizontal, !!layer.isFlippedVertical, true).rotation;
    const off = apply(rotateCCW(-rot), { x: s.offsetX, y: s.offsetY });
    const clipped = !!s.blurRadius && (node.type === 'rectangle' || node.type === 'ellipse' || (node.type === 'frame' && !!node.clip));
    let band: PathShape | null;
    if (clipped) {
      // Blurred shadow: everything outside the (shrunk, shifted) hole is shadow; blur it and clip it to the shape.
      const hole = transformPath(offsetShape(outline, -(s.spread ?? 0)), [1, 0, 0, 1, off.x, off.y]);
      const m = s.blurRadius * 1.5 + Math.abs(off.x) + Math.abs(off.y) + Math.abs(s.spread ?? 0) + 2;
      const w = layer.frame.width;
      const h = layer.frame.height;
      band = difference({ d: `M${-m} ${-m}L${w + m} ${-m}L${w + m} ${h + m}L${-m} ${h + m}Z`, fillRule: 'nonzero' }, hole);
    } else {
      band = innerShadowBand(outline, off.x, off.y, s.spread ?? 0);
    }
    if (!band || !band.d || band.d === 'Z') return;
    const id = ctx.ids.for(layer.do_objectID, `#inner${i}`);
    const overlay: PenNode = {
      type: 'path',
      id,
      name: `${layer.name} (inner shadow)`,
      geometry: band.d,
      viewBox: [0, 0, Math.max(r3(layer.frame.width), 0.01), Math.max(r3(layer.frame.height), 0.01)],
      width: Math.max(r2(layer.frame.width), 0.01),
      height: Math.max(r2(layer.frame.height), 0.01),
      fill: color,
      ...(band.fillRule === 'evenodd' ? { fillRule: 'evenodd' as const } : {}),
    };
    if (s.blurRadius) overlay.effect = { type: 'blur', radius: r2(s.blurRadius) };
    if (s.blurRadius && !clipped) ctx.report.warn('inner-shadow-blur', 'Blurred inner shadow on a path emulated with an overlay that is not clipped to the shape', where);
    if (layer.isVisible === false) overlay.enabled = false;
    ctx.innerShadowTargets.set(`${layer.do_objectID}:${i}`, { id, prop: 'fill' });
    if (s.blurRadius && (node.type === 'rectangle' || node.type === 'ellipse')) {
      // keep the blurred band inside the shape, like Sketch clips inner shadows
      const clip: PenNode = {
        type: 'frame',
        id: ctx.ids.for(layer.do_objectID, `#innerclip${i}`),
        name: `${layer.name} (inner shadow clip)`,
        width: overlay.width,
        height: overlay.height,
        layout: 'none',
        clip: true,
        children: [{ ...overlay, x: 0, y: 0 }],
      };
      if (node.type === 'ellipse') clip.cornerRadius = r2(Math.min(layer.frame.width, layer.frame.height) / 2);
      else if (node.cornerRadius !== undefined) clip.cornerRadius = node.cornerRadius;
      if (layer.isVisible === false) clip.enabled = false;
      extra.push(clip);
      return;
    }
    extra.push(overlay);
  });
  // position overlays: inside frames as the bottom child, otherwise as siblings on top of the layer
  for (const o of extra) {
    if (node.type === 'frame') {
      o.x = 0;
      o.y = 0;
      if (node.layout && node.layout !== 'none') o.layoutPosition = 'absolute';
    } else {
      const f = { ...layer.frame, x: layer.frame.x + parent.dx, y: layer.frame.y + parent.dy };
      const t = penTransform(f, layer.rotation ?? 0, !!layer.isFlippedHorizontal, !!layer.isFlippedVertical, true);
      o.x = r2(t.x);
      o.y = r2(t.y);
      if (t.rotation) o.rotation = r2(t.rotation);
      if (parent.layout !== 'none') o.layoutPosition = 'absolute';
    }
  }
  if (node.type === 'frame') {
    node.children = [...extra, ...(node.children ?? [])];
    return [];
  }
  if (parent.layout !== 'none' && extra.length) ctx.report.warn('inner-shadow-stack', 'Inner shadow inside a stack emulated with an absolutely positioned layer', where);
  return extra;
}

/** Outline of a converted node in its own box (flips baked, like path geometry). */
function nodeOutline(layer: Layer, node: PenNode): PathShape | null {
  if (node.type === 'rectangle' || node.type === 'frame') return { d: roundedOutline(layer, node), fillRule: 'nonzero' };
  if (node.type === 'ellipse') return { d: ellipsePath(layer.frame.width, layer.frame.height, IDENTITY), fillRule: 'nonzero' };
  if (node.type === 'path' && node.geometry) return { d: node.geometry, fillRule: node.fillRule ?? 'nonzero' };
  return layerOutline(layer);
}

function roundedOutline(layer: Layer, node: PenNode): string {
  const w = layer.frame.width;
  const h = layer.frame.height;
  const cr = node.cornerRadius;
  const radii: [number, number, number, number] = cr === undefined ? [0, 0, 0, 0] : Array.isArray(cr) ? cr : [cr, cr, cr, cr];
  const k = 1 - 0.5522847498;
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, w / 2, h / 2)));
  const f = (n: number) => r3(n);
  let d = `M${f(tl!)} 0L${f(w - tr!)} 0`;
  if (tr) d += `C${f(w - tr * k)} 0 ${f(w)} ${f(tr * k)} ${f(w)} ${f(tr)}`;
  d += `L${f(w)} ${f(h - br!)}`;
  if (br) d += `C${f(w)} ${f(h - br * k)} ${f(w - br * k)} ${f(h)} ${f(w - br)} ${f(h)}`;
  d += `L${f(bl!)} ${f(h)}`;
  if (bl) d += `C${f(bl * k)} ${f(h)} 0 ${f(h - bl * k)} 0 ${f(h - bl)}`;
  d += `L0 ${f(tl!)}`;
  if (tl) d += `C0 ${f(tl * k)} ${f(tl * k)} 0 ${f(tl)} 0`;
  return d + 'Z';
}

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

const OPS: Record<number, BoolOp> = { 0: 'union', 1: 'difference', 2: 'intersect', 3: 'xor' };

/** Combined outline of a Sketch shape group (children with boolean operations) in the space given by `m`. */
export function shapeGroupPath(group: Layer, m: Matrix): PathShape {
  const parts: { shape: PathShape; op: number }[] = [];
  for (const child of group.layers ?? []) {
    if (child.isVisible === false) continue;
    const cm = multiply(m, parentMatrix(child));
    let shape: PathShape | null = null;
    if (isShape(child)) shape = { d: shapePathData(child, cm), fillRule: 'nonzero' };
    else if (child._class === 'shapeGroup') shape = shapeGroupPath(child, cm);
    if (shape?.d) parts.push({ shape, op: child.booleanOperation ?? -1 });
  }
  const fillRule = group.windingRule === 1 || group.style?.windingRule === 1 ? 'evenodd' : 'nonzero';
  if (!parts.length) return { d: '', fillRule };
  // Children without a boolean operation are simply drawn as one compound path.
  if (parts.slice(1).every((p) => p.op === -1)) return { d: parts.map((p) => p.shape.d).join(''), fillRule };
  const first = parts[0]!;
  const res = combine(first.shape, parts.slice(1).map((p) => ({ shape: p.shape, op: OPS[p.op] ?? 'union' })));
  return res ?? { d: parts.map((p) => p.shape.d).join(''), fillRule };
}

function shapeNode(ctx: Context, layer: Layer, id: string, parent: ParentInfo, where: string): PenNode {
  const { width: w, height: h } = layer.frame;
  const fills = convertFills(ctx, layer.style?.fills, w, h, where);
  const open = layer._class === 'shapePath' && layer.isClosed === false;
  const strokes = convertBorders(ctx, layer.style, w, h, where, open);
  const base = { id, fill: paintValue(fills), ...strokes };
  let node: PenNode;
  let baked = false;
  const smooth = layer._class === 'rectangle' && !layer.edited && layer.style?.corners?.style === 1 && cornerRadii(layer).some((r) => r > 0);
  if (smooth && ctx.options.smoothCorners) {
    // exact continuous corners as a path (loses the editable corner radius)
    baked = true;
    node = { type: 'path', ...base, geometry: smoothRectPath(w, h, cornerRadii(layer), layer.style?.corners?.smoothing ?? 0.6), viewBox: [0, 0, Math.max(r3(w), 0.01), Math.max(r3(h), 0.01)] };
  } else if (layer._class === 'rectangle' && !layer.edited) {
    node = { type: 'rectangle', ...base };
    const radii = cornerRadii(layer);
    if (radii.some((r) => r > 0)) node.cornerRadius = radii.every((r) => r === radii[0]) ? r2(radii[0]) : (radii.map(r2) as [number, number, number, number]);
    if (smooth) ctx.report.warn('smooth-corners', 'Smooth (squircle) corners drawn as regular rounded corners – use --smooth-corners for exact paths', where);
  } else if (layer._class === 'oval' && !layer.edited) {
    node = { type: 'ellipse', ...base };
  } else {
    let shape: PathShape;
    if (layer._class === 'shapeGroup') {
      shape = shapeGroupPath(layer, flipMatrix(layer));
    } else {
      shape = { d: shapePathData(layer, flipMatrix(layer)), fillRule: layer.style?.windingRule === 1 ? 'evenodd' : 'nonzero' };
    }
    baked = true;
    node = {
      type: 'path',
      ...base,
      geometry: shape.d || 'M0 0',
      viewBox: [0, 0, Math.max(r3(w), 0.01), Math.max(r3(h), 0.01)],
    };
    if (shape.fillRule === 'evenodd') node.fillRule = 'evenodd';
  }
  if (parent.clipPath) clipToPath(ctx, layer, node, parent.clipPath, where);
  node.width = axisSizing(layer, 'h', parent, false);
  node.height = axisSizing(layer, 'v', parent, false);
  if (typeof node.width === 'number') node.width = Math.max(node.width, 0.01);
  if (typeof node.height === 'number') node.height = Math.max(node.height, 0.01);
  applyCommon(ctx, layer, node, parent, { bakedFlip: baked });
  return node;
}

/** Box-space → Sketch-parent matrix of a pen.dev path node (flips are baked into its geometry). */
function boxMatrix(layer: Layer): Matrix {
  const single = !!layer.isFlippedHorizontal !== !!layer.isFlippedVertical;
  return layerMatrix(layer.frame, single ? -(layer.rotation ?? 0) : (layer.rotation ?? 0), false, false);
}

/** Replaces the node's geometry by its intersection with a Sketch path mask (exact clipping of vector content). */
function clipToPath(ctx: Context, layer: Layer, node: PenNode, clip: PathShape, where: string): void {
  const { width: w, height: h } = layer.frame;
  let own: PathShape;
  if (node.type === 'path') own = { d: node.geometry ?? '', fillRule: node.fillRule ?? 'nonzero' };
  else if (node.type === 'ellipse') own = { d: ellipsePath(w, h, IDENTITY), fillRule: 'nonzero' };
  else {
    const cr = node.cornerRadius;
    const radii: [number, number, number, number] = cr === undefined ? [0, 0, 0, 0] : Array.isArray(cr) ? cr : [cr, cr, cr, cr];
    own = { d: roundedRectPath(w, h, radii, IDENTITY), fillRule: 'nonzero' };
  }
  const local = transformPath(clip, invert(boxMatrix(layer)));
  const res = intersect(own, local);
  if (!res) return;
  if (node.stroke !== undefined) ctx.report.warn('mask-stroke', 'The border of a shape clipped by a path mask is also drawn along the mask edge', where);
  node.type = 'path';
  node.geometry = res.d || 'M0 0';
  node.viewBox = [0, 0, Math.max(r3(w), 0.01), Math.max(r3(h), 0.01)];
  if (res.fillRule === 'evenodd') node.fillRule = 'evenodd';
  else delete node.fillRule;
  delete node.cornerRadius;
  if (!res.d) node.enabled = false;
}

// ---------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------

function isFrameLike(layer: Layer): boolean {
  return layer._class === 'symbolMaster' || layer._class === 'artboard' || (layer._class === 'group' && (layer.groupBehavior === 1 || layer.groupBehavior === 2));
}

/** Frames clip by default; clippingBehavior 2 turns clipping off. */
export function frameClips(layer: Layer): boolean {
  if (layer._class === 'artboard') return true;
  return layer.clippingBehavior !== 2;
}

function containerNode(ctx: Context, layer: Layer, id: string, parent: ParentInfo, where: string): PenNode[] {
  const frameLike = isFrameLike(layer);
  const flex = ctx.options.flexLayout && isFlexLayout(layer) ? planFlex(layer) : { plan: null };
  if (isFlexLayout(layer)) {
    if (flex.plan) ctx.report.stats.flexStacks++;
    else ctx.report.stats.absoluteStacks++;
  }
  const plan = flex.plan;
  if (plan) ctx.flexContainers.add(layer.do_objectID);
  const childLayers = layer.layers ?? [];

  // Plain Sketch group → pen.dev group (children keep coordinates relative to the group origin).
  const tint = parent.tint ?? tintOf(layer.style, !frameLike);
  if (!frameLike && !plan) {
    if (!childLayers.length) return [];
    const node: PenNode = { type: 'group', id };
    applyCommon(ctx, layer, node, parent);
    const inner = applyEffects(ctx, layer, node, where);
    if (inner.length) ctx.report.warn('inner-shadow-group', 'Inner shadow on a group is not supported – skipped', where);
    // groups in a stack flow still need a position for their children
    const clipPath = parent.clipPath ? transformPath(parent.clipPath, invert(parentMatrix(layer))) : undefined;
    node.children = convertChildren(ctx, childLayers, { layout: 'none', dx: 0, dy: 0, path: where, tint, backdropEmpty: parent.backdropEmpty, clipPath });
    if (!node.children.length) return [];
    if (parent.layout !== 'none' && !layer.flexItem?.ignoreLayout) {
      delete node.x;
      delete node.y;
    }
    return [node];
  }

  const { width: w, height: h } = layer.frame;
  const node: PenNode = { type: 'frame', id };
  if (layer._class === 'symbolMaster') node.reusable = true;
  // Symbol masters only show their background in instances when Sketch is told to include it.
  const bgHidden = layer._class === 'symbolMaster' && layer.includeBackgroundColorInInstance === false;
  const fills = bgHidden ? [] : convertFills(ctx, layer.style?.fills?.filter((f) => !f.layeringType), w, h, where);
  if (layer.hasBackgroundColor && layer.backgroundColor && !fills.length) fills.push(hexColor(layer.backgroundColor));
  if (fills.length && frameLike) node.fill = paintValue(fills);
  if (frameLike) Object.assign(node, convertBorders(ctx, layer.style, w, h, where, false, true));
  const radii = frameLike && layer.style?.corners ? cornerRadii(layer) : [0, 0, 0, 0];
  if (radii.some((r) => r > 0)) node.cornerRadius = radii.every((r) => r === radii[0]) ? r2(radii[0]) : (radii.map(r2) as [number, number, number, number]);
  if (frameLike && frameClips(layer)) node.clip = true;
  node.width = axisSizing(layer, 'h', parent, !!plan);
  node.height = axisSizing(layer, 'v', parent, !!plan);
  node.layout = 'none';

  let children: PenNode[];
  if (plan) {
    Object.assign(node, plan.props);
    // a hugging stack whose child fills the same axis would be circular in pen.dev → keep the Sketch size
    const mainAxis = plan.direction === 'horizontal' ? 'h' : 'v';
    const fillsMain = plan.items.some((l) => (mainAxis === 'h' ? l.horizontalSizing : l.verticalSizing) === 2);
    if (fillsMain) {
      if (mainAxis === 'h' && node.width === 'fit_content') node.width = r2(w);
      if (mainAxis === 'v' && node.height === 'fit_content') node.height = r2(h);
    }
    if (plan.stretch) {
      if (mainAxis === 'h' && node.height === 'fit_content') node.height = r2(h);
      if (mainAxis === 'v' && node.width === 'fit_content') node.width = r2(w);
    }
    const inner: ParentInfo = { layout: plan.direction, stretch: plan.stretch, dx: 0, dy: 0, path: where, tint, backdropEmpty: frameLike || parent.backdropEmpty };
    const flow = plan.items.flatMap((l) => convertLayer(ctx, l, inner));
    const indexOf = new Map(childLayers.map((l, i) => [l.do_objectID, i]));
    const minFlow = Math.min(...plan.items.map((l) => indexOf.get(l.do_objectID)!));
    const below: PenNode[] = [];
    const above: PenNode[] = [];
    for (const l of childLayers) {
      if (!plan.absolute.has(l.do_objectID)) continue;
      const nodes = convertLayer(ctx, { ...l, flexItem: { alignSelf: 5, ignoreLayout: true, preserveSpaceWhenHidden: false } }, inner);
      (indexOf.get(l.do_objectID)! < minFlow ? below : above).push(...nodes);
    }
    children = [...below, ...flow, ...above];
  } else {
    children = convertChildren(ctx, childLayers, { layout: 'none', dx: 0, dy: 0, path: where, tint, backdropEmpty: frameLike || parent.backdropEmpty });
  }
  node.children = children;
  applyTint(node, parent.tint);
  applyCommon(ctx, layer, node, parent);
  const inner = applyEffects(ctx, layer, node, where);
  emulateInnerShadows(ctx, layer, node, inner, parent, where);
  // a component's siblings are not part of its instances, so masters keep the shadow on the frame itself
  const below = layer._class === 'symbolMaster' ? [] : spreadShadowExtras(ctx, layer, node, nodeOutline(layer, node), parent, where);
  if (layer._class === 'symbolMaster' && layer.style?.shadows?.some((s) => s.isEnabled && !s.isInnerShadow && s.spread)) {
    ctx.report.warn('shadow-spread-component', 'Shadow spread on a symbol master is not supported by pen.dev – drawn without spread', where);
  }
  ctx.report.stats.frames += frameLike ? 1 : 0;
  return [...below, node];
}

function parseRect(s: string | undefined): { x: number; y: number; width: number; height: number } | null {
  const m = s?.match(/\{\{\s*([-\d.eE+]+),\s*([-\d.eE+]+)\s*\},\s*\{\s*([-\d.eE+]+),\s*([-\d.eE+]+)\s*\}\}/);
  return m ? { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) } : null;
}

/** SF Symbols / icon-font glyph texts become vector paths placed on Sketch's glyph bounds. */
function glyphNode(ctx: Context, layer: Layer, id: string, parent: ParentInfo, where: string): PenNode | null {
  const req = glyphRequest(layer);
  if (!req) return null;
  const o = ctx.glyphs.get(glyphKey(req.font, req.size, req.text));
  if (!o) {
    ctx.report.warn('glyph-text', 'Symbol glyph text (SF Symbols / icon font) could not be outlined – kept as text', where);
    return null;
  }
  const gb = parseRect(layer.glyphBounds);
  const box = gb && gb.width > 0 && gb.height > 0 ? gb : { x: o.x, y: o.y, width: o.width, height: o.height };
  const f = layer.frame;
  const fills = convertFills(ctx, layer.style?.fills, f.width, f.height, where);
  const runColor = layer.attributedString?.attributes?.[0]?.attributes.MSAttributedStringColorAttribute ?? layer.style?.textStyle?.encodedAttributes.MSAttributedStringColorAttribute;
  const node: PenNode = {
    type: 'path',
    id,
    geometry: o.d,
    viewBox: [r3(o.x), r3(o.y), Math.max(r3(o.width), 0.01), Math.max(r3(o.height), 0.01)],
    width: r2(Math.max(box.width, 0.01)),
    height: r2(Math.max(box.height, 0.01)),
    fill: paintValue(fills) ?? (runColor ? colorOrVariable(ctx, runColor) : '#000000'),
  };
  const glyphLayer: Layer = { ...layer, frame: { x: f.x + box.x, y: f.y + box.y, width: box.width, height: box.height } };
  applyCommon(ctx, glyphLayer, node, parent);
  applyTint(node, parent.tint);
  applyEffects(ctx, layer, node, where);
  ctx.textParts.set(layer.do_objectID, [id]);
  return node;
}

// ---------------------------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------------------------

export function convertLayer(ctx: Context, layer: Layer, parent: ParentInfo): PenNode[] {
  const where = `${parent.path}/${layer.name}`;
  const id = ctx.ids.for(layer.do_objectID);
  if (layer._class === 'symbolMaster' && ctx.currentMaster?.master !== layer) {
    const pre = ctx.preconverted.get(layer.do_objectID);
    if (pre) return [pre];
  }
  ctx.report.stats.layers++;
  let nodes: PenNode[];
  switch (layer._class) {
    case 'group':
    case 'artboard':
    case 'symbolMaster':
      nodes = containerNode(ctx, layer, id, parent, where);
      break;
    case 'text': {
      const glyph = glyphNode(ctx, layer, id, parent, where);
      if (glyph) {
        nodes = [glyph];
        break;
      }
      const res = convertText(ctx, layer, id, where, parent.layout !== 'none' && !layer.flexItem?.ignoreLayout);
      const node = res.node;
      applyCommon(ctx, layer, node, parent);
      const dx = (node as PenNode & { _dx?: number })._dx;
      if (dx !== undefined) {
        if (node.x !== undefined) node.x = r2(node.x + dx);
        delete (node as PenNode & { _dx?: number })._dx;
      }
      const decorations = isDecorated(layer) ? textDecorations(ctx, layer, node, parent, dx ?? 0, where) : [];
      const inner = applyEffects(ctx, layer, node, where);
      if (inner.length) ctx.report.warn('inner-shadow-text', 'Inner shadow on text is not supported – skipped', where);
      Object.assign(node, node.type === 'text' ? convertBorders(ctx, layer.style, layer.frame.width, layer.frame.height, where, false, true) : {});
      applyTint(node, parent.tint);
      decorations.forEach((d) => applyTint(d, parent.tint));
      ctx.textParts.set(layer.do_objectID, res.textIds);
      if (decorations.length) ctx.textDecorations.set(layer.do_objectID, decorations.map((d) => d.id));
      nodes = [node, ...decorations];
      break;
    }
    case 'bitmap': {
      const url = ctx.imageUrl(layer.image?._ref);
      const node: PenNode = { type: 'rectangle', id };
      if (parent.clipPath) {
        // image under a path-shaped mask: clip the image rectangle itself (geometry in the unflipped layer box)
        const { width: bw, height: bh } = layer.frame;
        const local = transformPath(parent.clipPath, invert(parentMatrix(layer)));
        const res = intersect({ d: `M0 0L${bw} 0L${bw} ${bh}L0 ${bh}Z`, fillRule: 'nonzero' }, local);
        if (res) {
          node.type = 'path';
          node.geometry = res.d || 'M0 0';
          node.viewBox = [0, 0, Math.max(r3(bw), 0.01), Math.max(r3(bh), 0.01)];
          if (res.fillRule === 'evenodd') node.fillRule = 'evenodd';
        }
      }
      if (parent.tint) ctx.report.warn('tint-image', 'Tint on an image is not supported – the image keeps its colours', where);
      if (url) node.fill = { type: 'image', url, mode: 'stretch' };
      Object.assign(node, convertBorders(ctx, layer.style, layer.frame.width, layer.frame.height, where));
      node.width = axisSizing(layer, 'h', parent, false);
      node.height = axisSizing(layer, 'v', parent, false);
      applyCommon(ctx, layer, node, parent);
      const inner = applyEffects(ctx, layer, node, where);
      const outline = nodeOutline(layer, node);
      const below = spreadShadowExtras(ctx, layer, node, outline, parent, where);
      nodes = [...below, node, ...emulateInnerShadows(ctx, layer, node, inner, parent, where), ...borderExtras(ctx, layer, node, outline, parent, where)];
      break;
    }
    case 'rectangle':
    case 'oval':
    case 'shapePath':
    case 'triangle':
    case 'star':
    case 'polygon':
    case 'shapeGroup': {
      const node = shapeNode(ctx, layer, id, parent, where);
      const inner = applyEffects(ctx, layer, node, where);
      const outline = nodeOutline(layer, node);
      const below = spreadShadowExtras(ctx, layer, node, outline, parent, where);
      const above = [
        ...emulateInnerShadows(ctx, layer, node, inner, parent, where),
        ...borderExtras(ctx, layer, node, outline, parent, where),
        ...markerExtras(ctx, layer, parent, where),
      ];
      nodes = [...below, node, ...above];
      nodes.forEach((n) => applyTint(n, parent.tint));
      break;
    }
    case 'symbolInstance': {
      const node = convertInstance(ctx, layer, id, parent, where, parent.tint ?? tintOf(layer.style, true));
      applyCommon(ctx, layer, node, parent);
      const inner = applyEffects(ctx, layer, node, where);
      if (inner.length) ctx.report.warn('inner-shadow-instance', 'Inner shadow on a symbol instance is not supported – skipped', where);
      nodes = [node];
      break;
    }
    case 'slice':
    case 'MSImmutableHotspotLayer':
    case 'hotspot':
      return [];
    default:
      ctx.report.warn('unknown-layer', `Unknown layer type (${layer._class}) skipped`, where);
      return [];
  }
  if (nodes.some((n) => n.id === id)) ctx.track(layer, id);
  else if (nodes[0]) ctx.track(layer, nodes[0].id);
  return nodes;
}

export type { PenEffect };
