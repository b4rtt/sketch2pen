// Boolean path operations via Skia PathOps (pathkit-wasm). pen.dev has no boolean groups,
// so Sketch shape groups and emulated inner shadows are flattened into a single SVG path.
// @ts-expect-error – the package ships no typings
import PathKitInit from 'pathkit-wasm/bin/pathkit.js';
import wasmPath from 'pathkit-wasm/bin/pathkit.wasm' with { type: 'file' };
import { readFileSync } from 'node:fs';

export type BoolOp = 'union' | 'difference' | 'intersect' | 'xor';

interface SkPath {
  op(other: SkPath, op: unknown): SkPath | null;
  copy(): SkPath;
  setFillType(t: unknown): SkPath;
  getFillTypeString(): string;
  toSVGString(): string;
  transform(...m: number[]): SkPath;
  delete(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PK: any = null;

export async function initPathOps(): Promise<void> {
  if (PK) return;
  PK = await PathKitInit({ wasmBinary: readFileSync(wasmPath) });
}

function fromSvg(d: string, fillRule: 'nonzero' | 'evenodd'): SkPath {
  const p: SkPath = PK.FromSVGString(d);
  p.setFillType(fillRule === 'evenodd' ? PK.FillType.EVENODD : PK.FillType.WINDING);
  return p;
}

const OPS = (): Record<BoolOp, unknown> => ({
  union: PK.PathOp.UNION,
  difference: PK.PathOp.DIFFERENCE,
  intersect: PK.PathOp.INTERSECT,
  xor: PK.PathOp.XOR,
});

export interface PathShape {
  d: string;
  fillRule: 'nonzero' | 'evenodd';
}

/** Folds shapes left-to-right: ((a op1 b) op2 c) … Returns null if Skia could not compute it. */
export function combine(first: PathShape, rest: { shape: PathShape; op: BoolOp }[]): PathShape | null {
  if (!PK) throw new Error('initPathOps() must be awaited first');
  let acc = fromSvg(first.d, first.fillRule);
  for (const { shape, op } of rest) {
    const other = fromSvg(shape.d, shape.fillRule);
    const res = acc.op(other, OPS()[op]);
    other.delete();
    if (!res) {
      acc.delete();
      return null;
    }
    acc = res;
  }
  const out: PathShape = {
    d: acc.toSVGString(),
    fillRule: acc.getFillTypeString() === 'evenodd' ? 'evenodd' : 'nonzero',
  };
  acc.delete();
  return out;
}

function toShape(p: SkPath): PathShape {
  return { d: p.toSVGString(), fillRule: p.getFillTypeString() === 'evenodd' ? 'evenodd' : 'nonzero' };
}

/** Applies an affine matrix [a, b, c, d, e, f] (x' = a·x + c·y + e, y' = b·x + d·y + f). */
export function transformPath(shape: PathShape, m: [number, number, number, number, number, number]): PathShape {
  if (!PK) throw new Error('initPathOps() must be awaited first');
  const p = fromSvg(shape.d, shape.fillRule).transform(m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1);
  const out = toShape(p);
  p.delete();
  return out;
}

/** shape ∩ clip, or null when Skia fails. An empty `d` means nothing is left. */
export function intersect(shape: PathShape, clip: PathShape): PathShape | null {
  return combine(shape, [{ shape: clip, op: 'intersect' }]);
}

export type Cap = 'butt' | 'round' | 'square';
export type Join = 'miter' | 'round' | 'bevel';

/**
 * Outline of a stroke as a fillable shape – used for dashed borders and line markers, which pen.dev cannot draw.
 * `dash` is an on/off pattern (Skia supports one pair; longer Sketch patterns use their first pair).
 */
export function strokeOutline(shape: PathShape, width: number, cap: Cap = 'butt', join: Join = 'miter', dash?: [number, number]): PathShape | null {
  if (!PK) throw new Error('initPathOps() must be awaited first');
  const p = fromSvg(shape.d, shape.fillRule) as SkPath & { dash(on: number, off: number, phase: number): SkPath | null; stroke(o: object): SkPath | null };
  if (dash && dash[0] > 0 && !p.dash(dash[0], Math.max(dash[1], 0.001), 0)) {
    p.delete();
    return null;
  }
  const caps = { butt: PK.StrokeCap.BUTT, round: PK.StrokeCap.ROUND, square: PK.StrokeCap.SQUARE };
  const joins = { miter: PK.StrokeJoin.MITER, round: PK.StrokeJoin.ROUND, bevel: PK.StrokeJoin.BEVEL };
  const stroked = p.stroke({ width, cap: caps[cap], join: joins[join], miter_limit: 10 });
  if (!stroked) {
    p.delete();
    return null;
  }
  const simplified = (stroked as SkPath & { simplify(): SkPath | null }).simplify() ?? stroked;
  const out = toShape(simplified);
  simplified.delete();
  return out;
}

/** Shape grown (delta > 0) or shrunk (delta < 0) by |delta|. */
export function offsetShape(shape: PathShape, delta: number): PathShape {
  if (!PK) throw new Error('initPathOps() must be awaited first');
  const p = offsetPath(fromSvg(shape.d, shape.fillRule), delta);
  const out = toShape(p);
  p.delete();
  return out;
}

/** a − b */
export function difference(a: PathShape, b: PathShape): PathShape | null {
  return combine(a, [{ shape: b, op: 'difference' }]);
}

/** Grows (delta > 0) or shrinks (delta < 0) a shape by |delta|; corners stay sharp like Sketch's shadow spread. */
function offsetPath(p: SkPath, delta: number): SkPath {
  if (Math.abs(delta) < 1e-3) return p;
  const ring = p.copy() as SkPath & { stroke(o: object): SkPath | null };
  const stroked = ring.stroke({ width: Math.abs(delta) * 2, join: PK.StrokeJoin.MITER, cap: PK.StrokeCap.BUTT, miter_limit: 8 });
  if (!stroked) return p;
  const res = p.op(stroked, delta > 0 ? PK.PathOp.UNION : PK.PathOp.DIFFERENCE);
  stroked.delete();
  return res ?? p;
}

/**
 * The visible band of an inner shadow: shape − (shape shrunk by `spread`, moved by dx/dy).
 * A negative spread grows the hole, so e.g. spread −30 on a 34 px button leaves nothing (like Sketch).
 */
export function innerShadowBand(shape: PathShape, dx: number, dy: number, spread = 0): PathShape | null {
  if (!PK) throw new Error('initPathOps() must be awaited first');
  const a = fromSvg(shape.d, shape.fillRule);
  const b = offsetPath(a.copy(), -spread).transform(1, 0, dx, 0, 1, dy, 0, 0, 1);
  const res = a.op(b, PK.PathOp.DIFFERENCE);
  b.delete();
  if (!res) {
    a.delete();
    return null;
  }
  const out: PathShape = { d: res.toSVGString(), fillRule: res.getFillTypeString() === 'evenodd' ? 'evenodd' : 'nonzero' };
  res.delete();
  return out;
}
