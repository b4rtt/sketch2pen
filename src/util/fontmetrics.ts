// Horizontal metrics of OpenType / TrueType fonts for text measurement: character → glyph (cmap), advance widths
// (hmtx), pair kerning (GPOS PairPos or the legacy kern table) and vertical metrics. No shaping beyond kerning –
// enough to reproduce how wide a line of text is and where it wraps.

export interface VerticalMetrics {
  /** in em units (1 = font size), ascender positive, descender positive (below the baseline) */
  ascender: number;
  descender: number;
  lineGap: number;
}

export class FontMetrics {
  readonly unitsPerEm: number;
  readonly vertical: VerticalMetrics;
  private view: DataView;
  private tables = new Map<string, { offset: number; length: number }>();
  private cmap = new Map<number, number>();
  private advances: Uint16Array = new Uint16Array(0);
  private kernCache = new Map<number, number>();
  private pairLookups: number[] = []; // offsets of PairPos subtables
  private legacyKern = new Map<number, number>();

  constructor(data: Uint8Array, faceIndex = 0) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let base = 0;
    if (this.tag(0) === 'ttcf') base = this.view.getUint32(12 + faceIndex * 4);
    const numTables = this.view.getUint16(base + 4);
    for (let i = 0; i < numTables; i++) {
      const r = base + 12 + i * 16;
      this.tables.set(this.tag(r), { offset: this.view.getUint32(r + 8), length: this.view.getUint32(r + 12) });
    }
    const head = this.table('head');
    this.unitsPerEm = head ? this.view.getUint16(head + 18) || 1000 : 1000;
    this.vertical = this.readVertical();
    this.readCmap();
    this.readHmtx();
    this.readGpos();
    if (!this.pairLookups.length) this.readKern();
  }

  private tag(o: number): string {
    return String.fromCharCode(this.view.getUint8(o), this.view.getUint8(o + 1), this.view.getUint8(o + 2), this.view.getUint8(o + 3));
  }

  private table(tag: string): number | null {
    return this.tables.get(tag)?.offset ?? null;
  }

  private readVertical(): VerticalMetrics {
    const em = this.unitsPerEm;
    const hhea = this.table('hhea');
    const os2 = this.table('OS/2');
    let asc = 0.8 * em;
    let desc = 0.2 * em;
    let gap = 0;
    if (hhea !== null) {
      asc = this.view.getInt16(hhea + 4);
      desc = -this.view.getInt16(hhea + 6);
      gap = this.view.getInt16(hhea + 8);
    }
    // fonts that ask for their typographic metrics (USE_TYPO_METRICS), or have no usable hhea values
    if (os2 !== null && (this.tables.get('OS/2')?.length ?? 0) >= 78) {
      const useTypo = (this.view.getUint16(os2 + 62) & 0x80) !== 0;
      const typoAsc = this.view.getInt16(os2 + 68);
      const typoDesc = -this.view.getInt16(os2 + 70);
      const typoGap = this.view.getInt16(os2 + 72);
      if (useTypo || (asc === 0 && desc === 0)) {
        asc = typoAsc;
        desc = typoDesc;
        gap = typoGap;
      }
    }
    return { ascender: asc / em, descender: desc / em, lineGap: Math.max(0, gap) / em };
  }

  private readCmap(): void {
    const cmap = this.table('cmap');
    if (cmap === null) return;
    const v = this.view;
    const n = v.getUint16(cmap + 2);
    let best: { offset: number; score: number } | null = null;
    for (let i = 0; i < n; i++) {
      const platform = v.getUint16(cmap + 4 + i * 8);
      const encoding = v.getUint16(cmap + 6 + i * 8);
      const offset = cmap + v.getUint32(cmap + 8 + i * 8);
      const format = v.getUint16(offset);
      let score = 0;
      if (format === 12 && (platform === 3 || platform === 0)) score = 4;
      else if (format === 4 && ((platform === 3 && (encoding === 1 || encoding === 0)) || platform === 0)) score = 3;
      if (platform === 3 && encoding === 0) score = Math.min(score, 1); // symbol fonts
      if (score && (!best || score > best.score)) best = { offset, score };
    }
    if (!best) return;
    const o = best.offset;
    const format = v.getUint16(o);
    if (format === 4) {
      const segX2 = v.getUint16(o + 6);
      const ends = o + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const rangeOffsets = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = v.getUint16(ends + s * 2);
        const start = v.getUint16(starts + s * 2);
        const delta = v.getInt16(deltas + s * 2);
        const ro = v.getUint16(rangeOffsets + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g: number;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            const addr = rangeOffsets + s * 2 + ro + (c - start) * 2;
            g = v.getUint16(addr);
            if (g !== 0) g = (g + delta) & 0xffff;
          }
          if (g) this.cmap.set(c, g);
        }
      }
    } else if (format === 12) {
      const groups = v.getUint32(o + 12);
      for (let i = 0; i < groups; i++) {
        const r = o + 16 + i * 12;
        const start = v.getUint32(r);
        const end = v.getUint32(r + 4);
        const glyph = v.getUint32(r + 8);
        if (end - start > 0x30000) continue;
        for (let c = start; c <= end; c++) this.cmap.set(c, glyph + (c - start));
      }
    }
  }

  private readHmtx(): void {
    const hhea = this.table('hhea');
    const hmtx = this.table('hmtx');
    if (hhea === null || hmtx === null) return;
    const n = this.view.getUint16(hhea + 34);
    const maxp = this.table('maxp');
    const glyphs = maxp !== null ? this.view.getUint16(maxp + 4) : n;
    this.advances = new Uint16Array(Math.max(glyphs, n));
    let last = 0;
    for (let g = 0; g < this.advances.length; g++) {
      if (g < n) last = this.view.getUint16(hmtx + g * 4);
      this.advances[g] = last;
    }
  }

  private readGpos(): void {
    const gpos = this.table('GPOS');
    if (gpos === null) return;
    const v = this.view;
    const featureList = gpos + v.getUint16(gpos + 6);
    const lookupList = gpos + v.getUint16(gpos + 8);
    const lookups = new Set<number>();
    const fCount = v.getUint16(featureList);
    for (let i = 0; i < fCount; i++) {
      const r = featureList + 2 + i * 6;
      if (this.tag(r) !== 'kern') continue;
      const feature = featureList + v.getUint16(r + 4);
      const count = v.getUint16(feature + 2);
      for (let k = 0; k < count; k++) lookups.add(v.getUint16(feature + 4 + k * 2));
    }
    for (const index of [...lookups].sort((a, b) => a - b)) {
      const lookup = lookupList + v.getUint16(lookupList + 2 + index * 2);
      const type = v.getUint16(lookup);
      const subCount = v.getUint16(lookup + 4);
      for (let s = 0; s < subCount; s++) {
        let sub = lookup + v.getUint16(lookup + 6 + s * 2);
        let subType = type;
        if (type === 9) {
          subType = v.getUint16(sub + 2);
          sub = sub + v.getUint32(sub + 4);
        }
        if (subType === 2) this.pairLookups.push(sub);
      }
    }
  }

  private readKern(): void {
    const kern = this.table('kern');
    if (kern === null) return;
    const v = this.view;
    if (v.getUint16(kern) !== 0) return; // Apple's newer kern format is rare in fonts pen.dev can load
    const nTables = v.getUint16(kern + 2);
    let o = kern + 4;
    for (let t = 0; t < nTables; t++) {
      const length = v.getUint16(o + 2);
      const coverage = v.getUint16(o + 4);
      if (coverage >> 8 === 0 && (coverage & 1) === 1) {
        const nPairs = v.getUint16(o + 6);
        for (let i = 0; i < nPairs; i++) {
          const r = o + 14 + i * 6;
          this.legacyKern.set((v.getUint16(r) << 16) | v.getUint16(r + 2), v.getInt16(r + 4));
        }
      }
      o += length;
    }
  }

  private coverageIndex(coverage: number, glyph: number): number {
    const v = this.view;
    const format = v.getUint16(coverage);
    if (format === 1) {
      let lo = 0;
      let hi = v.getUint16(coverage + 2) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = v.getUint16(coverage + 4 + mid * 2);
        if (g === glyph) return mid;
        if (g < glyph) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    }
    if (format === 2) {
      let lo = 0;
      let hi = v.getUint16(coverage + 2) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = coverage + 4 + mid * 6;
        const start = v.getUint16(r);
        const end = v.getUint16(r + 2);
        if (glyph < start) hi = mid - 1;
        else if (glyph > end) lo = mid + 1;
        else return v.getUint16(r + 4) + glyph - start;
      }
    }
    return -1;
  }

  private classOf(classDef: number, glyph: number): number {
    const v = this.view;
    const format = v.getUint16(classDef);
    if (format === 1) {
      const start = v.getUint16(classDef + 2);
      const count = v.getUint16(classDef + 4);
      return glyph >= start && glyph < start + count ? v.getUint16(classDef + 6 + (glyph - start) * 2) : 0;
    }
    if (format === 2) {
      let lo = 0;
      let hi = v.getUint16(classDef + 2) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = classDef + 4 + mid * 6;
        const start = v.getUint16(r);
        const end = v.getUint16(r + 2);
        if (glyph < start) hi = mid - 1;
        else if (glyph > end) lo = mid + 1;
        else return v.getUint16(r + 4);
      }
    }
    return 0;
  }

  /** xAdvance of the first value record of a pair (font units). */
  private static valueSize(format: number): number {
    let n = 0;
    for (let f = format; f; f >>= 1) n += f & 1;
    return n * 2;
  }

  private xAdvance(record: number, format: number): number {
    if (!(format & 0x4)) return 0;
    let o = record;
    if (format & 0x1) o += 2;
    if (format & 0x2) o += 2;
    return this.view.getInt16(o);
  }

  private pairKern(left: number, right: number): number {
    const v = this.view;
    for (const sub of this.pairLookups) {
      const format = v.getUint16(sub);
      const cov = this.coverageIndex(sub + v.getUint16(sub + 2), left);
      if (cov < 0) continue;
      const vf1 = v.getUint16(sub + 4);
      const vf2 = v.getUint16(sub + 6);
      const s1 = FontMetrics.valueSize(vf1);
      const s2 = FontMetrics.valueSize(vf2);
      if (format === 1) {
        const setCount = v.getUint16(sub + 8);
        if (cov >= setCount) continue;
        const set = sub + v.getUint16(sub + 10 + cov * 2);
        const count = v.getUint16(set);
        const recSize = 2 + s1 + s2;
        let lo = 0;
        let hi = count - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const r = set + 2 + mid * recSize;
          const g = v.getUint16(r);
          if (g === right) return this.xAdvance(r + 2, vf1);
          if (g < right) lo = mid + 1;
          else hi = mid - 1;
        }
      } else if (format === 2) {
        const c1 = this.classOf(sub + v.getUint16(sub + 8), left);
        const c2 = this.classOf(sub + v.getUint16(sub + 10), right);
        const class1Count = v.getUint16(sub + 12);
        const class2Count = v.getUint16(sub + 14);
        if (c1 >= class1Count || c2 >= class2Count) continue;
        const r = sub + 16 + (c1 * class2Count + c2) * (s1 + s2);
        const adv = this.xAdvance(r, vf1);
        if (adv) return adv;
        // a zero entry in a class subtable ends the search for this pair (OpenType semantics)
        return 0;
      }
    }
    return 0;
  }

  /** Number of glyphs (maxp). */
  get glyphCount(): number {
    const maxp = this.table('maxp');
    return maxp !== null ? this.view.getUint16(maxp + 4) : 0;
  }

  /**
   * Outline of a TrueType glyph as SVG path data in font units, y pointing down (baseline at 0). Composite glyphs are
   * resolved (offsets only). Null for fonts without a glyf table (CFF).
   */
  outline(glyph: number, depth = 0): string | null {
    const head = this.table('head');
    const loca = this.table('loca');
    const glyf = this.table('glyf');
    if (head === null || loca === null || glyf === null || depth > 8) return null;
    const v = this.view;
    const long = v.getInt16(head + 50) === 1;
    const at = (i: number) => (long ? v.getUint32(loca + i * 4) : v.getUint16(loca + i * 2) * 2);
    const start = at(glyph);
    const end = at(glyph + 1);
    if (end <= start) return '';
    const g = glyf + start;
    const contours = v.getInt16(g);
    const f = (n: number) => Math.round(n * 100) / 100;
    if (contours < 0) {
      // composite: components with x/y offsets
      let d = '';
      let o = g + 10;
      for (;;) {
        const flags = v.getUint16(o);
        const index = v.getUint16(o + 2);
        o += 4;
        let dx = 0;
        let dy = 0;
        if (flags & 1) {
          dx = v.getInt16(o);
          dy = v.getInt16(o + 2);
          o += 4;
        } else {
          dx = v.getInt8(o);
          dy = v.getInt8(o + 1);
          o += 2;
        }
        let a = 1, b = 0, c = 0, e = 1;
        if (flags & 0x8) {
          a = e = v.getInt16(o) / 16384;
          o += 2;
        } else if (flags & 0x40) {
          a = v.getInt16(o) / 16384;
          e = v.getInt16(o + 2) / 16384;
          o += 4;
        } else if (flags & 0x80) {
          a = v.getInt16(o) / 16384;
          b = v.getInt16(o + 2) / 16384;
          c = v.getInt16(o + 4) / 16384;
          e = v.getInt16(o + 6) / 16384;
          o += 8;
        }
        const part = this.outline(index, depth + 1) ?? '';
        // transform the component's path (y down: flip the offset)
        d += part.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, xs: string, ys: string) => {
          const x = Number(xs);
          const y = -Number(ys);
          return `${f(a * x + c * y + dx)} ${f(-(b * x + e * y + dy))}`;
        });
        if (!(flags & 0x20)) break;
      }
      return d;
    }
    const endPts: number[] = [];
    for (let i = 0; i < contours; i++) endPts.push(v.getUint16(g + 10 + i * 2));
    const n = contours ? endPts[contours - 1]! + 1 : 0;
    const instrLen = v.getUint16(g + 10 + contours * 2);
    let o = g + 12 + contours * 2 + instrLen;
    const flags: number[] = [];
    while (flags.length < n) {
      const fl = v.getUint8(o++);
      flags.push(fl);
      if (fl & 8) {
        let rep = v.getUint8(o++);
        while (rep-- > 0) flags.push(fl);
      }
    }
    const xs: number[] = [];
    const ys: number[] = [];
    let x = 0;
    for (const fl of flags) {
      if (fl & 2) {
        const dx = v.getUint8(o++);
        x += fl & 16 ? dx : -dx;
      } else if (!(fl & 16)) {
        x += v.getInt16(o);
        o += 2;
      }
      xs.push(x);
    }
    let y = 0;
    for (const fl of flags) {
      if (fl & 4) {
        const dy = v.getUint8(o++);
        y += fl & 32 ? dy : -dy;
      } else if (!(fl & 32)) {
        y += v.getInt16(o);
        o += 2;
      }
      ys.push(y);
    }
    let d = '';
    let first = 0;
    for (const last of endPts) {
      const pts: { x: number; y: number; on: boolean }[] = [];
      for (let i = first; i <= last; i++) pts.push({ x: xs[i]!, y: -ys[i]!, on: (flags[i]! & 1) === 1 });
      first = last + 1;
      if (!pts.length) continue;
      // start on an on-curve point (or the midpoint of two off-curve ones)
      let startIdx = pts.findIndex((p) => p.on);
      let startPt: { x: number; y: number };
      if (startIdx < 0) {
        startPt = { x: (pts[0]!.x + pts[1 % pts.length]!.x) / 2, y: (pts[0]!.y + pts[1 % pts.length]!.y) / 2 };
        startIdx = 0;
      } else startPt = pts[startIdx]!;
      d += `M${f(startPt.x)} ${f(startPt.y)}`;
      let ctrl: { x: number; y: number } | null = null;
      for (let k = 1; k <= pts.length; k++) {
        const p = pts[(startIdx + k) % pts.length]!;
        const isStart = k === pts.length;
        const target = isStart ? startPt : p;
        if (!isStart && !p.on) {
          if (ctrl) {
            const mid = { x: (ctrl.x + p.x) / 2, y: (ctrl.y + p.y) / 2 };
            d += `Q${f(ctrl.x)} ${f(ctrl.y)} ${f(mid.x)} ${f(mid.y)}`;
          }
          ctrl = p;
          continue;
        }
        if (ctrl) d += `Q${f(ctrl.x)} ${f(ctrl.y)} ${f(target.x)} ${f(target.y)}`;
        else d += `L${f(target.x)} ${f(target.y)}`;
        ctrl = null;
      }
      d += 'Z';
    }
    return d;
  }

  /** The glyph a ligature-forming font (icon fonts like Material Symbols) shows for a whole string, if any. */
  ligature(text: string): number | null {
    const gsub = this.table('GSUB');
    if (gsub === null) return null;
    const v = this.view;
    const glyphs = [...text].map((ch) => this.glyph(ch.codePointAt(0)!));
    if (!glyphs.length || glyphs.some((g) => !g)) return null;
    const featureList = gsub + v.getUint16(gsub + 6);
    const lookupList = gsub + v.getUint16(gsub + 8);
    const lookups = new Set<number>();
    const fCount = v.getUint16(featureList);
    for (let i = 0; i < fCount; i++) {
      const r = featureList + 2 + i * 6;
      const tag = this.tag(r);
      if (tag !== 'liga' && tag !== 'rlig' && tag !== 'dlig' && tag !== 'calt') continue;
      const feature = featureList + v.getUint16(r + 4);
      const count = v.getUint16(feature + 2);
      for (let k = 0; k < count; k++) lookups.add(v.getUint16(feature + 4 + k * 2));
    }
    for (const index of [...lookups].sort((a, b) => a - b)) {
      const lookup = lookupList + v.getUint16(lookupList + 2 + index * 2);
      const type = v.getUint16(lookup);
      const subCount = v.getUint16(lookup + 4);
      for (let s = 0; s < subCount; s++) {
        let sub = lookup + v.getUint16(lookup + 6 + s * 2);
        let subType = type;
        if (type === 7) {
          subType = v.getUint16(sub + 2);
          sub = sub + v.getUint32(sub + 4);
        }
        if (subType !== 4) continue;
        const cov = this.coverageIndex(sub + v.getUint16(sub + 2), glyphs[0]!);
        if (cov < 0) continue;
        const set = sub + v.getUint16(sub + 6 + cov * 2);
        const ligCount = v.getUint16(set);
        for (let l = 0; l < ligCount; l++) {
          const lig = set + v.getUint16(set + 2 + l * 2);
          const ligGlyph = v.getUint16(lig);
          const comps = v.getUint16(lig + 2);
          if (comps !== glyphs.length) continue;
          let match = true;
          for (let c = 1; c < comps; c++) if (v.getUint16(lig + 4 + (c - 1) * 2) !== glyphs[c]) match = false;
          if (match) return ligGlyph;
        }
      }
    }
    return null;
  }

  glyph(codePoint: number): number {
    return this.cmap.get(codePoint) ?? 0;
  }

  hasGlyph(codePoint: number): boolean {
    return this.cmap.has(codePoint);
  }

  /** Advance of a glyph in em units. */
  advance(glyph: number): number {
    return (this.advances[glyph] ?? this.advances[this.advances.length - 1] ?? this.unitsPerEm / 2) / this.unitsPerEm;
  }

  /** Kerning between two glyphs in em units. */
  kerning(left: number, right: number): number {
    const key = left * 65536 + right;
    let k = this.kernCache.get(key);
    if (k === undefined) {
      k = this.pairLookups.length ? this.pairKern(left, right) : (this.legacyKern.get((left << 16) | right) ?? 0);
      this.kernCache.set(key, k);
    }
    return k / this.unitsPerEm;
  }
}
