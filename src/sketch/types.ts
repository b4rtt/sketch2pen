// Minimal typings for the parts of the Sketch file format (up to Sketch 2026) that the converter reads.
// The official schema (@sketch-hq/sketch-file-format) stops at 2023, so newer fields
// (frames, stacks, pins, style.corners, style.blurs) are typed from observed files.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
  swatchID?: string;
}

export interface GraphicsContext {
  blendMode: number;
  opacity: number;
}

export interface GradientStop {
  position: number;
  color: SColor;
}

export interface Gradient {
  gradientType: number; // 0 linear, 1 radial, 2 angular
  from: string; // "{x, y}" normalized to the layer frame
  to: string;
  elipseLength: number;
  stops: GradientStop[];
}

export interface FileRef {
  _ref: string;
  _ref_class?: string;
}

export interface Fill {
  isEnabled: boolean;
  fillType: number; // 0 color, 1 gradient, 4 image (pattern), 5 noise
  color: SColor;
  gradient: Gradient;
  contextSettings?: GraphicsContext;
  image?: FileRef;
  patternFillType?: number; // 0 tile, 1 fill, 2 stretch, 3 fit
  patternTileScale?: number;
  /** 0 normal, 1 tint (recolours the content of groups/frames/instances), 2 prototype overlay backdrop */
  layeringType?: number;
}

export interface Border extends Fill {
  position: number; // 0 center, 1 inside, 2 outside
  thickness: number;
}

export interface Shadow {
  isEnabled: boolean;
  blurRadius: number;
  offsetX: number;
  offsetY: number;
  spread: number;
  color: SColor;
  contextSettings?: GraphicsContext;
  isInnerShadow?: boolean;
}

export interface Blur {
  isEnabled: boolean;
  type: number; // 0 gaussian, 1 motion, 2 zoom, 3 background, 4 glass
  radius: number;
}

export interface Corners {
  radii: number[];
  style: number;
  smoothing: number;
}

export interface BorderOptions {
  isEnabled: boolean;
  dashPattern: number[];
  lineCapStyle: number; // 0 butt, 1 round, 2 square
  lineJoinStyle: number; // 0 miter, 1 round, 2 bevel
}

export interface FontDescriptor {
  attributes: { name: string; size: number; variation?: Record<string, number> };
}

export interface ParagraphStyle {
  alignment?: number; // 0 left, 1 right, 2 center, 3 justified, 4 natural
  maximumLineHeight?: number;
  minimumLineHeight?: number;
  paragraphSpacing?: number;
}

export interface TextAttributes {
  MSAttributedStringFontAttribute?: FontDescriptor;
  MSAttributedStringColorAttribute?: SColor;
  MSAttributedStringTextTransformAttribute?: number; // 1 uppercase, 2 lowercase
  paragraphStyle?: ParagraphStyle;
  kerning?: number;
  underlineStyle?: number;
  strikethroughStyle?: number;
  textStyleVerticalAlignmentKey?: number;
}

export interface StringAttribute {
  location: number;
  length: number;
  attributes: TextAttributes;
}

export interface TextStyle {
  encodedAttributes: TextAttributes;
  verticalAlignment?: number;
}

export interface Style {
  fills?: Fill[];
  borders?: Border[];
  borderOptions?: BorderOptions;
  shadows?: Shadow[];
  innerShadows?: Shadow[]; // pre-2025 files
  blur?: Blur; // pre-2025 files
  blurs?: Blur[];
  contextSettings?: GraphicsContext;
  textStyle?: TextStyle;
  windingRule?: number; // 0 non-zero, 1 even-odd
  corners?: Corners;
  startMarkerType?: number;
  endMarkerType?: number;
}

export interface CurvePoint {
  point: string;
  curveFrom: string;
  curveTo: string;
  hasCurveFrom: boolean;
  hasCurveTo: boolean;
  curveMode: number;
  cornerRadius: number;
}

export interface FlexGroupLayout {
  _class: 'MSImmutableFlexGroupLayout';
  flexDirection: number; // 0 horizontal, 1 vertical
  justifyContent: number; // 0 start, 1 center, 2 end, 3 space-between
  alignItems: number; // 0 start, 1 center, 2 end, 3 stretch
  allGuttersGap: number;
  crossAxisGutterGap: number;
  wrappingEnabled: boolean;
}

export interface FlexItem {
  alignSelf: number;
  ignoreLayout: boolean;
  preserveSpaceWhenHidden: boolean;
}

export interface OverrideValue {
  overrideName: string;
  value: unknown;
}

export interface Layer {
  _class: string;
  do_objectID: string;
  name: string;
  frame: Rect;
  isVisible: boolean;
  isLocked?: boolean;
  rotation?: number;
  isFlippedHorizontal?: boolean;
  isFlippedVertical?: boolean;
  style?: Style;
  layers?: Layer[];
  booleanOperation?: number; // -1 none, 0 union, 1 subtract, 2 intersect, 3 difference
  hasClippingMask?: boolean;
  clippingMaskMode?: number; // 0 outline, 1 alpha
  shouldBreakMaskChain?: boolean;

  // Sizing & pinning (Sketch 2025+)
  horizontalSizing?: number; // 0 fixed, 1 fit, 2 fill, 3 relative
  verticalSizing?: number;
  horizontalPins?: number; // bit 1 = min edge, bit 4 = max edge
  verticalPins?: number;
  resizingConstraint?: number;
  flexItem?: FlexItem;

  // Groups, frames, symbol masters
  groupBehavior?: number; // 0 group, 1 frame, 2 graphic
  clippingBehavior?: number;
  groupLayout?: FlexGroupLayout | { _class: string };
  leftPadding?: number;
  topPadding?: number;
  rightPadding?: number;
  bottomPadding?: number;
  hasBackgroundColor?: boolean;
  includeBackgroundColorInInstance?: boolean;
  backgroundColor?: SColor;

  // Shapes
  points?: CurvePoint[];
  isClosed?: boolean;
  edited?: boolean;
  fixedRadius?: number;
  numberOfPoints?: number;
  radius?: number;
  windingRule?: number;

  // Text
  attributedString?: { string: string; attributes: StringAttribute[] };
  textBehaviour?: number; // pre-2025: 0 auto, 1 fixed width, 2 fixed
  sharedStyleID?: string;
  glyphBounds?: string;

  // Bitmap
  image?: FileRef;

  // Symbols
  symbolID?: string;
  overrideValues?: OverrideValue[];
  scale?: number;

  [key: string]: unknown;
}

export interface Page extends Layer {
  _class: 'page';
  layers: Layer[];
}

export interface SketchDocument {
  colorSpace?: number;
  fontReferences?: { fontFamilyName: string; fontFileName: string; postscriptNames: string[]; fontData?: FileRef }[];
  foreignSymbols?: { symbolMaster: Layer; originalMaster?: Layer }[];
  foreignSwatches?: { localSwatch: { do_objectID: string; name: string; value: SColor } }[];
  sharedSwatches?: { objects: { do_objectID: string; name: string; value: SColor }[] };
  layerStyles?: { objects: { do_objectID: string; name: string; value: Style }[] };
  layerTextStyles?: { objects: { do_objectID: string; name: string; value: Style }[] };
  foreignLayerStyles?: { localSharedStyle: { do_objectID: string; name: string; value: Style } }[];
  foreignTextStyles?: { localSharedStyle: { do_objectID: string; name: string; value: Style } }[];
  pages: FileRef[];
}

export interface SketchMeta {
  appVersion: string;
  version: number;
  pagesAndArtboards: Record<string, { name: string; artboards?: Record<string, { name: string }> }>;
}
