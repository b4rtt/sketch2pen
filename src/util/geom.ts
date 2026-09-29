export interface Pt {
  x: number;
  y: number;
}

/** Parses Sketch's "{x, y}" point strings. */
export function parsePoint(s: string | undefined): Pt {
  if (!s) return { x: 0, y: 0 };
  const m = s.match(/\{\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\}/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
}

/** Rounds to 3 decimals and strips trailing zeros – keeps the .pen file compact. */
export function r3(n: number): number {
  return Math.round(n * 1000) / 1000 || 0;
}

export function r2(n: number): number {
  return Math.round(n * 100) / 100 || 0;
}

/** 2D affine matrix [a, b, c, d, e, f] mapping (x, y) → (a·x + c·y + e, b·x + d·y + f). */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  // m ∘ n: apply n first, then m
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Matrix, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function invert(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-12;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function translate(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y];
}

/** Counter-clockwise (on screen, y axis pointing down) rotation by `deg` degrees. */
export function rotateCCW(deg: number): Matrix {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, s, c, 0, 0];
}

/**
 * Local → parent transform of a Sketch layer. Sketch rotates around the centre of the frame and then mirrors the
 * rotated layer (flips act in the parent's axes): T(centre) · S · R · T(−centre).
 */
export function layerMatrix(frame: { x: number; y: number; width: number; height: number }, rotation = 0, flipH = false, flipV = false): Matrix {
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  let m: Matrix = translate(-cx, -cy);
  if (rotation) m = multiply(rotateCCW(rotation), m);
  m = multiply([flipH ? -1 : 1, 0, 0, flipV ? -1 : 1, 0, 0], m);
  return multiply(translate(frame.x + cx, frame.y + cy), m);
}

/**
 * pen.dev rotates nodes counter-clockwise around their top-left corner, Sketch around the centre.
 * Returns the position pen.dev needs so that the rotated box lands where Sketch draws it.
 */
export function penRotatedPosition(frame: { x: number; y: number; width: number; height: number }, rotation: number): Pt {
  if (!rotation) return { x: frame.x, y: frame.y };
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  const corner = apply(rotateCCW(rotation), { x: -frame.width / 2, y: -frame.height / 2 });
  return { x: cx + corner.x, y: cy + corner.y };
}

/**
 * Position and rotation for pen.dev. pen.dev maps a node's local point p to pos + R·S·p (mirror first, around the
 * node origin, then rotate around the top-left corner); Sketch maps it to centre + S·R·(p − size/2). With a single
 * flip S·R(θ) = R(−θ)·S, so the rotation changes sign. `baked` means the flips live in the node's geometry.
 */
export function penTransform(frame: { x: number; y: number; width: number; height: number }, rotation: number, flipX: boolean, flipY: boolean, baked = false): Pt & { rotation: number } {
  const rot = normalizeAngle(flipX !== flipY ? -rotation : rotation);
  const sx = !baked && flipX ? -1 : 1;
  const sy = !baked && flipY ? -1 : 1;
  const v = apply(rotateCCW(rot), { x: (-sx * frame.width) / 2, y: (-sy * frame.height) / 2 });
  return { x: frame.x + frame.width / 2 + v.x, y: frame.y + frame.height / 2 + v.y, rotation: rot };
}

export function normalizeAngle(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a || 0; // no negative zero
}
