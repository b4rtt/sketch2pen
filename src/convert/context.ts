import type { SketchFile } from '../sketch/reader.ts';
import type { Layer } from '../sketch/types.ts';
import type { FontResolver } from './fonts.ts';

export interface ConvertOptions {
  /** Map Sketch Stacks to pen.dev flex layout (falls back to absolute positions when the stack cannot be reproduced). */
  flexLayout: boolean;
  /** Folder name (relative to the .pen file) where images are written. */
  assetsDir: string;
  /** Only convert pages whose names are listed (all pages when empty). */
  pages: string[];
  /** Which fonts pen.dev cannot load itself are shipped with the document. */
  embedFonts?: import('./fonts.ts').EmbedMode;
  /** Font substitutions, Sketch family → pen.dev family. */
  fontMap?: Record<string, string>;
  /** Folder name (relative to the .pen file) for shipped fonts. */
  fontsDir?: string;
  /** Draw smooth (squircle) corners exactly as paths instead of editable rectangles. */
  smoothCorners?: boolean;
}

export interface Warning {
  code: string;
  message: string;
  count: number;
  examples: string[];
}

/** Collects approximations and unsupported features so the user gets an honest conversion report. */
export class Report {
  private items = new Map<string, Warning>();
  stats = { pages: 0, frames: 0, layers: 0, components: 0, instances: 0, images: 0, texts: 0, flexStacks: 0, absoluteStacks: 0 };

  warn(code: string, message: string, where?: string): void {
    let w = this.items.get(code);
    if (!w) {
      w = { code, message, count: 0, examples: [] };
      this.items.set(code, w);
    }
    w.count++;
    if (where && w.examples.length < 8 && !w.examples.includes(where)) w.examples.push(where);
  }

  get warnings(): Warning[] {
    return [...this.items.values()].sort((a, b) => b.count - a.count);
  }
}

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Short, deterministic node ids (pen.dev ids must not contain '/'). */
export class IdGen {
  private used = new Set<string>();
  private bySource = new Map<string, string>();

  private hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** Id for a Sketch object (stable across runs); `suffix` distinguishes extra nodes derived from one layer. */
  for(sourceId: string, suffix = ''): string {
    const key = sourceId + suffix;
    const known = this.bySource.get(key);
    if (known) return known;
    let h = this.hash(key);
    let id = '';
    for (;;) {
      id = '';
      let x = h;
      for (let i = 0; i < 6; i++) {
        id += B62[x % 62];
        x = Math.floor(x / 62);
      }
      if (!this.used.has(id)) break;
      h = this.hash(id + key);
    }
    this.used.add(id);
    this.bySource.set(key, id);
    return id;
  }

  fresh(prefix: string): string {
    return this.for(`${prefix}:${this.used.size}:${Math.random()}`);
  }
}

export interface AssetRef {
  /** Path inside the .sketch archive, e.g. images/abc.png */
  source: string;
  /** File name inside the assets folder */
  fileName: string;
  /** Generated image data (e.g. an image with a baked alpha mask) instead of an archive file */
  data?: Uint8Array;
}

export interface MasterInfo {
  master: Layer;
  penId: string;
  /** Sketch layer id → pen node id of the node representing it inside the component. */
  nodeIds: Map<string, string>;
  /** Sketch layer id → layer (for override resolution). */
  layers: Map<string, Layer>;
  /** Every pen node of the component by id (for validating instance overrides). */
  nodes: Map<string, import('../pen/types.ts').PenNode>;
}

export class Context {
  report = new Report();
  ids = new IdGen();
  assets = new Map<string, AssetRef>();
  masters = new Map<string, MasterInfo>(); // by symbolID
  swatchVars = new Map<string, { name: string; hex: string }>(); // swatch object id → variable
  sharedStyles = new Map<string, { name: string; value: NonNullable<Layer['style']> }>();
  /** When converting a symbol master, collects Sketch id → pen id for override resolution. */
  currentMaster: MasterInfo | null = null;
  /** Symbol masters converted up-front (by Sketch object id), placed when their page is converted. */
  preconverted = new Map<string, import('../pen/types.ts').PenNode>();
  /** Text layer id → ids of the pen text nodes it became (several for split mixed-style texts). */
  textParts = new Map<string, string[]>();
  /** "<layer id>:<index>" → node carrying the emulated inner shadow and the property holding its colour. */
  innerShadowTargets = new Map<string, { id: string; prop: 'stroke' | 'fill' }>();
  /** Outlines of private-use glyph texts (SF Symbols) keyed by font|size|text. */
  glyphs = new Map<string, import('./coretext.ts').GlyphOutline>();
  /** Sketch's line breaks of fixed-width texts with pen.dev line widths (CoreText pre-pass). */
  textLines = new Map<string, import('./coretext.ts').TextLine[]>();
  /** Sketch mask layer id → id of the clipping frame that replaced it. */
  maskFrames = new Map<string, string>();
  /** Components by their pen id. */
  mastersByPenId = new Map<string, MasterInfo>();
  /** Sketch groups converted to pen.dev flex frames. */
  flexContainers = new Set<string>();

  constructor(
    readonly sketch: SketchFile,
    readonly fonts: FontResolver,
    readonly options: ConvertOptions,
  ) {}

  /** Registers an image from the .sketch archive and returns its url relative to the .pen file. */
  imageUrl(ref: string | undefined): string | null {
    if (!ref) return null;
    const source = ref.includes('.') ? ref : `${ref}.png`;
    if (!this.sketch.files.has(source)) {
      this.report.warn('missing-image', 'Image missing from the .sketch file', source);
      return null;
    }
    let asset = this.assets.get(source);
    if (!asset) {
      asset = { source, fileName: source.split('/').pop()! };
      this.assets.set(source, asset);
      this.report.stats.images++;
    }
    return `./${this.options.assetsDir}/${asset.fileName}`;
  }

  /** Records the pen id of a Sketch layer while a symbol master is being converted. */
  track(layer: Layer, penId: string): void {
    if (this.currentMaster) {
      this.currentMaster.nodeIds.set(layer.do_objectID, penId);
      this.currentMaster.layers.set(layer.do_objectID, layer);
    }
  }
}
