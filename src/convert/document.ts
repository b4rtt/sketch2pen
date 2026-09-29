import type { PenDocument, PenNode } from '../pen/types.ts';
import { walkLayers, type SketchFile } from '../sketch/reader.ts';
import type { Layer, Page } from '../sketch/types.ts';
import { initPathOps } from '../util/pathops.ts';
import { Context, type ConvertOptions } from './context.ts';
import { FontResolver } from './fonts.ts';
import { runCoreText } from './coretext.ts';
import { convertChildren, convertLayer, ROOT } from './layers.ts';
import { hexColor } from './style.ts';
import { masterOrder } from './symbols.ts';

export const PAGE_GAP = 1200;
const TITLE_SIZE = 96;

export interface ConvertResult {
  doc: PenDocument;
  ctx: Context;
  /** Sketch page → top-level pen nodes (after placement), for per-page splitting and verification. */
  pages: { name: string; nodes: PenNode[] }[];
}

function registerSwatches(ctx: Context, doc: PenDocument): void {
  const d = ctx.sketch.document;
  const swatches = [
    ...(d.sharedSwatches?.objects ?? []),
    ...(d.foreignSwatches ?? []).map((f) => f.localSwatch).filter(Boolean),
  ];
  if (!swatches.length) return;
  doc.variables = {};
  const used = new Set<string>();
  for (const s of swatches) {
    let name = s.name.replace(/:/g, '-').trim() || 'color';
    if (used.has(name)) {
      let i = 2;
      while (used.has(`${name} ${i}`)) i++;
      name = `${name} ${i}`;
    }
    used.add(name);
    const hex = hexColor(s.value);
    ctx.swatchVars.set(s.do_objectID, { name, hex });
    doc.variables[name] = { type: 'color', value: hex };
  }
}

function registerSharedStyles(ctx: Context): void {
  const d = ctx.sketch.document;
  for (const s of [...(d.layerStyles?.objects ?? []), ...(d.layerTextStyles?.objects ?? [])]) ctx.sharedStyles.set(s.do_objectID, s);
  for (const f of [...(d.foreignLayerStyles ?? []), ...(d.foreignTextStyles ?? [])]) {
    if (f.localSharedStyle) ctx.sharedStyles.set(f.localSharedStyle.do_objectID, f.localSharedStyle);
  }
}

function bbox(layers: Layer[]): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const l of layers) {
    const f = l.frame;
    x0 = Math.min(x0, f.x);
    y0 = Math.min(y0, f.y);
    x1 = Math.max(x1, f.x + f.width);
    y1 = Math.max(y1, f.y + f.height);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function shift(node: PenNode, dx: number, dy: number): void {
  node.x = Math.round(((node.x ?? 0) + dx) * 100) / 100;
  node.y = Math.round(((node.y ?? 0) + dy) * 100) / 100;
}

function titleNode(ctx: Context, text: string, x: number, y: number): PenNode {
  return {
    type: 'text',
    id: ctx.ids.for(`page-title:${text}:${y}`),
    name: `Page: ${text}`,
    content: text,
    x,
    y,
    fontFamily: 'Inter',
    fontWeight: '700',
    fontSize: TITLE_SIZE,
    fill: '#9CA3AF',
  };
}

export async function convertSketch(sketch: SketchFile, options: ConvertOptions): Promise<ConvertResult> {
  await initPathOps();
  const ctx = new Context(sketch, new FontResolver(sketch, { embed: options.embedFonts ?? 'all', map: options.fontMap ?? {} }), options);
  const doc: PenDocument = { version: '2.18', children: [] };
  registerSwatches(ctx, doc);
  registerSharedStyles(ctx);
  const ct = runCoreText(sketch, ctx.fonts);
  ctx.glyphs = ct.glyphs;
  ctx.textLines = ct.lines;
  if (!ct.available) ctx.report.warn('no-coretext', 'CoreText helper not available (needs macOS) – SF Symbols and text wrapping are approximated');

  // 1) Symbol masters (local + library) become reusable components, converted before any instance.
  const masters = new Map<string, Layer>();
  const pageOfMaster = new Map<string, string>();
  for (const page of sketch.pages) {
    walkLayers(page, (l) => {
      if (l._class === 'symbolMaster' && l.symbolID) {
        masters.set(l.symbolID, l);
        pageOfMaster.set(l.symbolID, page.name);
        return false;
      }
    });
  }
  const libraryMasters: Layer[] = [];
  for (const f of sketch.document.foreignSymbols ?? []) {
    const m = f.symbolMaster;
    if (m?.symbolID && !masters.has(m.symbolID)) {
      masters.set(m.symbolID, m);
      libraryMasters.push(m);
    }
  }
  for (const [symbolID, m] of masters) {
    const info = { master: m, penId: ctx.ids.for(m.do_objectID), nodeIds: new Map(), layers: new Map(), nodes: new Map() };
    ctx.masters.set(symbolID, info);
    ctx.mastersByPenId.set(info.penId, info);
  }
  for (const m of masterOrder(masters)) {
    const info = ctx.masters.get(m.symbolID!)!;
    ctx.currentMaster = info;
    const node = convertLayer(ctx, m, ROOT).find((n) => n.id === info.penId);
    ctx.currentMaster = null;
    if (node) {
      ctx.preconverted.set(m.do_objectID, node);
      const index = (n: PenNode) => {
        info.nodes.set(n.id, n);
        n.children?.forEach(index);
      };
      index(node);
    }
    ctx.report.stats.components++;
  }

  // 2) Pages are stacked vertically on the single pen.dev canvas, each under a title.
  const pages: ConvertResult['pages'] = [];
  const wanted = (p: Page) => !options.pages.length || options.pages.some((n) => n.toLowerCase() === p.name.toLowerCase());
  let cursorY = 0;
  const placeBand = (name: string, layers: Layer[], convert: () => PenNode[], isPage = true) => {
    const box = bbox(layers);
    if (!box) return;
    const nodes = convert();
    if (!nodes.length) return;
    const dx = -box.x;
    const dy = cursorY + TITLE_SIZE * 2 - box.y;
    for (const n of nodes) shift(n, dx, dy);
    const title = titleNode(ctx, name, 0, cursorY);
    doc.children.push(title, ...nodes);
    pages.push({ name, nodes });
    cursorY += TITLE_SIZE * 2 + box.h + PAGE_GAP;
    if (isPage) ctx.report.stats.pages++;
  };

  for (const page of sketch.pages) {
    if (!wanted(page)) continue;
    placeBand(page.name, page.layers, () => convertChildren(ctx, page.layers, { ...ROOT, path: page.name }));
  }

  // Library symbols are not on any page – lay them out in a row so instances have their components.
  const usedLibrary = libraryMasters.filter((m) => ctx.preconverted.has(m.do_objectID));
  if (usedLibrary.length) {
    let x = 0;
    const laid: Layer[] = usedLibrary.map((m) => {
      const l = { ...m, frame: { ...m.frame, x, y: 0 } };
      x += m.frame.width + 100;
      return l;
    });
    placeBand('Library symbols', laid, () =>
      laid.map((l, i) => {
        const node = ctx.preconverted.get(usedLibrary[i]!.do_objectID)!;
        node.x = l.frame.x;
        node.y = 0;
        return node;
      }),
      false,
    );
  }

  // Masters living on pages that were not converted still have to be in the file for their instances.
  const placed = new Set<string>();
  const collect = (n: PenNode) => {
    placed.add(n.id);
    n.children?.forEach(collect);
  };
  doc.children.forEach(collect);
  const missing = [...masters.values()].filter((m) => !placed.has(ctx.ids.for(m.do_objectID)) && !libraryMasters.includes(m));
  if (missing.length) {
    placeBand('Symbols (from pages not converted)', missing, () => missing.map((m) => ctx.preconverted.get(m.do_objectID)!).filter(Boolean), false);
  }

  return { doc, ctx, pages };
}
