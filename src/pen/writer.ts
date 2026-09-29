import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '../convert/context.ts';
import { extractCollectionFace } from '../convert/fonts.ts';
import type { PenDocument, PenFont } from './types.ts';

export interface WrittenFiles {
  penFile: string;
  assetsDir: string;
  fontsDir: string | null;
  fonts: string[];
  assetBytes: number;
}

function fontExtension(data: Uint8Array): string {
  const tag = String.fromCharCode(...data.subarray(0, 4));
  return tag === 'OTTO' ? 'otf' : 'ttf';
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'font';

/** Writes the .pen document, its images and the fonts pen.dev cannot load by itself. */
export function writePen(outDir: string, baseName: string, doc: PenDocument, ctx: Context): WrittenFiles {
  mkdirSync(outDir, { recursive: true });
  const assetsDir = join(outDir, ctx.options.assetsDir);
  mkdirSync(assetsDir, { recursive: true });
  let assetBytes = 0;
  for (const asset of ctx.assets.values()) {
    const data = asset.data ?? ctx.sketch.files.get(asset.source);
    if (!data) continue;
    writeFileSync(join(assetsDir, asset.fileName), data);
    assetBytes += data.byteLength;
  }

  // Fonts that pen.dev cannot load from Google Fonts ship with the document (its "Custom Fonts").
  const fontsDirName = ctx.options.fontsDir ?? 'fonts';
  const faces = ctx.fonts.documentFonts();
  const fonts: string[] = [];
  const entries: PenFont[] = [];
  let fontsDir: string | null = null;
  if (faces.length) {
    fontsDir = join(outDir, fontsDirName);
    mkdirSync(fontsDir, { recursive: true });
    const written = new Map<string, string>();
    for (const { family, face, file } of faces) {
      const key = `${file.path}#${file.faceIndex}`;
      let name = written.get(key);
      if (!name) {
        let data: Uint8Array | undefined = file.kind === 'sketch' ? ctx.sketch.files.get(file.path) : readFileSync(file.path);
        if (!data) continue;
        if (file.collection) data = extractCollectionFace(data, file.faceIndex);
        name = `${slug(face.postscriptName)}.${fontExtension(data)}`;
        writeFileSync(join(fontsDir, name), data);
        written.set(key, name);
        fonts.push(name);
      }
      const wght = face.axes.find((a) => a.tag === 'wght');
      entries.push({
        name: family,
        url: `./${fontsDirName}/${name}`,
        ...(wght ? { weight: [wght.min, wght.max] as [number, number], axes: [{ tag: 'wght', start: wght.min, end: wght.max }] } : face.weight !== 400 ? { weight: face.weight } : {}),
        ...(face.italic ? { style: 'italic' as const } : {}),
      });
    }
    if (entries.length) doc.fonts = entries;
  }

  const penFile = join(outDir, `${baseName}.pen`);
  writeFileSync(penFile, JSON.stringify(doc));
  return { penFile, assetsDir, fontsDir, fonts, assetBytes };
}
