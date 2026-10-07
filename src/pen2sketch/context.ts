import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPath, type PenFile } from '../pen/reader.ts';
import { encodePng } from '../util/image.ts';
import type { FontLibrary } from './fonts.ts';
import { iconKey, type IconRequest, type IconSvg } from './icons.ts';
import type { Report } from './report.ts';
import type { RNode } from './tree.ts';
import type { Variables } from './variables.ts';

export interface PenToSketchOptions {
  /** Sketch stacks for pen.dev flex layout (frames keep pen.dev's positions either way) */
  stacks: boolean;
  /** pen.dev components become Sketch symbols (otherwise instances are expanded into plain layers) */
  symbols: boolean;
  /** download Google Fonts, remote images and icons */
  download: boolean;
  /** which fonts are embedded in the Sketch document */
  embedFonts: import('./fonts.ts').EmbedMode;
  /** font folders searched for installed fonts (default: the platform's) */
  fontDirs?: string[];
}

export const DEFAULT_OPTIONS: PenToSketchOptions = { stacks: true, symbols: true, download: true, embedFonts: 'document' };

/** Deterministic Sketch object id (UUID form) for a key. */
export function uuidFor(key: string): string {
  const h = createHash('sha1').update(key).digest('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface ImageAsset {
  /** archive path inside the .sketch file (images/<sha1>.png) */
  ref: string;
  data: Uint8Array;
}

function imageType(data: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | 'svg' | 'other' {
  if (data[0] === 0x89 && data[1] === 0x50) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'gif';
  if (data[0] === 0x52 && data[1] === 0x49 && data[8] === 0x57) return 'webp';
  const head = new TextDecoder().decode(data.subarray(0, 256)).trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return 'other';
}

/** Converts an image Sketch cannot store (WebP, GIF, HEIC …) to PNG with macOS's sips. */
function toPng(data: Uint8Array): Uint8Array | null {
  if (process.platform !== 'darwin') return null;
  const dir = mkdtempSync(join(tmpdir(), 'sketch2pen-img-'));
  try {
    const src = join(dir, 'in');
    const out = join(dir, 'out.png');
    writeFileSync(src, data);
    const r = spawnSync('sips', ['-s', 'format', 'png', src, '--out', out], { stdio: 'ignore' });
    return r.status === 0 && existsSync(out) ? new Uint8Array(readFileSync(out)) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class Context {
  readonly images = new Map<string, ImageAsset | null>(); // by url
  /** colour variable → Sketch swatch */
  readonly swatches = new Map<string, { id: string; name: string; hex: string }>();
  private remote = new Map<string, Uint8Array | null>();
  /** icon outlines by request key (loaded before the conversion) */
  icons = new Map<string, IconSvg | null>();

  constructor(
    readonly pen: PenFile,
    readonly vars: Variables,
    readonly fonts: FontLibrary,
    readonly report: Report,
    readonly options: PenToSketchOptions,
  ) {}

  uuid(key: string): string {
    return uuidFor(`${this.pen.path}|${key}`);
  }

  /** Remote images are fetched before the conversion (it is synchronous). */
  async prefetch(urls: string[]): Promise<void> {
    await Promise.all(
      [...new Set(urls)]
        .filter((u) => /^https?:\/\//i.test(u) && !this.remote.has(u))
        .map(async (u) => {
          if (!this.options.download) return this.remote.set(u, null);
          try {
            const res = await fetch(u, { signal: AbortSignal.timeout(30_000) });
            this.remote.set(u, res.ok ? new Uint8Array(await res.arrayBuffer()) : null);
          } catch {
            this.remote.set(u, null);
          }
        }),
    );
  }

  private load(url: string): Uint8Array | null {
    if (url.startsWith('data:')) {
      const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(url);
      if (!m) return null;
      return m[1] ? new Uint8Array(Buffer.from(m[2]!, 'base64')) : new TextEncoder().encode(decodeURIComponent(m[2]!));
    }
    if (/^https?:\/\//i.test(url)) return this.remote.get(url) ?? null;
    const path = localPath(this.pen.dir, url);
    return path && existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }

  iconRequest(n: RNode): IconRequest | null {
    const library = this.vars.string(n.p.library, n.theme);
    const name = this.vars.string(n.p.icon, n.theme);
    return library && name ? { library, name, weight: this.vars.number(n.p.weight, n.theme), size: Math.min(n.w, n.h) } : null;
  }

  icon(n: RNode): IconSvg | null {
    const r = this.iconRequest(n);
    return r ? (this.icons.get(iconKey(r)) ?? null) : null;
  }

  private placeholder: ImageAsset | null = null;

  /**
   * The checkerboard pen.dev draws for an image fill without an image: 8 pt squares, every other one #808080 at 20 %,
   * starting at the layer's top-left corner. One 16 pt tile at twice the resolution (drawn at half scale).
   */
  placeholderImage(): ImageAsset {
    if (!this.placeholder) {
      const size = 32;
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (((x >> 4) + (y >> 4)) % 2 === 0) continue;
          data.set([128, 128, 128, 51], (y * size + x) * 4);
        }
      }
      const png = encodePng({ width: size, height: size, data });
      this.placeholder = { ref: `images/${createHash('sha1').update(png).digest('hex')}.png`, data: png };
      this.images.set('#placeholder', this.placeholder);
    }
    return this.placeholder;
  }

  /** Stores an image for the Sketch document; null when it cannot be read or converted. */
  image(url: string, where: string): ImageAsset | null {
    if (this.images.has(url)) return this.images.get(url)!;
    let data = this.load(url);
    let asset: ImageAsset | null = null;
    if (!data) this.report.warn('missing-image', 'Image not found – the fill was left out', `${where}: ${url.slice(0, 120)}`);
    else {
      let type = imageType(data);
      if (type !== 'png' && type !== 'jpg') {
        const png = type === 'svg' ? null : toPng(data);
        if (png) {
          data = png;
          type = 'png';
        } else {
          this.report.warn('image-format', 'Image format Sketch cannot store (convert it to PNG or JPEG) – the fill was left out', `${where}: ${url.slice(0, 120)}`);
          data = null;
        }
      }
      if (data) {
        const hash = createHash('sha1').update(data).digest('hex');
        asset = { ref: `images/${hash}.${type === 'jpg' ? 'jpg' : 'png'}`, data };
        this.report.stats.images++;
      }
    }
    this.images.set(url, asset);
    return asset;
  }
}
