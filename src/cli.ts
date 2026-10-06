#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { convertSketch } from './convert/document.ts';
import type { EmbedMode } from './convert/fonts.ts';
import { PenReadError, readPen } from './pen/reader.ts';
import { writePen } from './pen/writer.ts';
import { convertPen } from './pen2sketch/document.ts';
import { penConsoleSummary, penJsonReport } from './pen2sketch/summary.ts';
import { consoleSummary, htmlReport, jsonReport } from './report.ts';
import { zipDocument } from './sketch/builder.ts';
import { readSketch, SketchReadError } from './sketch/reader.ts';

const HELP = `sketch2pen ${pkg.version} – convert between Sketch and pen.dev documents

Usage:
  sketch2pen <file.sketch> [options]     Sketch → pen.dev
  sketch2pen <file.pen> [options]        pen.dev → Sketch

Sketch → pen.dev:
  -o, --out <dir>           output folder (default: "<name> (Pen)" next to the .sketch file)
  -p, --pages <names>       convert only these pages, comma separated
      --list                list pages and artboards, then exit
      --embed-fonts <mode>  fonts pen.dev cannot load by itself:
                              all       ship fonts from the Sketch file and this computer (default)
                              document  ship only fonts embedded in the Sketch file
                              none      substitute them with Google Fonts
      --font-map <map>      font substitutions, e.g. "Brand Sans=Figtree,SF Pro=Inter"
      --smooth-corners      draw smooth (squircle) corners exactly as paths instead of editable rectangles
      --no-flex             keep Sketch stacks as absolute positions instead of flex layout

pen.dev → Sketch:
  -o, --out <file>          output file (default: "<name> (Sketch).sketch" next to the .pen file)
      --embed-fonts <mode>  fonts embedded in the Sketch document:
                              document  fonts shipped with the .pen file and Google Fonts (default)
                              all       also fonts installed on this computer
                              none      none (Sketch uses installed fonts)
      --no-symbols          expand component instances instead of creating Sketch symbols
      --no-stacks           keep flex layout as fixed positions instead of Sketch stacks
      --offline             do not download Google Fonts, icons and remote images

Both directions:
      --no-open             do not open the result
      --json                print the conversion report as JSON
  -v, --version             print the version
  -h, --help                show this help
`;

function parseFontMap(value: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of (value ?? '').split(',')) {
    const [from, to] = pair.split('=').map((s) => s?.trim());
    if (from && to) map[from] = to;
  }
  return map;
}

type Values = Record<string, string | boolean | undefined>;

async function sketchToPen(input: string, values: Values): Promise<number> {
  const embed = (values['embed-fonts'] ?? 'all') as EmbedMode;
  if (!['all', 'document', 'none'].includes(embed)) {
    console.error(`Invalid --embed-fonts value "${embed}" (use all, document or none).`);
    return 2;
  }
  const started = performance.now();
  const log = values.json ? () => {} : (s: string) => console.log(s);
  log(`Reading ${basename(input)} …`);
  const sketch = readSketch(input);

  if (values.list) {
    for (const p of sketch.pages) {
      const boards = p.layers.filter((l) => l._class === 'artboard' || l._class === 'symbolMaster' || (l._class === 'group' && l.groupBehavior === 1)).length;
      console.log(`  ${p.name}  (${boards} artboards, ${p.layers.length} top-level layers)`);
    }
    return 0;
  }

  const baseName = basename(input, extname(input));
  const outDir = resolve((values.out as string | undefined) ?? join(dirname(input), `${baseName} (Pen)`));
  const penPath = join(outDir, `${baseName}.pen`);
  const existed = existsSync(penPath);
  const pages = values.pages ? String(values.pages).split(',').map((s) => s.trim()).filter(Boolean) : [];
  log(`Converting ${pages.length || sketch.pages.length} pages (Sketch ${sketch.meta.appVersion}) …`);

  const { doc, ctx } = await convertSketch(sketch, {
    flexLayout: !values['no-flex'],
    assetsDir: 'assets',
    pages,
    embedFonts: embed,
    fontMap: parseFontMap(values['font-map'] as string | undefined),
    smoothCorners: !!values['smooth-corners'],
  });
  const files = writePen(outDir, baseName, doc, ctx);
  const seconds = (performance.now() - started) / 1000;
  writeFileSync(join(outDir, 'report.html'), htmlReport(ctx, files, input, seconds, pkg.version));
  const json = jsonReport(ctx, files, input, seconds, pkg.version);
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(json, null, 2));

  if (values.json) console.log(JSON.stringify(json, null, 2));
  else {
    console.log(consoleSummary(ctx, files, seconds));
    console.log(`  Report: ${join(outDir, 'report.html')}`);
    if (existed) console.log('  Note: pen.dev keeps open documents in memory – if this file was already open, close it and open it again.');
  }

  if (!values['no-open']) {
    if (process.platform === 'darwin') {
      const r = spawnSync('open', ['-a', 'Pen', files.penFile]);
      if (r.status !== 0) log('  (pen.dev was not found – open the .pen file manually.)');
    } else {
      log('  Open the .pen file in pen.dev.');
    }
  }
  return 0;
}

async function penToSketch(input: string, values: Values): Promise<number> {
  const embed = (values['embed-fonts'] ?? 'document') as EmbedMode;
  if (!['all', 'document', 'none'].includes(embed)) {
    console.error(`Invalid --embed-fonts value "${embed}" (use document, all or none).`);
    return 2;
  }
  const started = performance.now();
  const log = values.json ? () => {} : (s: string) => console.log(s);
  log(`Reading ${basename(input)} …`);
  const pen = readPen(input);
  const baseName = basename(input, extname(input));
  const out = resolve((values.out as string | undefined) ?? join(dirname(input), `${baseName} (Sketch).sketch`));
  log('Converting to Sketch …');
  const result = await convertPen(pen, {
    symbols: !values['no-symbols'],
    stacks: !values['no-stacks'],
    download: !values.offline,
    embedFonts: embed,
  });
  writeFileSync(out, zipDocument(result.files));
  const seconds = (performance.now() - started) / 1000;
  const json = penJsonReport(result, input, out, seconds, pkg.version);
  if (values.json) console.log(JSON.stringify(json, null, 2));
  else console.log(penConsoleSummary(result, out, seconds));
  if (!values['no-open']) {
    if (process.platform === 'darwin') {
      const r = spawnSync('open', ['-a', 'Sketch', out]);
      if (r.status !== 0) log('  (Sketch was not found – open the .sketch file manually.)');
    } else {
      log('  Open the .sketch file in Sketch.');
    }
  }
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      pages: { type: 'string', short: 'p' },
      list: { type: 'boolean' },
      'embed-fonts': { type: 'string' },
      'font-map': { type: 'string' },
      'smooth-corners': { type: 'boolean' },
      'no-flex': { type: 'boolean' },
      'no-symbols': { type: 'boolean' },
      'no-stacks': { type: 'boolean' },
      offline: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      json: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.version) {
    console.log(pkg.version);
    return 0;
  }
  if (values.help || !positionals.length) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }
  const input = resolve(positionals[0]!);
  if (!existsSync(input)) {
    console.error(`File not found: ${input}`);
    return 1;
  }
  const ext = extname(input).toLowerCase();
  if (ext === '.pen') return penToSketch(input, values);
  if (ext === '.sketch') return sketchToPen(input, values);
  console.error(`Unsupported file type "${ext || basename(input)}" – expected a .sketch or .pen file.`);
  return 2;
}

main()
  .then((c) => (process.exitCode = c))
  .catch((e) => {
    if (e instanceof SketchReadError || e instanceof PenReadError) console.error(`Error: ${e.message}`);
    else console.error(`Error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    process.exitCode = 1;
  });
