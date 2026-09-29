// Rewrites the feature lab into the pre-2025 Sketch data model (artboards, style.innerShadows, style.blur,
// textBehaviour, resizingConstraint) so older documents are covered too. Sketch renders the result after its own
// migration, which gives the reference for the legacy code paths.
//
//   bun tools/lab/legacy.ts <out.sketch>
import { readFileSync, writeFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

type J = Record<string, any>;

function pinsToConstraint(l: J): number {
  // resizingConstraint: a cleared bit means "fixed" – right 1, width 2, left 4, bottom 8, height 16, top 32
  let rc = 63;
  const h = l.horizontalPins ?? 0;
  const v = l.verticalPins ?? 0;
  if (h & 1) rc &= ~4;
  if (h & 4) rc &= ~1;
  if (v & 1) rc &= ~32;
  if (v & 4) rc &= ~8;
  if ((l.horizontalSizing ?? 0) === 0) rc &= ~2;
  if ((l.verticalSizing ?? 0) === 0) rc &= ~16;
  return rc;
}

function legacyLayer(l: J, topLevel: boolean): J {
  const out: J = { ...l };
  const style: J = { ...(l.style ?? {}) };
  // shadows / inner shadows were separate lists, blur was a single object
  const shadows = (style.shadows ?? []) as J[];
  style.shadows = shadows.filter((s) => !s.isInnerShadow).map(({ isInnerShadow, ...s }) => ({ ...s, _class: 'shadow' }));
  style.innerShadows = shadows.filter((s) => s.isInnerShadow).map(({ isInnerShadow, ...s }) => ({ ...s, _class: 'innerShadow' }));
  const blur = (style.blurs ?? [])[0];
  style.blur = blur ? { _class: 'blur', isEnabled: true, center: '{0.5, 0.5}', motionAngle: 0, radius: blur.radius, saturation: 1, type: blur.type } : { _class: 'blur', isEnabled: false, center: '{0.5, 0.5}', motionAngle: 0, radius: 10, saturation: 1, type: 0 };
  delete style.blurs;
  // fills had no layering type: a fill on a group was its tint
  style.fills = (style.fills ?? []).map(({ layeringType, ...f }: J) => f);
  delete style.corners;
  delete style.skipCorners;
  out.style = style;
  out.resizingConstraint = pinsToConstraint(l);
  for (const k of ['horizontalPins', 'verticalPins', 'horizontalSizing', 'verticalSizing', 'hasExplicitConstraints', 'minSize', 'maxSize', 'percentageSize', 'flexItem']) delete out[k];

  if (l._class === 'text') {
    const hs = l.horizontalSizing ?? 0;
    const vs = l.verticalSizing ?? 0;
    out.textBehaviour = hs === 1 ? 0 : vs === 1 ? 1 : 2;
  }
  if (l._class === 'group' && l.groupBehavior === 1 && topLevel) {
    // Sketch 2025 frames were artboards
    const fill = (style.fills ?? []).find((f: J) => f.isEnabled);
    out._class = 'artboard';
    out.hasBackgroundColor = !!fill;
    out.backgroundColor = fill?.color ?? { _class: 'color', red: 1, green: 1, blue: 1, alpha: 1 };
    out.includeBackgroundColorInExport = true;
    out.style = { ...style, fills: [] };
    out.horizontalRulerData = { _class: 'rulerData', base: 0, guides: [] };
    out.verticalRulerData = { _class: 'rulerData', base: 0, guides: [] };
  }
  for (const k of ['groupBehavior', 'clippingBehavior', 'groupLayout', 'leftPadding', 'topPadding', 'rightPadding', 'bottomPadding', 'paddingSelection']) {
    if (out._class !== 'group' && out._class !== 'symbolMaster' && out._class !== 'artboard') continue;
    if (out._class === 'artboard' || k !== 'groupLayout') delete out[k];
  }
  if (out.layers) out.layers = (out.layers as J[]).map((c) => legacyLayer(c, false));
  return out;
}

export function makeLegacy(input: string, output: string): void {
  const zip = unzipSync(readFileSync(input));
  const out: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(zip)) {
    if (name.startsWith('pages/')) {
      const page = JSON.parse(strFromU8(data));
      page.layers = page.layers.map((l: J) => legacyLayer(l, true));
      out[name] = strToU8(JSON.stringify(page));
    } else if (name === 'meta.json') {
      const meta = JSON.parse(strFromU8(data));
      const app = { app: 'com.bohemiancoding.sketch3', appVersion: '70.3', build: 109109, commit: '', compatibilityVersion: 99, variant: 'NONAPPSTORE', version: 136 };
      out[name] = strToU8(JSON.stringify({ ...meta, ...app, created: app, saveHistory: ['NONAPPSTORE.109109'] }));
    } else {
      out[name] = data;
    }
  }
  writeFileSync(output, zipSync(out, { level: 0 }));
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('usage: bun tools/lab/legacy.ts <lab.sketch> <legacy.sketch>');
  makeLegacy(input, output);
  console.log(`legacy lab → ${output}`);
}
