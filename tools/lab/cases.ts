// Feature lab: one artboard per Sketch feature. Sketch renders them (ground truth), sketch2pen converts them and
// the verify tool compares both renders. Run with `bun tools/lab/run.ts <workdir>`.
import * as B from './builder.ts';

type J = Record<string, unknown>;

const W = 240;
const H = 160;
const INK = B.hex('#1F2937');
const RED = B.hex('#EF4444');
const BLUE = B.hex('#3B82F6');
const GREEN = B.hex('#10B981');
const YELLOW = B.hex('#F59E0B');
const font = 'HelveticaNeue';
const bold = 'HelveticaNeue-Bold';

const IMG = 'images/lab.png';
const image = B.png(120, 80, (x, y) => {
  const cx = x - 60;
  const cy = y - 40;
  const ring = Math.sqrt(cx * cx + cy * cy) < 26;
  return ring ? [250, 200, 40, 255] : [Math.round((x / 120) * 255), Math.round((y / 80) * 180), 200, 255];
});

function stripes(): J[] {
  return [0, 1, 2, 3, 4, 5].map((i) => B.rect(`stripe ${i}`, [i * 40, 0, 20, H], { style: { fills: [B.fill([RED, BLUE, GREEN][i % 3]!)] } }));
}

const cases: Record<string, J[]> = {
  // ---------------------------------------------------------------------------------------------- effects
  'blur gaussian': [
    B.rect('r4', [20, 40, 80, 80], { style: { fills: [B.fill(BLUE)], blurs: [B.blur(0, 4)] } }),
    B.rect('r12', [140, 40, 80, 80], { style: { fills: [B.fill(RED)], blurs: [B.blur(0, 12)] } }),
  ],
  'background blur': [...stripes(), B.rect('glass', [40, 40, 160, 80], { style: { fills: [B.fill(B.hex('#FFFFFF', 0.3))], blurs: [B.blur(3, 10)], radii: [16] } })],
  'drop shadows': [
    B.rect('s1', [16, 40, 60, 60], { style: { fills: [B.fill(B.hex('#FFFFFF'))], shadows: [B.shadow(B.hex('#000000', 0.4), 0, 6, 12)] } }),
    B.rect('s2', [92, 40, 60, 60], { style: { fills: [B.fill(B.hex('#FFFFFF'))], shadows: [B.shadow(B.hex('#000000', 0.5), 4, 4, 0, 6)] } }),
    B.oval('s3', [168, 40, 60, 60], { style: { fills: [B.fill(BLUE)], shadows: [B.shadow(B.hex('#EF4444', 0.8), 0, 10, 8, -4)] } }),
  ],
  'inner shadows': [
    B.rect('i1', [16, 30, 60, 60], { style: { fills: [B.fill(B.hex('#E5E7EB'))], shadows: [B.shadow(RED, 0, 4, 0, 0, true)] } }),
    B.rect('i2', [92, 30, 60, 60], { style: { fills: [B.fill(B.hex('#E5E7EB'))], shadows: [B.shadow(B.hex('#000000', 0.6), 0, 0, 12, 0, true)], radii: [12] } }),
    B.oval('i3', [168, 30, 60, 60], { style: { fills: [B.fill(B.hex('#E5E7EB'))], shadows: [B.shadow(BLUE, 3, 3, 4, 2, true)] } }),
    B.rect('i4', [16, 104, 212, 40], { style: { fills: [B.fill(B.hex('#FFFFFF'))], shadows: [B.shadow(B.hex('#D1D5DB'), 0, -1, 0, 0, true)] } }),
  ],
  'inner shadow on paths': [
    B.path('star', [16, 30, 90, 90], [[0.5, 0], [0.62, 0.36], [1, 0.38], [0.7, 0.62], [0.8, 1], [0.5, 0.78], [0.2, 1], [0.3, 0.62], [0, 0.38], [0.38, 0.36]], true, { style: { fills: [B.fill(YELLOW)], shadows: [B.shadow(B.hex('#000000', 0.5), 0, 3, 4, 0, true)] } }),
    B.path('blob', [130, 30, 90, 90], [[0.1, 0.1, 30], [0.9, 0, 20], [1, 0.8, 30], [0.2, 1, 20]], true, { style: { fills: [B.fill(B.hex('#E5E7EB'))], shadows: [B.shadow(BLUE, -2, 2, 8, 0, true)] } }),
  ],
  // ---------------------------------------------------------------------------------------------- fills
  'gradient linear diagonal': [
    B.rect('g', [20, 30, 200, 100], { style: { fills: [B.fill(RED, { gradient: B.gradient([[0, RED], [0.5, YELLOW], [1, BLUE]], '{0, 0}', '{1, 1}') })] } }),
  ],
  'gradient radial': [
    B.rect('g1', [10, 30, 140, 100], { style: { fills: [B.fill(RED, { gradient: B.gradient([[0, YELLOW], [1, BLUE]], '{0.5, 0.5}', '{1, 0.5}', 1, 1) })] } }),
    B.rect('g2', [160, 30, 70, 100], { style: { fills: [B.fill(RED, { gradient: B.gradient([[0, RED], [1, GREEN]], '{0.3, 0.3}', '{0.8, 0.9}', 1, 0.5) })] } }),
  ],
  'gradient angular': [
    B.oval('g', [60, 20, 120, 120], { style: { fills: [B.fill(RED, { gradient: B.gradient([[0, RED], [0.33, YELLOW], [0.66, BLUE], [1, RED]], '{0.5, 0}', '{0.5, 1}', 2) })] } }),
  ],
  'image fills': [
    B.rect('fill', [8, 20, 70, 60], { style: { fills: [B.fill(RED, { image: IMG, patternFillType: 1 })] } }),
    B.rect('fit', [86, 20, 70, 60], { style: { fills: [B.fill(RED, { image: IMG, patternFillType: 3 })] } }),
    B.rect('stretch', [164, 20, 70, 60], { style: { fills: [B.fill(RED, { image: IMG, patternFillType: 2 })] } }),
    B.bitmap('bitmap', [60, 90, 120, 60], IMG),
  ],
  'blend modes': [
    B.rect('base', [0, 0, W, H], { style: { fills: [B.fill(B.hex('#60A5FA'))] } }),
    ...[2, 5, 7, 10].map((mode, i) => B.oval(`blend ${mode}`, [10 + i * 58, 50, 56, 56], { style: { fills: [B.fill(YELLOW)], blend: mode } })),
  ],
  // ---------------------------------------------------------------------------------------------- borders
  'dashed borders': [
    B.rect('center', [12, 20, 60, 60], { style: { borders: [B.border(INK, 2, 0)], dash: [6, 4] } }),
    B.rect('inside', [90, 20, 60, 60], { style: { borders: [B.border(RED, 4, 1)], dash: [8, 4], radii: [12] } }),
    B.oval('outside', [168, 20, 60, 60], { style: { borders: [B.border(BLUE, 3, 2)], dash: [2, 3] } }),
    B.path('line', [12, 110, 216, 30], [[0, 1], [0.5, 0], [1, 1]], false, { style: { borders: [B.border(GREEN, 3)], dash: [10, 5], cap: 1 } }),
  ],
  'line markers': [
    B.path('arrow filled', [20, 30, 200, 0], [[0, 0], [1, 0]], false, { style: { borders: [B.border(INK, 2)], endMarker: 2 } }),
    B.path('arrow open', [20, 70, 200, 0], [[0, 0], [1, 0]], false, { style: { borders: [B.border(RED, 2)], startMarker: 1, endMarker: 1 } }),
    B.path('circles', [20, 110, 200, 0], [[0, 0], [1, 0]], false, { style: { borders: [B.border(BLUE, 2)], startMarker: 5, endMarker: 4 } }),
    B.path('squares', [20, 145, 200, 0], [[0, 0], [1, 0]], false, { style: { borders: [B.border(GREEN, 2)], startMarker: 7, endMarker: 6 } }),
  ],
  'border positions': [
    B.rect('multi', [20, 30, 80, 80], { style: { fills: [B.fill(B.hex('#F3F4F6'))], borders: [B.border(BLUE, 8, 2), B.border(RED, 3, 1)] } }),
    B.path('join round', [130, 30, 90, 80], [[0, 1], [0.5, 0], [1, 1]], false, { style: { borders: [B.border(INK, 10)], join: 1, cap: 1 } }),
  ],
  // ---------------------------------------------------------------------------------------------- shapes
  'smooth corners': [
    B.rect('round', [16, 30, 96, 96], { style: { fills: [B.fill(BLUE)], radii: [28] } }),
    B.rect('smooth', [128, 30, 96, 96], { style: { fills: [B.fill(BLUE)], radii: [28], smooth: true } }),
  ],
  booleans: [0, 1, 2, 3].map((op, i) =>
    B.shapeGroup(`op ${op}`, [8 + i * 58, 50, 54, 54], [B.rect('a', [0, 0, 36, 36]), B.oval('b', [18, 18, 36, 36], { booleanOperation: op })], { style: { fills: [B.fill(GREEN)] } }),
  ),
  'point radius': [B.path('star', [60, 20, 120, 120], [[0.5, 0, 12], [1, 0.8, 12], [0, 0.8, 12]], true, { style: { fills: [B.fill(YELLOW)], borders: [B.border(INK, 2)] } })],
  'rotation and flips': [
    B.rect('rot30', [20, 30, 60, 30], { rotation: 30, style: { fills: [B.fill(RED)] } }),
    B.group('flipped group', [110, 20, 40, 40], [B.path('arrow', [0, 10, 40, 20], [[0, 0.5], [1, 0.5], [0.7, 0], [1, 0.5], [0.7, 1]], false, { style: { borders: [B.border(INK, 3)] } })], { flipH: true }),
    B.bitmap('flipped bitmap', [160, 20, 60, 40], IMG, { flipH: true }),
    B.text('rotated text', [40, 100, 140, 20], [{ text: 'Rotated text', font, size: 16 }], {}, { rotation: 15 }),
    B.group('rot+flip', [170, 90, 50, 50], [B.path('tri', [0, 0, 50, 50], [[0, 0], [1, 0], [0, 1]], true, { style: { fills: [B.fill(BLUE)] } })], { flipV: true, rotation: 20 }),
  ],
  // ---------------------------------------------------------------------------------------------- masks
  'path mask over image': [
    B.group('masked', [20, 10, 200, 140], [
      B.path('bubble', [20, 10, 160, 120], [[0, 0, 20], [1, 0, 20], [1, 0.8, 20], [0.3, 0.8], [0.1, 1], [0.15, 0.8], [0, 0.8, 20]], true, { mask: 0, style: { fills: [B.fill(B.hex('#E5E7EB'))] } }),
      B.bitmap('photo', [0, 0, 200, 140], IMG),
    ]),
  ],
  'oval mask over shapes': [
    B.group('masked', [70, 30, 100, 100], [
      B.oval('mask', [0, 0, 100, 100], { mask: 0 }),
      B.rect('red', [0, 0, 100, 50], { style: { fills: [B.fill(RED)] } }),
      B.rect('blue', [0, 50, 100, 50], { style: { fills: [B.fill(BLUE)] } }),
      B.text('label', [10, 40, 80, 20], [{ text: 'MASKED', font: bold, size: 16, color: B.hex('#FFFFFF') }], { align: 2, sizing: [0, 1] }),
    ]),
  ],
  'alpha mask': [
    B.group('faded', [20, 20, 200, 120], [
      B.rect('fade', [0, 0, 200, 120], { mask: 1, style: { fills: [B.fill(INK, { gradient: B.gradient([[0, B.hex('#000000', 1)], [1, B.hex('#000000', 0)]]) })] } }),
      B.bitmap('photo', [0, 0, 200, 120], IMG),
    ]),
  ],
  // ---------------------------------------------------------------------------------------------- text
  'text alignment': [0, 2, 1, 3].map((align, i) =>
    B.text(`align ${align}`, [10, 8 + i * 38, 220, 32], [{ text: 'The quick brown fox jumps over the lazy dog again', font, size: 12 }], { align, sizing: [0, 1], lineHeight: 16 }),
  ),
  'paragraph spacing': [
    B.text('paragraphs', [16, 10, 208, 140], [{ text: 'First paragraph with two lines of text here.\nSecond paragraph.\nThird one.', font, size: 13 }], { sizing: [0, 1], lineHeight: 18, paragraphSpacing: 12 }),
  ],
  'vertical alignment': [0, 1, 2].map((v, i) =>
    B.text(`valign ${v}`, [10 + i * 76, 20, 70, 120], [{ text: 'Middle?', font, size: 14 }], { sizing: [0, 0], vAlign: v, align: 2 }, { style: { fills: [] } }),
  ).concat([0, 1, 2].map((v, i) => B.rect(`box ${v}`, [10 + i * 76, 20, 70, 120], { style: { borders: [B.border(B.hex('#D1D5DB'), 1, 1)] } }))),
  decorations: [
    B.text('underline', [16, 16, 200, 20], [{ text: 'Underlined text', font, size: 15, underline: true }]),
    B.text('strike', [16, 46, 200, 20], [{ text: 'Struck through', font, size: 15, strike: true }]),
    B.text('upper', [16, 76, 200, 20], [{ text: 'uppercase transform', font, size: 15, transform: 1 }]),
    B.text('kerning', [16, 106, 200, 20], [{ text: 'Letter spacing', font, size: 15, kerning: 3 }]),
  ],
  'decorations wrapped': [
    B.text('underlined paragraph', [20, 12, 200, 60], [{ text: 'An underlined paragraph that wraps over two centred lines', font, size: 14, underline: true, color: BLUE }], { sizing: [0, 1], align: 2, lineHeight: 20 }),
    B.text('old price', [20, 100, 80, 20], [{ text: '$150.00', font, size: 16, strike: true, color: B.hex('#9CA3AF') }]),
    B.text('new price', [110, 100, 80, 20], [{ text: '$120.00', font: bold, size: 16 }]),
  ],
  'sf pro sizes': [13, 17, 22, 34].map((size, i) =>
    B.text(`sf ${size}`, [12, [8, 30, 56, 88][i]!, 220, 40], [{ text: `9:41 Wallet ${size}`, font: 'SFPro-Semibold', size }]),
  ),
  'ellipse mask': [
    B.group('masked', [20, 30, 200, 100], [
      B.oval('ellipse', [0, 0, 200, 100], { mask: 0 }),
      ...[0, 1, 2, 3, 4].map((i) => B.rect(`band ${i}`, [i * 40, 0, 40, 100], { style: { fills: [B.fill([RED, BLUE, GREEN, YELLOW, INK][i]!)] } })),
      B.text('inside', [70, 40, 60, 20], [{ text: 'Inside', font: bold, size: 14, color: B.hex('#FFFFFF') }]),
    ]),
  ],
  'rich text': [
    B.text('rich', [16, 16, 208, 128], [
      { text: 'Pay like a local with ', font, size: 15 },
      { text: 'QR payments', font: bold, size: 15, color: RED },
      { text: ' across the region. Read the ', font, size: 15 },
      { text: 'terms', font, size: 15, color: BLUE, underline: true },
      { text: ' first.', font, size: 15 },
    ], { sizing: [0, 1], lineHeight: 22 }),
  ],
  'auto width centered': [
    B.text('center', [40, 30, 160, 24], [{ text: 'Centered title', font: bold, size: 20 }], { align: 2, sizing: [1, 1] }),
    B.text('right', [40, 80, 160, 24], [{ text: 'Right aligned', font, size: 18 }], { align: 1, sizing: [1, 1] }),
  ],
  // ---------------------------------------------------------------------------------------------- groups
  tint: [
    B.group('tinted', [20, 20, 200, 120], [
      B.path('stroke', [0, 0, 60, 60], [[0, 1], [0.5, 0], [1, 1]], false, { style: { borders: [B.border(INK, 4)] } }),
      B.oval('fill', [70, 0, 60, 60], { style: { fills: [B.fill(RED)] } }),
      B.rect('gradient', [140, 0, 60, 60], { style: { fills: [B.fill(RED, { gradient: B.gradient([[0, B.hex('#000000', 1)], [1, B.hex('#000000', 0.2)]]) })] } }),
      B.bitmap('image', [0, 70, 200, 50], IMG),
    ], { style: { fills: [B.fill(GREEN, { layeringType: 1 })] } }),
  ],
  'group opacity': [
    B.rect('bg', [0, 0, W, H], { style: { fills: [B.fill(B.hex('#FDE68A'))] } }),
    B.group('half', [40, 30, 160, 100], [B.rect('a', [0, 0, 100, 100], { style: { fills: [B.fill(RED)] } }), B.rect('b', [60, 0, 100, 100], { style: { fills: [B.fill(BLUE)] } })], { style: { opacity: 0.5 } }),
  ],
};

// A rectangle edited in Sketch: an extra point on the top edge, but still a rounded rectangle.
function editedRoundedRect(name: string, f: [number, number, number, number], r: number, o: B.LayerOptions = {}): J {
  const p = (x: number, y: number, radius: number) => ({ _class: 'curvePoint', cornerRadius: radius, cornerStyle: 0, curveFrom: `{${x}, ${y}}`, curveMode: 1, curveTo: `{${x}, ${y}}`, hasCurveFrom: false, hasCurveTo: false, point: `{${x}, ${y}}` });
  const l = B.rect(name, f, { ...o, style: { radii: [r], ...o.style } });
  return { ...l, edited: true, points: [p(0, 0, r), p(0.55, 0, 0), p(1, 0, r), p(1, 1, r), p(0, 1, r)] };
}

// Masks built from symbols: a striped tile reaching past a rounded mask, and a circle symbol used as a mask.
function maskSymbols(): { masters: J[]; boards: Record<string, J[]> } {
  const tile = B.symbolMaster('Tile', [300, -200, 120, 120], [
    ...[0, 1, 2].map((i) => B.rect(`t${i}`, [i * 40, 0, 40, 120], { style: { fills: [B.fill([RED, BLUE, GREEN][i]!)] } })),
  ]);
  // the circle scales with the instance (relative sizing, no pins), like the shapes in Apple's UI kits
  const circle = B.symbolMaster('Shape / Circle', [460, -200, 48, 48], [B.oval('Mask', [0, 0, 48, 48], { pins: [0, 0], sizing: [3, 3], style: { fills: [B.fill(B.hex('#E5E7EB'))] } })]);
  return {
    masters: [tile, circle],
    boards: {
      'edited rect mask': [
        B.group('card', [20, 20, 200, 120], [
          editedRoundedRect('mask', [0, 0, 200, 120], 32, { mask: 0, style: { fills: [B.fill(B.hex('#F3F4F6'))] } }),
          B.instance('tile', tile, [-20, -20, 120, 120]),
          B.instance('tile 2', tile, [120, 40, 120, 120]),
        ]),
      ],
      'instance mask': [
        B.group('flag', [70, 30, 100, 100], [
          B.instance('Shape', circle, [0, 0, 100, 100], [], { mask: 0 }),
          B.group('stripes', [-20, 0, 140, 100], [0, 1, 2, 3].map((i) => B.rect(`s${i}`, [0, i * 25, 140, 25], { style: { fills: [B.fill([RED, B.hex('#FFFFFF'), RED, BLUE][i]!)] } }))),
          B.text('label', [-10, 38, 120, 24], [{ text: 'FLAG FLAG', font: bold, size: 20, color: INK }]),
        ]),
      ],
    },
  };
}

// Symbols: a button with a stretching background, centred label and an icon pinned to the right.
function symbols(): { master: J; boards: Record<string, J[]> } {
  const bg = B.rect('bg', [0, 0, 120, 40], { pins: [5, 5], style: { fills: [B.fill(BLUE)], radii: [20] } });
  const label = B.text('label', [14, 11, 70, 18], [{ text: 'Button', font: bold, size: 14, color: B.hex('#FFFFFF') }], { sizing: [1, 1] }, { pins: [1, 0] });
  const icon = B.oval('icon', [92, 12, 16, 16], { pins: [4, 0], style: { fills: [B.fill(YELLOW)] } });
  const master = B.symbolMaster('Button', [0, 0, 120, 40], [bg, label, icon]);
  const id = (l: J) => String(l.do_objectID);
  return {
    master,
    boards: {
      'symbol instances': [
        B.instance('same', master, [10, 10, 120, 40]),
        B.instance('wider', master, [10, 60, 220, 40], [[`${id(label)}_stringValue`, 'Continue']]),
        B.instance('scaled', master, [140, 10, 60, 20], [], { scale: 0.5 }),
        B.instance('taller', master, [10, 110, 160, 48]),
      ],
    },
  };
}

// Stacks (Sketch 2025 auto layout)
function stacks(): Record<string, J[]> {
  const chip = (t: string) => B.frame(`chip ${t}`, [0, 0, 60, 24], [B.text('t', [8, 4, 44, 16], [{ text: t, font, size: 12 }], { sizing: [1, 1] })], { style: { fills: [B.fill(B.hex('#E5E7EB'))], radii: [12] } });
  const row = [chip('One'), chip('Two'), chip('Three')];
  row.forEach((c, i) => ((c.frame as { x: number }).x = 12 + i * 68));
  row.forEach((c) => ((c.frame as { y: number }).y = 12));
  const h = B.frame('row', [12, 20, 216, 48], [...row].reverse(), { stack: B.stack('h', 8), padding: [12, 12, 12, 12], style: { fills: [B.fill(B.hex('#F9FAFB'))] } });
  return { stacks: [h] };
}

export function buildLab(path: string): string[] {
  const sym = symbols();
  const masks = maskSymbols();
  const all: Record<string, J[]> = { ...cases, ...sym.boards, ...masks.boards, ...stacks() };
  const names = Object.keys(all);
  const cols = 6;
  const boards = names.map((name, i) => B.frame(name, [(i % cols) * (W + 40), Math.floor(i / cols) * (H + 60), W, H], all[name]!));
  const master = sym.master;
  (master.frame as { x: number }).x = 0;
  (master.frame as { y: number }).y = -200;
  B.writeDocument(path, [{ name: 'Lab', layers: boards }, { name: 'Symbols', layers: [master, ...masks.masters] }], { [IMG]: image });
  return names;
}

if (import.meta.main) {
  const out = process.argv[2] ?? 'lab.sketch';
  console.log(`${buildLab(out).length} lab artboards → ${out}`);
}
