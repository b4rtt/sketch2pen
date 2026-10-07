// pen.dev → Sketch: unit tests of the building blocks and end-to-end conversions of synthetic documents. Everything
// runs offline (no Google Fonts, no installed fonts) so results are the same on every machine; rendering fidelity is
// verified with `bun run lab:pen` on a Mac with pen.dev and Sketch.
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { linearGradientParams, radialGradientParams } from '../src/convert/style.ts';
import { parsePen, readPen } from '../src/pen/reader.ts';
import type { PenDocument } from '../src/pen/types.ts';
import { convertPen, type PenToSketchResult } from '../src/pen2sketch/document.ts';
import { Layout } from '../src/pen2sketch/layout.ts';
import { linearFromTo, radialFromTo } from '../src/pen2sketch/paint.ts';
import { Report } from '../src/pen2sketch/report.ts';
import { curvePoints, parsePath, pathBounds, polygonPoints } from '../src/pen2sketch/svgpath.ts';
import { layoutText } from '../src/pen2sketch/textlayout.ts';
import { TreeBuilder, type RNode } from '../src/pen2sketch/tree.ts';
import { Variables } from '../src/pen2sketch/variables.ts';
import { readSketch } from '../src/sketch/reader.ts';
import { zipDocument } from '../src/sketch/builder.ts';
import { buildPenLab } from '../tools/lab/pen-cases.ts';

// no downloads, no cache from earlier runs, no installed fonts: deterministic everywhere
process.env.SKETCH2PEN_CACHE = mkdtempSync(join(tmpdir(), 'sketch2pen-cache-'));
const OFFLINE = { download: false, fontDirs: [] as string[] };

type J = Record<string, any>;

function doc(children: unknown[], extra: Partial<PenDocument> = {}): PenDocument {
  return { version: '2.19', children: children as PenDocument['children'], ...extra };
}

/** Expands and lays out a document with fallback text metrics (texts are 7 px per character, 17 px per line). */
function laidOut(d: PenDocument): RNode[] {
  const vars = new Variables(d);
  const { roots } = new TreeBuilder(d, vars, new Report()).build();
  const layout = new Layout({
    vars,
    measureText: (n, w) => {
      const lines = String(n.p.content ?? '').split('\n');
      const width = Math.max(...lines.map((l) => l.length * 7));
      const count = w === undefined ? lines.length : lines.reduce((s, l) => s + Math.max(1, Math.ceil((l.length * 7) / w)), 0);
      return { width: w ?? width, height: count * 17 };
    },
  });
  for (const r of roots) layout.run(r);
  return roots;
}

const box = (n: RNode) => [n.x, n.y, n.w, n.h];

/** Pages and their layers from the converted archive. */
function pages(result: PenToSketchResult): { name: string; layers: J[] }[] {
  const document = JSON.parse(strFromU8(result.files['document.json']!));
  return document.pages.map((ref: { _ref: string }) => JSON.parse(strFromU8(result.files[`${ref._ref}.json`]!)));
}

function allLayers(layers: J[]): J[] {
  const out: J[] = [];
  const walk = (l: J) => {
    out.push(l);
    (l.layers ?? []).forEach(walk);
  };
  layers.forEach(walk);
  return out;
}

describe('reading .pen files', () => {
  test('older stroke objects and icon_font nodes are brought to the current schema', () => {
    const pen = parsePen(
      JSON.stringify(
        doc([
          { type: 'rectangle', id: 'r', width: 10, height: 10, stroke: { align: 'inside', thickness: { bottom: 1 }, fill: '#000000' } },
          { type: 'icon_font', id: 'i', width: 16, height: 16, iconFontName: 'house', iconFontFamily: 'lucide' },
        ]),
      ),
    );
    const [r, i] = pen.doc.children as J[];
    expect(r).toMatchObject({ stroke: '#000000', strokeWidth: { bottom: 1 }, strokeAlignment: 'inner' });
    expect(i).toMatchObject({ type: 'icon', icon: 'house', library: 'lucide' });
  });

  test('a file that is not a pen.dev document is rejected with a clear message', () => {
    expect(() => parsePen('not json', 'x.pen')).toThrow(/not a readable pen.dev document/);
    expect(() => parsePen('{"a":1}', 'x.pen')).toThrow(/not a pen.dev document/);
  });
});

describe('variables and themes', () => {
  const d = doc([], {
    themes: { mode: ['light', 'dark'] },
    variables: {
      bg: { type: 'color', value: [{ value: '#FFFFFF' }, { value: '#000000', theme: { mode: 'dark' } }] },
      accent: { type: 'color', value: '$bg' },
      gap: { type: 'number', value: 12 },
    },
  });
  const vars = new Variables(d);

  test('the first theme value is the default', () => {
    expect(vars.color('$bg')).toEqual({ hex: '#FFFFFFFF', variable: 'bg' });
    expect(vars.color('$bg', { mode: 'dark' })?.hex).toBe('#000000FF');
  });

  test('variables can refer to variables', () => {
    expect(vars.color('$accent', { mode: 'dark' })?.hex).toBe('#000000FF');
    expect(vars.number('$gap')).toBe(12);
  });

  test('a dollar text that is no variable stays text', () => {
    expect(vars.string('$100')).toBe('$100');
  });

  test('short and alpha hex colours are normalised', () => {
    expect(vars.color('#abc')?.hex).toBe('#AABBCCFF');
    expect(vars.color('#11223344')?.hex).toBe('#11223344');
  });
});

describe('layout', () => {
  test('frames lay out horizontally unless told otherwise and hug their content', () => {
    const [f] = laidOut(doc([{ type: 'frame', id: 'f', children: [{ type: 'rectangle', id: 'a', width: 20, height: 10 }, { type: 'rectangle', id: 'b', width: 30, height: 40 }] }]));
    expect(box(f!)).toEqual([0, 0, 50, 40]);
    expect(box(f!.children[1]!)).toEqual([20, 0, 30, 40]);
  });

  test('gap, padding and alignment', () => {
    const [f] = laidOut(
      doc([{ type: 'frame', id: 'f', layout: 'vertical', gap: 10, padding: [5, 8], alignItems: 'center', children: [{ type: 'rectangle', id: 'a', width: 20, height: 10 }, { type: 'rectangle', id: 'b', width: 40, height: 10 }] }]),
    );
    expect(box(f!)).toEqual([0, 0, 56, 40]);
    expect(box(f!.children[0]!)).toEqual([18, 5, 20, 10]);
    expect(box(f!.children[1]!)).toEqual([8, 25, 40, 10]);
  });

  test('fill_container shares the free space; space_between spreads the rest', () => {
    const [f] = laidOut(
      doc([
        { type: 'frame', id: 'f', width: 200, height: 50, children: [{ type: 'rectangle', id: 'a', width: 'fill_container', height: 'fill_container' }, { type: 'rectangle', id: 'b', width: 50, height: 10 }, { type: 'rectangle', id: 'c', width: 'fill_container', height: 10 }] },
        { type: 'frame', id: 'g', width: 100, height: 10, justifyContent: 'space_between', children: [{ type: 'rectangle', id: 'd', width: 10, height: 10 }, { type: 'rectangle', id: 'e', width: 10, height: 10 }] },
      ]),
    );
    expect(f!.children.map(box)).toEqual([
      [0, 0, 75, 50],
      [75, 0, 50, 10],
      [125, 0, 75, 10],
    ]);
  });

  test('absolutely positioned and hidden children do not take part in the flow', () => {
    const [f] = laidOut(
      doc([{ type: 'frame', id: 'f', children: [{ type: 'rectangle', id: 'a', width: 20, height: 10 }, { type: 'rectangle', id: 'h', width: 99, height: 10, enabled: false }, { type: 'rectangle', id: 'b', layoutPosition: 'absolute', x: 5, y: 30, width: 99, height: 10 }] }]),
    );
    expect(box(f!)).toEqual([0, 0, 20, 10]);
    expect(box(f!.children[2]!)).toEqual([5, 30, 99, 10]);
  });

  test('a wrapping text gets the width of its column', () => {
    const [f] = laidOut(doc([{ type: 'frame', id: 'f', width: 70, layout: 'vertical', children: [{ type: 'text', id: 't', content: 'aaaaaaaaaaaaaaaaaaaa', textGrowth: 'fixed-width', width: 'fill_container' }] }]));
    expect(box(f!.children[0]!)).toEqual([0, 0, 70, 34]);
    expect(f!.h).toBe(34);
  });

  test('a hugging row is as tall as its children that do not fill; filling ones stretch to it', () => {
    const [f] = laidOut(
      doc([{ type: 'frame', id: 'row', children: [{ type: 'rectangle', id: 'a', width: 20, height: 40 }, { type: 'frame', id: 'b', height: 'fill_container', layout: 'vertical', children: [{ type: 'rectangle', id: 'c', width: 10, height: 90 }] }] }]),
    );
    expect(f!.h).toBe(40);
    expect(f!.children[1]!.h).toBe(40);
  });

  test('space_between spreads the free room and ignores a gap that does not fit', () => {
    const [f] = laidOut(doc([{ type: 'frame', id: 'f', width: 100, height: 10, gap: 320, justifyContent: 'space_between', children: [{ type: 'rectangle', id: 'a', width: 30, height: 10 }, { type: 'rectangle', id: 'b', width: 16, height: 10 }] }]));
    expect(box(f!.children[1]!)).toEqual([84, 0, 16, 10]);
  });

  test('groups are as large as their children', () => {
    const [g] = laidOut(doc([{ type: 'group', id: 'g', x: 100, y: 0, children: [{ type: 'rectangle', id: 'a', x: 10, y: 10, width: 20, height: 20 }, { type: 'ellipse', id: 'b', x: 50, y: 40, width: 20, height: 20 }] }]));
    expect([g!.ox, g!.oy, g!.w, g!.h]).toEqual([10, 10, 60, 50]);
  });
});

describe('component instances', () => {
  const d = doc([
    { type: 'frame', id: 'btn', reusable: true, children: [{ type: 'text', id: 'label', content: 'OK' }, { type: 'ref', id: 'inner', ref: 'dot' }] },
    { type: 'ellipse', id: 'dot', reusable: true, width: 4, height: 4, fill: '#FF0000' },
    { type: 'ellipse', id: 'dot2', reusable: true, width: 4, height: 4, fill: '#00FF00' },
    { type: 'ref', id: 'i1', ref: 'btn', descendants: { label: { content: 'Cancel' }, inner: { type: 'ref', ref: 'dot2', id: 'inner' } } },
  ]);
  const vars = new Variables(d);
  const { roots } = new TreeBuilder(d, vars, new Report()).build();
  const inst = roots[3]!;

  test('expand with their overrides, keyed by the instance path', () => {
    expect(inst.instance?.ref).toBe('btn');
    expect(inst.children.map((c) => c.key)).toEqual(['i1/label', 'i1/inner']);
    expect(inst.children[0]!.p.content).toBe('Cancel');
  });

  test('an instance can bring the children of a slot component', () => {
    const d2 = doc([
      { type: 'frame', id: 'table', reusable: true, slot: ['row'], layout: 'vertical' },
      { type: 'ref', id: 't1', ref: 'table', children: [{ type: 'rectangle', id: 'r1', width: 10, height: 10 }, { type: 'rectangle', id: 'r2', width: 10, height: 10 }] },
    ]);
    const v2 = new Variables(d2);
    const t = new TreeBuilder(d2, v2, new Report()).build().roots[1]!;
    expect(t.children.map((c) => c.key)).toEqual(['t1/r1', 't1/r2']);
  });

  test('a replacement swaps the nested instance', () => {
    expect(inst.children[1]!.replaced).toBe(true);
    expect(inst.children[1]!.instance?.ref).toBe('dot2');
  });
});

describe('geometry', () => {
  test('SVG paths: relative commands, quadratic curves and arcs become cubic segments', () => {
    const subs = parsePath('m10 10 h20 v20 q-10 10 -20 0 z M50 50 A10 10 0 0 1 70 50');
    expect(subs.length).toBe(2);
    expect(subs[0]!.closed).toBe(true);
    expect(subs[0]!.segments.map((s) => !!s.c1)).toEqual([false, false, true]);
    const b = pathBounds(subs)!;
    expect(b.x).toBeCloseTo(10);
    expect(b.y).toBeCloseTo(10);
    expect(b.w).toBeCloseTo(60);
    expect(b.y + b.h).toBeCloseTo(50, 0);
  });

  test('a closed subpath does not repeat its first point', () => {
    const { points, closed } = curvePoints(parsePath('M0 0 C10 0 10 10 0 10 C-10 10 -10 0 0 0 Z')[0]!);
    expect(closed).toBe(true);
    expect(points.length).toBe(2);
    expect(points[0]!.curveTo).toEqual({ x: -10, y: 0 });
  });

  test('polygons are inscribed in the ellipse of their box', () => {
    const tri = polygonPoints(3, 100, 100);
    expect(tri[0]).toEqual({ x: 50, y: 0 });
    expect(tri[1]!.y).toBeCloseTo(75);
  });

  test('gradients map back to what the Sketch → pen.dev conversion produces', () => {
    const box = { w: 300, h: 120 };
    const lin = linearFromTo({ x: 0.3, y: 0.6 }, 0.7, 35, box);
    const back = linearGradientParams({ gradientType: 0, from: lin.from, to: lin.to, elipseLength: 0, stops: [] }, box.w, box.h);
    expect(back.center.x).toBeCloseTo(0.3, 5);
    expect(back.length).toBeCloseTo(0.7, 5);
    expect(back.rotation).toBeCloseTo(35, 3);
    const rad = radialFromTo({ x: 0.4, y: 0.5 }, { width: 1.2, height: 0.5 }, 20, box);
    const rback = radialGradientParams({ gradientType: 1, from: rad.from, to: rad.to, elipseLength: rad.elipseLength, stops: [] }, box.w, box.h);
    expect(rback.width).toBeCloseTo(1.2, 4);
    expect(rback.height).toBeCloseTo(0.5, 4);
    expect(((rback.rotation % 180) + 180) % 180).toBeCloseTo(20, 3);
  });
});

describe('text layout', () => {
  test('wraps greedily at spaces and breaks words wider than the box', () => {
    const style = { size: 10, letterSpacing: 0 };
    const l = layoutText('aaa bbb ccc', style, 40);
    expect(l.lines.length).toBe(2);
    expect(layoutText('aaaaaaaaaaaa', style, 30).lines.length).toBeGreaterThan(1);
  });

  test('letter spacing applies to every character', () => {
    const a = layoutText('abc', { size: 10, letterSpacing: 0 }).width;
    expect(layoutText('abc', { size: 10, letterSpacing: 2 }).width).toBeCloseTo(a + 6);
  });
});

describe('end-to-end', () => {
  let result: PenToSketchResult;
  const d = doc(
    [
      { type: 'frame', id: 'btn', name: 'Button', reusable: true, x: 0, y: 0, layout: 'horizontal', padding: [8, 12], gap: 6, fill: '$primary', cornerRadius: 6, children: [{ type: 'text', id: 'label', content: 'Save', fill: '#FFFFFF' }] },
      {
        type: 'frame', id: 'screen', name: 'Screen', x: 200, y: 0, width: 300, height: 200, layout: 'vertical', gap: 8, padding: 16, fill: '#F8FAFC', clip: true,
        children: [
          { type: 'text', id: 'title', content: 'Title', fontSize: 20, fontWeight: '700' },
          { type: 'ref', id: 'b1', ref: 'btn' },
          { type: 'ref', id: 'b2', ref: 'btn', descendants: { label: { content: 'Cancel' } } },
          { type: 'ref', id: 'b3', ref: 'btn', fill: '#DC2626' },
          { type: 'rectangle', id: 'grad', width: 'fill_container', height: 20, fill: { type: 'gradient', gradientType: 'linear', rotation: 90, colors: [{ color: '#000000', position: 0 }, { color: '#FFFFFF', position: 1 }] }, effect: { type: 'shadow', shadowType: 'outer', offset: { x: 0, y: 2 }, blur: 4, color: '#00000040' } },
          { type: 'path', id: 'p', width: 20, height: 20, geometry: 'M0 0 H10 V10 H0 Z M2 2 V8 H8 V2 Z', fillRule: 'evenodd', fill: '#000000' },
        ],
      },
    ],
    { variables: { primary: { type: 'color', value: '#2563EB' } } },
  );

  beforeAll(async () => {
    result = await convertPen(parsePen(JSON.stringify(d), join(tmpdir(), 'test.pen')), OFFLINE);
  });

  test('writes a complete Sketch archive with unique object ids', () => {
    expect(Object.keys(result.files)).toEqual(expect.arrayContaining(['document.json', 'meta.json', 'user.json']));
    const layers = allLayers(pages(result).flatMap((p) => p.layers));
    const ids = layers.map((l) => l.do_objectID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('colour variables become swatches the fills refer to', () => {
    const document = JSON.parse(strFromU8(result.files['document.json']!));
    const swatch = document.sharedSwatches.objects[0];
    expect(swatch.name).toBe('primary');
    const master = allLayers(pages(result)[0]!.layers).find((l) => l._class === 'symbolMaster')!;
    expect(master.style.fills[0].color.swatchID).toBe(swatch.do_objectID);
  });

  test('components become symbols, instances overrides or expanded layers', () => {
    const layers = allLayers(pages(result)[0]!.layers);
    const master = layers.find((l) => l._class === 'symbolMaster')!;
    const instances = layers.filter((l) => l._class === 'symbolInstance');
    expect(instances.every((i) => i.symbolID === master.symbolID)).toBe(true);
    expect(instances.length).toBe(2);
    const label = master.layers.find((l: J) => l._class === 'text');
    const overridden = instances.filter((i) => i.overrideValues.length);
    expect(overridden.length).toBe(1);
    expect(overridden[0]!.overrideValues).toEqual([{ _class: 'overrideValue', overrideName: `${label.do_objectID}_stringValue`, value: 'Cancel' }]);
    // a different background has no Sketch override: that instance is drawn as layers
    expect(result.ctx.report.stats.detached).toBe(1);
  });

  test('flex layout becomes a stack with the layout pen.dev computes', () => {
    const screen = pages(result)[0]!.layers.find((l) => l.name === 'Screen')!;
    expect(screen.groupLayout).toMatchObject({ _class: 'MSImmutableFlexGroupLayout', flexDirection: 1, allGuttersGap: 8 });
    expect([screen.leftPadding, screen.topPadding]).toEqual([16, 16]);
    // stack items are stored last-first
    expect(screen.layers.at(-1).name).toBe('Title');
  });

  test('gradients, shadows and compound paths', () => {
    const layers = allLayers(pages(result)[0]!.layers);
    const grad = layers.find((l) => l.name === 'Rectangle')!;
    expect(grad.style.fills[0]).toMatchObject({ fillType: 1, gradient: { gradientType: 0 } });
    expect(grad.style.shadows[0]).toMatchObject({ offsetY: 2, blurRadius: 4, isInnerShadow: false });
    const path = layers.find((l) => l._class === 'shapeGroup')!;
    expect(path.windingRule).toBe(1);
    expect(path.layers.length).toBe(2);
  });

  test('missing fonts are reported, the PostScript name follows the usual pattern', () => {
    const title = allLayers(pages(result)[0]!.layers).find((l) => l.name === 'Title')!;
    expect(title.attributedString.attributes[0].attributes.MSAttributedStringFontAttribute.attributes.name).toBe('Inter-Bold');
  });
});

describe('image fill without an image', () => {
  test('is drawn as pen.dev’s placeholder: a tiled checkerboard and an inside outline', async () => {
    const d = doc([{ type: 'frame', id: 'f', width: 60, height: 60, layout: 'none', children: [{ type: 'frame', id: 'avatar', x: 10, y: 10, width: 40, height: 40, cornerRadius: 9999, fill: { type: 'image', mode: 'cover' } }] }]);
    const result = await convertPen(parsePen(JSON.stringify(d), join(tmpdir(), 'placeholder.pen')), OFFLINE);
    const avatar = allLayers(pages(result)[0]!.layers).find((l) => l.do_objectID === result.ctx.uuid('avatar'))!;
    expect(avatar.style.fills[0]).toMatchObject({ fillType: 4, patternFillType: 0, patternTileScale: 0.5 });
    expect(result.files[avatar.style.fills[0].image._ref]).toBeDefined();
    expect(avatar.style.borders[0]).toMatchObject({ position: 1, thickness: 1 });
    expect(result.ctx.report.warnings.map((w) => w.code)).toContain('image-placeholder');
  });
});

describe('round trip', () => {
  test('the pen.dev feature lab converts to a Sketch document Sketch can read back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sketch2pen-penlab-'));
    const { file } = buildPenLab(dir);
    const result = await convertPen(readPen(file), OFFLINE);
    const out = join(dir, 'lab.sketch');
    writeFileSync(out, zipDocument(result.files));
    const sketch = readSketch(out);
    expect(sketch.pages.length).toBeGreaterThan(0);
    const layers = allLayers(sketch.pages.flatMap((p) => p.layers as J[]));
    const ids = layers.map((l) => l.do_objectID);
    expect(new Set(ids).size).toBe(ids.length);
    // every symbol instance has its master
    const masters = new Set(layers.filter((l) => l._class === 'symbolMaster').map((l) => l.symbolID));
    for (const i of layers.filter((l) => l._class === 'symbolInstance')) expect(masters.has(i.symbolID)).toBe(true);
    expect(result.topLevel.length).toBeGreaterThan(25);
    // the archive unzips into JSON Sketch understands
    expect(Object.keys(unzipSync(zipDocument(result.files)))).toContain('document.json');
  }, 60_000);
});
