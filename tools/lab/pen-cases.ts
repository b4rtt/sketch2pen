// Feature lab for pen.dev → Sketch: a pen.dev document with one frame per pen.dev feature. `bun run lab:pen` converts
// it, renders every frame with pen.dev (ground truth) and Sketch, and writes a pixel-diff report.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PenDocument, PenNode } from '../../src/pen/types.ts';
import { png } from '../../src/sketch/builder.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lab documents use loosely typed nodes (variables, themes)
type N = Record<string, any>;

let seq = 0;
const id = (p = 'n') => `${p}${(seq++).toString(36)}`;

const W = 240;
const H = 160;

function frame(name: string, children: N[], o: Partial<N> = {}): N {
  return { type: 'frame', id: id('f'), name, width: W, height: H, layout: 'none', fill: '#FFFFFF', clip: true, children, ...o } as N;
}
const rect = (o: Partial<N>): N => ({ type: 'rectangle', id: id('r'), x: 20, y: 20, width: 80, height: 60, fill: '#3B82F6', ...o }) as N;
const ellipse = (o: Partial<N>): N => ({ type: 'ellipse', id: id('e'), x: 20, y: 20, width: 80, height: 60, fill: '#F59E0B', ...o }) as N;
const text = (content: string, o: Partial<N> = {}): N => ({ type: 'text', id: id('t'), x: 16, y: 16, content, fontFamily: 'Inter', fontSize: 16, fill: '#111827', ...o }) as N;
const path = (geometry: string, o: Partial<N>): N => ({ type: 'path', id: id('p'), x: 20, y: 20, width: 80, height: 80, geometry, fill: '#10B981', ...o }) as N;

export function penCases(imageUrl: string): N[] {
  const grad = (o: Record<string, unknown>) => ({ type: 'gradient', gradientType: 'linear', colors: [{ color: '#EF4444', position: 0 }, { color: '#3B82F6', position: 1 }], ...o });
  const cases: N[] = [
    frame('Fills: solid, radius', [rect({ cornerRadius: 12 }), rect({ x: 120, cornerRadius: [0, 8, 16, 24], fill: '#EC4899' }), rect({ y: 96, height: 40, width: 200, fill: '#22C55E80' })]),
    frame('Linear gradients', [
      rect({ x: 10, y: 10, width: 100, height: 60, fill: grad({}) }),
      rect({ x: 130, y: 10, width: 100, height: 60, fill: grad({ rotation: 90 }) }),
      rect({ x: 10, y: 90, width: 100, height: 60, fill: grad({ rotation: 45 }) }),
      rect({ x: 130, y: 90, width: 100, height: 60, fill: grad({ rotation: 200, center: { x: 0.3, y: 0.6 }, size: { height: 0.6 } }) }),
    ]),
    frame('Radial gradients', [
      rect({ x: 10, y: 20, width: 100, height: 120, fill: grad({ gradientType: 'radial' }) }),
      rect({ x: 130, y: 20, width: 100, height: 120, fill: grad({ gradientType: 'radial', center: { x: 0.3, y: 0.4 }, size: { width: 1.4, height: 0.6 }, rotation: 30 }) }),
    ]),
    frame('Angular gradients', [
      ellipse({ x: 10, y: 20, width: 100, height: 100, fill: { type: 'gradient', gradientType: 'angular', colors: [{ color: '#EF4444', position: 0 }, { color: '#22C55E', position: 0.5 }, { color: '#3B82F6', position: 1 }] } }),
      ellipse({ x: 130, y: 20, width: 100, height: 100, fill: { type: 'gradient', gradientType: 'angular', rotation: 45, colors: [{ color: '#F59E0B', position: 0 }, { color: '#8B5CF6', position: 1 }] } }),
    ]),
    frame('Multiple fills, opacity, blend', [
      rect({ x: 10, y: 10, width: 140, height: 100, fill: ['#0EA5E9', grad({ colors: [{ color: '#FFFFFF00', position: 0 }, { color: '#00000099', position: 1 }] })] }),
      ellipse({ x: 90, y: 50, width: 100, height: 100, fill: { type: 'color', color: '#F43F5E', blendMode: 'multiply' } }),
      rect({ x: 170, y: 10, width: 50, height: 50, fill: '#111827', opacity: 0.4 }),
    ]),
    frame('Image fills', [
      rect({ x: 10, y: 20, width: 70, height: 110, fill: { type: 'image', url: imageUrl, mode: 'fill' } }),
      rect({ x: 85, y: 20, width: 70, height: 110, fill: { type: 'image', url: imageUrl, mode: 'fit' } }),
      rect({ x: 160, y: 20, width: 70, height: 110, cornerRadius: 16, fill: { type: 'image', url: imageUrl, mode: 'stretch' } }),
    ]),
    frame('Stroke alignment', [
      rect({ x: 20, y: 40, width: 50, height: 50, fill: '#E5E7EB', stroke: '#111827', strokeWidth: 6, strokeAlignment: 'inner' }),
      rect({ x: 95, y: 40, width: 50, height: 50, fill: '#E5E7EB', stroke: '#111827', strokeWidth: 6 }),
      rect({ x: 170, y: 40, width: 50, height: 50, fill: '#E5E7EB', stroke: '#111827', strokeWidth: 6, strokeAlignment: 'outer', cornerRadius: 10 }),
    ]),
    frame('Strokes on shapes', [
      ellipse({ x: 20, y: 30, width: 60, height: 60, fill: '#FDE68A', stroke: '#B45309', strokeWidth: 4 }),
      path('M0 40 C20 0 60 0 80 40 S140 80 160 40', { x: 60, y: 90, width: 160, height: 40, fill: undefined, stroke: '#1D4ED8', strokeWidth: 6, strokeLinecap: 'round' }),
      path('M0 0 L40 30 L80 0', { x: 120, y: 20, width: 80, height: 30, fill: undefined, stroke: { type: 'gradient', gradientType: 'linear', rotation: 90, colors: [{ color: '#DC2626', position: 0 }, { color: '#7C3AED', position: 1 }] }, strokeWidth: 8, strokeLinejoin: 'round' }),
    ]),
    frame('Per-side strokes', [
      { type: 'frame', id: id('f'), name: 'Header', x: 0, y: 0, width: W, height: 48, layout: 'none', fill: '#F3F4F6', stroke: '#9CA3AF', strokeWidth: { bottom: 2 }, strokeAlignment: 'inner', children: [] } as N,
      rect({ x: 40, y: 80, width: 160, height: 50, fill: '#FFFFFF', stroke: '#2563EB', strokeWidth: { top: 4, left: 2 }, strokeAlignment: 'inner' }),
    ]),
    frame('Shadows', [
      rect({ x: 20, y: 30, width: 80, height: 80, fill: '#FFFFFF', cornerRadius: 12, effect: [{ type: 'shadow', shadowType: 'outer', color: '#0000003D', offset: { x: 0, y: 8 }, blur: 16 }, { type: 'shadow', shadowType: 'outer', color: '#0000001A', offset: { x: 0, y: 1 }, blur: 2 }] }),
      rect({ x: 140, y: 30, width: 80, height: 80, fill: '#DBEAFE', cornerRadius: 12, effect: { type: 'shadow', shadowType: 'inner', color: '#1E40AF80', offset: { x: 4, y: 4 }, blur: 8 } }),
    ], { fill: '#F9FAFB' }),
    frame('Blurs', [
      rect({ x: 10, y: 10, width: 220, height: 40, fill: grad({ rotation: 90 }) }),
      ellipse({ x: 30, y: 60, width: 60, height: 60, fill: '#16A34A', effect: { type: 'blur', radius: 8 } }),
      rect({ x: 120, y: 30, width: 100, height: 100, fill: '#FFFFFF66', effect: { type: 'background_blur', radius: 20 } }),
    ]),
    frame('Ellipse arcs', [
      ellipse({ x: 10, y: 40, width: 60, height: 60, startAngle: 0, sweepAngle: 270 }),
      ellipse({ x: 90, y: 40, width: 60, height: 60, innerRadius: 0.6, fill: '#6366F1' }),
      ellipse({ x: 170, y: 40, width: 60, height: 60, innerRadius: 0.5, startAngle: 90, sweepAngle: -200, fill: '#EF4444' }),
    ]),
    frame('Polygons', [
      { type: 'polygon', id: id('pg'), x: 10, y: 40, width: 60, height: 60, polygonCount: 3, fill: '#0EA5E9' } as N,
      { type: 'polygon', id: id('pg'), x: 90, y: 40, width: 60, height: 60, polygonCount: 5, fill: '#F97316' } as N,
      { type: 'polygon', id: id('pg'), x: 170, y: 40, width: 60, height: 60, polygonCount: 6, cornerRadius: 8, fill: '#84CC16' } as N,
    ]),
    frame('Paths', [
      path('M50 0 L61 35 L98 35 L68 57 L79 91 L50 70 L21 91 L32 57 L2 35 L39 35 Z', { x: 10, y: 30, width: 100, height: 92 }),
      path('M0 0 H100 V100 H0 Z M25 25 V75 H75 V25 Z', { x: 130, y: 20, width: 50, height: 50, fillRule: 'evenodd', fill: '#7C3AED' }),
      path('M10 80 Q 52.5 10, 95 80 T 180 80', { x: 120, y: 80, width: 110, height: 50, fill: '#FDE047', stroke: '#854D0E', strokeWidth: 2 }),
      path('M 10 10 A 30 20 0 1 0 60 40', { x: 190, y: 20, width: 40, height: 40, viewBox: [0, 0, 70, 70], fill: undefined, stroke: '#0F172A', strokeWidth: 3 }),
    ]),
    frame('Rotation and flips', [
      rect({ x: 30, y: 30, width: 60, height: 30, rotation: 30, fill: '#14B8A6' }),
      path('M0 0 L60 0 L60 40 Z', { x: 110, y: 20, width: 60, height: 40, flipX: true, fill: '#E11D48' }),
      path('M0 0 L60 0 L60 40 Z', { x: 110, y: 90, width: 60, height: 40, flipY: true, rotation: 20, fill: '#2563EB' }),
      { type: 'group', id: id('g'), x: 180, y: 60, rotation: -25, children: [rect({ x: 0, y: 0, width: 40, height: 20, fill: '#A855F7' }), ellipse({ x: 10, y: 25, width: 20, height: 20, fill: '#F59E0B' })] } as N,
    ]),
    frame('Text: sizes and weights', [
      text('Regular 12', { fontSize: 12, y: 12 }),
      text('Medium 16', { fontSize: 16, fontWeight: '500', y: 34 }),
      text('Semibold 20', { fontSize: 20, fontWeight: '600', y: 60 }),
      text('Bold 28', { fontSize: 28, fontWeight: '700', y: 92 }),
      text('Italic', { fontSize: 18, fontStyle: 'italic', x: 150, y: 36 }),
      text('Black', { fontSize: 22, fontWeight: '900', x: 150, y: 96 }),
    ]),
    frame('Text: alignment', [
      { ...text('Left aligned text', { textGrowth: 'fixed-width', width: 208, y: 12 }) },
      { ...text('Centred text', { textGrowth: 'fixed-width', width: 208, y: 40, textAlign: 'center' }) },
      { ...text('Right aligned', { textGrowth: 'fixed-width', width: 208, y: 68, textAlign: 'right' }) },
      { type: 'rectangle', id: id('r'), x: 16, y: 96, width: 208, height: 52, fill: '#F3F4F6' } as N,
      { ...text('Bottom right', { textGrowth: 'fixed-width-height', width: 208, height: 52, y: 96, textAlign: 'right', textAlignVertical: 'bottom' }) },
    ]),
    frame('Text: wrapping, spacing', [
      text('The quick brown fox jumps over the lazy dog, again and again.', { textGrowth: 'fixed-width', width: 120, fontSize: 13, lineHeight: 1.5 }),
      text('SPACED', { x: 150, y: 20, fontSize: 14, letterSpacing: 3, fontWeight: '600' }),
      text('Tight', { x: 150, y: 60, fontSize: 24, letterSpacing: -1 }),
      text('Line one\nLine two\nLine three', { x: 150, y: 96, fontSize: 12 }),
    ]),
    frame('Text: Google fonts', [
      text('Roboto 16', { fontFamily: 'Roboto', y: 12 }),
      text('Poppins Medium', { fontFamily: 'Poppins', fontWeight: '500', y: 40 }),
      text('DM Sans optical', { fontFamily: 'DM Sans', fontSize: 20, y: 68 }),
      text('Playfair italic', { fontFamily: 'Playfair Display', fontStyle: 'italic', fontSize: 20, y: 100 }),
    ]),
    frame('Text: decoration and fills', [
      text('Underlined', { y: 20, underline: true }),
      text('Struck through', { y: 50, strikethrough: true }),
      text('Gradient', { y: 84, fontSize: 36, fontWeight: '800', fill: grad({ rotation: 90 }) }),
    ]),
    frame('Flex: horizontal', [
      {
        type: 'frame', id: id('f'), name: 'Row', x: 12, y: 50, layout: 'horizontal', gap: 8, padding: [8, 12], alignItems: 'center', fill: '#E0E7FF', cornerRadius: 8,
        children: [rect({ width: 24, height: 24, fill: '#4F46E5' }), text('Label'), rect({ width: 40, height: 12, fill: '#818CF8' })],
      } as N,
    ]),
    frame('Flex: vertical, fill', [
      {
        type: 'frame', id: id('f'), name: 'Column', x: 12, y: 12, width: 216, height: 136, layout: 'vertical', gap: 6, padding: 10, justifyContent: 'space_between', fill: '#ECFDF5',
        children: [
          { ...text('Title', { fontWeight: '600' }) },
          rect({ width: 'fill_container', height: 20, fill: '#34D399' }),
          { type: 'frame', id: id('f'), name: 'Buttons', width: 'fill_container', layout: 'horizontal', gap: 6, children: [rect({ width: 'fill_container', height: 28, fill: '#059669', cornerRadius: 6 }), rect({ width: 'fill_container', height: 28, fill: '#A7F3D0', cornerRadius: 6 })] } as N,
        ],
      } as N,
    ]),
    frame('Flex: wrapping text, absolute child', [
      {
        type: 'frame', id: id('f'), name: 'Card', x: 16, y: 16, width: 208, layout: 'vertical', gap: 4, padding: 12, fill: '#FFF7ED', stroke: '#FDBA74', strokeWidth: 1, cornerRadius: 10,
        children: [
          text('Card title', { fontWeight: '700', fontSize: 15 }),
          text('A longer description that wraps onto a second line inside the card.', { width: 'fill_container', textGrowth: 'fixed-width', fontSize: 12, fill: '#9A3412' }),
          { type: 'ellipse', id: id('e'), layoutPosition: 'absolute', x: 184, y: -6, width: 16, height: 16, fill: '#EA580C' } as N,
        ],
      } as N,
    ]),
    frame('Flex: hidden child, default layout', [
      { type: 'frame', id: id('f'), name: 'Default horizontal', x: 12, y: 20, fill: '#FEF3C7', children: [rect({ width: 30, height: 30 }), rect({ width: 30, height: 30, enabled: false, fill: '#000000' }), rect({ width: 30, height: 50, fill: '#F59E0B' })] } as N,
      { type: 'frame', id: id('f'), name: 'Centred', x: 120, y: 20, width: 100, height: 100, layout: 'vertical', justifyContent: 'center', alignItems: 'center', fill: '#FCE7F3', children: [ellipse({ width: 40, height: 40, fill: '#DB2777' })] } as N,
    ]),
    frame('Groups', [
      { type: 'group', id: id('g'), name: 'Badge', x: 40, y: 40, effect: { type: 'shadow', shadowType: 'outer', color: '#00000040', offset: { x: 0, y: 4 }, blur: 8 }, children: [rect({ x: 0, y: 0, width: 100, height: 40, cornerRadius: 20, fill: '#0F172A' }), text('Group', { x: 26, y: 10, fill: '#FFFFFF' })] } as N,
      { type: 'frame', id: id('f'), name: 'Row with group', x: 20, y: 100, layout: 'horizontal', gap: 10, children: [rect({ width: 20, height: 20 }), { type: 'group', id: id('g'), children: [ellipse({ x: 0, y: 0, width: 20, height: 20 }), ellipse({ x: 10, y: 10, width: 20, height: 20, fill: '#10B981' })] } as N] } as N,
    ]),
  ];
  return cases;
}

/** Components with instances (overrides, a swap, a resized instance) and themed variables. */
export function componentCases(): { components: N[]; frames: N[]; variables: PenDocument['variables']; themes: PenDocument['themes'] } {
  const label = id('label');
  const iconSlot = id('icon');
  const button: N = {
    type: 'frame', id: 'cButton', name: 'Button', reusable: true, x: 0, y: 0, layout: 'horizontal', gap: 8, padding: [10, 16], alignItems: 'center', fill: '$primary', cornerRadius: 8,
    children: [{ type: 'ellipse', id: iconSlot, width: 14, height: 14, fill: '$on-primary' } as N, { type: 'text', id: label, content: 'Button', fontFamily: 'Inter', fontSize: 14, fontWeight: '600', fill: '$on-primary' } as N],
  } as N;
  const tag: N = { type: 'frame', id: 'cTag', name: 'Tag', reusable: true, x: 0, y: 0, width: 60, height: 24, layout: 'none', fill: '#FEE2E2', cornerRadius: 12, children: [{ type: 'text', id: id('tl'), x: 14, y: 4, content: 'Tag', fontFamily: 'Inter', fontSize: 12, fill: '#991B1B' } as N] } as N;
  const dot: N = { type: 'ellipse', id: 'cDot', name: 'Dot', reusable: true, x: 0, y: 0, width: 14, height: 14, fill: '#22C55E' } as N;
  const dot2: N = { type: 'ellipse', id: 'cDot2', name: 'Dot red', reusable: true, x: 0, y: 0, width: 14, height: 14, fill: '#EF4444' } as N;
  const card: N = {
    type: 'frame', id: 'cCard', name: 'Status', reusable: true, x: 0, y: 0, width: 200, height: 40, layout: 'horizontal', gap: 8, padding: [0, 12], alignItems: 'center', fill: '#F8FAFC', stroke: '#CBD5E1', strokeWidth: 1,
    children: [{ type: 'ref', id: 'statusDot', ref: 'cDot' } as N, { type: 'text', id: 'statusText', content: 'Online', fontFamily: 'Inter', fontSize: 13, fill: '#0F172A' } as N],
  } as N;
  const comps = [button, tag, dot, dot2, card];
  let x = 0;
  for (const c of comps) {
    c.x = x;
    c.y = 0;
    x += 260;
  }
  const inst = (ref: string, o: Partial<N> = {}): N => ({ type: 'ref', id: id('i'), ref, x: 16, y: 16, ...o }) as N;
  const frames = [
    frame('Instances', [
      inst('cButton', { x: 16, y: 16 }),
      inst('cButton', { x: 16, y: 64, descendants: { [label]: { content: 'Longer label' } } }),
      inst('cButton', { x: 16, y: 112, descendants: { [label]: { content: 'Save' }, [iconSlot]: { enabled: false } } }),
      inst('cTag', { x: 160, y: 20 }),
      inst('cTag', { x: 160, y: 60, descendants: { [String((tag.children as N[])[0]!.id)]: { content: 'New', fill: '#1D4ED8' } } }),
      inst('cTag', { x: 160, y: 100, fill: '#DBEAFE' }),
    ]),
    frame('Nested instances', [
      inst('cCard', { x: 20, y: 20 }),
      inst('cCard', { x: 20, y: 70, descendants: { statusText: { content: 'Offline' }, statusDot: { type: 'ref', ref: 'cDot2', id: 'statusDot' } } }),
      inst('cCard', { x: 20, y: 120, width: 160, descendants: { statusText: { content: 'Narrow' } } }),
    ]),
    frame('Themes', [
      { type: 'frame', id: id('f'), name: 'Light', x: 10, y: 10, width: 105, height: 140, layout: 'vertical', padding: 12, gap: 8, fill: '$surface', children: [text('Light', { fill: '$text', x: 0, y: 0 }), inst('cButton', { x: 0, y: 0 })] } as N,
      { type: 'frame', id: id('f'), name: 'Dark', x: 125, y: 10, width: 105, height: 140, layout: 'vertical', padding: 12, gap: 8, fill: '$surface', theme: { mode: 'dark' }, children: [text('Dark', { fill: '$text', x: 0, y: 0 }), inst('cButton', { x: 0, y: 0 })] } as N,
    ]),
  ];
  return {
    components: comps,
    frames,
    themes: { mode: ['light', 'dark'] },
    variables: {
      primary: { type: 'color', value: [{ value: '#2563EB' }, { value: '#60A5FA', theme: { mode: 'dark' } }] },
      'on-primary': { type: 'color', value: [{ value: '#FFFFFF' }, { value: '#0B1220', theme: { mode: 'dark' } }] },
      surface: { type: 'color', value: [{ value: '#F8FAFC' }, { value: '#0F172A', theme: { mode: 'dark' } }] },
      text: { type: 'color', value: [{ value: '#0F172A' }, { value: '#F8FAFC', theme: { mode: 'dark' } }] },
    },
  };
}

export function iconCases(): N[] {
  const icon = (library: string, name: string, x: number, o: Partial<N> = {}): N => ({ type: 'icon', id: id('ic'), library, icon: name, x, y: 60, width: 32, height: 32, fill: '#111827', ...o }) as N;
  return [frame('Icons', [icon('lucide', 'house', 16), icon('feather', 'camera', 64), icon('Material Symbols Outlined', 'favorite', 112, { fill: '#DC2626' }), icon('Material Symbols Rounded', 'settings', 160, { weight: 600 }), icon('phosphor', 'airplane', 200, { width: 24, height: 24 })])];
}

/** Writes the lab document (and its image) and returns the path of the .pen file. */
export function buildPenLab(dir: string): { file: string; frames: number } {
  seq = 0;
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets/photo.png'), png(120, 80, (x, y) => [Math.round((x / 120) * 255), Math.round((y / 80) * 200), 160, 255]));
  const frames = [...penCases('./assets/photo.png'), ...iconCases()];
  const comp = componentCases();
  frames.push(...comp.frames);
  const children: N[] = [];
  // components in a row at the top, feature frames in a grid below
  children.push(...comp.components);
  frames.forEach((f, i) => {
    f.x = (i % 6) * (W + 40);
    f.y = 200 + Math.floor(i / 6) * (H + 60);
    children.push(f);
  });
  const doc: PenDocument = { version: '2.19', themes: comp.themes, variables: comp.variables, children: children as PenNode[] };
  const file = join(dir, 'pen-lab.pen');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 1));
  return { file, frames: frames.length };
}
