// Fills, strokes and effects: pen.dev paints → Sketch fills, borders, shadows and blurs. Gradients are mapped back
// from pen.dev's unit square stretched over the box to Sketch's pixel-space definitions (the inverse of
// src/convert/style.ts).
import type { PenTheme } from '../pen/types.ts';
import * as B from '../sketch/builder.ts';
import type { Context } from './context.ts';
import type { RNode } from './tree.ts';
import { hexToRgba, type ResolvedColor } from './variables.ts';

type J = Record<string, unknown>;

const BLEND: Record<string, number> = {
  normal: 0,
  darken: 1,
  multiply: 2,
  colorBurn: 3,
  light: 4,
  lighten: 4,
  screen: 5,
  colorDodge: 6,
  overlay: 7,
  softLight: 8,
  hardLight: 9,
  difference: 10,
  exclusion: 11,
  hue: 12,
  saturation: 13,
  color: 14,
  luminosity: 15,
  linearBurn: 16,
  linearDodge: 17,
};

export function blendMode(v: unknown): number {
  return typeof v === 'string' ? (BLEND[v] ?? 0) : 0;
}

/** Sketch colour (with the swatch reference when the colour is an unchanged colour variable). */
export function sketchColor(ctx: Context, c: ResolvedColor, alphaScale = 1): J {
  const { r, g, b, a } = hexToRgba(c.hex);
  const out = B.color(r, g, b, a * alphaScale);
  if (c.variable && alphaScale === 1) {
    const sw = ctx.swatches.get(c.variable);
    if (sw && sw.hex === c.hex) out.swatchID = sw.id;
  }
  return out;
}

export const BLACK: ResolvedColor = { hex: '#000000FF' };

/** A paint value as a list (pen.dev accepts a single paint or an array). */
export function paints(v: unknown): unknown[] {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

interface PaintBox {
  w: number;
  h: number;
}

function pt(x: number, y: number): string {
  const f = (n: number) => Math.round(n * 1e6) / 1e6;
  return `{${f(x)}, ${f(y)}}`;
}

/** pen.dev linear gradient (centre, length, rotation in the stretched unit square) → Sketch from / to. */
export function linearFromTo(center: { x: number; y: number }, length: number, rotation: number, box: PaintBox): { from: string; to: string } {
  const W = Math.max(box.w, 1e-6);
  const H = Math.max(box.h, 1e-6);
  const a = (rotation * Math.PI) / 180;
  // direction in which the gradient advances, in normalised coordinates (0° = up, 90° = left)
  const dx = -Math.sin(a);
  const dy = -Math.cos(a);
  const L = length || 1;
  // gradient of t in pixel space, then the pixel vector whose projection advances t by 1
  const gx = dx / (W * L);
  const gy = dy / (H * L);
  const g2 = gx * gx + gy * gy || 1e-12;
  const vx = gx / g2;
  const vy = gy / g2;
  const cx = center.x * W;
  const cy = center.y * H;
  return { from: pt((cx - vx / 2) / W, (cy - vy / 2) / H), to: pt((cx + vx / 2) / W, (cy + vy / 2) / H) };
}

/** pen.dev radial gradient (ellipse in the stretched unit square) → Sketch from / to / ellipse length. */
export function radialFromTo(center: { x: number; y: number }, size: { width: number; height: number }, rotation: number, box: PaintBox): { from: string; to: string; elipseLength: number } {
  const W = Math.max(box.w, 1e-6);
  const H = Math.max(box.h, 1e-6);
  const phi = (-rotation * Math.PI) / 180;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const rw = size.width / 2;
  const rh = size.height / 2;
  // the ellipse in pixel space: M · unit circle
  const m11 = W * rw * c;
  const m21 = H * rw * s;
  const m12 = -W * rh * s;
  const m22 = H * rh * c;
  // principal axes (SVD of M)
  const A = m11 * m11 + m12 * m12;
  const Bv = m11 * m21 + m12 * m22;
  const D = m21 * m21 + m22 * m22;
  const disc = Math.sqrt(Math.max(0, ((A - D) / 2) ** 2 + Bv * Bv));
  const l1 = (A + D) / 2 + disc;
  const l2 = Math.max(0, (A + D) / 2 - disc);
  let ux = Bv;
  let uy = l1 - A;
  if (Math.hypot(ux, uy) < 1e-12) [ux, uy] = A >= D ? [1, 0] : [0, 1];
  const ul = Math.hypot(ux, uy);
  const s1 = Math.sqrt(l1);
  const s2 = Math.sqrt(l2);
  const ax = (ux / ul) * s1;
  const ay = (uy / ul) * s1;
  const cx = center.x * W;
  const cy = center.y * H;
  return { from: pt(center.x, center.y), to: pt((cx + ax) / W, (cy + ay) / H), elipseLength: s1 > 1e-9 ? s2 / s1 : 1 };
}

interface Stop {
  position: number;
  color: ResolvedColor;
}

function lerpHex(a: string, b: string, t: number): string {
  const ca = hexToRgba(a);
  const cb = hexToRgba(b);
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${h(ca.r + (cb.r - ca.r) * t)}${h(ca.g + (cb.g - ca.g) * t)}${h(ca.b + (cb.b - ca.b) * t)}${h(ca.a + (cb.a - ca.a) * t)}`;
}

/** Colour of a stop list at a position (clamped at the ends). */
function colorAt(stops: Stop[], p: number): string {
  if (p <= stops[0]!.position) return stops[0]!.color.hex;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    if (p <= b.position) return lerpHex(a.color.hex, b.color.hex, b.position > a.position ? (p - a.position) / (b.position - a.position) : 0);
  }
  return stops[stops.length - 1]!.color.hex;
}

/** Sketch angular gradients start at 3 o'clock; a pen.dev one rotated by `rotation` starts elsewhere: shift the stops. */
function rotateStops(stops: Stop[], rotation: number): Stop[] {
  const shift = ((((rotation + 90) / 360) % 1) + 1) % 1;
  if (Math.abs(shift) < 1e-6 || Math.abs(shift - 1) < 1e-6) return stops;
  // the colour Sketch shows at position s is pen.dev's colour at s + shift
  const ext: Stop[] = [...stops.map((s) => ({ ...s, position: s.position - shift })), ...stops.map((s) => ({ ...s, position: s.position + 1 - shift }))];
  const inside = ext.filter((s) => s.position > 0 && s.position < 1);
  const wrapped = [...stops.map((s) => ({ ...s, position: s.position })), ...stops.map((s) => ({ ...s, position: s.position + 1 }))];
  const at = (p: number): ResolvedColor => ({ hex: colorAt(wrapped, p + shift) });
  return [{ position: 0, color: at(0) }, ...inside.sort((a, b) => a.position - b.position), { position: 1, color: at(1) }];
}

/** One pen.dev paint → Sketch fill (or border: the same structure plus thickness / position). */
export function sketchPaint(ctx: Context, paint: unknown, theme: PenTheme, box: PaintBox, where: string): J | null {
  const vars = ctx.vars;
  const resolved = vars.value(paint, theme);
  if (typeof resolved === 'string' || (typeof paint === 'string' && vars.refName(paint))) {
    const c = vars.color(paint, theme);
    return c ? B.fill(sketchColor(ctx, c)) : null;
  }
  if (!resolved || typeof resolved !== 'object') return null;
  const p = resolved as J;
  const enabled = vars.bool(p.enabled, theme) !== false;
  const blend = blendMode(vars.value(p.blendMode, theme));
  const opacity = vars.number(p.opacity, theme) ?? 1;
  let out: J | null = null;
  switch (p.type) {
    case 'color': {
      const c = vars.color(p.color, theme);
      if (c) out = B.fill(sketchColor(ctx, c), { blend });
      break;
    }
    case 'gradient': {
      const stopsRaw = Array.isArray(p.colors) ? (p.colors as J[]) : [];
      let stops: Stop[] = stopsRaw
        .map((s) => ({ position: Math.max(0, Math.min(1, vars.number(s.position, theme) ?? 0)), color: vars.color(s.color, theme) ?? BLACK }))
        .sort((a, b) => a.position - b.position);
      if (!stops.length) break;
      if (stops.length === 1) stops = [stops[0]!, { ...stops[0]!, position: 1 }];
      const kind = p.gradientType ?? 'linear';
      const center = { x: vars.number((p.center as J | undefined)?.x, theme) ?? 0.5, y: vars.number((p.center as J | undefined)?.y, theme) ?? 0.5 };
      const size = { width: vars.number((p.size as J | undefined)?.width, theme) ?? 1, height: vars.number((p.size as J | undefined)?.height, theme) ?? 1 };
      const rotation = vars.number(p.rotation, theme) ?? 0;
      let g: J;
      if (kind === 'radial') {
        const r = radialFromTo(center, size, rotation, box);
        g = B.gradient(stops.map((s) => [s.position, sketchColor(ctx, s.color)]), r.from, r.to, 1, r.elipseLength);
      } else if (kind === 'angular') {
        if (Math.abs(center.x - 0.5) > 0.01 || Math.abs(center.y - 0.5) > 0.01) ctx.report.warn('angular-center', 'Angular gradient centre moved to the middle (Sketch draws angular gradients around the centre)', where);
        g = B.gradient(rotateStops(stops, rotation).map((s) => [s.position, sketchColor(ctx, s.color)]), '{0.5, 0}', '{0.5, 1}', 2);
      } else {
        const l = linearFromTo(center, size.height, rotation, box);
        g = B.gradient(stops.map((s) => [s.position, sketchColor(ctx, s.color)]), l.from, l.to, 0);
      }
      out = B.fill(B.color(0, 0, 0), { gradient: g, opacity, blend });
      break;
    }
    case 'image': {
      const url = vars.string(p.url, theme);
      if (!url) break;
      const asset = ctx.image(url, where);
      if (!asset) break;
      const mode = vars.value(p.mode, theme);
      out = B.fill(B.color(0, 0, 0), { image: asset.ref, patternFillType: mode === 'fit' ? 3 : mode === 'stretch' ? 2 : 1, opacity, blend });
      break;
    }
    case 'mesh_gradient': {
      const colors = (Array.isArray(p.colors) ? p.colors : []).map((c) => vars.color(c, theme)).filter((c): c is ResolvedColor => !!c);
      if (!colors.length) break;
      ctx.report.warn('mesh-gradient', 'Mesh gradient drawn as a linear gradient of its colours (Sketch has no mesh gradients)', where);
      const stops = colors.length === 1 ? [colors[0]!, colors[0]!] : colors;
      out = B.fill(B.color(0, 0, 0), { gradient: B.gradient(stops.map((c, i) => [i / (stops.length - 1), sketchColor(ctx, c)]), '{0, 0}', '{1, 1}', 0), opacity, blend });
      break;
    }
    case 'shader':
      ctx.report.warn('shader-fill', 'Shader fill has no Sketch equivalent – left out', where);
      return null;
    default:
      return null;
  }
  if (out && !enabled) out.isEnabled = false;
  return out;
}

export function sketchFills(ctx: Context, n: RNode, value: unknown, where: string): J[] {
  return paints(value)
    .map((p) => sketchPaint(ctx, p, n.theme, n, where))
    .filter((f): f is J => !!f);
}

export interface StrokeInfo {
  borders: J[];
  /** per-side widths that Sketch cannot express on the border itself */
  sides?: { top: number; right: number; bottom: number; left: number };
  /** Sketch border position: 0 centre, 1 inside, 2 outside */
  position: number;
  cap: number;
  join: number;
}

const POSITION: Record<string, number> = { center: 0, inner: 1, inside: 1, outer: 2, outside: 2 };

/** pen.dev stroke → Sketch borders (all paints share pen.dev's single stroke width and alignment). */
export function sketchStroke(ctx: Context, n: RNode, where: string, openPath = false): StrokeInfo {
  const vars = ctx.vars;
  const p = n.p;
  const capV = vars.value(p.strokeLinecap, n.theme);
  const joinV = vars.value(p.strokeLinejoin, n.theme);
  const info: StrokeInfo = { borders: [], position: 0, cap: capV === 'round' ? 1 : capV === 'square' ? 2 : 0, join: joinV === 'round' ? 1 : joinV === 'bevel' ? 2 : 0 };
  const list = paints(p.stroke);
  if (!list.length) return info;
  const raw = vars.value(p.strokeWidth, n.theme);
  let width = 1;
  if (raw && typeof raw === 'object') {
    const side = (k: string) => vars.number((raw as J)[k], n.theme) ?? 0;
    const sides = { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') };
    const values = Object.values(sides);
    if (values.every((v) => v === values[0])) width = values[0]!;
    else {
      info.sides = sides;
      width = 0;
    }
  } else if (raw !== undefined) width = vars.number(raw, n.theme) ?? 1;
  const alignV = vars.value(p.strokeAlignment, n.theme);
  const position = openPath ? 0 : (POSITION[String(alignV)] ?? 0);
  info.position = position;
  for (const paint of list) {
    const f = sketchPaint(ctx, paint, n.theme, n, where);
    if (!f) continue;
    info.borders.push({ ...f, _class: 'border', position, thickness: width });
  }
  if (width <= 0 && !info.sides) info.borders = [];
  return info;
}

export interface EffectInfo {
  shadows: J[];
  blurs: J[];
}

/** pen.dev effects → Sketch shadows (outer and inner) and blurs (pen.dev blurs twice as strongly as Sketch). */
export function sketchEffects(ctx: Context, n: RNode, where: string): EffectInfo {
  const vars = ctx.vars;
  const out: EffectInfo = { shadows: [], blurs: [] };
  for (const e of paints(n.p.effect)) {
    const v = vars.value(e, n.theme);
    if (!v || typeof v !== 'object') continue;
    const fx = v as J;
    const enabled = vars.bool(fx.enabled, n.theme) !== false;
    if (fx.type === 'shadow') {
      const c = vars.color(fx.color, n.theme) ?? { hex: '#00000040' };
      const off = (fx.offset as J | undefined) ?? {};
      const s = B.shadow(sketchColor(ctx, c), vars.number(off.x, n.theme) ?? 0, vars.number(off.y, n.theme) ?? 0, vars.number(fx.blur, n.theme) ?? 0, 0, vars.value(fx.shadowType, n.theme) === 'inner', blendMode(vars.value(fx.blendMode, n.theme)));
      if (!enabled) s.isEnabled = false;
      if (vars.number(fx.spread, n.theme)) ctx.report.warn('shadow-spread', 'Shadow spread left out – pen.dev does not draw it', where);
      out.shadows.push(s);
    } else if (fx.type === 'blur' || fx.type === 'background_blur') {
      const radius = (vars.number(fx.radius, n.theme) ?? 0) / 2;
      const b = B.blur(fx.type === 'blur' ? 0 : 3, radius);
      if (!enabled) b.isEnabled = false;
      out.blurs.push(b);
    }
  }
  return out;
}
