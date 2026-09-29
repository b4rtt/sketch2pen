// Minimal image codec layer (pure JS) for the few cases where the converter has to change pixels,
// e.g. baking a Sketch alpha mask into an image because pen.dev has no opacity masks.
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export interface RGBA {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, row major */
  data: Uint8Array;
}

export function decodeImage(bytes: Uint8Array): RGBA | null {
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
      return { width: img.width, height: img.height, data: img.data };
    }
  } catch {
    return null;
  }
  return null;
}

export function encodePng(img: RGBA): Uint8Array {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return new Uint8Array(PNG.sync.write(png));
}
