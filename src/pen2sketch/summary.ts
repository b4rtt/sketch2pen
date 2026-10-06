import type { PenToSketchResult } from './document.ts';

export interface PenFontRow {
  family: string;
  weight: number;
  italic: boolean;
  postscriptName: string;
  source: 'document' | 'google' | 'local' | 'missing';
  embedded: boolean;
}

export function penFontRows(result: PenToSketchResult): PenFontRow[] {
  const rows = new Map<string, PenFontRow>();
  for (const f of result.ctx.fonts.used.values()) {
    rows.set(f.postscriptName, { family: f.family, weight: f.weight, italic: f.italic, postscriptName: f.postscriptName, source: f.source, embedded: f.embed && !!f.file });
  }
  return [...rows.values()].sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight);
}

/** Machine-readable summary of a pen.dev → Sketch conversion. */
export function penJsonReport(result: PenToSketchResult, source: string, output: string, seconds: number, version: string): unknown {
  return {
    tool: 'sketch2pen',
    direction: 'pen-to-sketch',
    version,
    source,
    output,
    seconds: Math.round(seconds * 100) / 100,
    pages: result.pages,
    stats: result.ctx.report.stats,
    fonts: penFontRows(result),
    warnings: result.ctx.report.warnings,
  };
}

export function penConsoleSummary(result: PenToSketchResult, output: string, seconds: number): string {
  const s = result.ctx.report.stats;
  const lines = [
    `✔ Converted in ${seconds.toFixed(1)} s → ${output}`,
    `  ${s.pages} pages · ${s.artboards} artboards · ${s.layers} layers · ${s.symbols} symbols · ${s.instances} instances (${s.detached} expanded) · ${s.images} images`,
    `  Flex layout → stacks: ${s.stacks} · colour variables → swatches: ${s.swatches}`,
  ];
  const fonts = penFontRows(result);
  const embedded = [...new Set(fonts.filter((f) => f.embedded).map((f) => f.family))];
  if (embedded.length) lines.push(`  Fonts embedded in the Sketch document: ${embedded.join(', ')}`);
  const missing = [...new Set(fonts.filter((f) => f.source === 'missing').map((f) => f.family))];
  if (missing.length) lines.push('', `  ⚠ Fonts not available (install them for Sketch): ${missing.join(', ')}`);
  const warns = result.ctx.report.warnings;
  if (warns.length) {
    lines.push('', '  Approximations:');
    for (const w of warns) lines.push(`   • ${w.message} (${w.count}×)`);
  }
  return lines.join('\n');
}
