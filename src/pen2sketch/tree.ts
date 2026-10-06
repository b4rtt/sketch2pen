// The document as pen.dev draws it: component instances (`ref` nodes) expanded into full subtrees with their
// overrides applied, themes propagated. Layout and conversion work on this tree.
import type { PenInputNode } from '../pen/reader.ts';
import type { PenDocument, PenNodeType, PenTheme } from '../pen/types.ts';
import type { Report } from './report.ts';
import type { Variables } from './variables.ts';

export interface InstanceInfo {
  /** id of the referenced component */
  ref: string;
  /** the component node as written in the document */
  component: PenInputNode;
  /** properties the `ref` node sets on the instance root (size, position, fills …) */
  rootProps: Record<string, unknown>;
  /** descendant overrides as applied: id path inside the instance → properties (or a replacement node) */
  overrides: Record<string, Record<string, unknown>>;
}

export interface RNode {
  /** unique key: the pen id, or the id path through instances ("instance/child") */
  key: string;
  /** pen id of the node (in an instance: the id inside the component) */
  id: string;
  type: PenNodeType;
  /** properties with instance overrides applied (values can still be variables) */
  p: PenInputNode;
  children: RNode[];
  parent: RNode | null;
  theme: PenTheme;
  /** set on the root of an expanded instance */
  instance?: InstanceInfo;
  /** innermost instance this node belongs to, and its id path inside it */
  owner?: RNode;
  rel?: string;
  /** this node replaced the component's node in an instance */
  replaced?: boolean;
  /** properties of this node changed by instance overrides */
  overridden?: Set<string>;
  /** a `ref` whose component is missing or recursive */
  broken?: boolean;

  // Layout (filled by the layout pass): position and size in the parent's local coordinates. For groups the box is
  // the bounds of the children; `ox`/`oy` is the group origin (children coordinates are relative to it).
  x: number;
  y: number;
  w: number;
  h: number;
  ox?: number;
  oy?: number;
  /** enabled (visible) after variables and overrides */
  visible: boolean;
}

const OWN_KEYS = new Set(['id', 'type', 'ref', 'descendants', 'children']);
const MAX_DEPTH = 24;

const clone = <T>(v: T): T => structuredClone(v);

export interface TreeResult {
  roots: RNode[];
  /** every node of the document (not inside instances) by pen id */
  byId: Map<string, PenInputNode>;
  /** component (reusable) nodes by id */
  components: Map<string, PenInputNode>;
}

export class TreeBuilder {
  readonly byId = new Map<string, PenInputNode>();
  readonly components = new Map<string, PenInputNode>();

  constructor(
    private doc: PenDocument,
    private vars: Variables,
    private report: Report,
  ) {
    const index = (n: PenInputNode) => {
      if (typeof n.id === 'string') this.byId.set(n.id, n);
      if (n.reusable === true || n.reusable === ('true' as unknown)) this.components.set(n.id, n);
      for (const c of n.children ?? []) index(c as PenInputNode);
    };
    for (const c of doc.children) index(c as PenInputNode);
  }

  build(): TreeResult {
    const roots = this.doc.children.map((c) => this.node(c as PenInputNode, null, c.id, undefined, undefined, 0));
    for (const r of roots) this.finish(r, this.vars.defaultTheme);
    return { roots, byId: this.byId, components: this.components };
  }

  /** Expands a single node (used for symbol masters: the component as itself). */
  buildOne(n: PenInputNode, theme: PenTheme = this.vars.defaultTheme): RNode {
    const r = this.node(n, null, n.id, undefined, undefined, 0);
    this.finish(r, theme);
    return r;
  }

  private node(raw: PenInputNode, parent: RNode | null, key: string, owner: RNode | undefined, rel: string | undefined, depth: number): RNode {
    if (raw.type === 'ref') return this.instance(raw, parent, key, owner, rel, depth);
    const p = { ...raw } as PenInputNode;
    delete (p as Record<string, unknown>).children;
    const r: RNode = { key, id: raw.id, type: raw.type, p, children: [], parent, theme: {}, owner, rel, x: 0, y: 0, w: 0, h: 0, visible: true };
    // inside an instance, ids are unique per component: a descendant's path is the instance key plus its id
    r.children = (raw.children ?? []).map((c) => this.node(c as PenInputNode, r, owner ? `${owner.key}/${c.id}` : c.id, owner, owner ? c.id : undefined, depth));
    return r;
  }

  private instance(raw: PenInputNode, parent: RNode | null, key: string, owner: RNode | undefined, rel: string | undefined, depth: number): RNode {
    const refId = String(raw.ref ?? '');
    const component = this.byId.get(refId);
    const placeholder = (why: string): RNode => {
      this.report.warn('missing-component', why, raw.name ? String(raw.name) : key);
      const p = { ...raw, type: 'frame', layout: 'none' } as PenInputNode;
      delete (p as Record<string, unknown>).ref;
      delete (p as Record<string, unknown>).descendants;
      return { key, id: raw.id, type: 'frame', p, children: [], parent, theme: {}, owner, rel, x: 0, y: 0, w: 0, h: 0, visible: true, broken: true };
    };
    if (!component) return placeholder(refId.includes(':') ? 'Instance of a component from an imported document – not converted' : 'Instance of a missing component – drawn as an empty frame');
    if (depth >= MAX_DEPTH) return placeholder('Component nested in itself – drawn as an empty frame');

    // the instance root: the component's own properties, then what the ref sets
    const rootProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (!OWN_KEYS.has(k)) rootProps[k] = v;
    const base = clone(component);
    delete (base as Record<string, unknown>).reusable;
    const p = { ...base, ...rootProps, id: raw.id } as PenInputNode;
    delete (p as Record<string, unknown>).children;
    if (component.type === 'ref') {
      // a ref to a ref: expand the inner one and re-root it
      const inner = this.instance({ ...(base as PenInputNode), ...rootProps, id: raw.id } as PenInputNode, parent, key, owner, rel, depth + 1);
      this.applyOverrides(inner, (raw.descendants as Record<string, Record<string, unknown>>) ?? {}, depth);
      return inner;
    }
    const r: RNode = { key, id: raw.id, type: component.type, p, children: [], parent, theme: {}, owner, rel, x: 0, y: 0, w: 0, h: 0, visible: true };
    r.instance = { ref: refId, component, rootProps, overrides: {} };
    if (Object.keys(rootProps).length) r.overridden = new Set(Object.keys(rootProps));
    r.children = (base.children ?? []).map((c) => this.node(c as PenInputNode, r, `${key}/${c.id}`, r, c.id, depth + 1));
    this.applyOverrides(r, (raw.descendants as Record<string, Record<string, unknown>>) ?? {}, depth);
    return r;
  }

  /** Finds a node inside an instance by its id path ("child" or "nestedInstance/child"). */
  private find(root: RNode, path: string[]): RNode | null {
    let scope: RNode = root;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i]!;
      let hit: RNode | null = null;
      const search = (n: RNode): void => {
        for (const c of n.children) {
          if (hit) return;
          if (c.id === seg) {
            hit = c;
            return;
          }
          if (!c.instance) search(c); // nested instances are entered only through their own id
        }
      };
      search(scope);
      // a name works too (pen.dev accepts unique descendant names)
      if (!hit) {
        const named: RNode[] = [];
        const byName = (n: RNode): void => {
          for (const c of n.children) {
            if (c.p.name === seg) named.push(c);
            if (!c.instance) byName(c);
          }
        };
        byName(scope);
        if (named.length === 1) hit = named[0]!;
      }
      if (!hit) return null;
      scope = hit;
    }
    return scope;
  }

  private applyOverrides(inst: RNode, descendants: Record<string, Record<string, unknown>>, depth: number): void {
    const entries = Object.entries(descendants).filter(([, v]) => v && typeof v === 'object');
    // shallow paths first, so overrides inside a replaced or re-expanded subtree land on the new nodes
    entries.sort((a, b) => a[0].split('/').length - b[0].split('/').length);
    for (const [path, props] of entries) {
      const target = this.find(inst, path.split('/'));
      if (!target) {
        this.report.warn('override-missing', 'Instance override for a layer the component does not have – skipped', `${inst.p.name ?? inst.key} → ${path}`);
        continue;
      }
      inst.instance!.overrides[path] = props;
      if ('type' in props && props.type) {
        // replacement: a new subtree in place of the component's node
        const raw = { ...(props as PenInputNode), id: (props.id as string) ?? target.id };
        const owner = target.owner;
        const repl = this.node(raw, target.parent, target.key, owner, target.rel, depth + 1);
        repl.replaced = true;
        const siblings = target.parent!.children;
        siblings[siblings.indexOf(target)] = repl;
        continue;
      }
      if (target.instance && ('descendants' in props || 'ref' in props)) {
        // a nested instance re-targeted or with more overrides: expand it again
        const raw = { ...target.instance.rootProps, ...props, id: target.id, type: 'ref', ref: (props.ref as string) ?? target.instance.ref } as PenInputNode;
        const prev = target.instance.overrides;
        if (!('ref' in props)) raw.descendants = { ...prev, ...((props.descendants as Record<string, Record<string, unknown>>) ?? {}) };
        const re = this.instance(raw, target.parent, target.key, target.owner, target.rel, depth + 1);
        re.overridden = new Set([...(target.overridden ?? []), ...Object.keys(props)]);
        const siblings = target.parent!.children;
        siblings[siblings.indexOf(target)] = re;
        continue;
      }
      const { children, ...rest } = props as Record<string, unknown> & { children?: PenInputNode[] };
      Object.assign(target.p, rest);
      target.overridden = new Set([...(target.overridden ?? []), ...Object.keys(rest)]);
      if (Array.isArray(children)) {
        // slot content
        target.children = children.map((c) => this.node(c, target, `${target.key}/${c.id}`, target.owner, c.id, depth + 1));
        target.overridden.add('children');
      }
    }
  }

  /** Themes and visibility, top-down. */
  private finish(n: RNode, theme: PenTheme): void {
    n.theme = this.vars.child(theme, (this.vars.value(n.p.theme, theme) as PenTheme | undefined) ?? undefined);
    n.visible = this.vars.bool(n.p.enabled, n.theme) !== false;
    for (const c of n.children) {
      c.parent = n;
      this.finish(c, n.theme);
    }
  }
}

/** Depth-first walk over the expanded tree. */
export function walk(n: RNode, visit: (n: RNode) => boolean | void): void {
  if (visit(n) === false) return;
  for (const c of n.children) walk(c, visit);
}
