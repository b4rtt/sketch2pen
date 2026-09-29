import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { convertSketch, type ConvertResult } from '../src/convert/document.ts';
import { readSketch } from '../src/sketch/reader.ts';
import { fill, layer, style, text, uid, writeSketch } from './fixture.ts';
import { allNodes as all, byName, checkInvariants } from './invariants.ts';

const OPTIONS = { flexLayout: true, assetsDir: 'assets', pages: [] as string[] };

describe('end-to-end conversion', () => {
  // Symbol "Button": background stretches, label stays centred, icon is pinned to the right edge.
  const bg = layer('rectangle', 'bg', [0, 0, 200, 48], { horizontalPins: 5, verticalPins: 5, style: style({ fills: [fill(0.1, 0.2, 0.3)], corners: { radii: [24], style: 0, smoothing: 0 } }) });
  const label = text('label', [70, 14, 60, 20], [['Button', 'Inter-SemiBold', 16]]);
  const icon = layer('rectangle', 'icon', [164, 12, 24, 24], { horizontalPins: 4, style: style({ fills: [fill(1, 1, 1)] }) });
  const symbolID = uid('SYM');
  const master = layer('symbolMaster', 'Button', [0, 0, 200, 48], { symbolID, groupBehavior: 0, includeBackgroundColorInInstance: false, style: style({ fills: [fill(1, 1, 1)] }), layers: [bg, label, icon] });

  const instance = layer('symbolInstance', 'Button instance', [20, 700, 300, 48], {
    symbolID,
    scale: 1,
    overrideValues: [{ _class: 'overrideValue', overrideName: `${label.do_objectID}_stringValue`, value: 'Continue' }],
  });
  const arrow = layer('shapePath', 'arrow', [4, 8, 16, 8], {
    isClosed: false,
    points: [
      { point: '{0, 0.5}', curveFrom: '{0, 0.5}', curveTo: '{0, 0.5}', hasCurveFrom: false, hasCurveTo: false, curveMode: 1, cornerRadius: 0 },
      { point: '{1, 0.5}', curveFrom: '{1, 0.5}', curveTo: '{1, 0.5}', hasCurveFrom: false, hasCurveTo: false, curveMode: 1, cornerRadius: 0 },
    ],
    style: style({ borders: [{ ...fill(0, 0, 0), position: 0, thickness: 2 }] }),
  });
  const back = layer('group', 'backbutton', [16, 74, 24, 24], {
    groupBehavior: 0,
    isFlippedHorizontal: true,
    style: style({ fills: [fill(1, 1, 1, 1, { layeringType: 1 })] }), // tint → white arrow
    layers: [arrow],
  });
  const avatarMask = layer('oval', 'avatar mask', [100, 200, 64, 64], { hasClippingMask: true, clippingMaskMode: 0 });
  const avatar = layer('bitmap', 'avatar', [100, 200, 64, 64], { image: { _class: 'MSJSONFileReference', _ref: 'images/pixel.png' } });
  const card = layer('rectangle', 'card', [16, 300, 343, 60], {
    shouldBreakMaskChain: true,
    style: style({ fills: [fill(1, 1, 1)], shadows: [{ _class: 'shadow', isEnabled: true, isInnerShadow: true, offsetX: 0, offsetY: 1, blurRadius: 0, spread: 0, color: { red: 0.9, green: 0.9, blue: 0.9, alpha: 1 }, contextSettings: { blendMode: 0, opacity: 1 } }] }),
  });
  const title = text('title', [16, 120, 200, 30], [['Hello ', 'Inter-Regular', 24], ['world', 'Inter-Bold', 24]]);
  const artboard = layer('group', 'Screen', [0, 0, 375, 812], {
    groupBehavior: 1,
    clippingBehavior: 0,
    style: style({ fills: [fill(1, 1, 1)] }),
    layers: [back, avatarMask, avatar, card, title, instance],
  });

  const path = writeSketch([
    { name: 'Screens', layers: [artboard] },
    { name: 'Symbols', layers: [master] },
  ]);

  // the first conversion may build the CoreText helper and index the installed fonts
  let result: ConvertResult;
  beforeAll(async () => {
    result = await convertSketch(readSketch(path), OPTIONS);
  }, 120_000);

  test('produces a valid pen.dev document', () => {
    const { doc } = result;
    checkInvariants(doc);
    const screen = byName(doc, 'Screen')!;
    expect(screen.type).toBe('frame');
    expect(screen.clip).toBe(true);
    expect(screen.fill).toBe('#FFFFFF');
  });

  test('flipped groups are positioned for pen.dev’s mirror pivot and tinted', () => {
    const { doc } = result;
    const g = byName(doc, 'backbutton')!;
    expect(g.flipX).toBe(true);
    expect(g.x).toBe(16 + 24);
    const a = g.children![0]!;
    expect(a.stroke).toBe('#FFFFFF');
  });

  test('a shape masking a same-size bitmap becomes the shape with an image fill', () => {
    const { doc } = result;
    const n = byName(doc, 'avatar mask + avatar')!;
    expect(n.type).toBe('ellipse');
    expect(JSON.stringify(n.fill)).toContain('./assets/pixel.png');
  });

  test('blur-less inner shadows become inner per-side strokes', () => {
    const { doc } = result;
    const card = byName(doc, 'card')!;
    expect(card.strokeWidth).toEqual({ top: 1 });
    expect(card.strokeAlignment).toBe('inner');
  });

  test('symbol instances become refs with overrides and Sketch resizing', () => {
    const { doc, ctx } = result;
    const ref = byName(doc, 'Button instance')!;
    const comp = byName(doc, 'Button')!;
    expect(ref.type).toBe('ref');
    expect(ref.ref).toBe(comp.id);
    expect(comp.fill).toBeUndefined(); // includeBackgroundColorInInstance = false
    const d = ref.descendants!;
    const id = (l: { do_objectID: string }) => ctx.ids.for(l.do_objectID);
    expect(d[id(label)]!.content).toBe('Continue');
    expect(d[id(bg)]!.width).toBe(300); // pinned left+right → stretches
    expect(d[id(icon)]!.x).toBe(264); // pinned right → keeps the 12 px margin
  });

  test('texts with several styles keep their runs', () => {
    const { doc } = result;
    const t = byName(doc, 'title')!;
    const texts = all({ children: [t] }).filter((n) => n.type === 'text');
    expect(texts.map((n) => n.fontWeight)).toEqual(['400', '700']);
  });
});

describe('masks', () => {
  const pt = (x: number, y: number, r = 0) => ({ point: `{${x}, ${y}}`, curveFrom: `{${x}, ${y}}`, curveTo: `{${x}, ${y}}`, hasCurveFrom: false, hasCurveTo: false, curveMode: 1, cornerRadius: r });
  // an edited rectangle with an extra point on its top edge is still a rounded rectangle
  const roundedMask = layer('rectangle', 'rounded mask', [0, 0, 200, 100], {
    hasClippingMask: true,
    edited: true,
    points: [pt(0, 0, 24), pt(0.55, 0), pt(1, 0, 24), pt(1, 1, 24), pt(0, 1, 24)],
    style: style({ fills: [fill(1, 1, 1)] }),
  });
  const banner = layer('group', 'banner', [-10, 10, 120, 120], { groupBehavior: 0, layers: [layer('rectangle', 'art', [0, 0, 120, 120], { style: style({ fills: [fill(1, 0, 0)] }) })] });
  const bannerRef = uid('SYM');
  const bannerMaster = layer('symbolMaster', 'Banner art', [0, 0, 120, 120], { symbolID: bannerRef, groupBehavior: 0, layers: [layer('rectangle', 'art', [0, 0, 120, 120], { style: style({ fills: [fill(1, 0, 0)] }) })] });
  const card = layer('group', 'Card', [0, 0, 200, 100], {
    groupBehavior: 1,
    layers: [roundedMask, banner, layer('symbolInstance', 'banner instance', [120, 40, 120, 120], { symbolID: bannerRef })],
  });

  // a symbol consisting of one circle, used as the mask of a flag
  const circleId = uid('SYM');
  const circle = layer('symbolMaster', 'Shape / Circle', [0, 300, 48, 48], { symbolID: circleId, groupBehavior: 0, layers: [layer('oval', 'Mask', [0, 0, 48, 48], { horizontalSizing: 3, verticalSizing: 3, style: style({ fills: [fill(0.9, 0.9, 0.9)] }) })] });
  const flag = layer('group', 'Flag', [0, 0, 40, 40], {
    groupBehavior: 1,
    layers: [
      layer('symbolInstance', 'Shape', [0, 0, 40, 40], { symbolID: circleId, hasClippingMask: true }),
      layer('group', 'stripes', [-10, 0, 60, 40], { groupBehavior: 0, layers: [layer('text', 'label', [0, 0, 60, 40])] }),
    ],
  });

  // a triangle mask: a text inside the outline needs no clipping, one reaching past it does
  const tri = (name: string, inner: [number, number, number, number]) =>
    layer('group', name, [0, 500, 100, 100], {
      groupBehavior: 1,
      layers: [
        layer('shapePath', 'triangle', [0, 0, 100, 100], { hasClippingMask: true, isClosed: true, points: [pt(0.5, 0), pt(1, 1), pt(0, 1)] }),
        text('caption', inner, [['Hi', 'Inter-Regular', 12]]),
      ],
    });
  const path = writeSketch([{ name: 'Masks', layers: [card, flag, tri('inside', [40, 70, 20, 16]), tri('crossing', [0, 0, 100, 16])] }, { name: 'Symbols', layers: [circle, bannerMaster] }]);

  let result: ConvertResult;
  beforeAll(async () => {
    result = await convertSketch(readSketch(path), OPTIONS);
  }, 120_000);

  test('an edited rectangle that is still a rounded rectangle clips like one', () => {
    const frame = byName(result.doc, 'rounded mask (mask)')!;
    expect(frame).toMatchObject({ type: 'frame', clip: true, cornerRadius: 24 });
    expect(all({ children: [frame] }).map((n) => n.name)).toContain('banner instance');
  });

  test('a symbol instance used as a mask clips with the shape of its symbol', () => {
    // the circle scales with the instance (relative sizing): 48 → 40
    const frame = byName(result.doc, 'Shape (mask)')!;
    expect(frame).toMatchObject({ clip: true, cornerRadius: 20, width: 40, height: 40 });
  });

  test('only content that reaches past a path mask is reported', () => {
    const examples = result.ctx.report.warnings.find((w) => w.code === 'path-mask')?.examples ?? [];
    expect(examples.some((e) => e.includes('crossing'))).toBe(true);
    expect(examples.some((e) => e.includes('inside') || e.includes('Card') || e.includes('Flag'))).toBe(false);
  });
});

// Optional: run the invariants against a real design file, e.g. SKETCH2PEN_REAL_FILE=~/Designs/App.sketch bun test
const REAL = process.env.SKETCH2PEN_REAL_FILE;
describe.if(!!REAL && existsSync(REAL))('real design file', () => {
  test('converts into a valid document', async () => {
    const { doc, ctx } = await convertSketch(readSketch(REAL!), OPTIONS);
    checkInvariants(doc);
    expect(ctx.report.stats.layers).toBeGreaterThan(0);
  }, 600_000);
});
