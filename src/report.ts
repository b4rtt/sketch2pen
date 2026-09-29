import type { Context } from './convert/context.ts';
import type { WrittenFiles } from './pen/writer.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface FontRow {
  postscriptName: string;
  family: string;
  penFamily: string;
  weight: number;
  italic: boolean;
  status: 'google' | 'embedded' | 'local' | 'substituted';
  note: string;
}

export function fontRows(ctx: Context): FontRow[] {
  return [...ctx.fonts.used.entries()]
    .map(([key, f]) => ({
      postscriptName: f.postscriptName ?? key,
      family: f.originalFamily,
      penFamily: f.family,
      weight: f.weight,
      italic: f.italic,
      status: f.source,
      note:
        f.source === 'google'
          ? 'Google Fonts – loaded by pen.dev'
          : f.source === 'embedded'
            ? 'shipped with the document (embedded in the Sketch file)'
            : f.source === 'local'
              ? 'shipped with the document (copied from this computer)'
              : `not available in pen.dev – replaced with ${f.family}`,
    }))
    .sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight);
}

/** Machine-readable summary (report.json). */
export function jsonReport(ctx: Context, files: WrittenFiles, source: string, seconds: number, version: string): unknown {
  return {
    tool: 'sketch2pen',
    version,
    source,
    output: files.penFile,
    seconds: Math.round(seconds * 100) / 100,
    sketchVersion: ctx.sketch.meta.appVersion,
    stats: ctx.report.stats,
    fonts: fontRows(ctx),
    warnings: ctx.report.warnings,
  };
}

export function consoleSummary(ctx: Context, files: WrittenFiles, seconds: number): string {
  const s = ctx.report.stats;
  const lines = [
    `✔ Converted in ${seconds.toFixed(1)} s → ${files.penFile}`,
    `  ${s.pages} pages · ${s.frames} frames · ${s.layers} layers · ${s.components} components · ${s.instances} instances · ${s.images} images`,
    `  Stacks → flex layout: ${s.flexStacks}, kept absolute: ${s.absoluteStacks}`,
  ];
  const shipped = fontRows(ctx).filter((f) => f.status === 'embedded' || f.status === 'local');
  if (shipped.length) lines.push(`  Fonts shipped with the document: ${[...new Set(shipped.map((f) => f.penFamily))].join(', ')}`);
  const substituted = fontRows(ctx).filter((f) => f.status === 'substituted');
  if (substituted.length) {
    lines.push('', '  ⚠ Fonts not available in pen.dev (substituted):');
    for (const f of new Map(substituted.map((x) => [`${x.family}→${x.penFamily}`, x])).values()) lines.push(`   • ${f.family} → ${f.penFamily}`);
  }
  const warns = ctx.report.warnings;
  if (warns.length) {
    lines.push('', '  Approximations:');
    for (const w of warns) lines.push(`   • ${w.message} (${w.count}×)`);
  }
  return lines.join('\n');
}

export function htmlReport(ctx: Context, files: WrittenFiles, source: string, seconds: number, version: string): string {
  const s = ctx.report.stats;
  const rows = ctx.report.warnings
    .map((w) => `<tr><td>${esc(w.message)}</td><td class="n">${w.count}</td><td class="ex">${w.examples.map(esc).join('<br>')}</td></tr>`)
    .join('');
  const fonts = fontRows(ctx)
    .map((f) => `<tr><td>${esc(f.family)}${f.italic ? ' <i>italic</i>' : ''}</td><td class="n">${f.weight}</td><td>${esc(f.postscriptName)}</td><td class="st ${f.status}">${esc(f.note)}</td></tr>`)
    .join('');
  const stat = (n: number, label: string) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>sketch2pen report</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--accent:#0f766e;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--card:#292524;--accent:#5eead4;--warn:#fbbf24}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Inter",sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}
.sub{color:var(--muted);margin:0 0 24px;word-break:break-all}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.stat b{display:block;font-size:22px;color:var(--accent)}.stat span{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:block;overflow-x:auto}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
td.n{text-align:right;font-variant-numeric:tabular-nums}td.ex{color:var(--muted);font-size:12px}
td.st.substituted{color:var(--warn)}
</style></head><body><main>
<h1>Sketch → pen.dev conversion</h1>
<p class="sub">${esc(source)} → ${esc(files.penFile)} · ${seconds.toFixed(1)} s · sketch2pen ${esc(version)}</p>
<div class="stats">${stat(s.pages, 'pages')}${stat(s.frames, 'frames / artboards')}${stat(s.layers, 'layers')}${stat(s.components, 'components')}${stat(s.instances, 'instances')}${stat(s.images, 'images')}${stat(s.flexStacks, 'stacks → flex layout')}</div>
<h2>Fonts</h2>
<table><thead><tr><th>Family</th><th>Weight</th><th>PostScript name</th><th>In pen.dev</th></tr></thead><tbody>${fonts}</tbody></table>
<h2>Approximations and unsupported features</h2>
${rows ? `<table><thead><tr><th>What</th><th>Count</th><th>Examples</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>Everything was converted without approximations.</p>'}
</main></body></html>`;
}
