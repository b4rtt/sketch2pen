// Subset of the .pen document schema (version 2.18) produced by the converter.
// Source of truth: the pen.dev `pen-schema.md` skill document.

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
  | { type: 'image'; url: string; mode?: 'stretch' | 'fill' | 'fit'; opacity?: number; blendMode?: PenBlendMode; enabled?: boolean };

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

export interface PenNode {
  type: 'frame' | 'group' | 'rectangle' | 'ellipse' | 'path' | 'polygon' | 'text' | 'ref';
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
  padding?: number | [number, number, number, number];
  justifyContent?: 'start' | 'center' | 'end' | 'space_between' | 'space_around';
  alignItems?: 'start' | 'center' | 'end';
  children?: PenNode[];

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

export interface PenDocument {
  version: '2.18';
  fonts?: PenFont[];
  variables?: Record<string, { type: 'color' | 'number' | 'string' | 'boolean'; value: unknown }>;
  children: PenNode[];
}
