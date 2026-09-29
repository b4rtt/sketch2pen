// Converts the feature-lab document (tools/lab/cases.ts) and checks how each emulated feature is represented.
// Rendering fidelity itself is verified with `bun run lab` on a Mac with Sketch and pen.dev.
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertSketch, type ConvertResult } from '../src/convert/document.ts';
import type { PenNode } from '../src/pen/types.ts';
import { readSketch } from '../src/sketch/reader.ts';
import { decodeImage } from '../src/util/image.ts';
import { buildLab } from '../tools/lab/cases.ts';
import { makeLegacy } from '../tools/lab/legacy.ts';
import { allNodes, checkInvariants } from './invariants.ts';

let result: ConvertResult;
const board = (name: string): PenNode => result.doc.children.find((n) => n.name === name)!;
const inBoard = (name: string) => allNodes({ children: [board(name)] });

// the first conversion may build the CoreText helper and index the installed fonts
beforeAll(async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sketch2pen-lab-')), 'lab.sketch');
  buildLab(path);
  result = await convertSketch(readSketch(path), { flexLayout: true, assetsDir: 'assets', pages: [] });
}, 120_000);

describe('feature lab document', () => {
  test('is a valid pen.dev document', () => {
    checkInvariants(result.doc);
  });

  test('dashed borders become filled dash outlines', () => {
    const dashes = inBoard('dashed borders').filter((n) => n.name?.endsWith('(dashed border)'));
    expect(dashes.length).toBe(4);
    for (const d of dashes) expect(d.geometry!.match(/M/g)!.length).toBeGreaterThan(3);
  });

  test('line markers are drawn', () => {
    expect(inBoard('line markers').filter((n) => n.name?.endsWith('(line ends)')).length).toBe(4);
  });

  test('several borders keep their own widths', () => {
    const multi = inBoard('border positions').filter((n) => n.name?.startsWith('multi'));
    expect(multi.map((n) => n.strokeWidth)).toEqual([8, 3]);
  });

  test('shadow spread is emulated with a shape behind the layer', () => {
    const nodes = inBoard('drop shadows');
    expect(nodes.filter((n) => n.name?.endsWith('(shadow)')).map((n) => n.name)).toEqual(['s2 (shadow)', 's3 (shadow)']);
  });

  test('angular gradients start at 3 o’clock like in Sketch', () => {
    const g = inBoard('gradient angular').find((n) => n.name === 'g')!;
    expect(g.fill).toMatchObject({ type: 'gradient', gradientType: 'angular', rotation: -90 });
  });

  test('an image under a path mask is clipped exactly', () => {
    const photo = inBoard('path mask over image').find((n) => n.name === 'photo')!;
    expect(photo.type).toBe('path');
    expect(photo.fill).toMatchObject({ type: 'image' });
  });

  test('an alpha mask is baked into the image', () => {
    const baked = [...result.ctx.assets.values()].find((a) => a.source.startsWith('generated/'));
    expect(baked).toBeDefined();
    const img = decodeImage(result.ctx.sketch.files.get(baked!.source)!)!;
    const alpha = (y: number) => img.data[(y * img.width + Math.floor(img.width / 2)) * 4 + 3]!;
    expect(alpha(1)).toBeGreaterThan(200);
    expect(alpha(img.height - 2)).toBeLessThan(40);
  });

  test('paragraph spacing becomes a gap between paragraphs', () => {
    const p = inBoard('paragraph spacing').find((n) => n.name === 'paragraphs')!;
    expect(p.type).toBe('frame');
    expect(p.gap).toBe(12);
    expect(p.children!.length).toBe(3);
  });

  test('flipped and rotated groups use pen.dev’s transform order', () => {
    const g = inBoard('rotation and flips').find((n) => n.name === 'rot+flip')!;
    expect(g.flipY).toBe(true);
    expect(g.rotation).toBe(-20);
  });

  test('underline and strikethrough are drawn as shapes (macOS) or reported', () => {
    const decorated = [...inBoard('decorations'), ...inBoard('decorations wrapped')].filter((n) => / \((underline|strikethrough)\)$/.test(n.name ?? ''));
    if (!result.ctx.coreText) {
      expect(decorated.length).toBe(0);
      expect(result.ctx.report.warnings.some((w) => w.code === 'text-decoration')).toBe(true);
      return;
    }
    expect(decorated.map((n) => n.name).sort()).toEqual(['old price (strikethrough)', 'strike (strikethrough)', 'underline (underline)', 'underlined paragraph (underline)']);
    // one stretch per wrapped line, in the text colour
    const paragraph = decorated.find((n) => n.name === 'underlined paragraph (underline)')!;
    expect(paragraph.geometry!.match(/M/g)!.length).toBe(2); // Sketch wraps it into two lines
    expect(paragraph.fill).toBe('#3B82F6');
    expect(result.ctx.report.warnings.some((w) => w.code === 'text-decoration')).toBe(false);
  });

  test('masks keep their exact outline where pen.dev can clip with frames', () => {
    expect(inBoard('edited rect mask').find((n) => n.name === 'mask (mask)')).toMatchObject({ type: 'frame', clip: true, cornerRadius: 32 });
    // the circle symbol scales with the instance used as a mask
    expect(inBoard('instance mask').find((n) => n.name === 'Shape (mask)')).toMatchObject({ clip: true, cornerRadius: 50, width: 100, height: 100 });
    // an ellipse: pill-shaped frame, shapes cut to the ellipse
    const ellipse = inBoard('ellipse mask');
    expect(ellipse.find((n) => n.name === 'ellipse (mask)')).toMatchObject({ clip: true, cornerRadius: 50 });
    expect(ellipse.filter((n) => n.name?.startsWith('band')).every((n) => n.type === 'path')).toBe(true);
    expect(result.ctx.report.warnings.some((w) => w.code === 'path-mask')).toBe(false);
  });

  test('fonts pen.dev cannot load are shipped with the document or substituted', () => {
    const fonts = result.ctx.fonts;
    const helvetica = [...fonts.used.values()].find((f) => f.originalFamily.startsWith('Helvetica'));
    expect(helvetica).toBeDefined();
    if (process.platform === 'darwin') expect(helvetica!.source).toBe('local');
    else expect(helvetica!.family).toBe('Arimo');
  });
});

describe('feature lab in the pre-2025 document format', () => {
  let legacy: ConvertResult;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sketch2pen-legacy-'));
    buildLab(join(dir, 'lab.sketch'));
    makeLegacy(join(dir, 'lab.sketch'), join(dir, 'legacy.sketch'));
    legacy = await convertSketch(readSketch(join(dir, 'legacy.sketch')), { flexLayout: true, assetsDir: 'assets', pages: [] });
  }, 120_000);

  test('is a valid pen.dev document', () => {
    checkInvariants(legacy.doc);
  });

  test('artboards become clipping frames with their background colour', () => {
    const board = legacy.doc.children.find((n) => n.name === 'tint')!;
    expect(board.type).toBe('frame');
    expect(board.clip).toBe(true);
    expect(board.fill).toBe('#FFFFFF');
  });

  test('a fill on a group is its tint', () => {
    const board = legacy.doc.children.find((n) => n.name === 'tint')!;
    const oval = allNodes({ children: [board] }).find((n) => n.name === 'fill')!;
    expect(oval.fill).toBe('#10B981');
  });

  test('inner shadows and blurs from the old style lists are converted', () => {
    const inner = legacy.doc.children.find((n) => n.name === 'inner shadows')!;
    expect(allNodes({ children: [inner] }).find((n) => n.name === 'i1')!.strokeWidth).toEqual({ top: 4 });
    const blur = legacy.doc.children.find((n) => n.name === 'blur gaussian')!;
    expect(allNodes({ children: [blur] }).find((n) => n.name === 'r12')!.effect).toMatchObject({ type: 'blur' });
  });
});
