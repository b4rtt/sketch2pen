// Fidelity check: converts a .sketch file, renders every artboard with Sketch (sketchtool) and pen.dev
// (via its MCP server) and writes a side-by-side pixel diff report.
//
//   bun tools/compare.ts <file.sketch> <workdir> [--pages A,B] [--render <sketch file for sketchtool>] [--limit N]
//                        [--skip-ref] [--smooth-corners]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { convertSketch } from '../src/convert/document.ts';
import { writePen } from '../src/pen/writer.ts';
import { readSketch } from '../src/sketch/reader.ts';
import { diffBoards, summary } from './diff.ts';
import { PenMcp } from './pen-mcp.ts';

const SKETCHTOOL = process.env.SKETCHTOOL ?? '/Applications/Sketch.app/Contents/MacOS/sketchtool';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { pages: { type: 'string' }, render: { type: 'string' }, limit: { type: 'string' }, 'skip-ref': { type: 'boolean' }, 'smooth-corners': { type: 'boolean' } },
});
if (positionals.length < 2) {
  console.error('usage: bun tools/compare.ts <file.sketch> <workdir> [--pages A,B] [--render file] [--limit N] [--skip-ref] [--smooth-corners]');
  process.exit(1);
}
const input = resolve(positionals[0]!);
const work = resolve(positionals[1]!);
const pages = values.pages ? values.pages.split(',').map((s) => s.trim()) : [];
mkdirSync(work, { recursive: true });

const sketch = readSketch(input);
const { doc, ctx } = await convertSketch(sketch, { flexLayout: true, assetsDir: 'assets', pages, smoothCorners: !!values['smooth-corners'] });
// a fresh file name each run – pen.dev keeps already-open documents in memory
const files = writePen(join(work, 'out'), `compare-${Date.now()}`, doc, ctx);
console.log(`converted → ${files.penFile}`);

const boards: { sketchId: string; penId: string; name: string }[] = [];
for (const page of sketch.pages) {
  if (pages.length && !pages.includes(page.name)) continue;
  for (const l of page.layers) {
    const frameLike = l._class === 'artboard' || l._class === 'symbolMaster' || (l._class === 'group' && (l.groupBehavior === 1 || l.groupBehavior === 2));
    if (frameLike && l.isVisible !== false) boards.push({ sketchId: l.do_objectID, penId: ctx.ids.for(l.do_objectID), name: `${page.name} / ${l.name}` });
  }
}
const limit = values.limit ? Number(values.limit) : boards.length;
const selected = boards.slice(0, limit);
console.log(`${selected.length} artboards`);

// Sketch reference renders
const refDir = join(work, 'ref');
mkdirSync(refDir, { recursive: true });
const todo = selected.filter((b) => !existsSync(join(refDir, `${b.sketchId}@2x.png`)));
if (todo.length && !values['skip-ref']) {
  const renderFile = resolve(values.render ?? input);
  for (let i = 0; i < todo.length; i += 40) {
    const chunk = todo.slice(i, i + 40);
    spawnSync(SKETCHTOOL, ['export', 'layers', renderFile, `--items=${chunk.map((b) => b.sketchId).join(',')}`, '--formats=png', '--scales=2', `--output=${refDir}`, '--use-id-for-name=YES'], { stdio: 'ignore' });
  }
}

// pen.dev renders
spawnSync('open', ['-a', 'Pen', files.penFile]);
const pen = new PenMcp();
await pen.init();
for (let i = 0; i < 60; i++) {
  const active = await pen.activeFile().catch(() => null);
  if (active && resolve(active) === resolve(files.penFile)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const penDir = join(work, 'pen');
mkdirSync(penDir, { recursive: true });
for (let i = 0; i < selected.length; i += 10) {
  const ids = selected.slice(i, i + 10).map((b) => b.penId);
  const out = await pen.call('execute', { filePath: files.penFile, input: `Export(${JSON.stringify(ids)},"png",${JSON.stringify(penDir)},{scale:2})` });
  if (!out.includes('Exported')) console.log(out.slice(0, 500));
}
pen.close();

await Bun.write(join(work, 'boards.json'), JSON.stringify(selected));
console.log(summary(diffBoards(work, selected)));
console.log(`report: ${join(work, 'compare.html')}`);
