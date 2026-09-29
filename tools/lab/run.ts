// Feature lab: builds a Sketch file with one artboard per Sketch feature, renders it with Sketch (ground truth)
// and pen.dev, and writes a pixel-diff report. Needs Sketch and pen.dev installed.
//
//   bun tools/lab/run.ts <workdir> [--smooth-corners]
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildLab } from './cases.ts';

const work = resolve(process.argv[2] ?? 'lab-output');
mkdirSync(work, { recursive: true });
const file = join(work, 'lab.sketch');
console.log(`${buildLab(file).length} lab artboards → ${file}`);
const r = spawnSync('bun', [join(import.meta.dir, '../compare.ts'), file, join(work, 'compare'), ...process.argv.slice(3)], { stdio: 'inherit' });
process.exit(r.status ?? 0);
