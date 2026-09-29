// Builds minimal OpenType files (name, OS/2 and optionally fvar tables) – enough for the font resolver, which only
// reads naming and variation data.

export interface TestFont {
  family: string;
  subfamily: string;
  postscriptName: string;
  weight: number;
  italic?: boolean;
  /** variation axes: tag, min, default, max */
  axes?: [string, number, number, number][];
  /** named instances; `ps` omitted → the record carries no PostScript name id */
  instances?: { subfamily: string; coords: number[]; ps?: string }[];
  /** name id 25 (variations PostScript name prefix) */
  prefix?: string;
}

function table(size: number): { buf: Buffer; at: number } {
  return { buf: Buffer.alloc(size), at: 0 };
}

function nameTable(names: [number, string][]): Buffer {
  const strings = names.map(([, s]) => Buffer.from(s, 'utf16le').swap16());
  const header = 6 + names.length * 12;
  const t = table(header + strings.reduce((n, b) => n + b.length, 0));
  t.buf.writeUInt16BE(0, 0);
  t.buf.writeUInt16BE(names.length, 2);
  t.buf.writeUInt16BE(header, 4);
  let off = 0;
  names.forEach(([id], i) => {
    const r = 6 + i * 12;
    t.buf.writeUInt16BE(3, r); // Windows
    t.buf.writeUInt16BE(1, r + 2); // Unicode BMP
    t.buf.writeUInt16BE(0x409, r + 4); // en-US
    t.buf.writeUInt16BE(id, r + 6);
    t.buf.writeUInt16BE(strings[i]!.length, r + 8);
    t.buf.writeUInt16BE(off, r + 10);
    strings[i]!.copy(t.buf, header + off);
    off += strings[i]!.length;
  });
  return t.buf;
}

function os2(weight: number, italic: boolean): Buffer {
  const b = Buffer.alloc(96);
  b.writeUInt16BE(4, 0); // version
  b.writeUInt16BE(weight, 4);
  b.writeUInt16BE(italic ? 1 : 0x40, 62); // fsSelection: ITALIC or REGULAR
  return b;
}

function fvar(font: TestFont, nameIds: Map<string, number>): Buffer {
  const axes = font.axes ?? [];
  const insts = font.instances ?? [];
  const withPs = insts.some((i) => i.ps);
  const instanceSize = 4 + axes.length * 4 + (withPs ? 2 : 0);
  const b = Buffer.alloc(16 + axes.length * 20 + insts.length * instanceSize);
  b.writeUInt16BE(1, 0);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(16, 4);
  b.writeUInt16BE(2, 6);
  b.writeUInt16BE(axes.length, 8);
  b.writeUInt16BE(20, 10);
  b.writeUInt16BE(insts.length, 12);
  b.writeUInt16BE(instanceSize, 14);
  axes.forEach(([tag, min, def, max], a) => {
    const o = 16 + a * 20;
    b.write(tag, o, 'latin1');
    b.writeInt32BE(Math.round(min * 65536), o + 4);
    b.writeInt32BE(Math.round(def * 65536), o + 8);
    b.writeInt32BE(Math.round(max * 65536), o + 12);
    b.writeUInt16BE(nameIds.get(`axis:${tag}`)!, o + 18);
  });
  insts.forEach((inst, i) => {
    const o = 16 + axes.length * 20 + i * instanceSize;
    b.writeUInt16BE(nameIds.get(`sub:${inst.subfamily}`)!, o);
    inst.coords.forEach((c, k) => b.writeInt32BE(Math.round(c * 65536), o + 4 + k * 4));
    if (withPs) b.writeUInt16BE(inst.ps ? nameIds.get(`ps:${inst.ps}`)! : 0xffff, o + 4 + axes.length * 4);
  });
  return b;
}

/** A syntactically valid OpenType file with the given naming, weight and variation data. */
export function buildFont(font: TestFont): Uint8Array {
  const names: [number, string][] = [
    [1, font.family],
    [2, font.subfamily],
    [4, `${font.family} ${font.subfamily}`],
    [6, font.postscriptName],
  ];
  if (font.prefix) names.push([25, font.prefix]);
  const ids = new Map<string, number>();
  let next = 256;
  for (const [tag] of font.axes ?? []) {
    ids.set(`axis:${tag}`, next);
    names.push([next++, tag]);
  }
  for (const inst of font.instances ?? []) {
    if (!ids.has(`sub:${inst.subfamily}`)) {
      ids.set(`sub:${inst.subfamily}`, next);
      names.push([next++, inst.subfamily]);
    }
    if (inst.ps) {
      ids.set(`ps:${inst.ps}`, next);
      names.push([next++, inst.ps]);
    }
  }
  names.sort((a, b) => a[0] - b[0]);
  const tables: [string, Buffer][] = [
    ['OS/2', os2(font.weight, !!font.italic)],
    ...(font.axes?.length ? ([['fvar', fvar(font, ids)]] as [string, Buffer][]) : []),
    ['name', nameTable(names)],
  ];
  const header = 12 + tables.length * 16;
  const out = Buffer.alloc(header + tables.reduce((n, [, b]) => n + ((b.length + 3) & ~3), 0));
  out.writeUInt32BE(0x00010000, 0);
  out.writeUInt16BE(tables.length, 4);
  let off = header;
  tables.forEach(([tag, data], i) => {
    const r = 12 + i * 16;
    out.write(tag, r, 'latin1');
    out.writeUInt32BE(off, r + 8);
    out.writeUInt32BE(data.length, r + 12);
    data.copy(out, off);
    off += (data.length + 3) & ~3;
  });
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
