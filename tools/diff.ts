// Pixel diff between Sketch reference renders and pen.dev exports (used by tools/compare.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

export interface Board {
  sketchId: string;
  penId: string;
  name: string;
}

export interface BoardScore {
  board: Board;
  /** percentage of pixels whose colour differs noticeably */
  differing: number;
  /** mean luminance of the difference (0–255) */
  mean: number;
  note: string;
}

interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

function readOverWhite(path: string): Image {
  const png = PNG.sync.read(readFileSync(path));
  const data = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    const a = png.data[i + 3]! / 255;
    data[j] = png.data[i]! * a + 255 * (1 - a);
    data[j + 1] = png.data[i + 1]! * a + 255 * (1 - a);
    data[j + 2] = png.data[i + 2]! * a + 255 * (1 - a);
  }
  return { width: png.width, height: png.height, data };
}

function resize(img: Image, width: number, height: number): Image {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / width));
      data.set(img.data.subarray((sy * img.width + sx) * 3, (sy * img.width + sx) * 3 + 3), (y * width + x) * 3);
    }
  }
  return { width, height, data };
}

const THRESHOLD = 40;

export function diffBoards(work: string, boards: Board[]): BoardScore[] {
  const diffDir = join(work, 'diff');
  mkdirSync(diffDir, { recursive: true });
  const scores: BoardScore[] = [];
  for (const board of boards) {
    const refPath = join(work, 'ref', `${board.sketchId}@2x.png`);
    const penPath = join(work, 'pen', `${board.penId}.png`);
    if (!existsSync(refPath) || !existsSync(penPath)) {
      scores.push({ board, differing: Number.NaN, mean: Number.NaN, note: existsSync(penPath) ? 'missing Sketch render' : 'missing pen.dev export' });
      continue;
    }
    const ref = readOverWhite(refPath);
    let pen = readOverWhite(penPath);
    let note = '';
    if (pen.width !== ref.width || pen.height !== ref.height) {
      note = `size ${pen.width}×${pen.height} ≠ ${ref.width}×${ref.height}`;
      pen = resize(pen, ref.width, ref.height);
    }
    const heat = new PNG({ width: ref.width, height: ref.height });
    let bad = 0;
    let sum = 0;
    for (let p = 0, i = 0; p < ref.width * ref.height; p++, i += 3) {
      const d = 0.299 * Math.abs(ref.data[i]! - pen.data[i]!) + 0.587 * Math.abs(ref.data[i + 1]! - pen.data[i + 1]!) + 0.114 * Math.abs(ref.data[i + 2]! - pen.data[i + 2]!);
      sum += d;
      if (d > THRESHOLD) bad++;
      const g = ref.data[i]! * 0.3 + ref.data[i + 1]! * 0.59 + ref.data[i + 2]! * 0.11;
      heat.data[p * 4] = d > THRESHOLD ? 230 : g * 0.4 + 150;
      heat.data[p * 4 + 1] = d > THRESHOLD ? 30 : g * 0.4 + 150;
      heat.data[p * 4 + 2] = d > THRESHOLD ? 30 : g * 0.4 + 150;
      heat.data[p * 4 + 3] = 255;
    }
    writeFileSync(join(diffDir, `${board.penId}.png`), PNG.sync.write(heat));
    const total = ref.width * ref.height;
    scores.push({ board, differing: (bad / total) * 100, mean: sum / total, note });
  }
  scores.sort((a, b) => (Number.isNaN(b.differing) ? 999 : b.differing) - (Number.isNaN(a.differing) ? 999 : a.differing));
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const rows = scores
    .map(
      (s) =>
        `<section><h3>${esc(s.board.name)} — ${Number.isNaN(s.differing) ? '–' : s.differing.toFixed(2)} % of pixels differ <small>${esc(s.note)}</small></h3>` +
        `<div class="row"><img src="ref/${s.board.sketchId}@2x.png" loading="lazy"><img src="pen/${s.board.penId}.png" loading="lazy"><img src="diff/${s.board.penId}.png" loading="lazy"></div></section>`,
    )
    .join('');
  writeFileSync(
    join(work, 'compare.html'),
    `<!doctype html><meta charset=utf-8><title>Sketch vs pen.dev</title><style>body{font:14px -apple-system,sans-serif;margin:16px;background:#f5f5f4}` +
      `.row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.row img{width:100%;border:1px solid #ddd;background:#fff}section{margin-bottom:32px}h3{font-size:15px}small{color:#888}</style>` +
      `<h1>Sketch (left) · pen.dev (middle) · difference (right)</h1>${rows}`,
  );
  return scores;
}

export function summary(scores: BoardScore[]): string {
  const valid = scores.filter((s) => !Number.isNaN(s.differing)).map((s) => s.differing).sort((a, b) => a - b);
  const median = valid.length ? valid[Math.floor(valid.length / 2)]! : 0;
  const lines = [`${valid.length} compared, median ${median.toFixed(2)} % of pixels differ`];
  for (const s of scores.slice(0, 15)) lines.push(`  ${Number.isNaN(s.differing) ? '     –' : s.differing.toFixed(2).padStart(6)} %  ${s.board.name}  ${s.note}`);
  return lines.join('\n');
}
