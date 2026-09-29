import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import type { Layer, Page, SketchDocument, SketchMeta } from './types.ts';

export interface SketchFile {
  path: string;
  document: SketchDocument;
  meta: SketchMeta;
  pages: Page[];
  /** Raw archive entries (images/…, fonts/…) keyed by their path inside the .sketch zip. */
  files: Map<string, Uint8Array>;
}

/** A problem with the input file that the user can act on (not a bug). */
export class SketchReadError extends Error {}

export function readSketch(path: string): SketchFile {
  const bytes = readFileSync(path);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new SketchReadError(`${path} is not a Sketch document. Files saved by Sketch 42 or older use a different format – open and save them in a newer Sketch first.`);
  }
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(bytes);
  } catch (e) {
    throw new SketchReadError(`${path} is not a readable Sketch document (${e instanceof Error ? e.message : e}).`);
  }
  const json = <T>(name: string): T => {
    const entry = zip[name];
    if (!entry) throw new SketchReadError(`${path} does not contain ${name} – it is not a valid Sketch document.`);
    try {
      return JSON.parse(strFromU8(entry)) as T;
    } catch {
      throw new SketchReadError(`${name} inside ${path} is damaged.`);
    }
  };

  const document = json<SketchDocument>('document.json');
  const meta = zip['meta.json'] ? json<SketchMeta>('meta.json') : ({ appVersion: 'unknown', version: 0, pagesAndArtboards: {} } as SketchMeta);
  const pages = document.pages.map((ref) => json<Page>(`${ref._ref}.json`));

  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(zip)) {
    if (!name.endsWith('.json')) files.set(name, data);
  }
  return { path, document, meta, pages, files };
}

/** Depth-first walk over a layer tree (the callback may return false to skip children). */
export function walkLayers(layer: Layer, visit: (layer: Layer, parent: Layer | null) => boolean | void, parent: Layer | null = null): void {
  if (visit(layer, parent) === false) return;
  for (const child of layer.layers ?? []) walkLayers(child, visit, layer);
}
