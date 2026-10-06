// Components → Sketch symbols. A component becomes a symbol master; an instance becomes a symbol instance when
// Sketch draws exactly what pen.dev draws: same geometry as the master, overrides Sketch can express (text, visibility,
// fill / text / border colour, image, nested symbol swap). Any other instance is expanded into plain layers.
import * as B from '../sketch/builder.ts';
import type { PenInputNode } from '../pen/reader.ts';
import type { Context } from './context.ts';
import { layoutMode } from './layout.ts';
import { NodeConverter, stackable, type Common, type ParentInfo } from './nodes.ts';
import { paints, sketchColor, sketchPaint } from './paint.ts';
import type { TreeBuilder, RNode } from './tree.ts';

type J = Record<string, unknown>;

/** Root properties of an instance that do not change how its content is drawn. */
const ROOT_SAFE = new Set(['x', 'y', 'name', 'enabled', 'opacity', 'rotation', 'flipX', 'flipY', 'layoutPosition', 'width', 'height', 'context', 'metadata', 'theme']);
/** Properties that change how a node is drawn and have no Sketch override. */
const LOOK = [
  'cornerRadius', 'strokeWidth', 'strokeAlignment', 'strokeLinecap', 'strokeLinejoin', 'opacity', 'rotation', 'flipX', 'flipY', 'clip',
  'layout', 'gap', 'padding', 'justifyContent', 'alignItems', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
  'lineHeight', 'textAlign', 'textAlignVertical', 'textGrowth', 'underline', 'strikethrough', 'geometry', 'viewBox', 'fillRule',
  'polygonCount', 'innerRadius', 'startAngle', 'sweepAngle', 'library', 'icon', 'weight',
];

const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

interface Master {
  id: string;
  symbolID: string;
  tree: RNode;
  layer?: J;
  /** placed on the canvas where the component is (top level), otherwise on the Symbols page */
  inPlace: boolean;
}

export class Symbols {
  private masters = new Map<string, Master>();
  /** masters some instance refers to */
  private used = new Set<string>();
  private conv: NodeConverter | null = null;
  private building = new Set<string>();

  constructor(
    private ctx: Context,
    private builder: TreeBuilder,
  ) {
    // every component an instance refers to, and every component on the canvas
    const used = new Set<string>();
    const scan = (n: PenInputNode) => {
      if (n.type === 'ref' && typeof n.ref === 'string') used.add(n.ref);
      for (const c of n.children ?? []) scan(c as PenInputNode);
      for (const d of Object.values((n.descendants as Record<string, PenInputNode>) ?? {})) if (d && typeof d === 'object') scan(d);
    };
    for (const c of ctx.pen.doc.children) scan(c as PenInputNode);
    for (const [id, comp] of builder.components) {
      if (!used.has(id) && !ctx.pen.doc.children.some((c) => c.id === id)) continue;
      const tree = builder.buildOne(comp);
      this.masters.set(id, { id, symbolID: ctx.uuid(`symbol:${id}`), tree, inPlace: ctx.pen.doc.children.some((c) => c.id === id) });
    }
  }

  /** Component trees to lay out (each at its own size). */
  components(): RNode[] {
    return [...this.masters.values()].map((m) => m.tree);
  }

  attach(conv: NodeConverter): void {
    this.conv = conv;
    conv.instanceHook = (n, parent, common) => this.instance(n, parent, common);
    conv.masterHook = (n, parent, common) => this.inPlaceMaster(n, parent, common);
  }

  /**
   * A component placed at the top level of the canvas becomes its symbol master right there. Sketch keeps masters at
   * the top level of a page, so a component nested in another layer is drawn as an instance of its master.
   */
  private inPlaceMaster(n: RNode, parent: ParentInfo, c: Common): J[] | null {
    const m = this.masters.get(n.id);
    if (!m || n.owner || this.building.has(m.id)) return null;
    if (!parent.path && m.inPlace) return [this.masterLayer(m, c.frame)];
    this.used.add(m.id);
    const layer = B.instance(c.name, { symbolID: m.symbolID }, c.frame, [], c.options);
    layer.do_objectID = this.ctx.uuid(`${n.key}#instance`);
    (layer.style as J).do_objectID = this.ctx.uuid(`${n.key}#instance-style`);
    this.ctx.report.stats.instances++;
    return [layer];
  }

  private masterLayer(m: Master, frame: B.Frame): J {
    if (m.layer) return m.layer;
    const ctx = this.ctx;
    const conv = this.conv!;
    this.building.add(m.id);
    // the master is the component's frame: convert it, then turn the frame into a symbol master
    const t = m.tree;
    const name = ctx.vars.string(t.p.name, t.theme) ?? 'Component';
    const placed = conv.convertPlain(t, { ox: 0, oy: 0, layout: 'none', stack: false, path: '' });
    const base = placed[0] ?? B.frame(name, frame, []);
    const isFrame = t.type === 'frame';
    const layer = B.symbolMaster(name, frame, isFrame ? ((base.layers as J[]) ?? []) : placed.map((l) => ({ ...l, frame: { ...(l.frame as J), x: 0, y: 0 } })), {});
    if (isFrame) {
      layer.style = base.style;
      for (const k of ['groupLayout', 'leftPadding', 'topPadding', 'rightPadding', 'bottomPadding', 'clippingBehavior', 'horizontalSizing', 'verticalSizing']) if (k in base) layer[k] = base[k];
      layer.includeBackgroundColorInInstance = true;
      layer.isVisible = base.isVisible;
    }
    layer.do_objectID = ctx.uuid(`master:${m.id}`);
    (layer.style as J).do_objectID = ctx.uuid(`master:${m.id}#style`);
    layer.symbolID = m.symbolID;
    m.layer = layer;
    this.building.delete(m.id);
    ctx.report.stats.symbols++;
    return layer;
  }

  /** Masters not placed on the canvas, in a row on their own page. */
  page(): B.PageSpec | null {
    const layers: J[] = [];
    const placed = new Set<string>();
    let x = 0;
    // converting a master can bring in the masters of its nested instances
    for (;;) {
      const next = [...this.masters.values()].find((m) => !m.inPlace && this.used.has(m.id) && !placed.has(m.id));
      if (!next) break;
      placed.add(next.id);
      const layer = this.masterLayer(next, [x, 0, next.tree.w, next.tree.h]);
      (layer.frame as J).x = x;
      (layer.frame as J).y = 0;
      x += Math.ceil(next.tree.w) + 100;
      layers.push(layer);
    }
    // in-place masters that were never reached (hidden, on a skipped page) still have to exist
    for (const m of this.masters.values()) {
      if (!m.inPlace || m.layer || !this.used.has(m.id)) continue;
      const layer = this.masterLayer(m, [x, 0, m.tree.w, m.tree.h]);
      x += Math.ceil(m.tree.w) + 100;
      layers.push(layer);
    }
    return layers.length ? { name: 'Symbols', layers, id: this.ctx.uuid('page:Symbols') } : null;
  }

  private master(id: string): Master | undefined {
    const m = this.masters.get(id);
    if (m) this.used.add(id);
    return m;
  }

  private instance(n: RNode, parent: ParentInfo, c: Common): J[] | null {
    const ctx = this.ctx;
    const info = n.instance!;
    const m = this.master(info.ref);
    if (!m || this.building.has(info.ref) || n.broken) return null;
    const overrides = this.overrides(n, m, c.where);
    if (!overrides) {
      ctx.report.stats.detached++;
      return null;
    }
    // the master has to exist (it is placed on its page or in place)
    const layer = B.instance(c.name, { symbolID: m.symbolID }, c.frame, overrides, c.options);
    layer.do_objectID = ctx.uuid(n.key);
    (layer.style as J).do_objectID = ctx.uuid(`${n.key}#style`);
    ctx.report.stats.instances++;
    void parent;
    return [layer];
  }

  /** Resolved properties that change how a node looks (besides fill, stroke, content and visibility). */
  private look(n: RNode): string {
    const v = this.ctx.vars;
    const out: Record<string, unknown> = {};
    for (const k of LOOK) if (n.p[k] !== undefined) out[k] = v.deep(n.p[k], n.theme);
    return JSON.stringify(out);
  }

  private resolved(n: RNode, prop: string): string {
    return JSON.stringify(this.ctx.vars.deep(n.p[prop], n.theme) ?? null);
  }

  /**
   * Sketch overrides for an instance, or null when Sketch could not draw it like pen.dev. The instance is compared
   * with the master node by node, with variables resolved in each one's theme: differences in text, visibility, a
   * solid fill / text / border colour, an image or a nested symbol become overrides; anything else expands it.
   * Geometry may differ inside stacks (Sketch lays them out again) and for the instance's own size; elsewhere it
   * has to match because Sketch keeps the master's positions.
   */
  private overrides(inst: RNode, m: Master, where: string): [string, unknown][] | null {
    const ctx = this.ctx;
    const v = ctx.vars;
    const root = m.tree;
    for (const k of Object.keys(inst.instance!.rootProps)) {
      if (ROOT_SAFE.has(k)) continue;
      // anything else on the instance itself has to resolve to what the master has
      if (JSON.stringify(v.deep(inst.p[k], inst.theme)) !== JSON.stringify(v.deep(root.p[k], root.theme))) return null;
    }
    for (const k of ['fill', 'stroke', 'effect']) if (this.resolved(inst, k) !== this.resolved(root, k)) return null;
    if (this.look(inst) !== this.look(root)) return null;
    // a different size is re-laid out by Sketch only where the master is a stack or keeps its children in place
    const rootRelayout = stackable(root, v) || layoutMode(root, v) === 'none';
    if (!rootRelayout && (!near(inst.w, root.w) || !near(inst.h, root.h))) return null;

    const out: [string, unknown][] = [];
    const byRel = new Map<string, RNode>();
    const index = (n: RNode, prefix: string) => {
      for (const c of n.children) {
        const rel = prefix ? `${prefix}/${c.id}` : c.id;
        byRel.set(rel, c);
        index(c, c.instance ? rel : prefix);
      }
    };
    index(root, '');
    let ok = true;
    const fail = (why: string) => {
      ok = false;
      void why;
    };
    const visit = (n: RNode, mParent: RNode, prefix: string) => {
      const relayout = stackable(mParent, v);
      for (const c of n.children) {
        if (!ok) return;
        const rel = prefix ? `${prefix}/${c.id}` : c.id;
        const mn = byRel.get(rel);
        if (!mn || mn.type !== c.type) return fail(`structure ${rel}`);
        const path = rel.split('/').map((s) => ctx.uuid(s)).join('/');
        if (c.visible !== mn.visible) out.push([`${path}_isVisible`, c.visible]);
        if (!c.visible) continue;
        if (!relayout) {
          const autoText = c.type === 'text' && !['fixed-width', 'fixed-width-height'].includes(String(v.value(c.p.textGrowth, c.theme))) && (v.value(c.p.textAlign, c.theme) ?? 'left') === 'left';
          if (!near(c.x, mn.x) || !near(c.y, mn.y)) return fail(`position ${rel}`);
          if (!autoText && (!near(c.w, mn.w) || !near(c.h, mn.h)) && !(c.type === 'frame' && (stackable(c, v) || layoutMode(c, v) === 'none'))) return fail(`size ${rel}`);
        }
        if (c.instance || mn.instance) {
          // a nested symbol: swapped for another one, and its own overrides
          if (!c.instance || !mn.instance) return fail(`nested ${rel}`);
          const sub = this.master(c.instance.ref);
          if (!sub) return fail(`nested master ${rel}`);
          if (c.instance.ref !== mn.instance.ref) out.push([`${path}_symbolID`, sub.symbolID]);
          if (this.look(c) !== this.look(mn) || this.resolved(c, 'effect') !== this.resolved(mn, 'effect')) return fail(`nested look ${rel}`);
          for (const k of ['fill', 'stroke']) if (this.resolved(c, k) !== this.resolved(sub.tree, k) && this.resolved(c, k) !== this.resolved(mn, k)) return fail(`nested paint ${rel}`);
          // its content is compared with the master it shows now
          const nested = this.overrides(c, sub, where);
          if (!nested) return fail(`nested overrides ${rel}`);
          for (const [name, value] of nested) out.push([`${path}/${name}`, value]);
          continue;
        }
        if (this.look(c) !== this.look(mn) || this.resolved(c, 'effect') !== this.resolved(mn, 'effect')) return fail(`look ${rel}`);
        if (c.type === 'text') {
          const text = v.string(c.p.content, c.theme) ?? '';
          if (text !== (v.string(mn.p.content, mn.theme) ?? '')) out.push([`${path}_stringValue`, text]);
        }
        for (const prop of ['fill', 'stroke'] as const) {
          if (this.resolved(c, prop) === this.resolved(mn, prop)) continue;
          const o = this.paintOverride(c, mn, prop, path, where);
          if (!o) return fail(`${prop} ${rel}`);
          out.push(...o);
        }
        visit(c, mn, prefix);
      }
    };
    visit(inst, root, '');
    return ok ? out : null;
  }

  /** Override for a changed fill or stroke: a solid colour on a solid paint, or an image on an image fill. */
  private paintOverride(c: RNode, mn: RNode, prop: 'fill' | 'stroke', path: string, where: string): [string, unknown][] | null {
    const ctx = this.ctx;
    const now = paints(c.p[prop]);
    const was = paints(mn.p[prop]);
    if (JSON.stringify(ctx.vars.value(now, c.theme)) === JSON.stringify(ctx.vars.value(was, mn.theme)) && JSON.stringify(now) === JSON.stringify(was)) return [];
    if (now.length !== 1 || was.length !== 1) return null;
    const color = ctx.vars.color(now[0], c.theme);
    const before = ctx.vars.color(was[0], mn.theme);
    if (color && before) {
      if (prop === 'stroke') return [[`${path}_color:border-0`, sketchColor(ctx, color)]];
      return [[c.type === 'text' ? `${path}_textColor` : `${path}_color:fill-0`, sketchColor(ctx, color)]];
    }
    const img = ctx.vars.value(now[0], c.theme) as J;
    const old = ctx.vars.value(was[0], mn.theme) as J;
    if (prop === 'fill' && img?.type === 'image' && old?.type === 'image' && (img.mode ?? 'fill') === (old.mode ?? 'fill') && (img.opacity ?? 1) === (old.opacity ?? 1)) {
      const f = sketchPaint(ctx, now[0], c.theme, c, where);
      const ref = (f?.image as J | undefined)?._ref;
      if (!ref) return null;
      return [[`${path}_image`, { _class: 'MSJSONFileReference', _ref_class: 'MSImageData', _ref: ref }]];
    }
    return null;
  }
}
