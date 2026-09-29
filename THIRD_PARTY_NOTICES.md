# Third-party notices

sketch2pen and its release binaries include the following open-source components.

| Component | Used for | License |
| --- | --- | --- |
| [fflate](https://github.com/101arrowz/fflate) | reading `.sketch` archives | MIT, © 2023 Arjun Barrett |
| [pathkit-wasm](https://www.npmjs.com/package/pathkit-wasm) (Skia PathOps) | boolean operations, dashes, outlines | BSD-3-Clause, © Google LLC |
| [pngjs](https://github.com/pngjs/pngjs) | decoding / encoding PNG images | MIT, © 2015 Luke Page & original contributors |
| [jpeg-js](https://github.com/jpeg-js/jpeg-js) | decoding JPEG images | BSD-3-Clause, © 2011 notmasteryet, Eugene Ware |
| [Bun](https://bun.sh) runtime (release binaries only) | standalone executables | MIT; bundles JavaScriptCore (LGPL-2.1) – see [bun.sh/docs/project/licensing](https://bun.sh/docs/project/licensing) |

`src/data/google-fonts.ts` lists family names from the public [Google Fonts](https://fonts.google.com) metadata.
The full license texts are in each package's `LICENSE` file (installed by `bun install`).

Fonts that sketch2pen copies next to a converted document (`fonts/`) remain under their own licenses; check them before
sharing converted documents.
