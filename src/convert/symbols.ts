import type { PenFill, PenNode } from '../pen/types.ts';
import type { Fill, Layer, Rect, SColor, Style } from '../sketch/types.ts';
import { penTransform, r2 } from '../util/geom.ts';
import type { Context, MasterInfo } from './context.ts';
import type { ParentInfo } from './layers.ts';
import { blendMode, colorOrVariable, convertBorders, convertEffects, convertFills, hexColor, paintValue } from './style.ts';
import { textSizing } from './text.ts';

type Props = Record<string, unknown>;

interface Override {
  ids: string[];
  prop: string;
  value: unknown;
}

function parseOverrides(layer: Layer): Override[] {
  const out: Override[] = [];
  for (const o of layer.overrideValues ?? []) {
    const cut = o.overrideName.indexOf('_');
    if (cut < 0) continue;
    out.push({ ids: o.overrideName.slice(0, cut).split('/'), prop: o.overrideName.slice(cut + 1), value: o.value });
  }
  return out;
}

function merge(target: Record<string, Props>, key: string, props: Props): void {
  target[key] = { ...(target[key] ?? {}), ...props };
}

/** All descendants of a layer (depth first). */
function descendants(layer: Layer): Layer[] {
  const out: Layer[] = [];
  const walk = (l: Layer) => {
    for (const c of l.layers ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(layer);
  return out;
}

function replaceColor(fills: Fill[] | undefined, index: number, color: SColor): Fill[] {
  return (fills ?? []).map((f, i) => (i === index ? { ...f, fillType: 0, color } : f));
}

function sharedStyle(ctx: Context, id: string): Style | undefined {
  return ctx.sharedStyles.get(id)?.value;
}

/** Tint (Sketch "fillColor" override / group fill): recolours every shape and text below the target. */
function tintProps(ctx: Context, info: MasterInfo, target: Layer, hex: string, prefix: string, out: Record<string, Props>): void {
  const visit = (layers: Layer[], lookup: MasterInfo, pre: string) => {
    for (const l of layers) {
      const pid = lookup.nodeIds.get(l.do_objectID);
      if (l._class === 'symbolInstance') {
        const nested = ctx.masters.get(l.symbolID ?? '');
        if (nested && pid) visit(nested.master.layers ?? [], nested, `${pre}${pid}/`);
        continue;
      }
      if (pid && (l._class === 'text' || l.style?.fills?.some((f) => f.isEnabled))) merge(out, pre + pid, { fill: hex });
      if (pid && l.style?.borders?.some((b) => b.isEnabled) && !l.style?.fills?.some((f) => f.isEnabled)) merge(out, pre + pid, { stroke: hex });
      if (l.layers) visit(l.layers, lookup, pre);
    }
  };
  if (target._class === 'symbolInstance') {
    const nested = ctx.masters.get(target.symbolID ?? '');
    const pid = info.nodeIds.get(target.do_objectID);
    if (nested && pid) visit(nested.master.layers ?? [], nested, `${prefix}${pid}/`);
  } else {
    visit(target.layers ?? [target], info, prefix);
  }
}

/** Translates one level of Sketch overrides into pen.dev `descendants` entries. */
function overridesFor(ctx: Context, info: MasterInfo, overrides: Override[], where: string): Record<string, Props> {
  const out: Record<string, Props> = {};
  const byFirst = new Map<string, Override[]>();
  for (const o of overrides) {
    const list = byFirst.get(o.ids[0]!) ?? [];
    list.push(o);
    byFirst.set(o.ids[0]!, list);
  }
  for (const [firstId, list] of byFirst) {
    const layer = info.layers.get(firstId);
    const pid = info.nodeIds.get(firstId);
    if (!layer || !pid) continue;
    const swap = list.find((o) => o.ids.length === 1 && o.prop === 'symbolID');
    const nestedOverrides = list.filter((o) => o.ids.length > 1).map((o) => ({ ...o, ids: o.ids.slice(1) }));

    if (swap) {
      const newId = String(swap.value ?? '');
      if (!newId) {
        merge(out, pid, { enabled: false });
        continue;
      }
      const target = ctx.masters.get(newId);
      if (!target) {
        ctx.report.warn('missing-swap', 'Symbol swap refers to a missing symbol', where);
        continue;
      }
      const f = layer.frame;
      const t = penTransform(f, layer.rotation ?? 0, !!layer.isFlippedHorizontal, !!layer.isFlippedVertical);
      const repl: Props = { type: 'ref', ref: target.penId, id: ctx.ids.for(`${where}:${firstId}`, '#swap'), name: layer.name, x: r2(t.x), y: r2(t.y) };
      if (layer.isFlippedHorizontal) repl.flipX = true;
      if (layer.isFlippedVertical) repl.flipY = true;
      if (Math.abs(target.master.frame.width - f.width) > 0.01 || Math.abs(target.master.frame.height - f.height) > 0.01) {
        repl.width = r2(f.width);
        repl.height = r2(f.height);
      }
      if (t.rotation) repl.rotation = r2(t.rotation);
      const nested = overridesFor(ctx, target, nestedOverrides, where);
      Object.assign(nested, geometryOverrides(ctx, target, f.width, f.height, { kind: 'constraints' }));
      const nestedValid = validate(ctx, target, nested);
      if (Object.keys(nestedValid).length) repl.descendants = nestedValid;
      out[pid] = repl;
      // other props on the swapped node itself
      for (const o of list) if (o.ids.length === 1 && o.prop !== 'symbolID') applyProp(ctx, info, layer, pid, o, out, where);
      continue;
    }

    for (const o of list) if (o.ids.length === 1) applyProp(ctx, info, layer, pid, o, out, where);
    if (nestedOverrides.length) {
      const nestedInfo = ctx.masters.get(layer.symbolID ?? '');
      if (!nestedInfo) continue;
      const sub = overridesFor(ctx, nestedInfo, nestedOverrides, where);
      for (const [k, v] of Object.entries(sub)) merge(out, `${pid}/${k}`, v);
    }
  }
  return out;
}

function applyProp(ctx: Context, info: MasterInfo, layer: Layer, pid: string, o: Override, out: Record<string, Props>, where: string): void {
  const { width: w, height: h } = layer.frame;
  const textIds = ctx.textParts.get(layer.do_objectID) ?? [pid];
  switch (o.prop) {
    case 'stringValue': {
      const text = String(o.value ?? '');
      const t = layer.attributedString?.attributes?.[0]?.attributes.MSAttributedStringTextTransformAttribute;
      const content = t === 1 ? text.toUpperCase() : t === 2 ? text.toLowerCase() : text;
      merge(out, textIds[0]!, { content });
      for (const extra of textIds.slice(1)) merge(out, extra, { enabled: false });
      // underlines were measured for the master's text – they would not fit the new one
      const decorations = ctx.textDecorations.get(layer.do_objectID) ?? [];
      for (const d of decorations) merge(out, d, { enabled: false });
      if (decorations.length) ctx.report.warn('text-decoration-override', 'Underline / strikethrough of a text replaced in a symbol instance not drawn', where);
      break;
    }
    case 'isVisible':
      merge(out, pid, { enabled: !!o.value });
      for (const d of ctx.textDecorations.get(layer.do_objectID) ?? []) merge(out, d, { enabled: !!o.value });
      break;
    case 'image': {
      const url = ctx.imageUrl((o.value as { _ref?: string })?._ref);
      if (url) merge(out, pid, { fill: { type: 'image', url, mode: 'stretch' } });
      break;
    }
    case 'textColor':
      for (const t of textIds) merge(out, t, { fill: colorOrVariable(ctx, o.value as SColor) });
      break;
    case 'fillColor':
      tintProps(ctx, info, layer, colorOrVariable(ctx, o.value as SColor), '', out);
      break;
    case 'textStyle': {
      const style = sharedStyle(ctx, String(o.value));
      const attrs = style?.textStyle?.encodedAttributes;
      if (!attrs) break;
      const font = attrs.MSAttributedStringFontAttribute?.attributes;
      const props: Props = {};
      if (font) {
        const f = ctx.fonts.resolve(font.name, font.size);
        Object.assign(props, { fontFamily: f.family, fontWeight: String(f.weight), fontSize: r2(font.size), ...(f.italic ? { fontStyle: 'italic' } : {}) });
        const lh = attrs.paragraphStyle?.maximumLineHeight;
        if (lh) props.lineHeight = Math.round((lh / font.size) * 1000) / 1000;
      }
      if (attrs.MSAttributedStringColorAttribute) props.fill = colorOrVariable(ctx, attrs.MSAttributedStringColorAttribute);
      if (attrs.kerning !== undefined) props.letterSpacing = r2(attrs.kerning);
      for (const t of textIds) merge(out, t, props);
      break;
    }
    case 'layerStyle': {
      const style = sharedStyle(ctx, String(o.value));
      if (!style) break;
      const fills = convertFills(ctx, style.fills, w, h, where);
      merge(out, pid, { fill: paintValue(fills) ?? [], ...convertBorders(ctx, style, w, h, where) });
      const { effects } = convertEffects(ctx, style, where);
      if (effects.length) merge(out, pid, { effect: effects });
      break;
    }
    default: {
      const m = o.prop.match(/^color:(fill|border|shadow|innershadow)-(\d+)$/);
      if (!m) {
        ctx.report.warn('override-unknown', `Unsupported symbol override (${o.prop})`, where);
        break;
      }
      const kind = m[1];
      const index = Number(m[2]);
      const color = o.value as SColor;
      if (kind === 'fill') {
        if (layer._class === 'text') {
          for (const t of textIds) merge(out, t, { fill: colorOrVariable(ctx, color) });
        } else {
          const fills = convertFills(ctx, replaceColor(layer.style?.fills, index, color), w, h, where);
          merge(out, pid, { fill: paintValue(fills) ?? [] });
        }
      } else if (kind === 'border') {
        const borders = (layer.style?.borders ?? []).map((b, i) => (i === index ? { ...b, fillType: 0, color } : b));
        const stroke = convertBorders(ctx, { ...layer.style, borders }, w, h, where);
        if (stroke.stroke !== undefined) merge(out, pid, { stroke: stroke.stroke });
      } else if (kind === 'innershadow') {
        const inner = (layer.style?.shadows ?? []).filter((s) => s.isEnabled && s.isInnerShadow);
        const target = ctx.innerShadowTargets.get(`${layer.do_objectID}:${Math.min(index, Math.max(inner.length - 1, 0))}`);
        const shadow = inner[index];
        const bm = blendMode(shadow?.contextSettings?.blendMode);
        const hex = hexColor(color, shadow?.contextSettings?.opacity ?? 1);
        if (target) merge(out, target.id, { [target.prop]: bm ? { type: 'color', color: hex, blendMode: bm } : hex });
      } else {
        const shadows = (layer.style?.shadows ?? []).filter((s) => s.isEnabled && !s.isInnerShadow);
        if (!shadows.length) break;
        const style = { ...layer.style, shadows: shadows.map((s, i) => (i === index ? { ...s, color } : s)) };
        const { effects } = convertEffects(ctx, style, where);
        if (effects.length) merge(out, pid, { effect: effects.length === 1 ? effects[0] : effects });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Resizing & scaling: Sketch re-lays out symbol content (pins & sizing modes, or the Scale tool); pen.dev keeps
// component children fixed, so every descendant that moves or changes size gets explicit overrides.
// ---------------------------------------------------------------------------------------------

export function resizeAxis(pos: number, size: number, oldLen: number, newLen: number, pins: number, sizing: number | undefined): [number, number] {
  if (oldLen <= 0) return [pos, size];
  const ratio = newLen / oldLen;
  const minPin = (pins & 1) !== 0;
  const maxPin = (pins & 4) !== 0;
  let newSize = size;
  if (sizing === 3) newSize = size * ratio;
  if (sizing === 2) newSize = size + (newLen - oldLen);
  if (minPin && maxPin) return [pos, size + (newLen - oldLen)];
  if (minPin) return [pos, newSize];
  if (maxPin) return [newLen - (oldLen - pos - size) - newSize, newSize];
  return [(pos + size / 2) * ratio - newSize / 2, newSize];
}

function legacyPins(c: number | undefined): { h: number; v: number; hs: number; vs: number } {
  // resizingConstraint: a cleared bit means "fixed": right 1, width 2, left 4, bottom 8, height 16, top 32
  const rc = c ?? 63;
  const fixed = (bit: number) => (rc & bit) === 0;
  return {
    h: (fixed(4) ? 1 : 0) | (fixed(1) ? 4 : 0),
    v: (fixed(32) ? 1 : 0) | (fixed(8) ? 4 : 0),
    hs: fixed(2) ? 0 : 3,
    vs: fixed(16) ? 0 : 3,
  };
}

/** Where a layer of a symbol ends up when the instance has another size (Sketch's pins and sizing). */
export function resizedFrame(layer: Layer, oldW: number, oldH: number, newW: number, newH: number): Rect {
  const f = layer.frame;
  const explicit = layer.horizontalPins !== undefined;
  const legacy = explicit ? null : legacyPins(layer.resizingConstraint);
  const hp = explicit ? (layer.horizontalPins ?? 0) : legacy!.h;
  const vp = explicit ? (layer.verticalPins ?? 0) : legacy!.v;
  let hs = explicit ? layer.horizontalSizing : legacy!.hs;
  let vs = explicit ? layer.verticalSizing : legacy!.vs;
  if (hs === 1) hs = 0; // "fit" keeps its content size
  if (vs === 1) vs = 0;
  const [x, w] = resizeAxis(f.x, f.width, oldW, newW, hp, hs);
  const [y, h] = resizeAxis(f.y, f.height, oldH, newH, vp, vs);
  return { x, y, width: w, height: h };
}

type Mode = { kind: 'constraints' } | { kind: 'scale'; sx: number; sy: number };

const isPlainGroup = (ctx: Context, l: Layer) => l._class === 'group' && !l.groupBehavior && !ctx.flexContainers.has(l.do_objectID);

function scaledRadius(l: Layer, k: number): Props {
  const radii = l.style?.corners?.radii;
  if (!radii?.length || radii.every((r) => !r)) return {};
  if (radii.length === 1 || radii.every((r) => r === radii[0])) return { cornerRadius: r2(radii[0]! * k) };
  return { cornerRadius: radii.slice(0, 4).map((r) => r2(r * k)) };
}

/**
 * Overrides that make a component instance of a different size (or scale) look like Sketch's layout of it.
 * Mask chains are respected: masked layers live inside the mask's clipping frame in pen.dev.
 */
export function geometryOverrides(ctx: Context, info: MasterInfo, newW: number, newH: number, mode: Mode, prefix = ''): Record<string, Props> {
  const out: Record<string, Props> = {};
  const oldW = info.master.frame.width;
  const oldH = info.master.frame.height;
  if (mode.kind === 'constraints') {
    if (Math.abs(oldW - newW) < 0.01 && Math.abs(oldH - newH) < 0.01) return out;
    if (ctx.flexContainers.has(info.master.do_objectID)) return out; // pen.dev's own layout handles it
  }
  const k = mode.kind === 'scale' ? Math.sqrt(mode.sx * mode.sy) : 1;

  const visit = (children: Layer[], ow: number, oh: number, nw: number, nh: number, lookup: MasterInfo, pre: string) => {
    const frameOf = (l: Layer): Rect =>
      mode.kind === 'scale'
        ? { x: l.frame.x * mode.sx, y: l.frame.y * mode.sy, width: l.frame.width * mode.sx, height: l.frame.height * mode.sy }
        : resizedFrame(l, ow, oh, nw, nh);
    let mask: Layer | null = null;
    for (const l of children) {
      if (l.hasClippingMask) mask = l;
      else if (l.shouldBreakMaskChain) mask = null;
      const pid = lookup.nodeIds.get(l.do_objectID);
      // a mask without fill has no node of its own, but its clipping frame still has to follow
      const wrapper = l.hasClippingMask ? ctx.maskFrames.get(l.do_objectID) : undefined;
      if (!pid && !wrapper) continue;
      const f = l.frame;
      const nf = frameOf(l);
      const owner = mask && mask !== l ? mask : null;
      const ownerWrapped = owner ? ctx.maskFrames.has(owner.do_objectID) : false;
      if (owner && lookup.nodeIds.get(owner.do_objectID) === pid) continue; // bitmap merged into its mask shape
      const base = ownerWrapped ? frameOf(owner!) : { x: 0, y: 0 };
      const baseOld = ownerWrapped ? owner!.frame : { x: 0, y: 0 };
      const moved = Math.abs(nf.x - base.x - (f.x - baseOld.x)) > 0.01 || Math.abs(nf.y - base.y - (f.y - baseOld.y)) > 0.01;
      const resized = Math.abs(nf.width - f.width) > 0.01 || Math.abs(nf.height - f.height) > 0.01;
      if (!moved && !resized && mode.kind === 'constraints') continue;

      const local = { ...nf, x: nf.x - base.x, y: nf.y - base.y };
      const node = pid ? lookup.nodes.get(pid) : undefined;
      const baked = node?.type === 'path';
      const pos = penTransform(wrapper ? { ...local, x: 0, y: 0 } : local, l.rotation ?? 0, !!l.isFlippedHorizontal, !!l.isFlippedVertical, baked);
      const props: Props = { x: r2(pos.x), y: r2(pos.y) };
      const size = { width: r2(Math.max(nf.width, 0.01)), height: r2(Math.max(nf.height, 0.01)) };
      if (l._class === 'text') {
        const s = textSizing(l);
        if (s.growth !== 'auto') props.width = size.width;
        if (s.growth === 'fixed-width-height') props.height = size.height;
        if (mode.kind === 'scale') {
          const a = l.attributedString?.attributes?.[0]?.attributes;
          const fs = a?.MSAttributedStringFontAttribute?.attributes.size;
          if (fs && (ctx.textParts.get(l.do_objectID)?.length ?? 1) === 1) props.fontSize = r2(fs * k);
          if (a?.kerning) props.letterSpacing = r2(a.kerning * k);
        }
      } else if (!isPlainGroup(ctx, l)) {
        if (resized) Object.assign(props, size);
      }
      if (mode.kind === 'scale') {
        const borders = (l.style?.borders ?? []).filter((b) => b.isEnabled && b.thickness > 0);
        if (borders.length && l._class !== 'symbolInstance') props.strokeWidth = r2(Math.max(...borders.map((b) => b.thickness)) * k);
        if (l._class === 'rectangle' || (l._class === 'group' && l.groupBehavior)) Object.assign(props, scaledRadius(l, k));
      }
      if (pid) merge(out, pre + pid, props);
      if (wrapper) {
        merge(out, pre + wrapper, { x: r2(local.x), y: r2(local.y), ...size, ...(l._class === 'oval' ? { cornerRadius: r2(Math.min(nf.width, nf.height) / 2) } : {}) });
      }
      for (let i = 0; i < 4; i++) {
        const inner = ctx.innerShadowTargets.get(`${l.do_objectID}:${i}`);
        if (pid && inner && inner.id !== pid && lookup.nodes.has(inner.id)) merge(out, pre + inner.id, { ...props, ...size });
      }
      if (!resized && mode.kind === 'constraints') continue;
      if (l._class === 'symbolInstance') {
        const nested = ctx.masters.get(l.symbolID ?? '');
        if (nested) {
          const nestedMode: Mode = mode.kind === 'scale' ? mode : { kind: 'constraints' };
          Object.assign(out, geometryOverrides(ctx, nested, nf.width, nf.height, nestedMode, `${pre}${pid}/`));
        }
      } else if (l.layers?.length && !ctx.flexContainers.has(l.do_objectID)) {
        visit(l.layers, f.width, f.height, nf.width, nf.height, lookup, pre);
      }
    }
  };
  visit(info.master.layers ?? [], oldW, oldH, newW, newH, info, prefix);
  return out;
}

/** Drops override keys that do not resolve to a node of the component (pen.dev would reject them). */
function validate(ctx: Context, info: MasterInfo, map: Record<string, Props>): Record<string, Props> {
  const out: Record<string, Props> = {};
  const swapped = Object.keys(map).filter((k) => map[k]!.type !== undefined);
  for (const [key, props] of Object.entries(map)) {
    if (swapped.some((s) => key.startsWith(s + '/'))) continue;
    const parts = key.split('/');
    let cur: MasterInfo | undefined = info;
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      const node: PenNode | undefined = cur?.nodes.get(parts[i]!);
      if (!node) ok = false;
      else if (i < parts.length - 1) {
        cur = node.type === 'ref' ? ctx.mastersByPenId.get(node.ref ?? '') : undefined;
        if (!cur) ok = false;
      }
    }
    if (ok) out[key] = props;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

export function convertInstance(ctx: Context, layer: Layer, id: string, parent: ParentInfo, where: string, tint?: string): PenNode {
  const info = ctx.masters.get(layer.symbolID ?? '');
  const { width: w, height: h } = layer.frame;
  if (!info) {
    ctx.report.warn('missing-symbol', 'Instance of a missing symbol – replaced by a placeholder', where);
    return { type: 'rectangle', id, width: r2(w), height: r2(h), fill: '#FF00FF22', stroke: '#FF00FF', strokeWidth: 1 };
  }
  ctx.report.stats.instances++;
  const node: PenNode = { type: 'ref', id, ref: info.penId };
  const inLayout = parent.layout !== 'none' && !layer.flexItem?.ignoreLayout;
  const mw = info.master.frame.width;
  const mh = info.master.frame.height;
  if (inLayout) {
    const cross = (axis: 'h' | 'v') => (parent.layout === 'vertical') === (axis === 'h');
    const hs = layer.horizontalSizing === 2 || (cross('h') && parent.stretch) ? 'fill_container' : undefined;
    const vs = layer.verticalSizing === 2 || (cross('v') && parent.stretch) ? 'fill_container' : undefined;
    if (hs) node.width = hs;
    else if (Math.abs(w - mw) > 0.01) node.width = r2(w);
    if (vs) node.height = vs;
    else if (Math.abs(h - mh) > 0.01) node.height = r2(h);
  } else if (Math.abs(w - mw) > 0.01 || Math.abs(h - mh) > 0.01) {
    node.width = r2(w);
    node.height = r2(h);
  }

  const scaled = !!layer.scale && Math.abs(layer.scale - 1) > 0.001;
  const mode: Mode = scaled ? { kind: 'scale', sx: w / mw, sy: h / mh } : { kind: 'constraints' };
  const descendantsMap = overridesFor(ctx, info, parseOverrides(layer), where);
  for (const [k, v] of Object.entries(geometryOverrides(ctx, info, w, h, mode))) merge(descendantsMap, k, { ...v, ...(descendantsMap[k] ?? {}) });
  // Tint on the instance itself or inherited from a tinted group
  if (tint) tintProps(ctx, info, info.master, tint, '', descendantsMap);
  const valid = validate(ctx, info, descendantsMap);
  if (Object.keys(valid).length) node.descendants = valid;
  return node;
}

/** Master dependency order: a master is converted after every master it instantiates. */
export function masterOrder(masters: Map<string, Layer>): Layer[] {
  const order: Layer[] = [];
  const state = new Map<string, number>();
  const deps = (m: Layer): string[] => {
    const out: string[] = [];
    for (const l of descendants(m)) {
      if (l._class === 'symbolInstance' && l.symbolID) out.push(l.symbolID);
      for (const o of l.overrideValues ?? []) if (o.overrideName.endsWith('_symbolID') && o.value) out.push(String(o.value));
    }
    return out;
  };
  const visit = (id: string) => {
    const m = masters.get(id);
    if (!m || state.get(id) === 2) return;
    if (state.get(id) === 1) return; // cycle guard
    state.set(id, 1);
    for (const d of deps(m)) visit(d);
    state.set(id, 2);
    order.push(m);
  };
  for (const id of masters.keys()) visit(id);
  return order;
}

export type { PenFill };
