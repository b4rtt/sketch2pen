# Changelog

## 1.1.0 – 2026-09-29

- **Underline and strikethrough are drawn.** pen.dev keeps them on the text without drawing them, so they become thin
  shapes placed exactly where Sketch draws them (measured with CoreText, per wrapped line, in the text colour).
- **Masks**: symbol instances used as masks (e.g. a circle symbol clipping a flag) clip with their symbol's shape;
  rectangles edited in Sketch that are still rectangles clip exactly with their corner radii; ellipse masks cut shapes
  exactly. Texts and instances inside path masks are only reported when they actually reach past the outline.
- **Fonts**: named instances of variable fonts (e.g. `SFPro-Semibold`) are found by their PostScript names – before,
  such fonts were substituted. Apple's SF Pro / SF Compact use the installed Text or Display cut matching the size, and
  shipped variable fonts get the letter spacing that keeps Sketch's text widths.
- Report: the text-decoration and path-mask notes only appear where something could not be reproduced.

## 1.0.0 – 2026-09-29

First public release.

- Converts Sketch documents (Sketch 43 – 2026 formats) directly into pen.dev `.pen` documents.
- Symbols → components with overrides, symbol swaps, tints, resized and scaled instances.
- Sketch Stacks → flex layout, verified against Sketch's saved positions.
- Exact emulation of what pen.dev lacks: inner shadows, shadow spread, several border widths, dashed borders,
  line-end markers, alpha masks (baked into images), path-shaped masks, paragraph spacing, mixed-style text,
  smooth corners (`--smooth-corners`).
- Fonts pen.dev cannot load are shipped with the document (from the Sketch file or the computer) or substituted with a
  metric-compatible Google font; `--font-map` overrides.
- CoreText helper on macOS: Sketch-exact line breaks and SF Symbols as vector paths.
- macOS drag-and-drop app, standalone CLI for macOS, Linux and Windows, HTML and JSON conversion reports.
