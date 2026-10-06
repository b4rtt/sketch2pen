# Contributing

Thanks for helping! Bug reports with a small `.sketch` file that shows the problem are the most useful thing –
please do not attach confidential designs; a minimal reproduction is enough.

## Development setup

```bash
bun install
bun test
bun run typecheck
```

Before opening a pull request:

1. Add or update a test. Conversion behaviour is covered by `test/lab.test.ts` (the feature lab document),
   `test/convert.test.ts` (hand-built fixtures) and `test/pen2sketch.test.ts` (pen.dev → Sketch).
2. If you touched rendering (geometry, styles, text), run the feature lab of that direction on a Mac with Sketch and
   pen.dev installed and check the report: `bun run lab ./lab-output` or `bun run lab:pen`. New Sketch features belong
   in `tools/lab/cases.ts`, new pen.dev features in `tools/lab/pen-cases.ts`.
3. Keep user-facing messages in English and add an entry to `CHANGELOG.md`.

See [docs/development.md](docs/development.md) for the tooling and [docs/architecture.md](docs/architecture.md) for how the
converter is organised.
