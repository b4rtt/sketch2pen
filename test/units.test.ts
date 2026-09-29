import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFlex } from '../src/convert/flex.ts';
import { FontResolver, facesFromBytes, weightFromStyle } from '../src/convert/fonts.ts';
import { pointsToPathData } from '../src/convert/path.ts';
import { hexColor, linearGradientParams, tintPaint } from '../src/convert/style.ts';
import { resizeAxis } from '../src/convert/symbols.ts';
import type { SketchFile } from '../src/sketch/reader.ts';
import type { Layer } from '../src/sketch/types.ts';
import { IDENTITY, apply, layerMatrix, parsePoint, penTransform, rotateCCW } from '../src/util/geom.ts';
import { combine, initPathOps, innerShadowBand } from '../src/util/pathops.ts';
import { buildFont, type TestFont } from './fontdata.ts';

describe('geometry', () => {
  test('parses Sketch point strings', () => {
    expect(parsePoint('{0.5, 1}')).toEqual({ x: 0.5, y: 1 });
    expect(parsePoint('{-1.25e-2, 3}')).toEqual({ x: -0.0125, y: 3 });
  });

  test('flips move the node by its size (pen.dev mirrors around the origin, Sketch around the centre)', () => {
    const f = { x: 16, y: 74, width: 24, height: 24 };
    expect(penTransform(f, 0, false, false)).toEqual({ x: 16, y: 74, rotation: 0 });
    expect(penTransform(f, 0, true, false)).toEqual({ x: 40, y: 74, rotation: 0 });
    expect(penTransform(f, 0, false, true)).toEqual({ x: 16, y: 98, rotation: 0 });
  });

  test('rotation pivots on the top-left corner in pen.dev', () => {
    // a 20×20 square rotated 90° around its centre (10,10) keeps its box; its top-left corner ends at (0,20)
    const p = penTransform({ x: 0, y: 0, width: 20, height: 20 }, 90, false, false);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(20, 6);
  });

  test('flipped and rotated nodes map every point like Sketch does', () => {
    const frame = { x: 170, y: 90, width: 50, height: 50 };
    for (const [flipX, flipY] of [[true, false], [false, true], [true, true]] as const) {
      const sketch = layerMatrix(frame, 20, flipX, flipY);
      const t = penTransform(frame, 20, flipX, flipY);
      // pen.dev: pos + R(rotation) · S · p
      const pen = (p: { x: number; y: number }) => {
        const r = apply(rotateCCW(t.rotation), { x: flipX ? -p.x : p.x, y: flipY ? -p.y : p.y });
        return { x: t.x + r.x, y: t.y + r.y };
      };
      for (const p of [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 50 }, { x: 13, y: 37 }]) {
        expect(pen(p).x).toBeCloseTo(apply(sketch, p).x, 6);
        expect(pen(p).y).toBeCloseTo(apply(sketch, p).y, 6);
      }
    }
  });
});

describe('paths', () => {
  const pt = (x: number, y: number, r = 0) => ({ point: `{${x}, ${y}}`, curveFrom: `{${x}, ${y}}`, curveTo: `{${x}, ${y}}`, hasCurveFrom: false, hasCurveTo: false, curveMode: 1, cornerRadius: r });

  test('straight closed path', () => {
    expect(pointsToPathData([pt(0, 0), pt(1, 0), pt(1, 1)], true, 10, 20, IDENTITY)).toBe('M0 0L10 0L10 20L0 0Z');
  });

  test('open path has no Z', () => {
    expect(pointsToPathData([pt(0, 0), pt(1, 1)], false, 10, 10, IDENTITY)).toBe('M0 0L10 10');
  });

  test('corner radius becomes a fillet', () => {
    const d = pointsToPathData([pt(0, 0), pt(1, 0, 5), pt(1, 1), pt(0, 1)], true, 20, 20, IDENTITY);
    expect(d).toContain('L15 0C');
    expect(d).toContain('20 5');
  });
});

describe('styles', () => {
  test('hex colours with alpha', () => {
    expect(hexColor({ red: 1, green: 0, blue: 0.5, alpha: 1 })).toBe('#FF0080');
    expect(hexColor({ red: 0, green: 0, blue: 0, alpha: 0.5 })).toBe('#00000080');
    expect(hexColor({ red: 0, green: 0, blue: 0, alpha: 1 }, 0.25)).toBe('#00000040');
  });

  test('vertical linear gradient', () => {
    const g = { gradientType: 0, from: '{0.5, 0}', to: '{0.5, 1}', elipseLength: 0, stops: [] };
    const p = linearGradientParams(g, 200, 100);
    expect(p.center).toEqual({ x: 0.5, y: 0.5 });
    expect(p.rotation).toBeCloseTo(180, 6); // pen.dev: 0° up, 180° down
    expect(p.length).toBeCloseTo(1, 6);
  });

  test('diagonal gradient keeps pixel-space iso-lines (like Sketch) on a non-square box', () => {
    const g = { gradientType: 0, from: '{0, 0}', to: '{1, 1}', elipseLength: 0, stops: [] };
    const w = 200;
    const h = 100;
    const p = linearGradientParams(g, w, h);
    // evaluate pen.dev's model: t = 0.5 + dot(pn − c, u) / L with u = (−sin θ, −cos θ) in the unit square
    const th = (p.rotation * Math.PI) / 180;
    const u = { x: -Math.sin(th), y: -Math.cos(th) };
    const penT = (x: number, y: number) => 0.5 + ((x / w - p.center.x) * u.x + (y / h - p.center.y) * u.y) / p.length;
    // Sketch: projection onto the pixel-space vector from (0,0) to (w,h)
    const sketchT = (x: number, y: number) => (x * w + y * h) / (w * w + h * h);
    for (const [x, y] of [[0, 0], [200, 100], [50, 80], [170, 10]]) expect(penT(x!, y!)).toBeCloseTo(sketchT(x!, y!), 6);
  });

  test('tint keeps paint opacity, gradient stop opacities and images', () => {
    expect(tintPaint('#FF000080', '#00BBA7')).toBe('#00BBA780');
    expect(tintPaint('#123456', '#00BBA7')).toBe('#00BBA7');
    const g = tintPaint({ type: 'gradient', gradientType: 'linear', colors: [{ color: '#F2F5F7', position: 0 }, { color: '#F2F5F700', position: 1 }] }, '#00BBA7');
    expect(typeof g !== 'string' && g.type === 'gradient' ? g.colors.map((c) => c.color) : []).toEqual(['#00BBA7', '#00BBA700']);
    const img = { type: 'image' as const, url: './a.png' };
    expect(tintPaint(img, '#00BBA7')).toBe(img);
  });
});

describe('fonts', () => {
  test('weights from style names', () => {
    expect(weightFromStyle('Regular')).toBe(400);
    expect(weightFromStyle('SemiBold')).toBe(600);
    expect(weightFromStyle('Extended ExtraBold')).toBe(800);
    expect(weightFromStyle('ExtraLight Italic')).toBe(200);
    expect(weightFromStyle('Black')).toBe(900);
  });

  const variable: TestFont = {
    family: 'Test Var',
    subfamily: 'Regular',
    postscriptName: 'TestVar-Regular',
    weight: 400,
    axes: [['wght', 100, 400, 900], ['opsz', 17, 28, 28]],
    instances: [
      { subfamily: 'Regular', coords: [400, 28], ps: 'TestVar-Regular' },
      { subfamily: 'Semibold', coords: [590, 28], ps: 'TestVar-Semibold' },
    ],
  };

  test('named instances of variable fonts are read with their PostScript names', () => {
    const [face] = facesFromBytes(buildFont(variable));
    expect(face!.axes.map((a) => a.tag)).toEqual(['wght', 'opsz']);
    expect(face!.instances).toEqual([
      { postscriptName: 'TestVar-Regular', subfamily: 'Regular', coords: { wght: 400, opsz: 28 } },
      { postscriptName: 'TestVar-Semibold', subfamily: 'Semibold', coords: { wght: 590, opsz: 28 } },
    ]);
  });

  test('instances without a PostScript name get the name derived from the variations prefix', () => {
    const [face] = facesFromBytes(buildFont({ ...variable, prefix: 'TestVarPS', instances: [{ subfamily: 'Extra Bold', coords: [800, 28] }] }));
    expect(face!.instances!.map((i) => i.postscriptName)).toEqual(['TestVarPS-ExtraBold']);
  });

  const resolverWith = (fonts: TestFont[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'sketch2pen-fonts-'));
    fonts.forEach((f, i) => writeFileSync(join(dir, `${i}.ttf`), buildFont(f)));
    const sketch = { files: new Map(), document: {}, pages: [] } as unknown as SketchFile;
    return new FontResolver(sketch, { embed: 'all', map: {}, dirs: [dir] });
  };

  test('a named instance resolves to its variable font with the instance weight', () => {
    const r = resolverWith([variable]).resolve('TestVar-Semibold');
    expect(r).toMatchObject({ family: 'Test Var', weight: 590, source: 'local' });
    expect(r.face!.axes.find((a) => a.tag === 'wght')).toMatchObject({ min: 100, max: 900 });
  });

  test('SF Pro uses the installed Text or Display cut matching the size, like automatic optical sizing', () => {
    const sfVariable: TestFont = { ...variable, family: 'SF Pro', postscriptName: 'SFPro-Regular', instances: [{ subfamily: 'Semibold', coords: [590, 28], ps: 'SFPro-Semibold' }] };
    const text: TestFont = { family: 'SF Pro Text', subfamily: 'Semibold', postscriptName: 'SFProText-Semibold', weight: 600 };
    const display: TestFont = { family: 'SF Pro Display', subfamily: 'Semibold', postscriptName: 'SFProDisplay-Semibold', weight: 600 };
    const fonts = resolverWith([sfVariable, text, display]);
    expect(fonts.resolve('SFPro-Semibold', 17)).toMatchObject({ family: 'SF Pro Text', weight: 600, postscriptName: 'SFPro-Semibold' });
    expect(fonts.resolve('SFPro-Semibold', 34)).toMatchObject({ family: 'SF Pro Display', weight: 600 });
    expect(fonts.documentFonts().map((f) => f.family).sort()).toEqual(['SF Pro Display', 'SF Pro Text']);
    // without the static cuts the variable font itself is used
    expect(resolverWith([sfVariable]).resolve('SFPro-Semibold', 17)).toMatchObject({ family: 'SF Pro', weight: 590 });
  });
});

describe('symbol resizing (Sketch pins & sizing)', () => {
  test('pinned left keeps position, relative size scales', () => {
    expect(resizeAxis(10, 20, 100, 200, 1, 0)).toEqual([10, 20]);
    expect(resizeAxis(10, 20, 100, 200, 1, 3)).toEqual([10, 40]);
  });
  test('pinned right keeps the right margin', () => {
    expect(resizeAxis(70, 20, 100, 200, 4, 0)).toEqual([170, 20]);
  });
  test('pinned both sides stretches', () => {
    expect(resizeAxis(10, 80, 100, 200, 5, 0)).toEqual([10, 180]);
  });
  test('no pins scales proportionally around the centre', () => {
    expect(resizeAxis(40, 20, 100, 200, 0, 0)).toEqual([90, 20]);
    expect(resizeAxis(40, 20, 100, 200, 0, 3)).toEqual([80, 40]);
  });
});

describe('stacks', () => {
  const child = (name: string, x: number, y: number, w: number, h: number): Layer =>
    ({ _class: 'rectangle', do_objectID: name, name, frame: { x, y, width: w, height: h }, isVisible: true }) as Layer;
  const stack = (layers: Layer[], extra: Partial<Layer> = {}): Layer =>
    ({
      _class: 'group',
      do_objectID: 's',
      name: 'stack',
      isVisible: true,
      groupBehavior: 1,
      frame: { x: 0, y: 0, width: 100, height: 100 },
      groupLayout: { _class: 'MSImmutableFlexGroupLayout', flexDirection: 1, justifyContent: 0, alignItems: 0, allGuttersGap: 10, crossAxisGutterGap: 0, wrappingEnabled: false },
      layers,
      ...extra,
    }) as Layer;

  test('reproducible vertical stack becomes flex (children listed bottom-up in Sketch)', () => {
    const { plan } = planFlex(stack([child('b', 0, 30, 50, 20), child('a', 0, 0, 50, 20)]));
    expect(plan?.direction).toBe('vertical');
    expect(plan?.items.map((l) => l.name)).toEqual(['a', 'b']);
    expect(plan?.props.gap).toBe(10);
  });

  test('stack whose saved positions do not match stays absolute', () => {
    const { plan, reason } = planFlex(stack([child('b', 0, 45, 50, 20), child('a', 0, 0, 50, 20)]));
    expect(plan).toBeNull();
    expect(reason).toBe('main axis mismatch');
  });
});

describe('path operations', () => {
  beforeAll(async () => {
    await initPathOps();
  });

  test('difference of a square and an inner square', () => {
    const res = combine({ d: 'M0 0L10 0L10 10L0 10Z', fillRule: 'nonzero' }, [{ shape: { d: 'M2 2L8 2L8 8L2 8Z', fillRule: 'nonzero' }, op: 'difference' }]);
    expect(res?.d).toContain('M');
    expect(res?.d.match(/M/g)?.length).toBe(2);
  });

  test('inner shadow with a large negative spread leaves nothing (like Sketch)', () => {
    const circle = { d: 'M34 17C34 26.4 26.4 34 17 34C7.6 34 0 26.4 0 17C0 7.6 7.6 0 17 0C26.4 0 34 7.6 34 17Z', fillRule: 'nonzero' as const };
    const band = innerShadowBand(circle, -20, 0, -30);
    expect(band?.d ?? '').toBe('');
    const thin = innerShadowBand(circle, 0, 1, 0);
    expect(thin?.d.length).toBeGreaterThan(10);
  });
});
