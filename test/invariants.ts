import { expect } from 'bun:test';
import type { PenDocument, PenNode } from '../src/pen/types.ts';

export function allNodes(doc: PenDocument | { children: PenNode[] }): PenNode[] {
  const out: PenNode[] = [];
  const walk = (n: PenNode) => {
    out.push(n);
    n.children?.forEach(walk);
  };
  doc.children.forEach(walk);
  return out;
}

export const byName = (doc: PenDocument, name: string) => allNodes(doc).find((n) => n.name === name);

/** Structural invariants every generated document must satisfy for pen.dev to load it. */
export function checkInvariants(doc: PenDocument): void {
  const nodes = allNodes(doc);
  const ids = nodes.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).not.toContain('/');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const componentIds = (compId: string) => {
    const set = new Set<string>();
    const walk = (n: PenNode) => {
      set.add(n.id);
      n.children?.forEach(walk);
    };
    walk(byId.get(compId)!);
    return set;
  };
  for (const ref of nodes.filter((n) => n.type === 'ref')) {
    const comp = byId.get(ref.ref!);
    expect(comp?.reusable).toBe(true);
    for (const key of Object.keys(ref.descendants ?? {})) {
      // every override path must resolve through the component (and nested components)
      let scope = componentIds(ref.ref!);
      const parts = key.split('/');
      parts.forEach((part, i) => {
        expect(scope.has(part)).toBe(true);
        const n = byId.get(part)!;
        if (i < parts.length - 1) {
          expect(n.type).toBe('ref');
          scope = componentIds(n.ref!);
        }
      });
    }
  }
  for (const f of doc.fonts ?? []) {
    expect(f.url.startsWith('./')).toBe(true);
    expect(f.name.length).toBeGreaterThan(0);
  }
}
