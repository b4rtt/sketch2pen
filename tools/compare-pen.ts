// Fidelity check for pen.dev → Sketch: converts a .pen file, renders every top-level frame with pen.dev (via its MCP
// server) and Sketch (sketchtool), and writes a side-by-side pixel diff report.
//
//   bun tools/compare-pen.ts <file.pen> <workdir> [--limit N] [--no-symbols] [--no-stacks]
//
// pen.dev renders a copy of the document in the work folder (relative image and font urls made absolute), so the
// original is never opened.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { localPath, readPen } from '../src/pen/reader.ts';
import type { PenDocument } from '../src/pen/types.ts';
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
// `export artboards` – `export layers` misses nested symbols whose masters are not on the document's current page
for (const mode of ['artboards', 'layers']) {
  const todo = selected.filter((b) => !existsSync(join(refDir, `${b.sketchId}@2x.png`)));
  for (let i = 0; i < todo.length; i += 40) {
    const chunk = todo.slice(i, i + 40);
    spawnSync(SKETCHTOOL, ['export', mode, sketchFile, `--items=${chunk.map((b) => b.sketchId).join(',')}`, '--formats=png', '--scales=2', `--output=${refDir}`, '--use-id-for-name=YES'], { stdio: 'ignore' });
  }
}

// pen.dev renders
if (!values['skip-pen']) {
  // a fresh file name each run – pen.dev keeps open documents in memory
  const copy = join(work, `render-${Date.now()}.pen`);
  writeFileSync(copy, JSON.stringify(absoluteUrls(readPen(input).doc, pen.dir)));
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

/** The document with relative image and font urls resolved against its folder. */
function absoluteUrls(doc: PenDocument, dir: string): PenDocument {
  const fix = (u: unknown) => (typeof u === 'string' ? (localPath(dir, u) ?? u) : u);
  const paints = (v: unknown) => {
    for (const p of Array.isArray(v) ? v : [v]) if (p && typeof p === 'object' && (p as { type?: string }).type === 'image') (p as { url: unknown }).url = fix((p as { url: unknown }).url);
  };
  for (const f of doc.fonts ?? []) f.url = fix(f.url) as string;
  const visit = (n: Record<string, unknown>) => {
    paints(n.fill);
    paints(n.stroke);
    for (const d of Object.values((n.descendants as Record<string, Record<string, unknown>>) ?? {})) if (d && typeof d === 'object') visit(d);
    for (const c of (n.children as Record<string, unknown>[]) ?? []) visit(c);
  };
  for (const c of doc.children) visit(c as unknown as Record<string, unknown>);
  return doc;
}
