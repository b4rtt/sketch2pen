// The .pen document schema: everything the Sketch → pen.dev converter writes (version 2.18) and the pen.dev → Sketch
// converter reads (up to 2.19). Source of truth: the pen.dev `pen-schema.md` skill document.

export type Sizing = number | string; // number or 'fit_content' / 'fill_container'

export type PenBlendMode =
  | 'normal' | 'darken' | 'multiply' | 'linearBurn' | 'colorBurn' | 'light' | 'screen' | 'linearDodge'
  | 'colorDodge' | 'overlay' | 'softLight' | 'hardLight' | 'difference' | 'exclusion' | 'hue'
  | 'saturation' | 'color' | 'luminosity';

export type PenFill =
  | string
  | { type: 'color'; color: string; blendMode?: PenBlendMode; enabled?: boolean }
  | {
      type: 'gradient';
      gradientType: 'linear' | 'radial' | 'angular';
      center?: { x: number; y: number };
      size?: { width?: number; height?: number };
      rotation?: number;
      opacity?: number;
      colors: { color: string; position: number }[];
      blendMode?: PenBlendMode;
      enabled?: boolean;
    }
  | { type: 'image'; url: string; mode?: 'stretch' | 'fill' | 'fit'; opacity?: number; blendMode?: PenBlendMode; enabled?: boolean }
  | { type: 'shader'; url: string; opacity?: number; blendMode?: PenBlendMode; enabled?: boolean; uniforms?: Record<string, unknown> }
  | {
      type: 'mesh_gradient';
      columns?: number;
      rows?: number;
      colors?: string[];
      points?: unknown[];
      opacity?: number;
      blendMode?: PenBlendMode;
      enabled?: boolean;
    };

export type PenEffect =
  | { type: 'blur'; radius: number; enabled?: boolean }
  | { type: 'background_blur'; radius: number; enabled?: boolean }
  | {
      type: 'shadow';
      shadowType?: 'inner' | 'outer';
      offset?: { x: number; y: number };
      spread?: number;
      blur?: number;
      color?: string;
      blendMode?: PenBlendMode;
      enabled?: boolean;
    };

export type StrokeWidth = number | { top?: number; right?: number; bottom?: number; left?: number };

export type PenNodeType =
  | 'frame' | 'group' | 'rectangle' | 'ellipse' | 'path' | 'polygon' | 'text' | 'ref'
  // read only: canvas annotations, icon-library glyphs, generated content and live web pages
  | 'note' | 'prompt' | 'context' | 'icon' | 'script' | 'browser' | 'line';

/** Theme axis → value, e.g. { mode: 'dark' }. */
export type PenTheme = Record<string, string>;

export interface PenNode {
  type: PenNodeType;
  id: string;
  name?: string;
  x?: number;
  y?: number;
  width?: Sizing;
  height?: Sizing;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  opacity?: number;
  enabled?: boolean;
  layoutPosition?: 'auto' | 'absolute';
  reusable?: boolean;
  /** theme axis values for this subtree (variables resolve against them) */
  theme?: PenTheme;
  metadata?: { type: string; [key: string]: unknown };

  fill?: PenFill | PenFill[];
  stroke?: PenFill | PenFill[];
  strokeWidth?: StrokeWidth;
  strokeAlignment?: 'inner' | 'center' | 'outer';
  strokeLinecap?: 'butt' | 'round' | 'square';
  strokeLinejoin?: 'miter' | 'bevel' | 'round';
  effect?: PenEffect | PenEffect[];
  cornerRadius?: number | [number, number, number, number];

  // frame
  clip?: boolean;
  layout?: 'none' | 'vertical' | 'horizontal';
  gap?: number;
  padding?: number | [number, number] | [number, number, number, number];
  justifyContent?: 'start' | 'center' | 'end' | 'space_between' | 'space_around';
  alignItems?: 'start' | 'center' | 'end';
  children?: PenNode[];
  layoutIncludeStroke?: boolean;
  slot?: false | string[];
  placeholder?: boolean;

  // path
  geometry?: string;
  viewBox?: [number, number, number, number];
  fillRule?: 'nonzero' | 'evenodd';

  // text
  content?: string;
  textGrowth?: 'auto' | 'fixed-width' | 'fixed-width-height';
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  letterSpacing?: number;
  lineHeight?: number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  textAlignVertical?: 'top' | 'middle' | 'bottom';
  underline?: boolean;
  strikethrough?: boolean;

  // ref (component instance)
  ref?: string;
  descendants?: Record<string, Record<string, unknown>>;

  // polygon / ellipse
  polygonCount?: number;
  innerRadius?: number;
  startAngle?: number;
  sweepAngle?: number;

  // icon
  library?: string;
  icon?: string;
  weight?: number;

  // browser
  url?: string;
}

/** A font file shipped with the document (pen.dev's document font library). */
export interface PenFont {
  name: string;
  /** relative to the .pen file */
  url: string;
  weight?: number | [number, number];
  style?: 'italic';
  axes?: { tag: string; start: number; end: number }[];
}

export type PenVariableValue = unknown | { value: unknown; theme?: PenTheme }[];

export interface PenVariable {
  type: 'color' | 'number' | 'string' | 'boolean';
  value: PenVariableValue;
}

export interface PenDocument {
  version: string;
  fonts?: PenFont[];
  themes?: Record<string, string[]>;
  imports?: Record<string, string>;
  variables?: Record<string, PenVariable>;
  children: PenNode[];
}
