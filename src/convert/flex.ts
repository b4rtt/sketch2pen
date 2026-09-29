import type { PenNode } from '../pen/types.ts';
import type { FlexGroupLayout, Layer } from '../sketch/types.ts';
import { r2 } from '../util/geom.ts';

export interface FlexPlan {
  direction: 'horizontal' | 'vertical';
  stretch: boolean;
  /** children in visual (layout) order */
  items: Layer[];
  /** children positioned absolutely (flexItem.ignoreLayout or hidden) */
  absolute: Set<string>;
  props: Partial<PenNode>;
}

const TOLERANCE = 1.01;

export function isFlexLayout(layer: Layer): layer is Layer & { groupLayout: FlexGroupLayout } {
  return layer.groupLayout?._class === 'MSImmutableFlexGroupLayout';
}

/**
 * Re-computes a Sketch stack with pen.dev's flex rules and only accepts it when every child lands exactly where
 * Sketch saved it. Anything we cannot reproduce (wrapping, negative padding, rotated children …) stays absolute,
 * so the converted screen always looks like the original.
 */
export function planFlex(layer: Layer): { plan: FlexPlan | null; reason?: string } {
  if (!isFlexLayout(layer)) return { plan: null, reason: 'not a stack' };
  const gl = layer.groupLayout;
  if (gl.wrappingEnabled) return { plan: null, reason: 'wrapping' };
  const vertical = gl.flexDirection === 1;
  const pad = { l: layer.leftPadding ?? 0, t: layer.topPadding ?? 0, r: layer.rightPadding ?? 0, b: layer.bottomPadding ?? 0 };
  if (pad.l < 0 || pad.t < 0 || pad.r < 0 || pad.b < 0) return { plan: null, reason: 'negative padding' };

  const all = [...(layer.layers ?? [])].reverse(); // Sketch stores stack children bottom-up
  const absolute = new Set<string>();
  const items: Layer[] = [];
  for (const l of all) {
    if (l.flexItem?.ignoreLayout || (l.isVisible === false && !l.flexItem?.preserveSpaceWhenHidden)) absolute.add(l.do_objectID);
    else items.push(l);
    if (l.hasClippingMask) return { plan: null, reason: 'mask inside stack' };
  }
  if (!items.length) return { plan: null, reason: 'empty' };
  if (items.some((l) => l.rotation)) return { plan: null, reason: 'rotated child' };
  if (items.some((l) => l.isVisible === false)) return { plan: null, reason: 'hidden child keeps space' };

  const W = layer.frame.width;
  const H = layer.frame.height;
  const mainLen = vertical ? H : W;
  const crossLen = vertical ? W : H;
  const [ms, me, cs, ce] = vertical ? [pad.t, pad.b, pad.l, pad.r] : [pad.l, pad.r, pad.t, pad.b];
  const mainPos = (l: Layer) => (vertical ? l.frame.y : l.frame.x);
  const mainSize = (l: Layer) => (vertical ? l.frame.height : l.frame.width);
  const crossPos = (l: Layer) => (vertical ? l.frame.x : l.frame.y);
  const crossSize = (l: Layer) => (vertical ? l.frame.width : l.frame.height);

  const sum = items.reduce((s, l) => s + mainSize(l), 0);
  let gap = gl.allGuttersGap ?? 0;
  let start = ms;
  const avail = mainLen - ms - me;
  switch (gl.justifyContent) {
    case 1:
      start = ms + (avail - sum - gap * (items.length - 1)) / 2;
      break;
    case 2:
      start = mainLen - me - sum - gap * (items.length - 1);
      break;
    case 3:
      gap = items.length > 1 ? (avail - sum) / (items.length - 1) : 0;
      break;
  }
  let cursor = start;
  const crossAvail = crossLen - cs - ce;
  for (const l of items) {
    if (Math.abs(mainPos(l) - cursor) > TOLERANCE) return { plan: null, reason: 'main axis mismatch' };
    cursor += mainSize(l) + gap;
    let expected = cs;
    if (gl.alignItems === 1) expected = cs + (crossAvail - crossSize(l)) / 2;
    else if (gl.alignItems === 2) expected = crossLen - ce - crossSize(l);
    else if (gl.alignItems === 3 && Math.abs(crossSize(l) - crossAvail) > TOLERANCE) return { plan: null, reason: 'stretch mismatch' };
    if (Math.abs(crossPos(l) - expected) > TOLERANCE) return { plan: null, reason: 'cross axis mismatch' };
  }

  const props: Partial<PenNode> = { layout: vertical ? 'vertical' : 'horizontal' };
  if (gl.justifyContent === 3) props.justifyContent = 'space_between';
  else if (gap) props.gap = r2(gap);
  if (gl.justifyContent === 1) props.justifyContent = 'center';
  if (gl.justifyContent === 2) props.justifyContent = 'end';
  if (gl.alignItems === 1) props.alignItems = 'center';
  if (gl.alignItems === 2) props.alignItems = 'end';
  if (pad.l || pad.t || pad.r || pad.b) {
    props.padding = pad.l === pad.r && pad.t === pad.b && pad.l === pad.t ? r2(pad.l) : [r2(pad.t), r2(pad.r), r2(pad.b), r2(pad.l)];
  }
  return { plan: { direction: vertical ? 'vertical' : 'horizontal', stretch: gl.alignItems === 3, items, absolute, props } };
}
