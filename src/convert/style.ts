import type { PenBlendMode, PenEffect, PenFill, PenNode } from '../pen/types.ts';
import type { Border, Fill, Gradient, SColor, Shadow, Style } from '../sketch/types.ts';
import { parsePoint, r2, r3 } from '../util/geom.ts';
import type { Context } from './context.ts';

const BLEND: Record<number, PenBlendMode> = {
  0: 'normal',
  1: 'darken',
  2: 'multiply',
  3: 'colorBurn',
  4: 'light',
  5: 'screen',
  6: 'colorDodge',
  7: 'overlay',
  8: 'softLight',
  9: 'hardLight',
  10: 'difference',
  11: 'exclusion',
  12: 'hue',
  13: 'saturation',
  14: 'color',
  15: 'luminosity',
  16: 'linearBurn',
  17: 'linearDodge',
};

export function blendMode(mode: number | undefined): PenBlendMode | undefined {
  if (!mode) return undefined;
  return BLEND[mode] ?? undefined;
}

const hex2 = (v: number) =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();

/** #RRGGBB, or #RRGGBBAA when not fully opaque. */
export function hexColor(c: SColor | undefined, opacity = 1): string {
  if (!c) return '#000000';
  const a = (c.alpha ?? 1) * opacity;
  const rgb = `#${hex2(c.red)}${hex2(c.green)}${hex2(c.blue)}`;
  return a >= 0.999 ? rgb : rgb + hex2(a);
}

/** Uses the swatch variable (`$name`) when the colour is an unmodified swatch reference. */
export function colorOrVariable(ctx: Context, c: SColor, opacity = 1): string {
  const value = hexColor(c, opacity);
  if (c.swatchID) {
    const v = ctx.swatchVars.get(c.swatchID);
    if (v && v.hex === value) return `$${v.name}`;
  }
  return value;
}

/**
 * Sketch draws linear gradients in pixel space (iso-lines perpendicular in pixels); pen.dev defines them in
 * the unit square stretched over the box. Both are affine in (x, y), so we solve for the pen parameters that
 * give exactly the same colour ramp.
 */
export function linearGradientParams(g: Gradient, w: number, h: number): { center: { x: number; y: number }; rotation: number; length: number } {
  const F = parsePoint(g.from);
  const T = parsePoint(g.to);
  const W = Math.max(w, 1e-6);
  const H = Math.max(h, 1e-6);
  const dpx = (T.x - F.x) * W;
  const dpy = (T.y - F.y) * H;
  const dl2 = dpx * dpx + dpy * dpy;
  const center = { x: (F.x + T.x) / 2, y: (F.y + T.y) / 2 };
  if (dl2 < 1e-9) return { center, rotation: 180, length: 1 };
  const a = dpx / dl2; // dt/dx
  const b = dpy / dl2; // dt/dy
  const ux = a * W;
  const uy = b * H;
  const ul = Math.hypot(ux, uy);
  const length = 1 / ul;
  let rotation = (Math.atan2(-ux / ul, -uy / ul) * 180) / Math.PI;
  if (rotation <= -180) rotation += 360;
  return { center, rotation, length };
}

/**
 * Sketch draws radial gradients as an ellipse in pixel space: semi-axis |to − from| along to − from and
 * elipseLength·|to − from| across it. pen.dev sizes and rotates the ellipse in the unit square stretched over the box,
 * so the pixel ellipse is mapped into that space and decomposed (singular values → diameters, vector → rotation).
 */
export function radialGradientParams(g: Gradient, w: number, h: number): { center: { x: number; y: number }; width: number; height: number; rotation: number } {
  const F = parsePoint(g.from);
  const T = parsePoint(g.to);
  const W = Math.max(w, 1e-6);
  const H = Math.max(h, 1e-6);
  const ax = (T.x - F.x) * W;
  const ay = (T.y - F.y) * H;
  const len = Math.hypot(ax, ay) || 1e-6;
  const e = g.elipseLength || 1;
  const bx = (-ay / len) * len * e;
  const by = (ax / len) * len * e;
  const n11 = ax / W;
  const n21 = ay / H;
  const n12 = bx / W;
  const n22 = by / H;
  const A = n11 * n11 + n12 * n12;
  const B = n11 * n21 + n12 * n22;
  const D = n21 * n21 + n22 * n22;
  const disc = Math.sqrt(Math.max(0, ((A - D) / 2) ** 2 + B * B));
  const l1 = (A + D) / 2 + disc;
  const l2 = Math.max(0, (A + D) / 2 - disc);
  let vx = B;
  let vy = l1 - A;
  if (Math.hypot(vx, vy) < 1e-12) [vx, vy] = A >= D ? [1, 0] : [0, 1];
  let rotation = (-Math.atan2(vy, vx) * 180) / Math.PI;
  if (rotation <= -180) rotation += 360;
  return { center: F, width: 2 * Math.sqrt(l1), height: 2 * Math.sqrt(l2), rotation };
}

function gradientFill(ctx: Context, fill: Fill, w: number, h: number, where: string): PenFill {
  const g = fill.gradient;
  const opacity = fill.contextSettings?.opacity ?? 1;
  const colors = [...g.stops]
    .sort((a, b) => a.position - b.position)
    .map((s) => ({ color: colorOrVariable(ctx, s.color), position: r3(s.position) }));
  const base = {
    type: 'gradient' as const,
    colors,
    ...(opacity < 0.999 ? { opacity: r3(opacity) } : {}),
    ...(blendMode(fill.contextSettings?.blendMode) ? { blendMode: blendMode(fill.contextSettings?.blendMode) } : {}),
  };
  if (g.gradientType === 0) {
    const p = linearGradientParams(g, w, h);
    return { ...base, gradientType: 'linear', center: { x: r3(p.center.x), y: r3(p.center.y) }, size: { height: r3(p.length) }, rotation: r2(p.rotation) };
  }
  if (g.gradientType === 1) {
    const p = radialGradientParams(g, w, h);
    return { ...base, gradientType: 'radial', center: { x: r3(p.center.x), y: r3(p.center.y) }, size: { width: r3(p.width), height: r3(p.height) }, rotation: r2(p.rotation) };
  }
  // Sketch's angular gradients start at 3 o'clock and run clockwise around the centre; pen.dev's start at 12.
  return { ...base, gradientType: 'angular', center: { x: 0.5, y: 0.5 }, rotation: -90 };
}

function imageFill(ctx: Context, fill: Fill, where: string): PenFill | null {
  const url = ctx.imageUrl(fill.image?._ref);
  if (!url) return null;
  const modes: Record<number, 'stretch' | 'fill' | 'fit'> = { 0: 'fill', 1: 'fill', 2: 'stretch', 3: 'fit' };
  if (fill.patternFillType === 0) ctx.report.warn('image-tile', 'Tiled image fill converted as "fill"', where);
  const opacity = fill.contextSettings?.opacity ?? 1;
  return { type: 'image', url, mode: modes[fill.patternFillType ?? 1] ?? 'fill', ...(opacity < 0.999 ? { opacity: r3(opacity) } : {}) };
}

export function convertPaint(ctx: Context, fill: Fill, w: number, h: number, where: string): PenFill | null {
  const opacity = fill.contextSettings?.opacity ?? 1;
  const bm = blendMode(fill.contextSettings?.blendMode);
  switch (fill.fillType) {
    case 0: {
      const color = colorOrVariable(ctx, fill.color, opacity);
      return bm ? { type: 'color', color, blendMode: bm } : color;
    }
    case 1:
      return gradientFill(ctx, fill, w, h, where);
    case 4:
      return imageFill(ctx, fill, where);
    case 5:
      ctx.report.warn('noise-fill', 'Noise fills are not supported by pen.dev – skipped', where);
      return null;
    default:
      return null;
  }
}

export function convertFills(ctx: Context, fills: Fill[] | undefined, w: number, h: number, where: string): PenFill[] {
  const out: PenFill[] = [];
  for (const f of fills ?? []) {
    if (!f.isEnabled || f.layeringType === 2) continue;
    const p = convertPaint(ctx, f, w, h, where);
    if (p) out.push(p);
  }
  return out;
}

function hexAlpha(hex: string): number {
  return hex.startsWith('#') && hex.length === 9 ? parseInt(hex.slice(7), 16) / 255 : 1;
}

function paintAlpha(p: PenFill): number {
  if (typeof p === 'string') return hexAlpha(p);
  if (p.type === 'color') return hexAlpha(p.color);
  if (p.type === 'gradient') return (p.opacity ?? 1) * Math.max(...p.colors.map((c) => hexAlpha(c.color)), 0);
  return p.opacity ?? 1;
}

/** Sketch tint: the paint keeps its opacity (per gradient stop) but takes the tint colour; images stay as they are. */
export function tintPaint(p: PenFill, tint: string): PenFill {
  if (typeof p !== 'string' && p.type === 'image') return p;
  if (typeof p !== 'string' && p.type === 'gradient') {
    return {
      ...p,
      colors: p.colors.map((c) => {
        const a = hexAlpha(c.color.startsWith('$') ? '#000000' : c.color) * hexAlpha(tint);
        return { ...c, color: a >= 0.999 ? tint.slice(0, 7) : tint.slice(0, 7) + hex2(a) };
      }),
    };
  }
  const alpha = paintAlpha(p) * hexAlpha(tint);
  const color = alpha >= 0.999 ? tint.slice(0, 7) : tint.slice(0, 7) + hex2(alpha);
  if (typeof p !== 'string' && p.blendMode) return { type: 'color', color, blendMode: p.blendMode };
  return color;
}

/**
 * Hex colour of the tint of a group/frame/instance, if any. Sketch 2025+ marks tints with layeringType 1; older
 * documents have no layering type and a fill on a group or symbol instance always was its tint.
 */
export function tintOf(style: Style | undefined, legacyTintHolder = false): string | undefined {
  const f = style?.fills?.find((x) => x.isEnabled && x.fillType === 0 && (x.layeringType === 1 || (legacyTintHolder && x.layeringType === undefined)));
  return f ? hexColor(f.color, f.contextSettings?.opacity ?? 1) : undefined;
}

/** pen.dev accepts a single paint or an array; a single one keeps the file readable. */
export function paintValue(paints: PenFill[]): PenFill | PenFill[] | undefined {
  if (!paints.length) return undefined;
  return paints.length === 1 ? paints[0] : paints;
}

/**
 * Stroke properties of a layer. Shapes emulate what pen.dev lacks (several border widths, dashes, line markers)
 * with extra nodes; containers and texts pass `limited` so the limitation is reported instead.
 */
export function convertBorders(ctx: Context, style: Style | undefined, w: number, h: number, where: string, isOpenPath = false, limited = false): Partial<PenNode> {
  const borders = (style?.borders ?? []).filter((b) => b.isEnabled && b.thickness > 0);
  if (!borders.length) return {};
  const paints = borders.map((b) => convertPaint(ctx, b, w, h, where)).filter((p): p is PenFill => !!p);
  if (!paints.length) return {};
  const top = borders[borders.length - 1] as Border;
  const widths = new Set(borders.map((b) => b.thickness));
  const positions = new Set(borders.map((b) => b.position));
  const opts = style?.borderOptions;
  if (limited && (widths.size > 1 || positions.size > 1)) ctx.report.warn('multi-border', 'Several borders with different widths on a frame or text – pen.dev supports one stroke width', where);
  if (limited && opts?.dashPattern?.some((v) => v > 0)) ctx.report.warn('dashed-border', 'Dashed border on a frame or text drawn solid (pen.dev has no dashes)', where);
  const align = isOpenPath ? 'center' : ({ 0: 'center', 1: 'inner', 2: 'outer' } as const)[top.position as 0 | 1 | 2] ?? 'center';
  const out: Partial<PenNode> = {
    stroke: paintValue(paints),
    strokeWidth: r3(Math.max(...borders.map((b) => b.thickness))),
    strokeAlignment: align,
  };
  if (opts?.lineCapStyle) out.strokeLinecap = opts.lineCapStyle === 1 ? 'round' : 'square';
  if (opts?.lineJoinStyle) out.strokeLinejoin = opts.lineJoinStyle === 1 ? 'round' : 'bevel';
  return out;
}

export function shadowColor(ctx: Context, s: Shadow): string {
  return hexColor(s.color, s.contextSettings?.opacity ?? 1);
}

export interface EffectResult {
  effects: PenEffect[];
  innerShadows: Shadow[];
}

export function convertEffects(ctx: Context, style: Style | undefined, where: string): EffectResult {
  const effects: PenEffect[] = [];
  const innerShadows: Shadow[] = [];
  if (!style) return { effects, innerShadows };
  const drops = (style.shadows ?? []).filter((s) => s.isEnabled);
  for (const s of drops) {
    if (s.isInnerShadow) {
      innerShadows.push(s);
      continue;
    }
    const bm = blendMode(s.contextSettings?.blendMode);
    effects.push({
      type: 'shadow',
      shadowType: 'outer',
      offset: { x: r2(s.offsetX), y: r2(s.offsetY) },
      ...(s.blurRadius ? { blur: r2(s.blurRadius) } : {}),
      ...(s.spread ? { spread: r2(s.spread) } : {}),
      color: shadowColor(ctx, s),
      ...(bm ? { blendMode: bm } : {}),
    });
  }
  for (const s of style.innerShadows ?? []) if (s.isEnabled) innerShadows.push(s);

  const blurs = [...(style.blurs ?? []), ...(style.blur ? [style.blur] : [])].filter((b) => b.isEnabled && b.radius > 0);
  for (const b of blurs) {
    if (b.type === 3 || b.type === 4) {
      effects.push({ type: 'background_blur', radius: r2(b.radius * BLUR_SCALE) });
      if (b.type === 4) ctx.report.warn('glass-blur', 'Glass effect converted to a background blur', where);
    } else {
      effects.push({ type: 'blur', radius: r2(b.radius * BLUR_SCALE) });
      if (b.type === 1 || b.type === 2) ctx.report.warn('motion-blur', 'Motion / zoom blur converted to a gaussian blur', where);
    }
  }
  return { effects, innerShadows };
}

/** Sketch blur radius → pen.dev blur radius (calibrated against Sketch renders). */
export const BLUR_SCALE = 2;
