// pen.dev's layout: every node's position and size, as pen.dev computes them. Frames lay out their children
// horizontally unless told otherwise (`layout` defaults to "horizontal"), size to their content by default and
// distribute the free space among `fill_container` children. Groups are as large as their children.
import type { PenTheme } from '../pen/types.ts';
import type { RNode } from './tree.ts';
import type { Variables } from './variables.ts';

export type Axis = 'w' | 'h';

export type SizeSpec = { kind: 'fixed'; value: number } | { kind: 'fit'; fallback?: number } | { kind: 'fill'; fallback?: number };

export interface LayoutEnv {
  vars: Variables;
  /** Size pen.dev gives a text: `width` set for wrapping texts. */
  measureText(n: RNode, width?: number): { width: number; height: number };
}

/** Parses a width/height value: number, "fit_content", "fill_container", optionally with a fallback "(100)". */
export function sizeSpec(value: unknown, vars: Variables, theme: PenTheme): SizeSpec | undefined {
  const v = vars.value(value, theme);
  if (typeof v === 'number' && Number.isFinite(v)) return { kind: 'fixed', value: Math.max(0, v) };
  if (typeof v !== 'string') return undefined;
  const m = /^\s*(fit_content|fill_container)\s*(?:\(\s*([-\d.]+)\s*\))?\s*$/.exec(v);
  if (m) {
    const fallback = m[2] !== undefined ? Number(m[2]) : undefined;
    return { kind: m[1] === 'fit_content' ? 'fit' : 'fill', ...(fallback !== undefined && Number.isFinite(fallback) ? { fallback } : {}) };
  }
  const n = Number(v);
  return Number.isFinite(n) && v.trim() !== '' ? { kind: 'fixed', value: Math.max(0, n) } : undefined;
}

/** [top, right, bottom, left] */
export function padding(n: RNode, vars: Variables): [number, number, number, number] {
  const raw = vars.value(n.p.padding, n.theme);
  const num = (x: unknown) => vars.number(x, n.theme) ?? 0;
  if (Array.isArray(raw)) {
    if (raw.length === 2) return [num(raw[0]), num(raw[1]), num(raw[0]), num(raw[1])];
    if (raw.length === 4) return [num(raw[0]), num(raw[1]), num(raw[2]), num(raw[3])];
    if (raw.length === 1) return [num(raw[0]), num(raw[0]), num(raw[0]), num(raw[0])];
    return [0, 0, 0, 0];
  }
  const p = num(raw);
  return [p, p, p, p];
}

export type LayoutMode = 'none' | 'horizontal' | 'vertical';

export function layoutMode(n: RNode, vars: Variables): LayoutMode {
  if (n.type !== 'frame') return 'none';
  const v = vars.value(n.p.layout, n.theme);
  return v === 'none' || v === 'vertical' ? v : 'horizontal';
}

/** Whether a node takes part in its parent's flex layout. */
export function inFlow(n: RNode, vars: Variables): boolean {
  return n.visible && vars.value(n.p.layoutPosition, n.theme) !== 'absolute';
}

export class Layout {
  constructor(private env: LayoutEnv) {}

  private get vars() {
    return this.env.vars;
  }

  spec(n: RNode, axis: Axis): SizeSpec | undefined {
    return sizeSpec(axis === 'w' ? n.p.width : n.p.height, this.vars, n.theme);
  }

  /** Lays out a top-level node (or a component on its own). */
  run(n: RNode): void {
    this.node(n);
    this.place(n);
  }

  /** Position of a node outside a flex flow: its own x/y. */
  private place(n: RNode): void {
    n.x = this.vars.number(n.p.x, n.theme) ?? 0;
    n.y = this.vars.number(n.p.y, n.theme) ?? 0;
  }

  /**
   * Sizes a node and lays out its subtree. `w` / `h` are sizes imposed by the parent (fill_container, stretch).
   * Sets n.w / n.h (and n.ox / n.oy for groups); children get positions relative to n's local origin.
   */
  node(n: RNode, w?: number, h?: number): void {
    switch (n.type) {
      case 'text':
        return this.text(n, w, h);
      case 'group':
        return this.group(n);
      case 'frame':
        return this.frame(n, w, h);
      default:
        return this.leaf(n, w, h);
    }
  }

  private fixedOr(n: RNode, axis: Axis, imposed: number | undefined, fallback: number): number {
    if (imposed !== undefined) return imposed;
    const s = this.spec(n, axis);
    if (!s) return fallback;
    if (s.kind === 'fixed') return s.value;
    return s.fallback ?? fallback;
  }

  private leaf(n: RNode, w?: number, h?: number): void {
    n.w = this.fixedOr(n, 'w', w, 0);
    n.h = this.fixedOr(n, 'h', h, 0);
    // icons and others drawn by pen.dev from their own content keep their declared size; children (e.g. of a
    // script node expanded by pen.dev) are laid out absolutely
    for (const c of n.children) {
      this.node(c);
      this.place(c);
    }
  }

  private text(n: RNode, w?: number, h?: number): void {
    const growth = this.vars.value(n.p.textGrowth, n.theme);
    if (growth === 'fixed-width' || growth === 'fixed-width-height') {
      const width = this.fixedOr(n, 'w', w, 0);
      n.w = width;
      if (growth === 'fixed-width-height') n.h = this.fixedOr(n, 'h', h, this.env.measureText(n, width).height);
      else n.h = this.env.measureText(n, width).height;
      return;
    }
    const m = this.env.measureText(n);
    n.w = m.width;
    n.h = m.height;
  }

  private group(n: RNode): void {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of n.children) {
      this.node(c);
      this.place(c);
      if (!c.visible) continue;
      const b = boxOf(c, this.vars);
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    if (!Number.isFinite(x0)) {
      n.ox = 0;
      n.oy = 0;
      n.w = 0;
      n.h = 0;
      return;
    }
    n.ox = x0;
    n.oy = y0;
    n.w = x1 - x0;
    n.h = y1 - y0;
  }

  private frame(n: RNode, w?: number, h?: number): void {
    const mode = layoutMode(n, this.vars);
    const sw = this.spec(n, 'w') ?? { kind: 'fit' };
    const sh = this.spec(n, 'h') ?? { kind: 'fit' };
    const known = (imposed: number | undefined, s: SizeSpec): number | undefined => {
      if (imposed !== undefined) return imposed;
      if (s.kind === 'fixed') return s.value;
      // fill_container outside a layout: the fallback; fit_content: computed from the children
      if (s.kind === 'fill') return s.fallback;
      return undefined;
    };
    let W = known(w, sw);
    let H = known(h, sh);

    if (mode === 'none') {
      for (const c of n.children) {
        const cw = this.spec(c, 'w')?.kind === 'fill' && W !== undefined && c.type !== 'text' ? W : undefined;
        const ch = this.spec(c, 'h')?.kind === 'fill' && H !== undefined && c.type !== 'text' ? H : undefined;
        this.node(c, cw, ch);
        this.place(c);
      }
      if (W === undefined || H === undefined) {
        // fit_content without a layout: the children's extent from the frame origin (fallback when empty)
        let x1 = 0;
        let y1 = 0;
        let any = false;
        for (const c of n.children) {
          if (!c.visible) continue;
          const b = boxOf(c, this.vars);
          x1 = Math.max(x1, b.x + b.w);
          y1 = Math.max(y1, b.y + b.h);
          any = true;
        }
        W ??= any ? x1 : ((sw.kind === 'fit' && sw.fallback) || 0);
        H ??= any ? y1 : ((sh.kind === 'fit' && sh.fallback) || 0);
      }
      n.w = W;
      n.h = H;
      return;
    }

    const horizontal = mode === 'horizontal';
    const [pt, pr, pb, pl] = padding(n, this.vars);
    const gap = this.vars.number(n.p.gap, n.theme) ?? 0;
    const padMain = horizontal ? pl + pr : pt + pb;
    const padCross = horizontal ? pt + pb : pl + pr;
    const mainAxis: Axis = horizontal ? 'w' : 'h';
    const crossAxis: Axis = horizontal ? 'h' : 'w';
    let innerMain = horizontal ? (W !== undefined ? W - padMain : undefined) : H !== undefined ? H - padMain : undefined;
    let innerCross = horizontal ? (H !== undefined ? H - padCross : undefined) : W !== undefined ? W - padCross : undefined;

    const flow = n.children.filter((c) => inFlow(c, this.vars));
    const out = n.children.filter((c) => !inFlow(c, this.vars));
    const size = (c: RNode, axis: Axis) => (axis === 'w' ? c.w : c.h);
    const lay = (c: RNode, main: number | undefined, cross: number | undefined) => (horizontal ? this.node(c, main, cross) : this.node(c, cross, main));
    // texts only stretch when they wrap
    const canFill = (c: RNode, axis: Axis) => {
      if (c.type === 'group') return false;
      if (c.type === 'text') {
        const g = this.vars.value(c.p.textGrowth, c.theme);
        if (axis === 'w') return g === 'fixed-width' || g === 'fixed-width-height';
        return g === 'fixed-width-height';
      }
      return true;
    };
    const fillsMain = (c: RNode) => this.spec(c, mainAxis)?.kind === 'fill' && canFill(c, mainAxis);
    const fillsCross = (c: RNode) => this.spec(c, crossAxis)?.kind === 'fill' && canFill(c, crossAxis);

    // 1) children with their own main size
    const deferred: RNode[] = [];
    for (const c of flow) {
      const cross = fillsCross(c) && innerCross !== undefined ? Math.max(0, innerCross) : undefined;
      if (fillsMain(c) && innerMain !== undefined) deferred.push(c);
      else lay(c, undefined, cross);
    }
    const gaps = gap * Math.max(0, flow.length - 1);
    let used = gaps;
    for (const c of flow) if (!deferred.includes(c)) used += size(c, mainAxis);
    // 2) fill_container children share the free space
    if (deferred.length) {
      const share = Math.max(0, (innerMain! - used) / deferred.length);
      for (const c of deferred) {
        const cross = fillsCross(c) && innerCross !== undefined ? Math.max(0, innerCross) : undefined;
        lay(c, share, cross);
        used += size(c, mainAxis);
      }
    }
    if (innerMain === undefined) innerMain = used;
    if (innerCross === undefined) {
      // a hugging frame is as large as the children with their own cross size; the ones that fill only stretch
      const own = flow.filter((c) => !fillsCross(c));
      innerCross = Math.max(0, ...(own.length ? own : flow).map((c) => size(c, crossAxis)));
      // a hugging frame: children that fill the cross axis stretch to the largest sibling
      for (const c of flow) if (fillsCross(c) && Math.abs(size(c, crossAxis) - innerCross) > 1e-6) lay(c, fillsMain(c) ? size(c, mainAxis) : undefined, innerCross);
    }
    const mainSize = innerMain + padMain;
    const crossSize = innerCross + padCross;
    n.w = horizontal ? mainSize : crossSize;
    n.h = horizontal ? crossSize : mainSize;

    // 3) positions
    const justify = this.vars.value(n.p.justifyContent, n.theme);
    const align = this.vars.value(n.p.alignItems, n.theme);
    const free = innerMain - used;
    let cursor = 0;
    let between = gap;
    if (justify === 'center') cursor = free / 2;
    else if (justify === 'end') cursor = free;
    // space_between spreads the room left by the items themselves – the gap does not count (it may not even fit)
    else if (justify === 'space_between' && flow.length > 1) between = (free + gaps) / (flow.length - 1);
    else if (justify === 'space_around' && flow.length && free > 0) {
      cursor = free / flow.length / 2;
      between = gap + free / flow.length;
    } else if (justify === 'space_between' && flow.length === 1 && free > 0) cursor = 0;
    const mainStart = horizontal ? pl : pt;
    const crossStart = horizontal ? pt : pl;
    for (const c of flow) {
      const extra = innerCross - size(c, crossAxis);
      const crossOff = align === 'center' ? extra / 2 : align === 'end' ? extra : 0;
      const mx = mainStart + cursor;
      const cx = crossStart + crossOff;
      // the box lands there; a group's origin is offset by its children's bounds
      const bx = horizontal ? mx : cx;
      const by = horizontal ? cx : mx;
      c.x = bx - (c.ox ?? 0);
      c.y = by - (c.oy ?? 0);
      cursor += size(c, mainAxis) + between;
    }
    for (const c of out) {
      const cw = this.spec(c, 'w')?.kind === 'fill' && canFill(c, 'w') ? n.w : undefined;
      const ch = this.spec(c, 'h')?.kind === 'fill' && canFill(c, 'h') ? n.h : undefined;
      this.node(c, cw, ch);
      this.place(c);
    }
  }
}

/** Unrotated box of a laid-out node in its parent's coordinates (for rotated nodes: the bounds of the rotated box). */
export function boxOf(n: RNode, vars: Variables): { x: number; y: number; w: number; h: number } {
  const ox = n.ox ?? 0;
  const oy = n.oy ?? 0;
  const rot = vars.number(n.p.rotation, n.theme) ?? 0;
  if (!rot) return { x: n.x + ox, y: n.y + oy, w: n.w, h: n.h };
  const a = (rot * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const pts = [
    [ox, oy],
    [ox + n.w, oy],
    [ox, oy + n.h],
    [ox + n.w, oy + n.h],
  ].map(([px, py]) => [n.x + c * px! + s * py!, n.y - s * px! + c * py!]);
  const xs = pts.map((p) => p[0]!);
  const ys = pts.map((p) => p[1]!);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
