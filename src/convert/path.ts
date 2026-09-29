import type { CurvePoint, Layer } from '../sketch/types.ts';
import { apply, layerMatrix, multiply, parsePoint, r3, type Matrix, type Pt } from '../util/geom.ts';

interface Vertex {
  p: Pt;
  from: Pt | null; // control point of the outgoing segment
  to: Pt | null; // control point of the incoming segment
  radius: number;
}

const KAPPA_FACTOR = 4 / 3;

function fmt(p: Pt): string {
  return `${r3(p.x)} ${r3(p.y)}`;
}

function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}
function len(a: Pt): number {
  return Math.hypot(a.x, a.y);
}
function add(a: Pt, b: Pt, k = 1): Pt {
  return { x: a.x + b.x * k, y: a.y + b.y * k };
}

/**
 * Converts Sketch curve points (normalized to the layer frame) into SVG path data in the space
 * given by `m` (which maps the layer's local pixel space). Per-point corner radii on straight
 * corners are rounded with circular fillets like Sketch does.
 */
export function pointsToPathData(points: CurvePoint[], closed: boolean, width: number, height: number, m: Matrix): string {
  if (!points.length) return '';
  const verts: Vertex[] = points.map((pt) => {
    const p = parsePoint(pt.point);
    const f = parsePoint(pt.curveFrom);
    const t = parsePoint(pt.curveTo);
    const scale = (q: Pt): Pt => ({ x: q.x * width, y: q.y * height });
    return {
      p: scale(p),
      from: pt.hasCurveFrom ? scale(f) : null,
      to: pt.hasCurveTo ? scale(t) : null,
      radius: pt.cornerRadius || 0,
    };
  });

  const n = verts.length;
  const segCount = closed ? n : n - 1;
  const inPt: Pt[] = verts.map((v) => v.p);
  const outPt: Pt[] = verts.map((v) => v.p);
  const arcs: ([Pt, Pt] | null)[] = verts.map(() => null);

  // Fillets for straight corners with a radius.
  for (let i = 0; i < n; i++) {
    const v = verts[i]!;
    if (v.radius <= 0 || v.from || v.to) continue;
    if (!closed && (i === 0 || i === n - 1)) continue;
    const prev = verts[(i - 1 + n) % n]!;
    const next = verts[(i + 1) % n]!;
    if (prev.from || next.to) continue;
    const a = sub(prev.p, v.p);
    const b = sub(next.p, v.p);
    const la = len(a);
    const lb = len(b);
    if (la < 1e-6 || lb < 1e-6) continue;
    const u = { x: a.x / la, y: a.y / la };
    const w = { x: b.x / lb, y: b.y / lb };
    const cos = Math.max(-1, Math.min(1, u.x * w.x + u.y * w.y));
    const theta = Math.acos(cos);
    if (theta < 1e-3 || Math.PI - theta < 1e-3) continue;
    const tanHalf = Math.tan(theta / 2);
    let d = v.radius / tanHalf;
    d = Math.min(d, la / 2, lb / 2);
    const r = d * tanHalf;
    const sweep = Math.PI - theta;
    const h = KAPPA_FACTOR * Math.tan(sweep / 4) * r;
    const t1 = add(v.p, u, d);
    const t2 = add(v.p, w, d);
    inPt[i] = t1;
    outPt[i] = t2;
    arcs[i] = [add(t1, u, -h), add(t2, w, -h)];
  }

  const T = (q: Pt) => fmt(apply(m, q));
  let d = `M${T(outPt[0]!)}`;
  for (let s = 0; s < segCount; s++) {
    const i = s;
    const j = (s + 1) % n;
    const a = verts[i]!;
    const b = verts[j]!;
    if (a.from || b.to) {
      d += `C${T(a.from ?? a.p)} ${T(b.to ?? b.p)} ${T(inPt[j]!)}`;
    } else {
      d += `L${T(inPt[j]!)}`;
    }
    const arc = arcs[j];
    if (arc && (closed || j !== 0)) d += `C${T(arc[0])} ${T(arc[1])} ${T(outPt[j]!)}`;
  }
  if (closed) d += 'Z';
  return d;
}

/** Matrix mapping a layer's local pixel space into its own box with flips applied (rotation excluded). */
export function flipMatrix(layer: Layer): Matrix {
  return layerMatrix({ x: 0, y: 0, width: layer.frame.width, height: layer.frame.height }, 0, !!layer.isFlippedHorizontal, !!layer.isFlippedVertical);
}

/** Matrix mapping a layer's local space into its parent's space (flip + rotation + offset). */
export function parentMatrix(layer: Layer): Matrix {
  return layerMatrix(layer.frame, layer.rotation ?? 0, !!layer.isFlippedHorizontal, !!layer.isFlippedVertical);
}

export function ellipsePath(w: number, h: number, m: Matrix): string {
  const k = 0.5522847498;
  const rx = w / 2;
  const ry = h / 2;
  const P = (x: number, y: number) => fmt(apply(m, { x, y }));
  return (
    `M${P(w, ry)}` +
    `C${P(w, ry + ry * k)} ${P(rx + rx * k, h)} ${P(rx, h)}` +
    `C${P(rx - rx * k, h)} ${P(0, ry + ry * k)} ${P(0, ry)}` +
    `C${P(0, ry - ry * k)} ${P(rx - rx * k, 0)} ${P(rx, 0)}` +
    `C${P(rx + rx * k, 0)} ${P(w, ry - ry * k)} ${P(w, ry)}Z`
  );
}

/** Rounded rectangle path; radii in [tl, tr, br, bl] order. */
export function roundedRectPath(w: number, h: number, radii: [number, number, number, number], m: Matrix): string {
  const clamp = (r: number) => Math.max(0, Math.min(r, w / 2, h / 2));
  const [tl, tr, br, bl] = radii.map(clamp) as [number, number, number, number];
  const k = 1 - 0.5522847498;
  const P = (x: number, y: number) => fmt(apply(m, { x, y }));
  let d = `M${P(tl, 0)}L${P(w - tr, 0)}`;
  if (tr) d += `C${P(w - tr * k, 0)} ${P(w, tr * k)} ${P(w, tr)}`;
  d += `L${P(w, h - br)}`;
  if (br) d += `C${P(w, h - br * k)} ${P(w - br * k, h)} ${P(w - br, h)}`;
  d += `L${P(bl, h)}`;
  if (bl) d += `C${P(bl * k, h)} ${P(0, h - bl * k)} ${P(0, h - bl)}`;
  d += `L${P(0, tl)}`;
  if (tl) d += `C${P(0, tl * k)} ${P(tl * k, 0)} ${P(tl, 0)}`;
  return d + 'Z';
}

/**
 * Continuous ("squircle") rounded rectangle – the iOS-style smooth corners Sketch draws for `corners.style = 1`.
 * Each corner is a cubic–arc–cubic sequence whose length grows with `smoothing` (0 = circular, 1 = fully smooth).
 */
export function smoothRectPath(w: number, h: number, radii: [number, number, number, number], smoothing: number): string {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const budget = Math.min(w, h) / 2;
  const corner = (radius: number) => {
    const r = Math.max(0, Math.min(radius, budget));
    let s = smoothing;
    let p = (1 + s) * r;
    if (p > budget) {
      s = Math.max(Math.min(budget / Math.max(r, 1e-6) - 1, s), 0);
      p = Math.min(p, budget);
    }
    const arcMeasure = 90 * (1 - s);
    const arc = Math.sin(rad(arcMeasure / 2)) * r * Math.SQRT2;
    const alpha = (90 - arcMeasure) / 2;
    const p3p4 = r * Math.tan(rad(alpha / 2));
    const beta = 45 * s;
    const c = p3p4 * Math.cos(rad(beta));
    const d = c * Math.tan(rad(beta));
    const b = (p - arc - c - d) / 3;
    return { r, p, a: 2 * b, b, c, d, arc };
  };
  const [tl, tr, br, bl] = radii.map(corner) as [ReturnType<typeof corner>, ReturnType<typeof corner>, ReturnType<typeof corner>, ReturnType<typeof corner>];
  const n = (v: number) => r3(v);
  let d = `M${n(w - tr.p)} 0`;
  if (tr.r) d += `c${n(tr.a)} 0 ${n(tr.a + tr.b)} 0 ${n(tr.a + tr.b + tr.c)} ${n(tr.d)}a${n(tr.r)} ${n(tr.r)} 0 0 1 ${n(tr.arc)} ${n(tr.arc)}c${n(tr.d)} ${n(tr.c)} ${n(tr.d)} ${n(tr.b + tr.c)} ${n(tr.d)} ${n(tr.a + tr.b + tr.c)}`;
  d += `L${n(w)} ${n(h - br.p)}`;
  if (br.r) d += `c0 ${n(br.a)} 0 ${n(br.a + br.b)} ${n(-br.d)} ${n(br.a + br.b + br.c)}a${n(br.r)} ${n(br.r)} 0 0 1 ${n(-br.arc)} ${n(br.arc)}c${n(-br.c)} ${n(br.d)} ${n(-(br.b + br.c))} ${n(br.d)} ${n(-(br.a + br.b + br.c))} ${n(br.d)}`;
  d += `L${n(bl.p)} ${n(h)}`;
  if (bl.r) d += `c${n(-bl.a)} 0 ${n(-(bl.a + bl.b))} 0 ${n(-(bl.a + bl.b + bl.c))} ${n(-bl.d)}a${n(bl.r)} ${n(bl.r)} 0 0 1 ${n(-bl.arc)} ${n(-bl.arc)}c${n(-bl.d)} ${n(-bl.c)} ${n(-bl.d)} ${n(-(bl.b + bl.c))} ${n(-bl.d)} ${n(-(bl.a + bl.b + bl.c))}`;
  d += `L0 ${n(tl.p)}`;
  if (tl.r) d += `c0 ${n(-tl.a)} 0 ${n(-(tl.a + tl.b))} ${n(tl.d)} ${n(-(tl.a + tl.b + tl.c))}a${n(tl.r)} ${n(tl.r)} 0 0 1 ${n(tl.arc)} ${n(-tl.arc)}c${n(tl.c)} ${n(-tl.d)} ${n(tl.b + tl.c)} ${n(-tl.d)} ${n(tl.a + tl.b + tl.c)} ${n(-tl.d)}`;
  return d + 'Z';
}

/** Corner radii of a rectangle-like layer in [tl, tr, br, bl] order (Sketch 2025 `style.corners` or legacy point radii). */
export function cornerRadii(layer: Layer): [number, number, number, number] {
  const radii = layer.style?.corners?.radii;
  if (radii && radii.length) {
    if (radii.length === 1) return [radii[0]!, radii[0]!, radii[0]!, radii[0]!];
    if (radii.length === 4) return [radii[0]!, radii[1]!, radii[2]!, radii[3]!];
  }
  const pts = layer.points ?? [];
  if (pts.length === 4) return [pts[0]!.cornerRadius, pts[1]!.cornerRadius, pts[2]!.cornerRadius, pts[3]!.cornerRadius];
  const r = layer.fixedRadius ?? 0;
  return [r, r, r, r];
}

/** Path data of a single shape layer in the coordinate space given by `m` (applied after the layer's local space). */
export function shapePathData(layer: Layer, m: Matrix): string {
  const { width: w, height: h } = layer.frame;
  if (layer._class === 'oval' && !layer.edited) return ellipsePath(w, h, m);
  if (layer._class === 'rectangle' && !layer.edited && layer.style?.corners) return roundedRectPath(w, h, cornerRadii(layer), m);
  return pointsToPathData(layer.points ?? [], layer.isClosed !== false, w, h, m);
}

export { multiply };
