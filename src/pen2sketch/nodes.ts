// pen.dev nodes (expanded and laid out) → Sketch layers.
import * as B from '../sketch/builder.ts';
import { apply, rotateCCW, multiply, type Matrix } from '../util/geom.ts';
import type { Context } from './context.ts';
import { layoutMode, sizeSpec, inFlow, padding, type LayoutMode } from './layout.ts';
import { sketchEffects, sketchFills, sketchPaint, sketchStroke, type StrokeInfo } from './paint.ts';
import { curvePoints, ellipseArcPath, mapSubpaths, parsePath, pathBounds, polygonPoints, type CurvePoint, type P, type Subpath } from './svgpath.ts';
import { textLayer, textProps } from './text.ts';
import type { RNode } from './tree.ts';

type J = Record<string, unknown>;

export interface ParentInfo {
  /** Sketch coordinates = pen.dev local coordinates − this offset (the bounds origin of a parent group) */
  ox: number;
  oy: number;
  /** layout of the pen.dev parent frame */
  layout: LayoutMode;
  /** the parent became a Sketch stack */
  stack: boolean;
  path: string;
}

export const PAGE: ParentInfo = { ox: 0, oy: 0, layout: 'none', stack: false, path: '' };

/** Hook for component instances (symbols): returns the Sketch layers, or null to expand the instance. */
export type InstanceHook = (n: RNode, parent: ParentInfo, common: Common) => J[] | null;

export interface Common {
  name: string;
  frame: B.Frame;
  options: B.LayerOptions;
  where: string;
}

const r = (n: number) => Math.round(n * 1000) / 1000;

/** Sketch frame, rotation and flips that put the node's local box where pen.dev draws it. */
export function placement(ctx: Context, n: RNode, parent: ParentInfo): { frame: B.Frame; rotation: number; flipH: boolean; flipV: boolean } {
  const v = ctx.vars;
  const theta = v.number(n.p.rotation, n.theme) ?? 0;
  const flipH = v.bool(n.p.flipX, n.theme) === true;
  const flipV = v.bool(n.p.flipY, n.theme) === true;
  const ox = n.ox ?? 0;
  const oy = n.oy ?? 0;
  // pen.dev: local p → position + R(θ)·S·p
  const L: Matrix = multiply(rotateCCW(theta), [flipH ? -1 : 1, 0, 0, flipV ? -1 : 1, 0, 0]);
  const c = apply(L, { x: ox + n.w / 2, y: oy + n.h / 2 });
  const cx = n.x + c.x;
  const cy = n.y + c.y;
  // Sketch rotates around the centre, then mirrors: S·R(θs) = R(θ)·S ⇒ θs = −θ with a single flip
  let rotation = flipH !== flipV ? -theta : theta;
  rotation = ((rotation % 360) + 360) % 360;
  if (rotation > 180) rotation -= 360;
  return { frame: [r(cx - n.w / 2 - parent.ox), r(cy - n.h / 2 - parent.oy), r(n.w), r(n.h)], rotation: r(rotation) || 0, flipH, flipV };
}

/** Sizing of a node inside a Sketch stack: 0 fixed, 1 fit, 2 fill. */
function sizing(ctx: Context, n: RNode, parent: ParentInfo): [number, number] {
  const spec = (axis: 'w' | 'h') => sizeSpec(axis === 'w' ? n.p.width : n.p.height, ctx.vars, n.theme);
  const one = (axis: 'w' | 'h'): number => {
    if (n.type === 'text') {
      const g = ctx.vars.value(n.p.textGrowth, n.theme);
      if (axis === 'w' && g !== 'fixed-width' && g !== 'fixed-width-height') return 1;
      if (axis === 'h' && g !== 'fixed-width-height') return 1;
    }
    if (n.type === 'group') return 1;
    const s = spec(axis);
    if (parent.stack && s?.kind === 'fill') return 2;
    if (n.type === 'frame' && (!s || s.kind === 'fit') && layoutMode(n, ctx.vars) !== 'none') return 1;
    return 0;
  };
  return [one('w'), one('h')];
}

function commonOptions(ctx: Context, n: RNode, parent: ParentInfo): Common {
  const name = ctx.vars.string(n.p.name, n.theme) ?? defaultName(n);
  const where = parent.path ? `${parent.path} / ${name}` : name;
  const place = placement(ctx, n, parent);
  const opacity = ctx.vars.number(n.p.opacity, n.theme);
  const options: B.LayerOptions = {
    rotation: place.rotation,
    flipH: place.flipH,
    flipV: place.flipV,
    hidden: !n.visible,
    sizing: sizing(ctx, n, parent),
    style: { ...(opacity !== undefined && opacity < 1 ? { opacity: Math.max(0, opacity) } : {}) },
    extra: {},
  };
  if (parent.stack) {
    const absolute = !inFlow(n, ctx.vars) && n.visible;
    options.extra!.flexItem = { _class: 'MSImmutableFlexItem', alignSelf: 5, ignoreLayout: absolute, preserveSpaceWhenHidden: false };
  }
  return { name, frame: place.frame, options, where };
}

function defaultName(n: RNode): string {
  const names: Record<string, string> = { frame: 'Frame', group: 'Group', rectangle: 'Rectangle', ellipse: 'Ellipse', path: 'Path', polygon: 'Polygon', text: 'Text', icon: 'Icon', ref: 'Instance' };
  return names[n.type] ?? n.type;
}

/** Corner radii [tl, tr, br, bl], or undefined when all are zero. */
function radii(ctx: Context, n: RNode): number[] | undefined {
  const raw = ctx.vars.value(n.p.cornerRadius, n.theme);
  let list: number[];
  if (Array.isArray(raw)) list = raw.slice(0, 4).map((x) => ctx.vars.number(x, n.theme) ?? 0);
  else list = [ctx.vars.number(raw, n.theme) ?? 0];
  if (list.length === 1) list = [list[0]!, list[0]!, list[0]!, list[0]!];
  while (list.length < 4) list.push(0);
  // pen.dev limits each radius to half the shorter side
  const max = Math.min(n.w, n.h) / 2;
  list = list.map((x) => Math.max(0, Math.min(x, max)));
  return list.some((x) => x > 0) ? list.map(r) : undefined;
}

function styleOf(ctx: Context, n: RNode, c: Common, stroke: StrokeInfo | null, fills: J[]): B.StyleOptions {
  const fx = sketchEffects(ctx, n, c.where);
  return {
    ...c.options.style,
    fills,
    borders: stroke?.borders ?? [],
    shadows: fx.shadows,
    blurs: fx.blurs,
    ...(stroke ? { cap: stroke.cap, join: stroke.join } : {}),
  };
}

export class NodeConverter {
  instanceHook: InstanceHook | null = null;
  /** Hook for components on the canvas (symbol masters in place). */
  masterHook: InstanceHook | null = null;

  constructor(private ctx: Context) {}

  /** Sets deterministic ids on a freshly built layer. */
  private ids(layer: J, key: string): J {
    layer.do_objectID = this.ctx.uuid(key);
    const style = layer.style as J | undefined;
    if (style) style.do_objectID = this.ctx.uuid(`${key}#style`);
    return layer;
  }

  convert(n: RNode, parent: ParentInfo): J[] {
    const c = commonOptions(this.ctx, n, parent);
    if (n.instance && this.instanceHook) {
      const out = this.instanceHook(n, parent, c);
      if (out) return out;
    }
    if (!n.instance && this.masterHook) {
      const out = this.masterHook(n, parent, c);
      if (out) return out;
    }
    return this.plain(n, parent, c);
  }

  /** Converts a node itself, without the symbol hooks (its children still use them). */
  convertPlain(n: RNode, parent: ParentInfo): J[] {
    return this.plain(n, parent, commonOptions(this.ctx, n, parent));
  }

  private plain(n: RNode, parent: ParentInfo, c: Common): J[] {
    const ctx = this.ctx;
    ctx.report.stats.layers++;
    switch (n.type) {
      case 'frame':
        return this.frame(n, parent, c);
      case 'group':
        return this.group(n, c);
      case 'rectangle':
        return this.rectangle(n, c);
      case 'ellipse':
        return this.ellipse(n, c);
      case 'polygon':
        return this.polygon(n, c);
      case 'path':
        return this.path(n, c);
      case 'text':
        return [this.ids(textLayer(ctx, n, { name: c.name, frame: c.frame, sizing: c.options.sizing as [number, number], layerOptions: { ...c.options, style: styleOf(ctx, n, c, sketchStroke(ctx, n, c.where), []) } }, c.where), n.key)];
      case 'note':
      case 'prompt':
      case 'context':
        ctx.report.warn('annotation', 'Canvas notes, prompts and contexts are not part of the design – left out', c.where);
        return [];
      case 'icon':
        return this.icon(n, c);
      case 'script':
        if (n.children.length) return this.group(n, c);
        ctx.report.warn('script', 'Script node (content generated by pen.dev) – left out; use exact layout to convert what it draws', c.where);
        return [];
      case 'browser': {
        ctx.report.warn('browser', 'Live web page drawn as an empty frame', c.where);
        const layer = B.frame(c.name, c.frame, [], { ...c.options, style: { ...c.options.style, fills: [B.fill(B.color(0.95, 0.95, 0.96))], borders: [B.border(B.color(0.8, 0.8, 0.82), 1, 1)] } });
        return [this.ids(layer, n.key)];
      }
      default:
        ctx.report.warn('unknown-node', 'Unknown node type – left out', `${c.where} (${n.type})`);
        return [];
    }
  }

  children(n: RNode, parent: ParentInfo): J[] {
    return n.children.flatMap((child) => this.convert(child, parent));
  }

  private frame(n: RNode, parent: ParentInfo, c: Common): J[] {
    const ctx = this.ctx;
    const mode = layoutMode(n, ctx.vars);
    const fills = sketchFills(ctx, n, n.p.fill, c.where);
    const stroke = sketchStroke(ctx, n, c.where);
    const rad = radii(ctx, n);
    const clip = ctx.vars.bool(n.p.clip, n.theme) === true;
    const stack = mode !== 'none' && ctx.options.stacks && this.canStack(n, mode);
    const inner: ParentInfo = { ox: 0, oy: 0, layout: mode, stack, path: c.where };
    let children = this.children(n, inner);
    if (stack) children = this.stackOrder(n, children);
    const sides = stroke.sides ? this.sideBorders(n, stroke, c, true) : [];
    const options: B.LayerOptions & { clip?: boolean; stack?: J; padding?: [number, number, number, number] } = {
      ...c.options,
      style: { ...styleOf(ctx, n, c, stroke, fills), ...(rad ? { radii: rad } : {}) },
      clip,
    };
    if (stack) {
      const gap = ctx.vars.number(n.p.gap, n.theme) ?? 0;
      const justify = ctx.vars.value(n.p.justifyContent, n.theme);
      const align = ctx.vars.value(n.p.alignItems, n.theme);
      options.stack = B.stack(mode === 'vertical' ? 'v' : 'h', gap, { justify: justify === 'center' ? 1 : justify === 'end' ? 2 : justify === 'space_between' ? 3 : 0, align: align === 'center' ? 1 : align === 'end' ? 2 : 0 });
      options.padding = padding(n, ctx.vars);
      ctx.report.stats.stacks++;
    }
    const layer = B.frame(c.name, c.frame, [...children, ...sides], options);
    if (!parent.path) ctx.report.stats.artboards++;
    return [this.ids(layer, n.key)];
  }

  /** Whether Sketch can keep the frame as a stack: no reordering artefacts, nothing Sketch lays out differently. */
  private canStack(n: RNode, mode: LayoutMode): boolean {
    const v = this.ctx.vars;
    if (v.value(n.p.justifyContent, n.theme) === 'space_around') return false;
    const flow = n.children.filter((c) => inFlow(c, v));
    if (!flow.length) return false;
    if (flow.some((c) => v.number(c.p.rotation, c.theme) || c.type === 'group')) return false;
    // Sketch paints stack items in reverse order: only safe when they do not overlap
    const horizontal = mode === 'horizontal';
    for (let i = 1; i < flow.length; i++) {
      const a = flow[i - 1]!;
      const b = flow[i]!;
      const end = horizontal ? a.x + (a.ox ?? 0) + a.w : a.y + (a.oy ?? 0) + a.h;
      const start = horizontal ? b.x + (b.ox ?? 0) : b.y + (b.oy ?? 0);
      if (start < end - 0.01) return false;
    }
    return true;
  }

  /** Sketch stores stack items last-first; absolutely positioned layers keep their place below or above the flow. */
  private stackOrder(n: RNode, layers: J[]): J[] {
    const flowIdx: number[] = [];
    const below: J[] = [];
    const above: J[] = [];
    const flow: J[] = [];
    let seenFlow = false;
    layers.forEach((l, i) => {
      const item = l.flexItem as J | undefined;
      if (item && !item.ignoreLayout && l.isVisible !== false) {
        flow.push(l);
        flowIdx.push(i);
        seenFlow = true;
      } else (seenFlow ? above : below).push(l);
    });
    void n;
    return [...below, ...flow.reverse(), ...above];
  }

  /** Per-side stroke widths: one rectangle per side, drawn where pen.dev draws the stroke. */
  private sideBorders(n: RNode, stroke: StrokeInfo, c: Common, inside: boolean): J[] {
    const ctx = this.ctx;
    const s = stroke.sides!;
    const paint = sketchPaint(ctx, (Array.isArray(n.p.stroke) ? n.p.stroke[0] : n.p.stroke) as unknown, n.theme, n, c.where);
    if (!paint) return [];
    // inner: inside the edge, outer: outside, centre: across it
    const k = stroke.position === 1 ? 0 : stroke.position === 2 ? 1 : 0.5;
    const [fx, fy, w, h] = inside ? [0, 0, n.w, n.h] : c.frame;
    const out: J[] = [];
    const add = (side: string, rect: B.Frame) => {
      const layer = B.rect(`${c.name} (border ${side})`, rect, { style: { fills: [paint] }, extra: inside ? { flexItem: { _class: 'MSImmutableFlexItem', alignSelf: 5, ignoreLayout: true, preserveSpaceWhenHidden: false } } : {} });
      out.push(this.ids(layer, `${n.key}#border-${side}`));
    };
    if (s.top) add('top', [r(fx - k * s.left), r(fy - k * s.top), r(w + k * (s.left + s.right)), s.top]);
    if (s.bottom) add('bottom', [r(fx - k * s.left), r(fy + h - (1 - k) * s.bottom), r(w + k * (s.left + s.right)), s.bottom]);
    if (s.left) add('left', [r(fx - k * s.left), r(fy - k * s.top), s.left, r(h + k * (s.top + s.bottom))]);
    if (s.right) add('right', [r(fx + w - (1 - k) * s.right), r(fy - k * s.top), s.right, r(h + k * (s.top + s.bottom))]);
    if (radii(ctx, n)) ctx.report.warn('side-stroke-radius', 'Per-side stroke on a rounded shape drawn with square corners', c.where);
    return out;
  }

  private group(n: RNode, c: Common): J[] {
    const ctx = this.ctx;
    const inner: ParentInfo = { ox: n.ox ?? 0, oy: n.oy ?? 0, layout: 'none', stack: false, path: c.where };
    const children = this.children(n, inner);
    if (!children.length) return [];
    const fx = sketchEffects(ctx, n, c.where);
    const layer = B.group(c.name, c.frame, children, { ...c.options, style: { ...c.options.style, shadows: fx.shadows, blurs: fx.blurs } });
    return [this.ids(layer, n.key)];
  }

  private rectangle(n: RNode, c: Common): J[] {
    const ctx = this.ctx;
    const fills = sketchFills(ctx, n, n.p.fill, c.where);
    const stroke = sketchStroke(ctx, n, c.where);
    const rad = radii(ctx, n);
    const layer = this.ids(B.rect(c.name, c.frame, { ...c.options, style: { ...styleOf(ctx, n, c, stroke, fills), radii: rad ?? [0] } }), n.key);
    return stroke.sides ? [layer, ...this.sideBorders(n, stroke, c, false)] : [layer];
  }

  private ellipse(n: RNode, c: Common): J[] {
    const ctx = this.ctx;
    const v = ctx.vars;
    const fills = sketchFills(ctx, n, n.p.fill, c.where);
    const stroke = sketchStroke(ctx, n, c.where);
    const inner = Math.max(0, Math.min(1, v.number(n.p.innerRadius, n.theme) ?? 0));
    const start = v.number(n.p.startAngle, n.theme) ?? 0;
    const sweep = v.number(n.p.sweepAngle, n.theme) ?? 360;
    const style = styleOf(ctx, n, c, stroke, fills);
    if (inner <= 0 && Math.abs(sweep) >= 360) return [this.ids(B.oval(c.name, c.frame, { ...c.options, style }), n.key)];
    const subs = parsePath(ellipseArcPath(n.w, n.h, start, sweep, inner));
    return [this.shape(n, c, subs, { x: 0, y: 0, w: n.w, h: n.h }, 'evenodd', style)];
  }

  private polygon(n: RNode, c: Common): J[] {
    const ctx = this.ctx;
    const count = Math.max(3, Math.round(ctx.vars.number(n.p.polygonCount, n.theme) ?? 3));
    const fills = sketchFills(ctx, n, n.p.fill, c.where);
    const stroke = sketchStroke(ctx, n, c.where);
    const radius = ctx.vars.number(n.p.cornerRadius, n.theme) ?? 0;
    const pts = polygonPoints(count, 1, 1);
    const layer = B.layer('polygon', c.name, c.frame, {
      ...c.options,
      style: styleOf(ctx, n, c, stroke, fills),
      extra: {
        ...c.options.extra,
        edited: false,
        isClosed: true,
        numberOfPoints: count,
        pointRadiusBehaviour: 1,
        points: pts.map((p) => sketchPoint({ point: p }, radius)),
      },
    });
    return [this.ids(layer, n.key)];
  }

  private path(n: RNode, c: Common): J[] {
    const ctx = this.ctx;
    const v = ctx.vars;
    const geometry = v.string(n.p.geometry, n.theme) ?? '';
    const subs = parsePath(geometry);
    if (!subs.length) {
      ctx.report.warn('empty-path', 'Path without geometry – left out', c.where);
      return [];
    }
    const vbRaw = v.value(n.p.viewBox, n.theme);
    const bounds = pathBounds(subs)!;
    const vb = Array.isArray(vbRaw) && vbRaw.length === 4 ? { x: Number(vbRaw[0]), y: Number(vbRaw[1]), w: Number(vbRaw[2]), h: Number(vbRaw[3]) } : bounds;
    const fills = sketchFills(ctx, n, n.p.fill, c.where);
    const open = subs.every((s) => !s.closed);
    const stroke = sketchStroke(ctx, n, c.where, open);
    const fillRule = v.value(n.p.fillRule, n.theme) === 'evenodd' ? 'evenodd' : 'nonzero';
    return [this.shape(n, c, subs, vb, fillRule, styleOf(ctx, n, c, stroke, fills))];
  }

  /**
   * A vector shape: subpaths in the coordinate space `vb`, mapped onto the node box. One subpath becomes a shape path,
   * several a combined shape whose parts are drawn as one compound path with the fill rule.
   */
  private shape(n: RNode, c: Common, subsIn: Subpath[], vb: { x: number; y: number; w: number; h: number }, fillRule: 'nonzero' | 'evenodd', style: B.StyleOptions): J {
    const sx = vb.w > 1e-9 ? n.w / vb.w : 1;
    const sy = vb.h > 1e-9 ? n.h / vb.h : 1;
    // degenerate boxes (a horizontal / vertical line): centre the geometry in the box
    const dx = vb.w > 1e-9 ? 0 : n.w / 2;
    const dy = vb.h > 1e-9 ? 0 : n.h / 2;
    const subs = mapSubpaths(subsIn, (p) => ({ x: (p.x - vb.x) * sx + dx, y: (p.y - vb.y) * sy + dy }));
    const winding = fillRule === 'evenodd' ? 1 : 0;
    const pathLayer = (sp: Subpath, name: string, key: string, frame: B.Frame, origin: P, opts: B.LayerOptions): J => {
      const { points, closed } = curvePoints(sp);
      const w = frame[2];
      const h = frame[3];
      const norm = (p: P): P => ({ x: w > 1e-9 ? (p.x - origin.x) / w : 0.5, y: h > 1e-9 ? (p.y - origin.y) / h : 0.5 });
      const layer = B.path(name, frame, [], closed, opts);
      layer.points = points.map((p) => sketchPoint({ point: norm(p.point), ...(p.curveFrom ? { curveFrom: norm(p.curveFrom) } : {}), ...(p.curveTo ? { curveTo: norm(p.curveTo) } : {}) }, 0));
      layer.isClosed = closed;
      return this.ids(layer, key);
    };
    if (subs.length === 1) {
      const b = pathBounds(subs)!;
      // the frame is the box pen.dev lays out; points outside it are fine for Sketch
      void b;
      return pathLayer(subs[0]!, c.name, n.key, c.frame, { x: 0, y: 0 }, { ...c.options, style: { ...style, windingRule: winding } });
    }
    const parts = subs.map((sp, i) => {
      const b = pathBounds([sp])!;
      return pathLayer(sp, `${c.name} ${i + 1}`, `${n.key}#${i}`, [r(b.x), r(b.y), r(b.w), r(b.h)], { x: b.x, y: b.y }, { style: { fills: [], windingRule: winding } });
    });
    const group = B.shapeGroup(c.name, c.frame, parts, { ...c.options, style: { ...style, windingRule: winding }, extra: { ...c.options.extra, windingRule: winding } });
    return this.ids(group, n.key);
  }

  private icon(n: RNode, c: Common): J[] {
    const ctx = this.ctx;
    const svg = ctx.icon(n);
    if (!svg) {
      ctx.report.warn('icon', 'Icon could not be loaded – drawn as an empty frame', `${c.where} (${ctx.vars.string(n.p.library, n.theme)} ${ctx.vars.string(n.p.icon, n.theme)})`);
      return [this.ids(B.frame(c.name, c.frame, [], { ...c.options, style: { ...c.options.style, fills: [] }, clip: false }), n.key)];
    }
    const fills = sketchFills(ctx, n, n.p.fill ?? '#000000', c.where);
    const fx = sketchEffects(ctx, n, c.where);
    const layers: J[] = [];
    const scale = Math.min(n.w / svg.viewBox.w, n.h / svg.viewBox.h);
    const ox = (n.w - svg.viewBox.w * scale) / 2 - svg.viewBox.x * scale;
    const oy = (n.h - svg.viewBox.h * scale) / 2 - svg.viewBox.y * scale;
    svg.shapes.forEach((shape, i) => {
      const subs = mapSubpaths(parsePath(shape.d), (p) => ({ x: p.x * scale + ox, y: p.y * scale + oy }));
      if (!subs.length) return;
      const b = pathBounds(subs)!;
      const style: B.StyleOptions = shape.stroke
        ? { fills: [], borders: fills.map((f) => ({ ...f, _class: 'border', position: 0, thickness: shape.strokeWidth * scale })), cap: shape.cap, join: shape.join }
        : { fills };
      const fake: RNode = { ...n, w: b.w, h: b.h };
      const part = this.shape(fake, { ...c, name: `${c.name} ${i + 1}`, frame: [r(b.x), r(b.y), r(b.w), r(b.h)], options: { style } }, subs, { x: b.x, y: b.y, w: b.w, h: b.h }, shape.evenOdd ? 'evenodd' : 'nonzero', style);
      part.do_objectID = ctx.uuid(`${n.key}#icon${i}`);
      layers.push(part);
    });
    const group = B.group(c.name, c.frame, layers, { ...c.options, style: { ...c.options.style, shadows: fx.shadows, blurs: fx.blurs } });
    // keep the icon's box even where the glyph does not reach the edges
    group.groupBehavior = 2;
    return [this.ids(group, n.key)];
  }
}

/** A Sketch curve point (coordinates normalised to the layer frame). */
export function sketchPoint(p: CurvePoint, cornerRadius: number): J {
  const s = (q: P) => `{${Math.round(q.x * 1e6) / 1e6}, ${Math.round(q.y * 1e6) / 1e6}}`;
  const curved = !!(p.curveFrom || p.curveTo);
  return {
    _class: 'curvePoint',
    cornerRadius,
    cornerStyle: 0,
    curveFrom: s(p.curveFrom ?? p.point),
    curveMode: curved ? 4 : 1,
    curveTo: s(p.curveTo ?? p.point),
    hasCurveFrom: !!p.curveFrom,
    hasCurveTo: !!p.curveTo,
    point: s(p.point),
  };
}

export { textProps };
