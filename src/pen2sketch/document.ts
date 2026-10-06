// pen.dev → Sketch: the pipeline. The document is expanded (instances, themes), laid out like pen.dev does it, and
// written as a Sketch document whose layers sit exactly where pen.dev draws them.
import { createHash } from 'node:crypto';
import type { PenFile } from '../pen/reader.ts';
import * as B from '../sketch/builder.ts';
import { Context, DEFAULT_OPTIONS, type PenToSketchOptions } from './context.ts';
import { cacheDir, FontLibrary } from './fonts.ts';
import { loadIcons, type IconRequest } from './icons.ts';
import { Layout } from './layout.ts';
import { NodeConverter, PAGE } from './nodes.ts';
import { sketchColor } from './paint.ts';
import { Report } from './report.ts';
import { Symbols } from './symbols.ts';
import { measureText, textProps } from './text.ts';
import { TreeBuilder, walk, type RNode } from './tree.ts';
import { Variables } from './variables.ts';
import { paints } from './paint.ts';

type J = Record<string, unknown>;

export interface PenToSketchResult {
  /** archive entries of the .sketch file */
  files: Record<string, Uint8Array>;
  ctx: Context;
  pages: { name: string; layers: number }[];
  /** top-level nodes and the Sketch layers they became (for verification) */
  topLevel: { penId: string; sketchId: string; name: string; page: string }[];
}

/** Bounds supplied from outside (pen.dev's own layout, see tools): node key → box in the parent's coordinates. */
export type ExternalLayout = Map<string, { x: number; y: number; width: number; height: number }>;

const PAGE_TITLE = /^Page: (.+)$/;

/**
 * Documents converted from Sketch by sketch2pen stack the Sketch pages vertically under "Page: <name>" titles.
 * Those bands become Sketch pages again.
 */
function pageBands(ctx: Context, roots: RNode[]): { name: string; nodes: RNode[]; dy: number }[] {
  const titles = roots
    .filter((n) => n.type === 'text' && PAGE_TITLE.test(String(n.p.name ?? '')) && ctx.vars.string(n.p.content, n.theme) === PAGE_TITLE.exec(String(n.p.name))![1])
    .sort((a, b) => a.y - b.y);
  if (!titles.length) return [{ name: 'Page 1', nodes: roots, dy: 0 }];
  const bands = titles.map((t) => ({ name: PAGE_TITLE.exec(String(t.p.name))![1]!, nodes: [] as RNode[], dy: t.y + t.h * 2 }));
  for (const n of roots) {
    if (titles.includes(n)) continue;
    let i = 0;
    while (i + 1 < titles.length && n.y >= titles[i + 1]!.y) i++;
    bands[i]!.nodes.push(n);
  }
  // the title is twice as tall as its text; content started one title height below it
  for (const [i, b] of bands.entries()) b.dy = titles[i]!.y + 2 * (ctx.vars.number(titles[i]!.p.fontSize, titles[i]!.theme) ?? titles[i]!.h);
  return bands.filter((b) => b.nodes.length);
}

export async function convertPen(pen: PenFile, options: Partial<PenToSketchOptions> = {}, external?: ExternalLayout): Promise<PenToSketchResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const report = new Report();
  const vars = new Variables(pen.doc);
  const builder = new TreeBuilder(pen.doc, vars, report);
  const { roots } = builder.build();

  // fonts, images and icons are loaded up front – the conversion itself is synchronous
  const fonts = new FontLibrary(pen, { embed: opts.embedFonts, download: opts.download, dirs: opts.fontDirs }, report);
  const ctx = new Context(pen, vars, fonts, report, opts);
  const fontRequests: { family: string; weight: number; italic: boolean }[] = [];
  const imageUrls: string[] = [];
  const collect = (n: RNode) => {
    if (n.type === 'text') {
      const t = textProps(ctx, n);
      fontRequests.push({ family: t.family, weight: t.weight, italic: t.italic });
    }
    for (const key of ['fill', 'stroke'] as const) {
      for (const p of paints(n.p[key])) {
        const v = vars.value(p, n.theme) as J | undefined;
        if (v && typeof v === 'object' && v.type === 'image' && typeof v.url === 'string') imageUrls.push(v.url);
      }
    }
  };
  for (const r of roots) walk(r, collect);
  const symbols = new Symbols(ctx, builder);
  for (const c of symbols.components()) walk(c, collect);
  await Promise.all([fonts.prepare(fontRequests), ctx.prefetch(imageUrls)]);

  // layout
  const layout = new Layout({ vars, measureText: (n, w) => measureText(ctx, n, w) });
  for (const r of roots) layout.run(r);
  for (const c of symbols.components()) layout.run(c);
  if (external) for (const r of roots) applyExternal(r, external);

  // icons depend on their drawn size (optical sizes)
  const iconRequests: IconRequest[] = [];
  const collectIcons = (n: RNode) => {
    const r = n.type === 'icon' ? ctx.iconRequest(n) : null;
    if (r) iconRequests.push(r);
  };
  for (const r of roots) walk(r, collectIcons);
  for (const c of symbols.components()) walk(c, collectIcons);
  ctx.icons = await loadIcons(iconRequests, cacheDir(), opts.download);

  // colour variables → swatches
  const swatches: J[] = [];
  for (const name of vars.names()) {
    const hex = vars.swatchValue(name);
    if (!hex) continue;
    const id = ctx.uuid(`swatch:${name}`);
    ctx.swatches.set(name, { id, name, hex });
    swatches.push({ _class: 'swatch', do_objectID: id, name: name.replace(/^--/, ''), value: sketchColor(ctx, { hex }) });
  }
  report.stats.swatches = swatches.length;

  // layers
  const conv = new NodeConverter(ctx);
  if (opts.symbols) symbols.attach(conv);
  const pages: B.PageSpec[] = [];
  const topLevel: PenToSketchResult['topLevel'] = [];
  for (const band of pageBands(ctx, roots)) {
    const layers = band.nodes.flatMap((n) => {
      const out = conv.convert(n, PAGE);
      if (out[0]) topLevel.push({ penId: n.id, sketchId: String(out[0].do_objectID), name: String(out[0].name), page: band.name });
      return out;
    });
    for (const l of layers) (l.frame as J).y = Math.round(((l.frame as J).y as number) - band.dy) || 0;
    pages.push({ name: band.name, layers, id: ctx.uuid(`page:${band.name}`) });
  }
  const symbolPage = symbols.page();
  if (symbolPage) pages.push(symbolPage);
  report.stats.pages = pages.length;

  // images and fonts go into the archive
  const files: Record<string, Uint8Array> = {};
  for (const asset of ctx.images.values()) if (asset) files[asset.ref] = asset.data;
  const fontReferences: J[] = [];
  const embedded = new Map<string, J>();
  for (const choice of fonts.used.values()) {
    if (!choice.file || !choice.embed) continue;
    const hash = createHash('sha1').update(choice.file.data).digest('hex');
    let ref = embedded.get(hash);
    if (!ref) {
      files[`fonts/${hash}`] = choice.file.data;
      ref = {
        _class: 'fontReference',
        do_objectID: ctx.uuid(`font:${hash}`),
        fontData: { _class: 'MSJSONFileReference', _ref_class: 'MSFontData', _ref: `fonts/${hash}` },
        fontFamilyName: choice.file.face.family,
        fontFileName: choice.file.fileName,
        options: 3,
        postscriptNames: [] as string[],
      };
      embedded.set(hash, ref);
      fontReferences.push(ref);
    }
    const names = ref.postscriptNames as string[];
    if (!names.includes(choice.postscriptName)) names.push(choice.postscriptName);
  }
  const doc = B.buildDocument(pages, files, { fontReferences, sharedSwatches: { _class: 'swatchContainer', do_objectID: ctx.uuid('swatches'), objects: swatches } }, ctx.uuid('document'));
  return { files: doc, ctx, pages: pages.map((p) => ({ name: p.name, layers: p.layers.length })), topLevel };
}

/** Replaces computed boxes by pen.dev's own (positions are relative to the parent, like pen.dev reports them). */
function applyExternal(n: RNode, ext: ExternalLayout): void {
  const b = ext.get(n.key);
  if (b) {
    n.w = b.width;
    n.h = b.height;
    n.x = b.x - (n.ox ?? 0);
    n.y = b.y - (n.oy ?? 0);
  }
  for (const c of n.children) applyExternal(c, ext);
}
