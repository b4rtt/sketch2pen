# How pen.dev documents are converted to Sketch

The pen.dev → Sketch direction is complete since version 2.0.0. It aims at one thing: **the Sketch document looks exactly like pen.dev draws the `.pen`
file**, with layers that stay editable – frames, stacks, symbols, swatches, text. Every mapping below was checked
against renders of both apps with the [pen.dev feature lab](development.md#pendev-feature-lab); approximations are
listed in the conversion report (`--json`, or the app's result screen).

## Document

| pen.dev | Sketch |
| --- | --- |
| The canvas | one page, *Page 1* |
| Documents created by sketch2pen (`Page: <name>` section titles) | the original pages again |
| Top-level frames | artboards (Sketch frames) |
| Components (`reusable`) at the top level | symbol masters in place |
| Components nested in other layers, library components | symbol masters on a *Symbols* page; the nested component itself becomes an instance |
| Colour variables | colour swatches – fills that use a variable refer to its swatch |
| Number / string / boolean variables | resolved values |
| Themes (`themes`, `theme` on a node) | resolved per subtree; the first value of every axis is the default |
| Disabled nodes (`enabled: false`) | hidden layers |
| Notes, prompts, contexts | left out (they are canvas annotations) |
| Script nodes, live web pages | left out / empty frame (reported) |
| Imported documents (`imports`) | not resolved (reported) |

Older documents are read too: the stroke object of schema 2.6 (`{align, thickness, fill}`) and `icon_font` nodes are
brought to the current schema. Image and font urls may be relative, absolute, `file://` or percent-encoded; remote
images are downloaded.

## Layout

pen.dev positions most layers with flex layout, so the converter re-computes pen.dev's layout to know where every
layer is:

- frames lay out their children **horizontally unless `layout` says otherwise**, size to their content by default,
  and share free space among `fill_container` children; `gap`, `padding`, `justifyContent` and `alignItems` as in
  pen.dev; children with `layoutPosition: absolute` and disabled children are not part of the flow;
- groups are as large as their children;
- texts are measured with the font files pen.dev uses (see [Fonts](#fonts)): advances and pair kerning (GPOS),
  letter spacing after every character, greedy wrapping at spaces and hyphens, widths rounded up to whole pixels and
  every line as tall as the rounded line height – exactly what pen.dev reports.

Flex frames become **Sketch stacks** (direction, gap, padding, alignment, *fit* and *fill* sizing, *ignore stack
layout*) with the positions pen.dev computes, so nothing moves and the layout stays editable. Frames Sketch would lay
out differently keep fixed positions: `space_around`, rotated items, groups in the flow, and overlapping items (Sketch
paints stack items in reverse order). `--no-stacks` keeps all frames fixed.

## Shapes, fills, strokes, effects

| pen.dev | Sketch |
| --- | --- |
| Rectangle, corner radii | rectangle with per-corner radii |
| Ellipse | oval; arcs and rings (`startAngle`, `sweepAngle`, `innerRadius`) as paths |
| Polygon | polygon inscribed in the ellipse of its box (like pen.dev), corner radius on the points |
| Path (SVG geometry, `viewBox`, `fillRule`) | shape path; several subpaths become a combined shape with the fill rule; quadratic curves and arcs become cubic curves |
| Rotation, flips | Sketch rotation and flips (pen.dev rotates around the top-left corner, Sketch around the centre) |
| Colour fill, opacity in the hex value, blend mode | fill |
| Linear / radial gradient | gradient with the identical colour ramp (pen.dev defines gradients in the unit square stretched over the box, Sketch in pixels) |
| Angular gradient | angular gradient; a rotation shifts the stops (Sketch's start at 3 o'clock) |
| Image fill (fill, fit, stretch, opacity) | pattern fill; WebP, GIF, HEIC images are converted to PNG on macOS |
| Mesh gradient | linear gradient of its colours (reported) |
| Shader fill | left out (reported) |
| Stroke: paints, width, alignment (default centre), caps, joins | borders |
| Per-side stroke widths | one rectangle per side, where pen.dev draws the stroke |
| Drop and inner shadows | shadows (spread is left out – pen.dev does not draw it) |
| Layer blur, background blur | gaussian / background blur at half the radius (pen.dev blurs twice as strongly) |

## Text

- Font family, weight, style, size, letter spacing, line height, colour (gradients and images as text fills),
  alignment, vertical alignment, auto / fixed-width / fixed-size boxes.
- **Baselines.** pen.dev and Sketch place lines differently: pen.dev centres the glyphs (ascender + descender) in the
  rounded line height – in the unrounded one when the font's own line height is used – and rounds the baseline to a
  whole pixel; Sketch centres them too, but with the font's line gap above, rounds as well and snaps to the device
  pixel grid when drawing. The converter writes pen.dev's line height and moves the text layer so the baselines land on
  the same pixel row – checked for six fonts × four sizes × five line heights, all identical.
- Underline and strikethrough are kept (pen.dev 1.2 does not draw them yet).
- Unnamed texts are named after their content, like in pen.dev's layer list.

## Fonts

Sketch draws installed fonts and fonts embedded in the document, so every font is resolved to the file pen.dev draws:

1. **Fonts shipped with the `.pen` file** (`fonts`) – embedded in the Sketch document.
2. **Google Fonts** – pen.dev draws each family's variable font at its default axis values (DM Sans at optical size 9,
   for example, while Google's static fonts are cut at 14). The converter downloads static instances at exactly those
   axis values (cached), embeds them and measures with them.
3. **Fonts installed on this computer** – referenced; embedded with `--embed-fonts all`.
4. Anything else is reported as missing and measured with approximate metrics; Sketch asks for the font when the
   document is opened.

Variable fonts are referred to by the named instance closest to the weight (Sketch's way of addressing them).

## Icons

pen.dev draws icon nodes with icon fonts; the converter uses the same fonts and draws the glyphs as vector shapes:
**lucide** 0.563.0 and **Phosphor** 1.4.2 (identical to pen.dev), **Material Symbols** (by ligature, optical size 48 –
pen.dev pins an older release of the font, so a few glyphs differ by a pixel) and **feather** (from its SVGs). The fonts
are downloaded once and cached; `--offline` uses only the cache.

## Components → symbols

Every component an instance uses becomes a symbol master. An instance becomes a **symbol instance** when Sketch draws
exactly what pen.dev draws; it is compared with its master node by node, with variables resolved in each one's theme:

| Difference | Sketch |
| --- | --- |
| Text content | text override |
| Visibility (`enabled`) | visibility override |
| Solid fill / text colour / border colour | colour override |
| Image fill | image override |
| Another component in a nested instance (`type: "ref"` replacement) | symbol swap |
| Instance size, re-flowed content | Sketch re-lays out stacks inside instances like pen.dev, and keeps children of fixed frames in place – so the size may differ wherever the master is a stack or has no layout |

Anything else – another background on the instance itself, other font sizes or effects, replaced subtrees, a
different layout where Sketch would not re-flow – expands the instance into plain layers (counted as *expanded* in the
report), so the design never changes. `--no-symbols` expands all instances.

## Report codes

| Code | Meaning |
| --- | --- |
| `missing-font`, `missing-font-file`, `variable-font` | font not available, shipped font file missing, variable font between named instances |
| `missing-image`, `image-format` | image not found, image format Sketch cannot store |
| `missing-component`, `override-missing` | instance of a missing / imported component, override for a layer the component does not have |
| `side-stroke-radius` | per-side stroke on a rounded shape drawn with square corners |
| `shadow-spread` | spread on a shadow (pen.dev does not draw it) |
| `mesh-gradient`, `shader-fill`, `angular-center` | paints Sketch does not have |
| `icon` | icon that could not be loaded (unknown name, offline) |
| `annotation`, `script`, `browser`, `unknown-node` | canvas annotations and generated content left out |
