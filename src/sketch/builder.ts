// Generates complete, valid Sketch documents from code: every field Sketch expects is filled with a neutral default.
// Used by the pen.dev → Sketch converter and by the feature lab (test files that Sketch itself renders as ground truth).
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { strToU8, zipSync, zlibSync } from 'fflate';

type J = Record<string, unknown>;

export const uuid = () => randomUUID().toUpperCase();

export function color(r: number, g: number, b: number, a = 1): J {
  return { _class: 'color', alpha: a, blue: b, green: g, red: r };
}

export const hex = (h: string, a = 1): J => {
  const n = parseInt(h.replace('#', ''), 16);
  return color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a);
};

const context = (opacity = 1, blendMode = 0): J => ({ _class: 'graphicsContextSettings', blendMode, opacity, isProgressive: false });

export function gradient(stops: [number, J][], from = '{0.5, 0}', to = '{0.5, 1}', type = 0, elipseLength = 0): J {
  return {
    _class: 'gradient',
    colorInterpolation: 0,
    elipseLength,
    from,
    gradientType: type,
    to,
    stops: stops.map(([position, c]) => ({ _class: 'gradientStop', position, color: c })),
  };
}

export function fill(c: J, o: { opacity?: number; blend?: number; gradient?: J; image?: string; patternFillType?: number; layeringType?: number } = {}): J {
  return {
    _class: 'fill',
    isEnabled: true,
    fillType: o.image ? 4 : o.gradient ? 1 : 0,
    color: c,
    contextSettings: context(o.opacity ?? 1, o.blend ?? 0),
    gradient: o.gradient ?? gradient([[0, color(1, 1, 1)], [1, color(0, 0, 0)]]),
    ...(o.image ? { image: { _class: 'MSJSONFileReference', _ref_class: 'MSImageData', _ref: o.image } } : {}),
    noiseIndex: 0,
    noiseIntensity: 0,
    patternFillType: o.patternFillType ?? 1,
    patternTileScale: 1,
    layeringType: o.layeringType ?? 0,
  };
}

export function border(c: J, thickness = 1, position = 0, o: { gradient?: J } = {}): J {
  return { ...fill(c, o), _class: 'border', position, thickness };
}

export function shadow(c: J, x: number, y: number, blur: number, spread = 0, inner = false, blend = 0): J {
  return { _class: 'shadow', isEnabled: true, blurRadius: blur, color: c, contextSettings: context(1, blend), isInnerShadow: inner, offsetX: x, offsetY: y, spread };
}

export function blur(type: number, radius: number): J {
  return {
    _class: 'blur',
    isEnabled: true,
    brightness: 1,
    center: '{0.5, 0.5}',
    chromaticAberrationMultiplier: 0,
    depth: 0.5,
    distortion: 0.5,
    extraSamplingRegion: 0,
    isProgressive: false,
    layeringType: 0,
    motionAngle: 0,
    radius,
    saturation: 1,
    skipLightingEffects: false,
    type,
  };
}

export interface StyleOptions {
  fills?: J[];
  borders?: J[];
  shadows?: J[];
  blurs?: J[];
  opacity?: number;
  blend?: number;
  radii?: number[];
  smooth?: boolean;
  dash?: number[];
  cap?: number;
  join?: number;
  startMarker?: number;
  endMarker?: number;
  windingRule?: number;
  textStyle?: J;
}

export function style(o: StyleOptions = {}): J {
  return {
    _class: 'style',
    do_objectID: uuid(),
    endMarkerType: o.endMarker ?? 0,
    miterLimit: 10,
    startMarkerType: o.startMarker ?? 0,
    windingRule: o.windingRule ?? 1,
    skipCorners: true,
    blurs: o.blurs ?? [],
    borderOptions: { _class: 'borderOptions', centerDashes: 1, isEnabled: true, dashPattern: o.dash ?? [], lineCapStyle: o.cap ?? 0, lineJoinStyle: o.join ?? 0 },
    borders: o.borders ?? [],
    colorControls: { _class: 'colorControls', isEnabled: false, brightness: 0, contrast: 1, hue: 0, saturation: 1 },
    contextSettings: context(o.opacity ?? 1, o.blend ?? 0),
    fills: o.fills ?? [],
    shadows: o.shadows ?? [],
    ...(o.radii ? { corners: { _class: 'MSImmutableStyleCorners', prefersConcentric: false, radii: o.radii, smoothing: 0.6, style: o.smooth ? 1 : 0 } } : {}),
    ...(o.textStyle ? { textStyle: o.textStyle } : {}),
  };
}

export type Frame = [number, number, number, number];

export interface LayerOptions {
  style?: StyleOptions;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  hidden?: boolean;
  mask?: 0 | 1;
  breakMask?: boolean;
  pins?: [number, number];
  sizing?: [number, number];
  booleanOperation?: number;
  extra?: J;
}

export function layer(cls: string, name: string, [x, y, width, height]: Frame, o: LayerOptions = {}): J {
  return {
    _class: cls,
    do_objectID: uuid(),
    booleanOperation: o.booleanOperation ?? -1,
    isFixedToViewport: false,
    isFlippedHorizontal: !!o.flipH,
    isFlippedVertical: !!o.flipV,
    isLocked: false,
    isTemplate: false,
    isVisible: !o.hidden,
    hasCustomPrototypeVisibility: false,
    hasExplicitConstraints: true,
    horizontalSizing: o.sizing?.[0] ?? 0,
    horizontalPins: o.pins?.[0] ?? 1,
    verticalSizing: o.sizing?.[1] ?? 0,
    verticalPins: o.pins?.[1] ?? 1,
    minSize: '{0, 0}',
    maxSize: '{0, 0}',
    percentageSize: '{0, 0}',
    prototypeVisibility: 1,
    prototypeVisibilityTrigger: 2,
    layerListExpandedType: 1,
    name,
    nameIsFixed: true,
    resizingConstraint: 63,
    resizingType: 0,
    rotation: o.rotation ?? 0,
    shouldBreakMaskChain: !!o.breakMask,
    exportOptions: { _class: 'exportOptions', includedLayerIds: [], layerOptions: 0, shouldTrim: false, exportFormats: [] },
    frame: { _class: 'rect', constrainProportions: false, height, width, x, y },
    clippingMaskMode: o.mask ?? 0,
    hasClippingMask: o.mask !== undefined,
    prototypeScrolling: 0,
    style: style(o.style),
    ...o.extra,
  };
}

const pt = (x: number, y: number, r = 0, from?: [number, number], to?: [number, number], mode = 1): J => ({
  _class: 'curvePoint',
  cornerRadius: r,
  cornerStyle: 0,
  curveFrom: `{${from?.[0] ?? x}, ${from?.[1] ?? y}}`,
  curveMode: from || to ? mode : 1,
  curveTo: `{${to?.[0] ?? x}, ${to?.[1] ?? y}}`,
  hasCurveFrom: !!from,
  hasCurveTo: !!to,
  point: `{${x}, ${y}}`,
});

export function rect(name: string, f: Frame, o: LayerOptions = {}): J {
  const radii = o.style?.radii ?? [0];
  const r = (i: number) => radii[radii.length === 4 ? i : 0] ?? 0;
  return layer('rectangle', name, f, {
    ...o,
    style: { radii: [0], ...o.style },
    extra: {
      edited: false,
      isClosed: true,
      fixedRadius: r(0),
      pointRadiusBehaviour: o.style?.smooth ? 2 : 1,
      points: [pt(0, 0, r(0)), pt(1, 0, r(1)), pt(1, 1, r(2)), pt(0, 1, r(3))],
      needsConvertionToNewRoundCorners: false,
      hasConvertedToNewRoundCorners: true,
      ...o.extra,
    },
  });
}

export function oval(name: string, f: Frame, o: LayerOptions = {}): J {
  const k = 0.2238576251;
  return layer('oval', name, f, {
    ...o,
    extra: {
      edited: false,
      isClosed: true,
      pointRadiusBehaviour: 1,
      points: [
        pt(0.5, 1, 0, [1 - k, 1], [k, 1], 2),
        pt(1, 0.5, 0, [1, k], [1, 1 - k], 2),
        pt(0.5, 0, 0, [k, 0], [1 - k, 0], 2),
        pt(0, 0.5, 0, [0, 1 - k], [0, k], 2),
      ],
      ...o.extra,
    },
  });
}

/** Polyline / polygon in normalized coordinates ([x, y, cornerRadius?]). */
export function path(name: string, f: Frame, points: [number, number, number?][], closed: boolean, o: LayerOptions = {}): J {
  return layer('shapePath', name, f, { ...o, extra: { edited: true, isClosed: closed, pointRadiusBehaviour: 1, points: points.map(([x, y, r]) => pt(x, y, r ?? 0)), ...o.extra } });
}

export function shapeGroup(name: string, f: Frame, layers: J[], o: LayerOptions = {}): J {
  return layer('shapeGroup', name, f, { ...o, extra: { ...groupFields(0, 0), layers, windingRule: 1, ...o.extra } });
}

function groupFields(groupBehavior: number, clippingBehavior: number): J {
  return {
    groupBehavior,
    overlayBackgroundInteraction: 0,
    presentationStyle: 0,
    clippingBehavior,
    includeBackgroundColorInExport: true,
    isFlowHome: false,
    leftPadding: 0,
    topPadding: 0,
    rightPadding: 0,
    bottomPadding: 0,
    paddingSelection: 1,
    prototypeScrollingArea: 0,
    groupLayout: { _class: 'MSImmutableFreeformGroupLayout' },
    variantProperties: [],
    resizesContent: 0,
  };
}

export function group(name: string, f: Frame, layers: J[], o: LayerOptions = {}): J {
  return layer('group', name, f, { ...o, extra: { ...groupFields(0, 0), layers, ...o.extra } });
}

/** A Sketch 2025 frame (the successor of artboards). */
export function frame(name: string, f: Frame, layers: J[], o: LayerOptions & { clip?: boolean; stack?: J; padding?: [number, number, number, number] } = {}): J {
  const [t, r, b, l] = o.padding ?? [0, 0, 0, 0];
  return layer('group', name, f, {
    ...o,
    style: { fills: [fill(color(1, 1, 1))], ...o.style },
    extra: {
      ...groupFields(1, o.clip === false ? 2 : 0),
      ...(o.stack ? { groupLayout: o.stack } : {}),
      topPadding: t,
      rightPadding: r,
      bottomPadding: b,
      leftPadding: l,
      layers,
      ...o.extra,
    },
  });
}

export function stack(direction: 'h' | 'v', gap: number, o: { justify?: number; align?: number } = {}): J {
  return {
    _class: 'MSImmutableFlexGroupLayout',
    alignContent: 0,
    alignItems: o.align ?? 0,
    allGuttersGap: gap,
    bordersAffectLayout: false,
    crossAxisGutterGap: 0,
    flexDirection: direction === 'v' ? 1 : 0,
    justifyContent: o.justify ?? 0,
    stackingOrder: 0,
    version: 1,
    wrappingEnabled: false,
  };
}

export interface Run {
  text: string;
  font: string;
  size: number;
  color?: J;
  kerning?: number;
  underline?: boolean;
  strike?: boolean;
  transform?: number;
}

export interface ParagraphOptions {
  align?: number;
  lineHeight?: number;
  paragraphSpacing?: number;
}

function attrs(r: Run, p: ParagraphOptions): J {
  return {
    MSAttributedStringFontAttribute: { _class: 'fontDescriptor', attributes: { name: r.font, size: r.size } },
    MSAttributedStringColorAttribute: r.color ?? color(0.1, 0.1, 0.12),
    paragraphStyle: {
      _class: 'paragraphStyle',
      alignment: p.align ?? 0,
      ...(p.lineHeight ? { maximumLineHeight: p.lineHeight, minimumLineHeight: p.lineHeight } : {}),
      ...(p.paragraphSpacing ? { paragraphSpacing: p.paragraphSpacing } : {}),
      allowsDefaultTighteningForTruncation: 0,
    },
    ...(r.kerning !== undefined ? { kerning: r.kerning } : {}),
    ...(r.underline ? { underlineStyle: 1 } : {}),
    ...(r.strike ? { strikethroughStyle: 1 } : {}),
    ...(r.transform ? { MSAttributedStringTextTransformAttribute: r.transform } : {}),
    textStyleVerticalAlignmentKey: 0,
  };
}

/** Text layer. `sizing`: [horizontal, vertical] – 0 fixed, 1 fit (auto). */
export function text(name: string, f: Frame, runs: Run[], p: ParagraphOptions & { sizing?: [number, number]; vAlign?: number } = {}, o: LayerOptions = {}): J {
  let loc = 0;
  const attributes = runs.map((r) => {
    const a = { _class: 'stringAttribute', location: loc, length: r.text.length, attributes: attrs(r, p) };
    loc += r.text.length;
    return a;
  });
  const first = runs[0]!;
  return layer('text', name, f, {
    ...o,
    sizing: p.sizing ?? [1, 1],
    style: {
      ...o.style,
      textStyle: { _class: 'textStyle', encodedAttributes: { ...attrs(first, p), textStyleVerticalAlignmentKey: p.vAlign ?? 0 }, verticalAlignment: p.vAlign ?? 0, skipColors: false, skipAlignment: false },
    },
    extra: {
      attributedString: { _class: 'attributedString', string: runs.map((r) => r.text).join(''), attributes },
      automaticallyDrawOnUnderlyingPath: false,
      dontSynchroniseWithSymbol: false,
      lineSpacingBehaviour: 3,
      ...o.extra,
    },
  });
}

export function bitmap(name: string, f: Frame, image: string, o: LayerOptions = {}): J {
  return layer('bitmap', name, f, {
    ...o,
    extra: { clippingMask: '{{0, 0}, {1, 1}}', fillReplacesImage: false, image: { _class: 'MSJSONFileReference', _ref_class: 'MSImageData', _ref: image }, intendedDPI: 72, ...o.extra },
  });
}

export function symbolMaster(name: string, f: Frame, layers: J[], o: LayerOptions & { background?: boolean } = {}): J {
  const symbolID = uuid();
  return layer('symbolMaster', name, f, {
    ...o,
    style: { fills: o.background ? [fill(color(1, 1, 1))] : [], ...o.style },
    extra: {
      ...groupFields(0, 0),
      layers,
      horizontalRulerData: { _class: 'rulerData', base: 0, guides: [] },
      verticalRulerData: { _class: 'rulerData', base: 0, guides: [] },
      allowsOverrides: true,
      preventUseAsOverride: false,
      preventInserting: false,
      preventSwapping: false,
      includeBackgroundColorInInstance: !!o.background,
      symbolID,
      preferredThumbnailBackground: 0,
      overrideProperties: [],
      ...o.extra,
    },
  });
}

export function instance(name: string, master: J, f: Frame, overrides: [string, unknown][] = [], o: LayerOptions & { scale?: number } = {}): J {
  return layer('symbolInstance', name, f, {
    ...o,
    extra: {
      scale: o.scale ?? 1,
      symbolID: master.symbolID,
      overrideValues: overrides.map(([overrideName, value]) => ({ _class: 'overrideValue', overrideName, value })),
      ...o.extra,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Images: a tiny PNG encoder so tests can carry their own bitmaps.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(strToU8(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGBA PNG from a pixel function. */
export function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

export interface PageSpec {
  name: string;
  layers: J[];
  /** object id of the page (random when omitted) */
  id?: string;
}

/** Archive entries of a .sketch file (Sketch 2025.3 format) with the given pages and extra archive files. */
export function buildDocument(pages: PageSpec[], files: Record<string, Uint8Array> = {}, documentExtra: J = {}, documentId: string = uuid()): Record<string, Uint8Array> {
  const zip: Record<string, Uint8Array> = { ...files };
  const pagesAndArtboards: J = {};
  const refs = pages.map((p) => {
    const id = p.id ?? uuid();
    const page = layer('page', p.name, [0, 0, 0, 0], { extra: { ...groupFields(0, 0), layers: p.layers } });
    page.do_objectID = id;
    (page.style as J).do_objectID = `${id.slice(0, -4)}5717`;
    zip[`pages/${id}.json`] = strToU8(JSON.stringify(page));
    const boards: J = {};
    for (const l of p.layers) boards[String(l.do_objectID)] = { name: l.name };
    pagesAndArtboards[id] = { name: p.name, artboards: boards };
    return { _class: 'MSJSONFileReference', _ref_class: 'MSImmutablePage', _ref: `pages/${id}` };
  });
  const sub = (suffix: string) => `${documentId.slice(0, -2)}${suffix}`;
  const document = {
    _class: 'document',
    do_objectID: documentId,
    colorSpace: 1,
    currentPageIndex: 0,
    assets: { _class: 'assetCollection', do_objectID: sub('A1'), images: [], colorAssets: [], exportPresets: [], gradientAssets: [], imageCollection: { _class: 'imageCollection', images: {} }, colors: [], gradients: [] },
    fontReferences: [],
    foreignLayerStyles: [],
    foreignSwatches: [],
    foreignSymbols: [],
    foreignTextStyles: [],
    foreignVariantSets: [],
    layerStyles: { _class: 'sharedStyleContainer', do_objectID: sub('A2'), objects: [] },
    layerTextStyles: { _class: 'sharedTextStyleContainer', do_objectID: sub('A3'), objects: [] },
    pages: refs,
    perDocumentLibraries: [],
    sharedSwatches: { _class: 'swatchContainer', do_objectID: sub('A4'), objects: [] },
    documentState: { _class: 'documentState' },
    ...documentExtra,
  };
  const app = { commit: '282a1825c1f94a92cca9fb620ffcfccd0a42207c', appVersion: '2025.3.4', build: 221297, app: 'com.bohemiancoding.sketch3', coeditCompatibilityVersion: 164, compatibilityVersion: 99, version: 182, variant: 'NONAPPSTORE' };
  zip['document.json'] = strToU8(JSON.stringify(document));
  zip['meta.json'] = strToU8(JSON.stringify({ ...app, autosaved: 0, created: app, saveHistory: ['NONAPPSTORE.221297'], pagesAndArtboards }));
  zip['user.json'] = strToU8(JSON.stringify({ document: { pageListHeight: 85, pageListCollapsed: 0 } }));
  return zip;
}

/** Compresses archive entries into .sketch file bytes (images and fonts are stored, JSON is deflated). */
export function zipDocument(zip: Record<string, Uint8Array>): Uint8Array {
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [name, data] of Object.entries(zip)) entries[name] = [data, { level: name.endsWith('.json') ? 6 : 0 }];
  return zipSync(entries);
}

/** Writes a .sketch file (Sketch 2025.3 format) with the given pages and extra archive files. */
export function writeDocument(path: string, pages: PageSpec[], files: Record<string, Uint8Array> = {}, documentExtra: J = {}): void {
  writeFileSync(path, zipSync(buildDocument(pages, files, documentExtra), { level: 0 }));
}
