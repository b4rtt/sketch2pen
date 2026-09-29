<p align="center"><img src="docs/images/icon.png" width="128" height="128" alt=""></p>

<h1 align="center">sketch2pen</h1>

<p align="center">Convert Sketch designs into <a href="https://pen.dev">pen.dev</a> documents – directly, with no Figma in between.</p>

<p align="center">
  <a href="https://github.com/b4rtt/sketch2pen/actions/workflows/ci.yml"><img src="https://github.com/b4rtt/sketch2pen/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/b4rtt/sketch2pen/releases/latest"><img src="https://img.shields.io/github/v/release/b4rtt/sketch2pen" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/b4rtt/sketch2pen" alt="MIT license"></a>
</p>

- **Native pen.dev documents.** Layers stay editable, symbols become components with overrides, Sketch Stacks become
  flex layout, colour swatches become variables, fonts ship with the document.
- **Pixel-close.** Every feature is verified against Sketch's own renderer: the median difference is **0.09 %** of pixels
  across the feature lab and **0.6 %** across a real 386-artboard production design.
- **Current Sketch files.** Sketch 2025/2026 documents (frames, stacks, tints, pins, smooth corners) as well as
  older files saved by Sketch 43 or newer.

![The same Sketch features rendered by Sketch and by pen.dev after conversion](docs/images/lab-comparison.png)

## Install

### macOS app (drag & drop)

1. Download **`Sketch-to-Pen-macos.zip`** from the [latest release](https://github.com/b4rtt/sketch2pen/releases/latest) and move
   *Sketch to Pen* to your Applications folder.
2. Drop a `.sketch` file onto the app (or open the app and pick a file). The converted document opens in pen.dev.

The app is not notarized by Apple, so macOS blocks it the first time: open **System Settings → Privacy & Security** and
click **Open Anyway** – or remove the quarantine flag in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Sketch to Pen.app"
```

### Command line

Download the archive for your platform from the [latest release](https://github.com/b4rtt/sketch2pen/releases/latest):

| Platform | Archive |
| --- | --- |
| macOS (Apple Silicon) | `sketch2pen-macos-arm64.zip` |
| macOS (Intel) | `sketch2pen-macos-x64.zip` |
| Linux | `sketch2pen-linux-x64.tar.gz`, `sketch2pen-linux-arm64.tar.gz` |
| Windows | `sketch2pen-windows-x64.zip` |

```bash
# macOS (Apple Silicon) – put both files in a folder on your PATH
curl -L -o sketch2pen.zip https://github.com/b4rtt/sketch2pen/releases/latest/download/sketch2pen-macos-arm64.zip
unzip sketch2pen.zip -d ~/.local/bin

# Linux
curl -L https://github.com/b4rtt/sketch2pen/releases/latest/download/sketch2pen-linux-x64.tar.gz | tar -xz -C ~/.local/bin
```

On Windows, unzip `sketch2pen-windows-x64.zip` and run `sketch2pen.exe` from a terminal.

On macOS keep `sketch2pen-coretext` next to `sketch2pen`: it lets the converter wrap text exactly like Sketch and draw
SF Symbols as vectors. On Linux and Windows the converter works without it, with approximate text wrapping and SF
Symbols kept as text. If you downloaded the archive with a browser, clear the quarantine flag first:
`xattr -d com.apple.quarantine sketch2pen sketch2pen-coretext`.

### From source

Requires [Bun](https://bun.sh) 1.2 or newer (and Xcode Command Line Tools on macOS for the CoreText helper).

```bash
git clone https://github.com/b4rtt/sketch2pen.git
cd sketch2pen
bun install
bun src/cli.ts path/to/design.sketch
```

## Usage

```bash
sketch2pen "Design.sketch"
```

This writes `Design (Pen)/` next to the Sketch file and opens the result in pen.dev:

```
Design (Pen)/
├── Design.pen      ← open in pen.dev
├── assets/         ← images from the Sketch file
├── fonts/          ← fonts shipped with the document (if any)
├── report.html     ← what was converted approximately, font decisions
└── report.json     ← the same report for scripts
```

| Option | Description |
| --- | --- |
| `-o, --out <dir>` | output folder (default: `<name> (Pen)` next to the Sketch file) |
| `-p, --pages <names>` | convert only these pages, comma separated |
| `--list` | list pages and artboards, then exit |
| `--embed-fonts <mode>` | `all` (default): ship fonts from the Sketch file and this computer · `document`: only fonts embedded in the Sketch file · `none`: substitute them |
| `--font-map <map>` | font substitutions, e.g. `"Brand Sans=Figtree,SF Pro=Inter"` |
| `--smooth-corners` | draw smooth (squircle) corners exactly as paths instead of editable rectangles |
| `--no-flex` | keep Sketch Stacks as absolute positions instead of flex layout |
| `--no-open` | do not open the result in pen.dev |
| `--json` | print the conversion report as JSON |

pen.dev has no pages, so every Sketch page becomes a titled section of one canvas; that keeps components linked across
pages. pen.dev keeps open documents in memory – if you convert a file again while it is open, close and reopen it.

## Fonts

pen.dev loads [Google Fonts](https://fonts.google.com) by name. For every other font the converter picks the most
faithful option:

1. **Shipped with the document** – fonts embedded in the Sketch file (and, with `--embed-fonts all`, fonts installed on
   this computer) are copied to `fonts/` and registered in the document, so pen.dev renders the exact typeface.
   Collections (`.ttc`) are split into single faces. Mind the font licences before you share the folder.
2. **Substituted** – with no font file available, a close Google font is used (metric-compatible where one exists:
   Arimo for Helvetica/Arial, Tinos for Times, Cousine for Courier, Carlito for Calibri, Inter for SF Pro …).
   Override the choice with `--font-map`.

Variable fonts are rendered by pen.dev at their default optical size, which makes some fonts (e.g. Inter 4 at large sizes)
a few percent wider than in Sketch. The converter measures every text block with CoreText and widens fixed-width text
boxes just enough to keep Sketch's line breaks; for fonts it ships (such as Apple's SF Pro) it adds the difference to the
letter spacing instead, so the text is exactly as wide as in Sketch.

**SF Pro**: install Apple's fonts from [developer.apple.com/fonts](https://developer.apple.com/fonts/) and the converter
uses the *SF Pro Text* or *SF Pro Display* cut that matches each text size, like Sketch does. Apple's licence allows them
only for mock-ups of apps for Apple platforms and forbids passing them on, so keep converted folders with SF Pro to
yourself.

## What gets converted

| Sketch | pen.dev |
| --- | --- |
| Pages, artboards / frames, groups | one canvas with a titled section per page, frames, groups |
| Rectangles, ovals, paths, boolean groups, point corner radii | rectangles, ellipses, SVG paths (booleans computed with Skia PathOps) |
| Colour, linear, radial and angular gradients, image fills, blend modes | fills (gradients re-mapped to pen.dev's coordinate system) |
| Borders – several widths, dashes, line-end arrows | strokes, plus exact outlines where pen.dev has no equivalent |
| Drop shadows (incl. spread), inner shadows, layer and background blur | effects, emulated where pen.dev falls short |
| Masks (outline, alpha, symbols as masks) | clipping frames with the mask's radii; other outlines cut vector shapes and images exactly, alpha masks are baked into images |
| Tints on groups, frames and instances | recoloured content |
| Text styles, mixed-style paragraphs, paragraph spacing, text transform | text layers (split per line/paragraph where pen.dev lacks inline formatting) |
| Underline, strikethrough | drawn as shapes exactly where Sketch draws them (pen.dev does not draw them) |
| SF Symbols and icon-font glyphs | vector paths |
| Symbols, overrides, symbol swaps, resized and scaled instances | components and instances with overrides; Sketch's pinning rules applied |
| Stacks | flex layout when it reproduces Sketch exactly, absolute positions otherwise |
| Colour swatches | pen.dev colour variables |

[docs/conversion.md](docs/conversion.md) documents every mapping and how each emulation works.

### Limitations

These come from the pen.dev format and are listed in each conversion report:

- underline and strikethrough are drawn as separate shapes (pen.dev does not draw them) – on macOS only;
- texts and symbol instances reaching past a path- or ellipse-shaped mask are clipped by the mask's bounds;
- noise fills, motion/zoom blur, the glass blur and colour adjustments have no pen.dev equivalent;
- prototype links, layout grids, guides and export presets are not converted;
- text baselines can differ by up to 1 px for some size / line-height combinations.

## How it works

The converter reads the `.sketch` archive (JSON + images + fonts), converts the layer tree into pen.dev's node schema and
writes a `.pen` file that pen.dev opens directly. Geometry that pen.dev cannot express natively is computed with
[Skia PathOps](https://skia.org/docs/user/modules/pathkit/) (booleans, dashes, markers, mask intersections); text is laid
out with CoreText exactly like Sketch does. See [docs/architecture.md](docs/architecture.md).

## Development

```bash
bun install
bun test            # unit and conversion tests
bun run typecheck
bun run build       # release artifacts in dist/
bun run lab         # render every feature in Sketch and pen.dev and diff them (macOS, needs both apps)
```

[docs/development.md](docs/development.md) covers the feature lab, the comparison tool and releasing.
Contributions are welcome – see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

sketch2pen is an independent project, not affiliated with Sketch B.V. or pen.dev.
