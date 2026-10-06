import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PenDocument, PenNode } from './types.ts';

/** A node as read from a .pen file: any property may still be bound to a variable ("$name"). */
export type PenInputNode = PenNode & Record<string, unknown>;

export interface PenFile {
  path: string;
  /** folder of the .pen file – relative urls (images, fonts) resolve against it */
  dir: string;
  doc: PenDocument;
}

/** A problem with the input file that the user can act on (not a bug). */
export class PenReadError extends Error {}

const ALIGN: Record<string, 'inner' | 'center' | 'outer'> = { inside: 'inner', inner: 'inner', center: 'center', outside: 'outer', outer: 'outer' };

/**
 * Brings older documents to the current schema. Files saved by pen.dev before schema 2.10 or so describe a stroke as
 * one object: `stroke: {align, thickness, fill}`.
 */
function normalize(node: PenInputNode): void {
  const s = node.stroke as unknown;
  if (s && typeof s === 'object' && !Array.isArray(s) && !('type' in s) && ('fill' in s || 'thickness' in s || 'align' in s)) {
    const legacy = s as { fill?: unknown; thickness?: unknown; align?: string; cap?: string; join?: string };
    if (legacy.fill !== undefined) node.stroke = legacy.fill as PenNode['stroke'];
    else delete node.stroke;
    if (legacy.thickness !== undefined && node.strokeWidth === undefined) node.strokeWidth = legacy.thickness as PenNode['strokeWidth'];
    if (legacy.align && !node.strokeAlignment) node.strokeAlignment = ALIGN[legacy.align];
    if (legacy.cap && !node.strokeLinecap) node.strokeLinecap = legacy.cap as PenNode['strokeLinecap'];
    if (legacy.join && !node.strokeLinejoin) node.strokeLinejoin = legacy.join as PenNode['strokeLinejoin'];
  }
  if (typeof node.strokeAlignment === 'string' && ALIGN[node.strokeAlignment]) node.strokeAlignment = ALIGN[node.strokeAlignment];
  for (const c of node.children ?? []) normalize(c as PenInputNode);
  // overrides and replacements inside instances use the same shapes
  const desc = node.descendants as Record<string, PenInputNode> | undefined;
  if (desc && typeof desc === 'object') for (const d of Object.values(desc)) if (d && typeof d === 'object') normalize(d);
}

export function parsePen(text: string, path = 'document.pen'): PenFile {
  let doc: PenDocument;
  try {
    doc = JSON.parse(text) as PenDocument;
  } catch {
    throw new PenReadError(`${path} is not a readable pen.dev document (it is not JSON). Open it in pen.dev and save it again.`);
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.children)) {
    throw new PenReadError(`${path} is not a pen.dev document (no "children").`);
  }
  for (const c of doc.children) normalize(c as PenInputNode);
  return { path, dir: dirname(path), doc };
}

export function readPen(path: string): PenFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new PenReadError(`Cannot read ${path} (${e instanceof Error ? e.message : e}).`);
  }
  return parsePen(text, path);
}

/** Depth-first walk over a node tree (the callback may return false to skip children). */
export function walkNodes(node: PenNode, visit: (node: PenInputNode, parent: PenInputNode | null) => boolean | void, parent: PenInputNode | null = null): void {
  if (visit(node as PenInputNode, parent) === false) return;
  for (const c of node.children ?? []) walkNodes(c, visit, node as PenInputNode);
}
