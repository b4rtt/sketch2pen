# Changelog

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
