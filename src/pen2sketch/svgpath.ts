// SVG path data → subpaths of straight and cubic segments (quadratic curves and arcs converted), their exact bounds,
// and Sketch curve points.

export interface P {
  x: number;
  y: number;
}

export interface Segment {
  /** control points of a cubic segment (absent for a straight line) */
  c1?: P;
  c2?: P;
  to: P;
}

export interface Subpath {
  start: P;
  segments: Segment[];
  closed: boolean;
}

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

function tokenize(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  let i = 0;
  while (i < d.length) {
    const c = d[i]!;
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(c)) {
      out.push(c);
      i++;
    } else if (/[\s,]/.test(c)) i++;
    else {
      NUM.lastIndex = i;
      const m = NUM.exec(d);
      if (!m) {
        i++;
        continue;
      }
      out.push(Number(m[0]));
      i = NUM.lastIndex;
    }
  }
  return out;
}

/** Arc flags may be written without separators ("a1 1 0 011 1"): re-split them. */
function arcFlag(tokens: (string | number)[], i: number): number {
  const v = tokens[i];
  return typeof v === 'number' ? (v ? 1 : 0) : 0;
}

/** Endpoint arc → cubic Béziers (SVG implementation notes, F.6). */
function arcToCubics(p0: P, rx: number, ry: number, phiDeg: number, large: number, sweep: number, p: P): Segment[] {
  if ((p0.x === p.x && p0.y === p.y) || rx === 0 || ry === 0) return [{ to: p }];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0.x - p.x) / 2;
  const dy = (p0.y - p.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cx1 = (co * rx * y1) / ry;
  const cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0.x + p.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0.y + p.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const pt = (t: number): P => ({ x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos });
  const der = (t: number): P => ({ x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos });
  const segs: Segment[] = [];
  let a = t1;
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const pa = pt(a);
    const pb = i === n - 1 ? p : pt(b);
    const da = der(a);
    const db = der(b);
    segs.push({ c1: { x: pa.x + k * da.x, y: pa.y + k * da.y }, c2: { x: pb.x - k * db.x, y: pb.y - k * db.y }, to: pb });
    a = b;
  }
  return segs;
}

export function parsePath(d: string): Subpath[] {
  const t = tokenize(d);
  const subs: Subpath[] = [];
  let cur: Subpath | null = null;
  let pos: P = { x: 0, y: 0 };
  let start: P = { x: 0, y: 0 };
  let lastC2: P | null = null; // for S
  let lastQ: P | null = null; // for T
  let cmd = '';
  let i = 0;
  const num = () => {
    const v = t[i];
    if (typeof v !== 'number') throw new Error('number expected');
    i++;
    return v;
  };
  const begin = (p: P) => {
    cur = { start: p, segments: [], closed: false };
    subs.push(cur);
  };
  const ensure = () => {
    if (!cur) begin(pos);
    return cur!;
  };
  while (i < t.length) {
    if (typeof t[i] === 'string') cmd = t[i++] as string;
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? pos.x : 0;
    const oy = rel ? pos.y : 0;
    try {
      switch (C) {
        case 'M': {
          pos = { x: ox + num(), y: oy + num() };
          start = pos;
          begin(pos);
          cmd = rel ? 'l' : 'L'; // following pairs are line-tos
          lastC2 = lastQ = null;
          break;
        }
        case 'L': {
          pos = { x: ox + num(), y: oy + num() };
          ensure().segments.push({ to: pos });
          lastC2 = lastQ = null;
          break;
        }
        case 'H': {
          pos = { x: (rel ? pos.x : 0) + num(), y: pos.y };
          ensure().segments.push({ to: pos });
          lastC2 = lastQ = null;
          break;
        }
        case 'V': {
          pos = { x: pos.x, y: (rel ? pos.y : 0) + num() };
          ensure().segments.push({ to: pos });
          lastC2 = lastQ = null;
          break;
        }
        case 'C': {
          const c1 = { x: ox + num(), y: oy + num() };
          const c2 = { x: ox + num(), y: oy + num() };
          pos = { x: ox + num(), y: oy + num() };
          ensure().segments.push({ c1, c2, to: pos });
          lastC2 = c2;
          lastQ = null;
          break;
        }
        case 'S': {
          const c1 = lastC2 ? { x: 2 * pos.x - lastC2.x, y: 2 * pos.y - lastC2.y } : pos;
          const c2 = { x: ox + num(), y: oy + num() };
          pos = { x: ox + num(), y: oy + num() };
          ensure().segments.push({ c1, c2, to: pos });
          lastC2 = c2;
          lastQ = null;
          break;
        }
        case 'Q':
        case 'T': {
          const q: P = C === 'Q' ? { x: ox + num(), y: oy + num() } : lastQ ? { x: 2 * pos.x - lastQ.x, y: 2 * pos.y - lastQ.y } : pos;
          const to = { x: ox + num(), y: oy + num() };
          const c1 = { x: pos.x + (2 / 3) * (q.x - pos.x), y: pos.y + (2 / 3) * (q.y - pos.y) };
          const c2 = { x: to.x + (2 / 3) * (q.x - to.x), y: to.y + (2 / 3) * (q.y - to.y) };
          ensure().segments.push({ c1, c2, to });
          pos = to;
          lastQ = q;
          lastC2 = null;
          break;
        }
        case 'A': {
          const rx = num();
          const ry = num();
          const rot = num();
          const large = arcFlag(t, i++);
          const sweep = arcFlag(t, i++);
          const to = { x: ox + num(), y: oy + num() };
          ensure().segments.push(...arcToCubics(pos, rx, ry, rot, large, sweep, to));
          pos = to;
          lastC2 = lastQ = null;
          break;
        }
        case 'Z': {
          if (cur) (cur as Subpath).closed = true;
          pos = start;
          cur = null;
          lastC2 = lastQ = null;
          // a drawing command right after Z starts a new subpath at the start point
          if (i < t.length && typeof t[i] === 'number') cmd = '';
          break;
        }
        default:
          i++;
      }
    } catch {
      break; // malformed tail: keep what was parsed
    }
  }
  return subs.filter((s) => s.segments.length > 0);
}

/** Exact bounds of the subpaths (cubic extrema included). */
export function pathBounds(subs: Subpath[]): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (p: P) => {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  };
  const extrema = (a: number, b: number, c: number, d: number): number[] => {
    // derivative of the cubic: 3[(b−a)(1−t)² + 2(c−b)t(1−t) + (d−c)t²]
    const A = -a + 3 * b - 3 * c + d;
    const B = 2 * (a - 2 * b + c);
    const C = b - a;
    if (Math.abs(A) < 1e-12) return Math.abs(B) < 1e-12 ? [] : [-C / B];
    const disc = B * B - 4 * A * C;
    if (disc < 0) return [];
    const s = Math.sqrt(disc);
    return [(-B + s) / (2 * A), (-B - s) / (2 * A)];
  };
  for (const sp of subs) {
    let p = sp.start;
    add(p);
    for (const s of sp.segments) {
      add(s.to);
      if (s.c1 && s.c2) {
        for (const axis of ['x', 'y'] as const) {
          for (const tt of extrema(p[axis], s.c1[axis], s.c2[axis], s.to[axis])) {
            if (tt <= 0 || tt >= 1) continue;
            const m = 1 - tt;
            const q = {
              x: m * m * m * p.x + 3 * m * m * tt * s.c1.x + 3 * m * tt * tt * s.c2.x + tt * tt * tt * s.to.x,
              y: m * m * m * p.y + 3 * m * m * tt * s.c1.y + 3 * m * tt * tt * s.c2.y + tt * tt * tt * s.to.y,
            };
            add(q);
          }
        }
      }
      p = s.to;
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function mapSubpaths(subs: Subpath[], f: (p: P) => P): Subpath[] {
  return subs.map((s) => ({ start: f(s.start), closed: s.closed, segments: s.segments.map((g) => ({ to: f(g.to), ...(g.c1 ? { c1: f(g.c1) } : {}), ...(g.c2 ? { c2: f(g.c2) } : {}) })) }));
}

export interface CurvePoint {
  point: P;
  curveFrom?: P;
  curveTo?: P;
}

const near = (a: P, b: P) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/**
 * Sketch curve points of a subpath: every vertex with the control point of its incoming segment (curveTo) and of its
 * outgoing segment (curveFrom). A closed subpath that returns to its start point does not repeat it.
 */
export function curvePoints(sp: Subpath): { points: CurvePoint[]; closed: boolean } {
  const pts: CurvePoint[] = [{ point: sp.start }];
  for (const s of sp.segments) {
    const prev = pts[pts.length - 1]!;
    if (s.c1 && !near(s.c1, prev.point)) prev.curveFrom = s.c1;
    const next: CurvePoint = { point: s.to };
    if (s.c2 && !near(s.c2, s.to)) next.curveTo = s.c2;
    pts.push(next);
  }
  let closed = sp.closed;
  const last = pts[pts.length - 1]!;
  if (pts.length > 1 && near(last.point, pts[0]!.point) && (closed || sp.segments.length > 1)) {
    // the last segment ends where the subpath started: that vertex is the first one
    if (last.curveTo) pts[0]!.curveTo = last.curveTo;
    pts.pop();
    closed = true;
  }
  return { points: pts, closed };
}

/** SVG path of an ellipse arc / ring (pen.dev ellipse with startAngle, sweepAngle, innerRadius) in a w×h box. */
export function ellipseArcPath(w: number, h: number, startDeg: number, sweepDeg: number, inner: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const sweep = Math.max(-360, Math.min(360, sweepDeg));
  const full = Math.abs(sweep) >= 360;
  // degrees counter-clockwise from 3 o'clock (y axis points down)
  const at = (deg: number, k: number): P => ({ x: cx + (w / 2) * k * Math.cos((deg * Math.PI) / 180), y: cy - (h / 2) * k * Math.sin((deg * Math.PI) / 180) });
  const f = (n: number) => Math.round(n * 1000) / 1000;
  const arc = (k: number, from: number, delta: number): string => {
    // split into ≤ 180° pieces so the flags stay simple
    let d = '';
    const n = Math.max(1, Math.ceil(Math.abs(delta) / 180));
    for (let i = 1; i <= n; i++) {
      const p = at(from + (delta * i) / n, k);
      d += `A${f((w / 2) * k)} ${f((h / 2) * k)} 0 0 ${delta > 0 ? 0 : 1} ${f(p.x)} ${f(p.y)}`;
    }
    return d;
  };
  const s0 = at(startDeg, 1);
  if (full) {
    let d = `M${f(at(startDeg, 1).x)} ${f(s0.y)}${arc(1, startDeg, 360)}Z`;
    if (inner > 0) {
      const i0 = at(startDeg, inner);
      d += `M${f(i0.x)} ${f(i0.y)}${arc(inner, startDeg, -360)}Z`;
    }
    return d;
  }
  let d = `M${f(s0.x)} ${f(s0.y)}${arc(1, startDeg, sweep)}`;
  if (inner > 0) {
    const e = at(startDeg + sweep, inner);
    d += `L${f(e.x)} ${f(e.y)}${arc(inner, startDeg + sweep, -sweep)}`;
  } else d += `L${f(cx)} ${f(cy)}`;
  return d + 'Z';
}

/** Regular polygon with `n` corners inscribed in the ellipse of a w×h box, first corner at the top centre. */
export function polygonPoints(n: number, w: number, h: number): P[] {
  const count = Math.max(3, Math.round(n));
  const out: P[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i * 2 * Math.PI) / count;
    out.push({ x: (0.5 + 0.5 * Math.sin(a)) * w, y: (0.5 - 0.5 * Math.cos(a)) * h });
  }
  return out;
}
