# How Sketch features are converted

sketch2pen maps every Sketch feature to the closest *native* pen.dev construct, so the result stays editable. Where
pen.dev has no equivalent, the converter draws the same pixels with extra layers or computed geometry and names those
layers clearly (`Card (inner shadow)`, `Line (border 2)` …). Everything approximate is listed in `report.html` /
`report.json` – see [report codes](#report-codes) at the end.

All mappings below are checked against Sketch's own renderer by the [feature lab](development.md#feature-lab).

## Document

| Sketch | pen.dev |
| --- | --- |
| Pages | pen.dev has no pages: each page becomes a section of one canvas, stacked vertically with a large `Page: <name>` title. Keeping one document keeps components linked across pages. `--pages` converts a subset. |
| Artboards, frames (Sketch 2025+), graphics | frames (`clip` follows the frame's *clip content* setting) |
| Symbols page / symbol masters | reusable components placed where they are in Sketch |
| Library (foreign) symbols | reusable components in a `Library symbols` section |
| Symbols used by instances on converted pages but living on a skipped page | components in a `Symbols (from pages not converted)` section |
| Colour swatches (local and library) | colour variables (`$Name`); fills that use an unmodified swatch reference the variable |
| Shared layer / text styles | applied to each layer (pen.dev has no shared styles) |
| Hidden layers | kept, disabled (`enabled: false`) |
| Images | `assets/` next to the `.pen` file |
| Embedded fonts | `fonts/` next to the `.pen` file, registered in the document (see [Fonts](#fonts)) |

Node ids are derived from Sketch object ids, so converting the same file twice gives the same ids.

## Geometry

- **Positions** are converted to pen.dev's parent-relative coordinates.
- **Rotation and flips.** Sketch rotates a layer and then mirrors it around its centre; pen.dev mirrors around the node's
  origin and rotates around its top-left corner. The converter computes pen.dev's `x`, `y` and `rotation` so the layer
  lands on the same pixels (a single flip reverses the rotation direction).
- **Rectangles** keep per-corner radii. **Smooth corners** (Sketch's squircle style) become ordinary radii so they stay
  editable; `--smooth-corners` draws them as exact paths instead.
- **Ovals** become ellipses, **paths and polygons** SVG paths. Point corner radii are rounded with circular fillets the
  way Sketch does.
- **Boolean groups** (union, subtract, intersect, difference) are computed with Skia PathOps into a single path.

## Fills, borders and effects

### Fills

- Colour, gradient and image fills, fill opacity and fill blend modes.
- **Linear gradients**: Sketch evaluates them in pixels, pen.dev in the unit square stretched over the layer. The
  converter solves for the pen.dev centre, length and angle that give the identical colour ramp, so gradients on
  non-square layers match.
- **Radial gradients**: Sketch's pixel-space ellipse (including the *ellipse length*) is mapped into pen.dev's
  normalised space and decomposed into width, height and rotation.
- **Angular gradients**: rotated so they start at 3 o'clock like Sketch.
- **Image fills**: fill, fit and stretch modes; tiled images are drawn as *fill* (reported).
- **Layer blend modes** become fill blend modes. Sketch blends a layer only with the layers below it inside its
  artboard, pen.dev also with the frame's background: blend modes with nothing below them are dropped, and masked
  groups are isolated, so the colours match.
- **Tints** (groups, frames and symbol instances) recolour the content: colour fills and borders take the tint colour,
  gradients keep their stop opacities, images keep their colours (reported).
- Prototype overlay backdrops are skipped; **noise fills** have no equivalent (reported).

### Borders

- Inside, centre and outside borders, colour and gradient borders, joins and caps.
- **Several borders** on a shape: the first becomes the stroke, the others are stroke-only copies of the shape on top.
  Frames and texts support one stroke width (reported when they have more).
- **Dashed borders**: pen.dev has no dashes. On shapes the dashes are computed with Skia (dash pattern, caps, joins),
  clipped to the border position and drawn as a filled path. Frames and texts get a solid border (reported).
- **Arrowheads and line-end markers** (arrows, circles, squares, lines) are drawn as paths with the geometry Sketch uses.

### Shadows and blurs

- **Drop shadows**: offset, blur, colour. Shadow **spread** is not supported by pen.dev; the converter draws a grown copy
  of the shape with the blurred shadow behind the layer instead (exact for rectangles and paths).
- **Inner shadows** are not supported by pen.dev (it draws them outside). They are emulated:
  - without blur on rectangles, as an inside stroke with per-side widths;
  - with blur, as a blurred band (the layer's outline minus the offset, spread-shrunk hole) clipped to the layer.
- **Layer blur** and **background blur**: the blur radius is converted to pen.dev's scale. A background blur needs a
  fill in pen.dev, so an invisible fill is added when the layer has none.
- **Motion, zoom** and **glass** blurs are converted to gaussian / background blur (reported).

## Masks

pen.dev clips only with frames, so a Sketch mask and the layers it masks become a clipping frame:

- **Rectangle and oval masks** become a frame with the same corner radius (circles stay exact).
- A shape masking **one image of the same size** becomes the shape with an image fill – the natural pen.dev structure.
- **Path-shaped masks**: vector shapes and images inside are intersected with the mask outline exactly (Skia PathOps).
  Texts and symbol instances are clipped by the mask's bounds (reported).
- **Alpha masks** (the mask's opacity or gradient decides visibility) are baked: the masked images are multiplied with
  the mask's alpha and written as new PNGs in `assets/generated/`.

## Text

- Font family, weight, style, size, line height, letter spacing, colour, alignment, vertical alignment, text transform
  (uppercase / lowercase), auto-width, auto-height and fixed-size boxes.
- **Line breaks**: on macOS a small CoreText helper lays out every wrapped text exactly like Sketch. pen.dev renders
  variable fonts at their default optical size, which can make them slightly wider than in Sketch; such text boxes are
  widened just enough to keep Sketch's line breaks. Centred and right-aligned auto-width texts are re-anchored so they
  stay in place.
- **Mixed styles in one text layer**: pen.dev has no inline formatting, so the text is split exactly where Sketch wraps
  it – one text layer per style run, arranged in rows (reported). When the lines cannot be measured, the dominant
  style is used for the paragraph (reported).
- **Paragraph spacing**: one text layer per paragraph in a vertical stack with the right gap.
- **SF Symbols and icon fonts** (private-use glyphs) are converted to vector paths, because pen.dev cannot render system
  fonts. This needs the macOS helper.
- **Underline and strikethrough** stay on the text but pen.dev does not draw them yet (reported).

### Fonts

pen.dev renders Google Fonts by name and fonts registered in the document. For every other font:

1. **Fonts embedded in the Sketch file** are written to `fonts/` and registered (`--embed-fonts document` or `all`).
2. **Fonts installed on this computer** are shipped the same way (`--embed-fonts all`, the default). Font collections
   (`.ttc`) are split into single faces, variable fonts are registered with their weight range.
3. Otherwise the font is **substituted** with a close Google font – metric-compatible where one exists:

   | Sketch font | Substitute |
   | --- | --- |
   | Helvetica, Helvetica Neue, Arial | Arimo |
   | Times, Times New Roman | Tinos |
   | Courier, Courier New | Cousine |
   | Georgia | Gelasio |
   | Calibri / Cambria | Carlito / Caladea |
   | SF Pro, SF Compact, system UI fonts, Graphik | Inter |
   | SF Pro Rounded | Nunito |
   | SF Mono, Menlo, Monaco | Roboto Mono |
   | Avenir, Avenir Next | Nunito Sans |
   | Futura | Jost |
   | Proxima Nova, Gotham | Montserrat |
   | Circular | DM Sans |
   | Gill Sans | Lato |
   | anything else | Inter |

   `--font-map "Brand Sans=Figtree"` overrides the choice for any family.

The report lists every font with its decision (Google font, shipped, substituted).

## Symbols

| Sketch | pen.dev |
| --- | --- |
| Symbol master | reusable component (frame) |
| Symbol instance | `ref` to the component |
| Text override | text content |
| Hidden / shown layer | `enabled` |
| Image override | image fill |
| Symbol swap (nested instances included) | replacement `ref` with its own overrides |
| Text style, layer style, text colour, fill colour and colour-swatch overrides | the corresponding properties |
| Resized instance | every descendant resized with Sketch's pinning rules (pins and sizing, or legacy resizing constraints) |
| Scaled instance | positions and sizes, font sizes, letter spacing, border widths and corner radii scaled |
| Instance tint | recoloured descendants |
| *Include background in instances* | the master's background on the instance |

An instance of a symbol missing from the file becomes a labelled placeholder (reported).

## Stacks

Sketch Stacks become pen.dev **flex layout** (direction, gap, padding, alignment, justification, stretched and fixed
children; children set to *ignore stack layout* are positioned absolutely). The converter re-computes every stack with
pen.dev's layout rules and keeps flex layout only when every child ends up exactly where Sketch saved it. Stacks it
cannot reproduce (wrapping, negative padding, masks inside, rotated children …) keep absolute positions, so the design
never shifts. `--no-flex` keeps all stacks absolute.

## Not converted

Prototype links and flows, layout grids and guides, export presets, slices, hotspots, and colour adjustments (hue,
saturation, brightness, contrast) have no pen.dev equivalent and are skipped.

## Report codes

| Code | Meaning |
| --- | --- |
| `rich-lines`, `split-text`, `mixed-text` | text with several styles split into lines or runs, or drawn in its dominant style |
| `paragraph-spacing` | paragraphs split into separate text layers |
| `text-decoration` | underline / strikethrough not drawn by pen.dev |
| `path-mask`, `rotated-mask`, `mask-stroke` | mask clipped by its bounds or drawn along the mask edge |
| `alpha-mask` | alpha mask whose content could not be baked, approximated by the mask's opacity |
| `smooth-corners` | squircle corners drawn as regular radii (use `--smooth-corners`) |
| `multi-border`, `dashed-border`, `dash-pattern` | border features pen.dev lacks on frames and texts |
| `shadow-spread`, `shadow-spread-component` | spread not possible on this layer type |
| `inner-shadow-*` | inner shadow on a layer type that cannot be emulated |
| `glass-blur`, `motion-blur` | blur converted to the closest pen.dev blur |
| `noise-fill`, `image-tile`, `tint-image`, `layer-blend` | fill features pen.dev lacks |
| `glyph-text`, `no-coretext` | SF Symbols / text wrapping without the macOS helper |
| `missing-symbol`, `missing-swap`, `missing-image`, `override-unknown` | references the Sketch file does not resolve |
| `flip-in-stack`, `unknown-layer` | rare layer setups converted best-effort |
