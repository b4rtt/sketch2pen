// Builds small synthetic .sketch files for end-to-end tests (no dependency on real design files).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

let seq = 0;
export const uid = (p = 'L') => `${p}-${String(++seq).padStart(4, '0')}-0000-0000-000000000000`;

const color = (r: number, g: number, b: number, a = 1) => ({ _class: 'color', red: r, green: g, blue: b, alpha: a });

export function fill(r: number, g: number, b: number, a = 1, extra: Record<string, unknown> = {}) {
  return {
    _class: 'fill',
    isEnabled: true,
    fillType: 0,
    color: color(r, g, b, a),
    contextSettings: { blendMode: 0, opacity: 1 },
    gradient: { gradientType: 0, from: '{0.5, 0}', to: '{0.5, 1}', elipseLength: 0, stops: [] },
    patternFillType: 1,
    layeringType: 0,
    ...extra,
  };
}

export function style(extra: Record<string, unknown> = {}) {
  return { _class: 'style', fills: [], borders: [], shadows: [], blurs: [], contextSettings: { blendMode: 0, opacity: 1 }, ...extra };
}

export function layer(cls: string, name: string, frame: [number, number, number, number], extra: Record<string, unknown> = {}) {
  const [x, y, width, height] = frame;
  return {
    _class: cls,
    do_objectID: uid(cls.slice(0, 3).toUpperCase()),
    name,
    isVisible: true,
    rotation: 0,
    isFlippedHorizontal: false,
    isFlippedVertical: false,
    horizontalPins: 0,
    verticalPins: 0,
    horizontalSizing: 0,
    verticalSizing: 0,
    frame: { _class: 'rect', x, y, width, height },
    style: style(),
    ...extra,
  };
}

export function text(name: string, frame: [number, number, number, number], runs: [string, string, number][], extra: Record<string, unknown> = {}) {
  let loc = 0;
  const attributes = runs.map(([s, font, size]) => {
    const a = {
      _class: 'stringAttribute',
      location: loc,
      length: s.length,
      attributes: {
        MSAttributedStringFontAttribute: { _class: 'fontDescriptor', attributes: { name: font, size } },
        MSAttributedStringColorAttribute: color(0.1, 0.1, 0.1),
        paragraphStyle: { _class: 'paragraphStyle', alignment: 0, maximumLineHeight: size * 1.25, minimumLineHeight: size * 1.25 },
      },
    };
    loc += s.length;
    return a;
  });
  return layer('text', name, frame, {
    attributedString: { _class: 'attributedString', string: runs.map((r) => r[0]).join(''), attributes },
    horizontalSizing: 1,
    verticalSizing: 1,
    ...extra,
  });
}

// 1×1 transparent PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));

export function writeSketch(pages: { name: string; layers: unknown[] }[], documentExtra: Record<string, unknown> = {}): string {
  const files: Record<string, Uint8Array> = {};
  const refs = pages.map((p) => {
    const id = uid('PAGE');
    files[`pages/${id}.json`] = strToU8(JSON.stringify({ _class: 'page', do_objectID: id, name: p.name, isVisible: true, frame: { x: 0, y: 0, width: 0, height: 0 }, layers: p.layers }));
    return { _class: 'MSJSONFileReference', _ref_class: 'MSImmutablePage', _ref: `pages/${id}` };
  });
  files['document.json'] = strToU8(JSON.stringify({ _class: 'document', do_objectID: uid('DOC'), pages: refs, ...documentExtra }));
  files['meta.json'] = strToU8(JSON.stringify({ appVersion: '2025.3.4', version: 182, pagesAndArtboards: {} }));
  files['user.json'] = strToU8('{}');
  files['images/pixel.png'] = PNG;
  const dir = mkdtempSync(join(tmpdir(), 'sketch2pen-test-'));
  const path = join(dir, 'test.sketch');
  writeFileSync(path, zipSync(files, { level: 0 }));
  return path;
}
