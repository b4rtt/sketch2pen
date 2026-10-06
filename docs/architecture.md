# Architecture

sketch2pen is a TypeScript program that runs on [Bun](https://bun.sh). The release binaries are the same code compiled
with `bun build --compile`; on macOS a small Swift helper adds CoreText text layout, and a SwiftUI app
(`native/app/SketchPen.swift`) runs the CLI for both directions. The CLI picks the direction from the file extension.

```
.sketch (zip)                                                   Design (Pen)/
  document.json ─┐                                                Design.pen
  pages/*.json   ├─ reader ─► convertSketch ─► PenDocument ─ writer ─► assets/
  images/, fonts/┘               │                                fonts/
                                 ├─ FontResolver (Google / shipped / substituted)
                                 ├─ CoreText helper (line breaks, SF Symbols)   ◄─ macOS only
                                 └─ Skia PathOps (booleans, dashes, outlines)
```

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | command line for both directions, output, reports, opening pen.dev / Sketch |
| `src/sketch/reader.ts`, `types.ts` | unzipping and parsing `.sketch` files; typings of the Sketch file format |
| `src/convert/document.ts` | the pipeline: swatches → variables, shared styles, fonts, CoreText pre-pass, symbol masters in dependency order, pages placed as canvas sections |
| `src/convert/context.ts` | conversion state: options, report, deterministic ids, assets, lookup tables shared between passes |
| `src/convert/layers.ts` | the layer dispatcher: containers, shapes, images, masks, inner-shadow emulation, positions and transforms |
| `src/convert/text.ts` | text layers: styles, sizing, splitting mixed styles into lines / paragraphs |
| `src/convert/symbols.ts` | instances and overrides, symbol swaps, resizing instances with Sketch's pinning rules |
| `src/convert/style.ts` | fills, gradients, borders, shadows, blurs, tints |
| `src/convert/extras.ts` | extra layers for what pen.dev lacks: dashed and multiple borders, line-end markers, shadow spread |
| `src/convert/decorations.ts` | underline and strikethrough drawn as shapes |
| `src/convert/flex.ts` | Sketch Stacks → flex layout, verified against Sketch's saved positions |
| `src/convert/fonts.ts` | font discovery (Sketch file, installed fonts), OpenType parsing, substitution |
| `src/convert/coretext.ts`, `native/coretext.swift` | the CoreText helper and its protocol |
| `src/convert/path.ts`, `src/util/pathops.ts` | SVG path generation and Skia PathOps wrappers |
| `src/util/geom.ts` | matrices, Sketch ⇄ pen.dev transforms |
| `src/util/image.ts` | PNG/JPEG decoding and PNG encoding (baked alpha masks) |
| `src/pen/types.ts`, `writer.ts`, `reader.ts` | the pen.dev document schema, writing the output folder, reading `.pen` files (older schemas normalised) |
| `src/sketch/builder.ts` | complete Sketch layers, styles and archives from code (pen.dev → Sketch, feature lab) |
| `src/pen2sketch/` | pen.dev → Sketch, see below |
| `src/util/fontmetrics.ts` | OpenType metrics: cmap, advances, GPOS / kern pair kerning, vertical metrics, TrueType outlines, GSUB ligatures |
| `src/report.ts` | console summary, `report.html`, `report.json` |
| `src/data/google-fonts.ts` | Google Fonts family list (generated) |

## Sketch → pen.dev pipeline

1. **Read.** The archive is unzipped in memory. Very old files (Sketch 42 and earlier used a different format) are
   rejected with a clear message.
2. **Document-level data.** Colour swatches become pen.dev variables; shared styles are indexed so overridden styles can
   be resolved by id.
3. **Fonts.** `FontResolver` indexes fonts embedded in the Sketch file and (with `--embed-fonts all`) installed on the
   computer by reading their `name`, `OS/2` and `fvar` tables (including the PostScript names of variable-font named
   instances), and decides per PostScript name – and, for Apple's SF fonts, per size – whether the font is a Google
   font, shipped or substituted.
4. **CoreText pre-pass** (macOS). One call of the helper outlines all private-use glyph texts and lays out every wrapped
   text with Sketch's line-breaking, returning each line's width in Sketch and in pen.dev, where underlines and
   strikethroughs go (with the font metrics), and the letter spacing that keeps Sketch's widths when pen.dev renders a
   shipped font differently (another optical size or cut).
5. **Symbol masters** are converted first, in dependency order, so instances can reference them and override
   resolution can look up the converted nodes.
6. **Pages.** Each page's layers are converted and the page is placed as a section below the previous one. Library
   symbols and symbols from skipped pages get their own sections.
7. **Write.** `writePen` writes the `.pen` JSON, images, generated images (baked masks) and the fonts to ship.

The converter is deterministic: node ids are hashes of Sketch object ids, so the same input produces the same output.

## pen.dev → Sketch

```
.pen (JSON) ─ reader ─► TreeBuilder ─► Layout ─► NodeConverter / Symbols ─► builder ─► .sketch (zip)
                           │              │            │
                     Variables, themes   text metrics  FontLibrary (shipped / Google Fonts / installed), icons, images
```

| Path | Responsibility |
| --- | --- |
| `document.ts` | the pipeline; Sketch pages (sketch2pen page sections become pages again), swatches, embedded fonts and images |
| `tree.ts` | the document as pen.dev draws it: instances expanded with overrides and replacements, themes, visibility |
| `variables.ts` | variables, themed values, colours |
| `layout.ts` | pen.dev's layout: flex frames, fit / fill sizing, groups, absolute children |
| `textlayout.ts`, `text.ts` | text measurement and wrapping, text layers and the baseline calibration |
| `fonts.ts`, `googlefonts.ts` | resolving fonts to the files pen.dev draws (Google Fonts at the axis values pen.dev uses), PostScript names, cache |
| `nodes.ts` | nodes → Sketch layers: frames and stacks, groups, shapes, paths, placement (rotation, flips) |
| `paint.ts` | fills, gradients (inverse of `src/convert/style.ts`), borders, shadows, blurs |
| `svgpath.ts` | SVG path parsing, bounds, Sketch curve points, arcs and polygons |
| `symbols.ts` | components → symbol masters, instances → symbol instances with overrides, or expanded |
| `icons.ts` | icon-library nodes drawn from the icon fonts pen.dev uses |
| `summary.ts`, `report.ts` | the conversion report |

The conversion itself is synchronous; everything remote (Google Fonts, icon fonts, remote images) is loaded before it
and cached in `~/Library/Caches/sketch2pen` (`$XDG_CACHE_HOME/sketch2pen`, `%LOCALAPPDATA%\sketch2pen`). Sketch object
ids are derived from the pen.dev ids, so the same input gives the same output.

## Notes on the pen.dev format

pen.dev documents are JSON (`{"version": "2.18", "fonts", "variables", "children"}`); pen.dev opens a plain JSON file
directly. These are the behaviours the converter relies on, all verified by rendering in pen.dev:

- **Coordinates** are relative to the parent. A node maps a local point *p* to `position + R·S·p`: it mirrors around its
  own origin, then rotates around its top-left corner. Sketch rotates first and mirrors around the layer's centre, so
  with a single flip the rotation direction reverses (`penTransform` in `src/util/geom.ts`).
- **Ids** must not contain `/`: a `ref` node's `descendants` overrides are keyed by id paths (`child/grandchild`).
- **Gradients** are defined in the unit square stretched over the node; linear, radial and angular parameters are
  converted accordingly (`src/convert/style.ts`).
- **Blur**: a layer blur needs twice Sketch's radius to match; shadow blur matches 1:1. A background blur only renders
  on a node that has a fill.
- **Blend modes** exist on paints only and blend with everything behind the node, including the parent frame's
  background. A frame with opacity 0.999 isolates its children like a Sketch mask group does.
- **Not drawn**: inner shadows (pen.dev 1.2 draws them outside paths), shadow spread, dashed strokes, line markers,
  masks, inline text formatting, paragraph spacing, underline and strikethrough (the properties exist but are not
  rendered), size-specific tracking of Apple fonts (`trak`, optical-size spacing). The converter emulates all of them.
- **Fonts**: pen.dev loads Google Fonts by family name and fonts listed in `fonts`:
  `{"name", "url": "./fonts/x.otf", "weight": 400 | [min, max], "style": "italic", "axes": [{"tag": "wght", "start", "end"}]}`.
  System fonts are not rendered. Variable fonts are rendered at their default optical size.
- **Images** are referenced by relative URL.
- pen.dev keeps open documents in memory; a file converted again must be closed and reopened.
- **Layout defaults**: a frame without `layout` lays out its children horizontally and is as large as its content;
  stroke alignment defaults to centre. Text boxes are whole pixels wide, lines as tall as the rounded line height.
- **Google Fonts** are drawn from each family's variable font at its default axis values (`opsz` included).
- **Icons** are drawn with icon fonts: lucide 0.563.0, Phosphor 1.4.2, Material Symbols at 90 % of the box, feather.

## Notes on the Sketch format

- **Sketch 2025+** replaced artboards with *frames*: groups with `groupBehavior` 1 (frame) or 2 (graphic) and a
  `clippingBehavior`. Stacks are groups with an `MSImmutableFlexGroupLayout`; their children are stored bottom-up.
- Sizing and pinning use `horizontalPins` / `verticalPins` (bit 1 = min edge, bit 4 = max edge) and
  `horizontalSizing` / `verticalSizing` (fixed, fit, fill, relative). Older files use `resizingConstraint`, where a
  *cleared* bit means fixed.
- Corners live in `style.corners` (`style` 1 = smooth); older files store radii on the rectangle's points.
- Shadows are one list with `isInnerShadow`; older files have `style.innerShadows`. Blurs moved from `style.blur` to
  `style.blurs`.
- Fills have a `layeringType`: 0 normal, 1 tint, 2 prototype overlay backdrop. In older files, a fill on a group is its
  tint.
- Symbol overrides are addressed as `<id>/<id>_<property>`.

## Verification

Unit tests cover the geometry and parsing helpers; conversion tests run hand-built fixtures and the generated feature
lab through the converter and check document invariants (unique ids, resolvable references and overrides, valid font
entries) and key properties. Visual fidelity is measured with `tools/compare.ts`, which renders every artboard with
Sketch (`sketchtool`) and pen.dev (through its MCP server) and diffs the images; `tools/compare-pen.ts` does the same
for pen.dev → Sketch, with its own feature lab (`tools/lab/pen-cases.ts`). See [development.md](development.md).
