// Feature lab for pen.dev → Sketch: builds a pen.dev document with one frame per feature, converts it, renders every
// frame with pen.dev (ground truth) and Sketch, and writes a pixel-diff report. Needs pen.dev and Sketch installed.
//
//   bun tools/lab/pen-run.ts [workdir]
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPenLab } from './pen-cases.ts';

const work = resolve(process.argv[2] ?? 'lab-output/pen');
mkdirSync(work, { recursive: true });
const { file, frames } = buildPenLab(join(work, 'doc'));
console.log(`${frames} lab frames → ${file}`);
const r = spawnSync('bun', [join(import.meta.dir, '../compare-pen.ts'), file, join(work, 'compare'), ...process.argv.slice(3)], { stdio: 'inherit' });
process.exit(r.status ?? 0);
