// Fidelity check for pen.dev → Sketch: converts a .pen file, renders every top-level frame with pen.dev (via its MCP
// server) and Sketch (sketchtool), and writes a side-by-side pixel diff report.
//
//   bun tools/compare-pen.ts <file.pen> <workdir> [--limit N] [--no-symbols] [--no-stacks]
//
// pen.dev renders a temporary copy of the document next to the original (relative image urls keep working); the
// copy is removed afterwards.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readPen } from '../src/pen/reader.ts';
import { convertPen } from '../src/pen2sketch/document.ts';
import { penConsoleSummary } from '../src/pen2sketch/summary.ts';
import { zipDocument } from '../src/sketch/builder.ts';
import { diffBoards, summary, type Board } from './diff.ts';
import { PenMcp } from './pen-mcp.ts';

const SKETCHTOOL = process.env.SKETCHTOOL ?? '/Applications/Sketch.app/Contents/MacOS/sketchtool';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { limit: { type: 'string' }, 'no-symbols': { type: 'boolean' }, 'no-stacks': { type: 'boolean' }, 'skip-pen': { type: 'boolean' } },
});
if (positionals.length < 2) {
  console.error('usage: bun tools/compare-pen.ts <file.pen> <workdir> [--limit N] [--no-symbols] [--no-stacks] [--skip-pen]');
  process.exit(1);
}
const input = resolve(positionals[0]!);
const work = resolve(positionals[1]!);
mkdirSync(work, { recursive: true });

const started = performance.now();
const pen = readPen(input);
const result = await convertPen(pen, { symbols: !values['no-symbols'], stacks: !values['no-stacks'] });
const sketchFile = join(work, `${basename(input, '.pen')}.sketch`);
writeFileSync(sketchFile, zipDocument(result.files));
console.log(penConsoleSummary(result, sketchFile, (performance.now() - started) / 1000));

const visible = new Set(pen.doc.children.filter((c) => c.enabled !== false && (c.type === 'frame' || c.type === 'ref')).map((c) => c.id));
const boards: Board[] = result.topLevel.filter((t) => visible.has(t.penId)).map((t) => ({ sketchId: t.sketchId, penId: t.penId, name: `${t.page} / ${t.name}` }));
const selected = boards.slice(0, values.limit ? Number(values.limit) : boards.length);
console.log(`${selected.length} frames`);

// Sketch renders
const refDir = join(work, 'ref');
rmSync(refDir, { recursive: true, force: true });
mkdirSync(refDir, { recursive: true });
for (let i = 0; i < selected.length; i += 40) {
  const chunk = selected.slice(i, i + 40);
  spawnSync(SKETCHTOOL, ['export', 'layers', sketchFile, `--items=${chunk.map((b) => b.sketchId).join(',')}`, '--formats=png', '--scales=2', `--output=${refDir}`, '--use-id-for-name=YES'], { stdio: 'ignore' });
}

// pen.dev renders
if (!values['skip-pen']) {
  const copy = join(dirname(input), `.compare-${Date.now()}.pen`);
  copyFileSync(input, copy);
  try {
    spawnSync('open', ['-a', 'Pen', copy]);
    const mcp = new PenMcp();
    await mcp.init();
    const penDir = join(work, 'pen');
    rmSync(penDir, { recursive: true, force: true });
    mkdirSync(penDir, { recursive: true });
    for (let i = 0; i < selected.length; i += 10) {
      const ids = selected.slice(i, i + 10).map((b) => b.penId);
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const out = await mcp.call('execute', { filePath: copy, input: `Export(${JSON.stringify(ids)},"png",${JSON.stringify(penDir)},{scale:2})` });
          if (!out.includes('Exported')) console.log(out.slice(0, 300));
          break;
        } catch (e) {
          // the document is still loading
          if (attempt === 39) throw e;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
    mcp.close();
  } finally {
    rmSync(copy, { force: true });
  }
}

console.log(summary(diffBoards(work, selected)));
console.log(`report: ${join(work, 'compare.html')}`);
