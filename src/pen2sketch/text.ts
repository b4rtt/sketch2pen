// Text nodes: pen.dev's single-style text → Sketch text layers (attributed string with one run), and the text
// measurement the layout uses.
import * as B from '../sketch/builder.ts';
import type { Context } from './context.ts';
import { parseWeight, type FontChoice } from './fonts.ts';
import { BLACK, paints, sketchColor, sketchFills } from './paint.ts';
import { layoutText, penTextBox, type TextStyle } from './textlayout.ts';
import type { RNode } from './tree.ts';
import type { ResolvedColor } from './variables.ts';

type J = Record<string, unknown>;

export interface TextProps {
  content: string;
  family: string;
  weight: number;
  italic: boolean;
  size: number;
  letterSpacing: number;
  /** multiple of the font size (undefined: the font's own) */
  lineHeight?: number;
  align: 'left' | 'center' | 'right' | 'justify';
  vAlign: 'top' | 'middle' | 'bottom';
  underline: boolean;
  strikethrough: boolean;
}

export const DEFAULT_FONT = 'Inter';
export const DEFAULT_SIZE = 14;

/** Text properties of a node (text, note …) with variables resolved. */
export function textProps(ctx: Context, n: RNode): TextProps {
  const v = ctx.vars;
  const t = n.theme;
  const p = n.p;
  const align = v.value(p.textAlign, t);
  const vAlign = v.value(p.textAlignVertical, t);
  const lh = v.number(p.lineHeight, t);
  return {
    content: (v.string(p.content, t) ?? '').replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n'),
    family: v.string(p.fontFamily, t)?.trim() || DEFAULT_FONT,
    weight: parseWeight(v.value(p.fontWeight, t)),
    italic: String(v.value(p.fontStyle, t) ?? '').toLowerCase() === 'italic',
    size: v.number(p.fontSize, t) ?? DEFAULT_SIZE,
    letterSpacing: v.number(p.letterSpacing, t) ?? 0,
    ...(lh !== undefined && lh > 0 ? { lineHeight: lh } : {}),
    align: align === 'center' || align === 'right' || align === 'justify' ? align : 'left',
    vAlign: vAlign === 'middle' || vAlign === 'bottom' ? vAlign : 'top',
    underline: v.bool(p.underline, t) === true,
    strikethrough: v.bool(p.strikethrough, t) === true,
  };
}

export function fontOf(ctx: Context, props: TextProps): FontChoice {
  return ctx.fonts.resolve(props.family, props.weight, props.italic);
}

export function textStyle(ctx: Context, props: TextProps): TextStyle {
  return { metrics: fontOf(ctx, props).metrics, size: props.size, letterSpacing: props.letterSpacing, lineHeight: props.lineHeight };
}

/** The box pen.dev gives a text; `width` for wrapping texts. */
export function measureText(ctx: Context, n: RNode, width?: number): { width: number; height: number } {
  const props = textProps(ctx, n);
  const box = penTextBox(layoutText(props.content, textStyle(ctx, props), width));
  return width === undefined ? box : { width, height: box.height };
}

const ALIGN = { left: 0, right: 1, center: 2, justify: 3 } as const;
const VALIGN = { top: 0, middle: 1, bottom: 2 } as const;

function attributes(ctx: Context, props: TextProps, color: ResolvedColor): J {
  const font = fontOf(ctx, props);
  const lh = props.lineHeight !== undefined ? props.lineHeight * props.size : undefined;
  return {
    MSAttributedStringFontAttribute: { _class: 'fontDescriptor', attributes: { name: font.postscriptName, size: props.size } },
    MSAttributedStringColorAttribute: sketchColor(ctx, color),
    paragraphStyle: {
      _class: 'paragraphStyle',
      alignment: ALIGN[props.align],
      ...(lh !== undefined ? { maximumLineHeight: lh, minimumLineHeight: lh } : {}),
      allowsDefaultTighteningForTruncation: 0,
    },
    ...(props.letterSpacing ? { kerning: props.letterSpacing } : {}),
    ...(props.underline ? { underlineStyle: 1 } : {}),
    ...(props.strikethrough ? { strikethroughStyle: 1 } : {}),
    textStyleVerticalAlignmentKey: VALIGN[props.vAlign],
  };
}

export interface TextLayerInput {
  name: string;
  frame: B.Frame;
  /** [horizontal, vertical] sizing: 0 fixed, 1 fit (auto), 2 fill */
  sizing: [number, number];
  layerOptions: B.LayerOptions;
}

/** A Sketch text layer for a pen.dev text node. Solid colours go into the text attributes, other paints into fills. */
export function textLayer(ctx: Context, n: RNode, input: TextLayerInput, where: string): J {
  const props = textProps(ctx, n);
  ctx.report.stats.texts++;
  // a single solid colour is the text colour; gradients, images and blended colours become fills
  const list = paints(n.p.fill);
  let color: ResolvedColor = BLACK;
  let fills: J[] = [];
  const only = list.length === 1 ? ctx.vars.value(list[0], n.theme) : undefined;
  const solid = typeof only === 'string' ? ctx.vars.color(list[0], n.theme) : only && typeof only === 'object' && (only as J).type === 'color' && !(only as J).blendMode && (only as J).enabled !== false ? ctx.vars.color((only as J).color, n.theme) : null;
  if (solid) color = solid;
  else if (list.length) fills = sketchFills(ctx, n, n.p.fill, where);
  const attrs = attributes(ctx, props, color);
  const layer = B.layer('text', input.name, input.frame, {
    ...input.layerOptions,
    sizing: input.sizing,
    style: {
      ...input.layerOptions.style,
      fills: fills.length ? fills : (input.layerOptions.style?.fills ?? []),
      textStyle: { _class: 'textStyle', encodedAttributes: attrs, verticalAlignment: VALIGN[props.vAlign], skipColors: false, skipAlignment: false },
    },
    extra: {
      attributedString: { _class: 'attributedString', string: props.content, attributes: [{ _class: 'stringAttribute', location: 0, length: props.content.length, attributes: attrs }] },
      automaticallyDrawOnUnderlyingPath: false,
      dontSynchroniseWithSymbol: false,
      lineSpacingBehaviour: 3,
      textBehaviour: input.sizing[0] === 1 ? 0 : input.sizing[1] === 0 ? 2 : 1,
      glyphBounds: `{{0, 0}, {${input.frame[2]}, ${input.frame[3]}}}`,
      ...input.layerOptions.extra,
    },
  });
  return layer;
}
