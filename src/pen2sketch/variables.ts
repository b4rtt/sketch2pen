import type { PenDocument, PenTheme, PenVariable } from '../pen/types.ts';

/** A colour as Sketch needs it, remembering the variable it came from (→ colour swatch). */
export interface ResolvedColor {
  /** #RRGGBBAA, upper case */
  hex: string;
  /** variable the colour is bound to, when it is used unchanged */
  variable?: string;
}

/** #RGB, #RGBA, #RRGGBB, #RRGGBBAA → #RRGGBBAA (upper case); null for anything else. */
export function normalizeHex(value: string): string | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  if (h.length === 6) h += 'FF';
  return `#${h.toUpperCase()}`;
}

export function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } {
  const h = normalizeHex(hex) ?? '#000000FF';
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(1), g: n(3), b: n(5), a: n(7) };
}

const NAMED: Record<string, string> = {
  black: '#000000FF',
  white: '#FFFFFFFF',
  transparent: '#00000000',
  red: '#FF0000FF',
  green: '#008000FF',
  blue: '#0000FFFF',
};

/**
 * Variables and themes of a document. Values can be themed (a list of `{value, theme}` entries) and can refer to
 * other variables; a node's `theme` property selects the theme for its subtree.
 */
export class Variables {
  readonly defaultTheme: PenTheme;
  private vars: Record<string, PenVariable>;

  constructor(doc: PenDocument) {
    this.vars = doc.variables ?? {};
    this.defaultTheme = {};
    for (const [axis, values] of Object.entries(doc.themes ?? {})) if (values.length) this.defaultTheme[axis] = values[0]!;
    // themes only declared through variable values still have a default: the first value seen
    for (const v of Object.values(this.vars)) {
      if (!Array.isArray(v.value)) continue;
      for (const e of v.value as { theme?: PenTheme }[]) for (const [axis, value] of Object.entries(e?.theme ?? {})) this.defaultTheme[axis] ??= value;
    }
  }

  names(): string[] {
    return Object.keys(this.vars);
  }

  type(name: string): PenVariable['type'] | undefined {
    return this.vars[name]?.type;
  }

  /** The variable a value refers to ("$name" → "name"), when such a variable exists. */
  refName(value: unknown): string | null {
    if (typeof value !== 'string' || !value.startsWith('$')) return null;
    const name = value.slice(1);
    return name in this.vars ? name : null;
  }

  /** The theme in effect below a node that sets `theme` (axes it does not set are inherited). */
  child(theme: PenTheme, own: PenTheme | undefined): PenTheme {
    return own && Object.keys(own).length ? { ...theme, ...own } : theme;
  }

  /** Value of a variable for a theme: the entry matching the most axes (entries for other values never match). */
  private pick(v: PenVariable, theme: PenTheme): unknown {
    if (!Array.isArray(v.value)) return v.value;
    const entries = v.value as { value: unknown; theme?: PenTheme }[];
    let best: { value: unknown } | undefined;
    let bestScore = -1;
    for (const e of entries) {
      if (!e || typeof e !== 'object' || !('value' in e)) continue;
      const axes = Object.entries(e.theme ?? {});
      if (axes.some(([k, val]) => (theme[k] ?? this.defaultTheme[k]) !== val)) continue;
      if (axes.length > bestScore) {
        best = e;
        bestScore = axes.length;
      }
    }
    return (best ?? entries[0])?.value;
  }

  /** Resolves a property value: variable references are replaced by their value (recursively). */
  value(value: unknown, theme: PenTheme = this.defaultTheme): unknown {
    let v = value;
    for (let depth = 0; depth < 16; depth++) {
      const name = this.refName(v);
      if (!name) return v;
      v = this.pick(this.vars[name]!, theme);
    }
    return v;
  }

  /** Resolves variables anywhere inside a value (paint objects, effect lists, gradient stops …). */
  deep(value: unknown, theme: PenTheme = this.defaultTheme): unknown {
    const v = this.value(value, theme);
    if (Array.isArray(v)) return v.map((x) => this.deep(x, theme));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.deep(x, theme)]));
    return v;
  }

  number(value: unknown, theme?: PenTheme): number | undefined {
    const v = this.value(value, theme);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return undefined;
  }

  string(value: unknown, theme?: PenTheme): string | undefined {
    const v = this.value(value, theme);
    if (v === undefined || v === null) return undefined;
    return String(v);
  }

  bool(value: unknown, theme?: PenTheme): boolean | undefined {
    const v = this.value(value, theme);
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return undefined;
  }

  color(value: unknown, theme?: PenTheme): ResolvedColor | null {
    const variable = this.refName(value) ?? undefined;
    const v = this.value(value, theme);
    if (typeof v !== 'string') return null;
    const hex = normalizeHex(v) ?? NAMED[v.trim().toLowerCase()] ?? null;
    if (!hex) return null;
    return variable ? { hex, variable } : { hex };
  }

  /** Default-theme value of a colour variable (for the Sketch swatch). */
  swatchValue(name: string): string | null {
    const v = this.vars[name];
    if (!v || v.type !== 'color') return null;
    return this.color(`$${name}`, this.defaultTheme)?.hex ?? null;
  }
}
