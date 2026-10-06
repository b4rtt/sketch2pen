# Development

## Setup

- [Bun](https://bun.sh) 1.2 or newer
- macOS: Xcode Command Line Tools (`xcode-select --install`) for the CoreText helper, which is compiled automatically
  on first use and cached in `~/Library/Caches/sketch2pen/`
- For visual verification: [Sketch](https://www.sketch.com) and [pen.dev](https://pen.dev) installed in `/Applications`

```bash
bun install
bun src/cli.ts path/to/design.sketch     # run from source
bun test                                 # unit and conversion tests
bun run typecheck
```

## Tests

| File | Covers |
| --- | --- |
| `test/units.test.ts` | transforms, paths, colours and gradients, tints, font weights, symbol resizing, stacks, path operations |
| `test/convert.test.ts` | end-to-end conversion of hand-built Sketch documents (`test/fixture.ts`) |
| `test/lab.test.ts` | the feature lab document in the current and the pre-2025 Sketch format |
| `test/pen2sketch.test.ts` | pen.dev → Sketch: reading, variables and themes, layout, instances, geometry, gradients, text, end-to-end and the pen.dev lab (offline, no installed fonts) |

Every converted document is checked against the invariants in `test/invariants.ts`: unique ids without `/`, every
`ref` and every override path resolves, font URLs are relative.

To run the invariants against one of your own designs:

```bash
SKETCH2PEN_REAL_FILE=~/Designs/App.sketch bun test
```

## Feature lab

The feature lab is the ground truth for rendering fidelity. `tools/lab/cases.ts` generates a Sketch document with one
artboard per feature (gradients, shadows, masks, borders, text, symbols, stacks …) using the Sketch file-format
builder in `src/sketch/builder.ts` (also used by the pen.dev → Sketch converter). `bun run lab` then

1. writes the lab to `lab-output/lab.sketch`,
2. converts it,
3. renders every artboard with Sketch's `sketchtool`,
4. opens the result in pen.dev and exports the same artboards through pen.dev's MCP server,
5. writes `lab-output/compare/compare.html` with Sketch, pen.dev and a difference heat map side by side.

```bash
bun run lab                      # or: bun run lab <workdir> [--smooth-corners]
open lab-output/compare/compare.html
```

The score is the percentage of pixels whose colour differs noticeably. Anti-aliasing alone accounts for a few tenths of
a percent; anything above 1 % deserves a look. `tools/lab/legacy.ts` rewrites the lab into the pre-2025 data model
(artboards, separate inner-shadow lists, resizing constraints) so the legacy code paths are covered too.

**Adding a feature:** add an artboard to `tools/lab/cases.ts`, run the lab, and add assertions for how the feature is
represented to `test/lab.test.ts`.

## pen.dev feature lab

The other direction has its own lab: `tools/lab/pen-cases.ts` generates a pen.dev document with one frame per pen.dev
feature (fills and gradients, strokes, effects, shapes and paths, text, flex layout, groups, components with overrides
and swaps, themed variables, icons). `bun run lab:pen` converts it to Sketch, renders every frame with pen.dev (through
its MCP server, ground truth) and with `sketchtool`, and writes `lab-output/pen/compare/compare.html`.

```bash
bun run lab:pen                  # or: bun tools/lab/pen-run.ts <workdir>
open lab-output/pen/compare/compare.html
```

To compare a real document:

```bash
bun run compare:pen path/to/design.pen compare-output [--limit 20] [--no-symbols] [--no-stacks] [--skip-pen]
```

pen.dev renders a copy of the document from the work folder (relative urls made absolute), so the original is never
opened. Small size differences in the report usually mean that pen.dev's export includes a shadow reaching past the
frame while Sketch's artboard export is clipped; pen.dev exports are limited to 8192 pixels.

Text metrics are the part most sensitive to pen.dev changes. The calibration behind `src/pen2sketch/text.ts` and
`src/pen2sketch/googlefonts.ts` (line heights, baselines, the axis values of Google Fonts) was done by rendering
grids of fonts, sizes and line heights in both apps and comparing the ink of every line; redo it after pen.dev changes
its text rendering.

## Comparing a real document

```bash
bun run compare path/to/design.sketch compare-output [--pages "Home,Settings"] [--limit 20]
```

| Option | |
| --- | --- |
| `--pages` | only these pages |
| `--limit N` | only the first N artboards |
| `--skip-ref` | reuse the Sketch renders from a previous run |
| `--render <file>` | render the references from another copy of the document (see below) |
| `--smooth-corners` | convert with `--smooth-corners` |

`sketchtool` refuses documents saved by a newer Sketch than the one installed. If you only have an older Sketch, render
from a copy whose `meta.json` declares the installed version and pass it with `--render`.

The paths of the tools can be overridden with the `SKETCHTOOL` and `PEN_MCP_SERVER` environment variables.

## Building

```bash
bun run build:host        # dist/sketch2pen for this machine (+ the CoreText helper on macOS)
bash tools/build.sh --app # dist/Sketch Pen.app for this Mac (the app with the CLI for this architecture)
bun run build             # all release artifacts in dist/release (the macOS app needs macOS)
```

The app (`native/app/SketchPen.swift`) is a single SwiftUI file compiled with `swiftc`; it runs the bundled CLI with
`--json` and shows its report. Set `SKETCH2PEN_CLI` to run it against another CLI binary while developing.

`bun run build` produces:

| Artifact | Contents |
| --- | --- |
| `Sketch-Pen-macos.zip` | the *Sketch ⇄ Pen* app (SwiftUI, universal) with both CLI binaries and the helper |
| `sketch2pen-macos-arm64.zip`, `sketch2pen-macos-x64.zip` | CLI + universal CoreText helper |
| `sketch2pen-linux-x64.tar.gz`, `sketch2pen-linux-arm64.tar.gz` | CLI |
| `sketch2pen-windows-x64.zip` | CLI |
| `SHA256SUMS.txt` | checksums |

The binaries are ad-hoc signed; they are not notarized.

### App icon

The icon is an Icon Composer document (`assets/AppIcon.icon`) with Liquid Glass layers. The build compiles it with
`actool` from Xcode 26 or newer and otherwise uses the prebuilt copy in `assets/icon/`. After editing the icon, refresh
the prebuilt copy and the README image:

```bash
bash tools/icon.sh
```

## Google Fonts list

pen.dev loads every Google Fonts family by name, so those fonts are never shipped or substituted. The list lives in
`src/data/google-fonts.ts`; refresh it with:

```bash
bun run fonts:update
```

## Releasing

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Commit, then tag and push:

   ```bash
   git tag v1.2.3
   git push origin main v1.2.3
   ```

3. The **Release** workflow builds every artifact on macOS and publishes a GitHub release with the changelog section as
   its notes. It can also be started manually for an existing tag from the Actions tab.
