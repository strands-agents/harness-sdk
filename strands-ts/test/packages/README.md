# Package Import Tests

This directory contains verification tests to ensure `@strands-agents/sdk` can be imported and packaged correctly. There are three checks, catching different classes of packaging bug:

- **`esm-module/` and `cjs-module/`** — fast local tests. Install the SDK via `file:../../..` and exercise ESM `import`, CommonJS `await import()`, and a static `import` from a CommonJS TypeScript project run through `tsx` (which resolves the SDK's dependencies under the CommonJS export conditions). Run by `npm run test:package`. These resolve through the monorepo, so they share the root `node_modules` and cannot detect missing-optional-peer regressions.
- **`assert-package-contents.js`** — local tarball contents guard. Reads `npm pack --dry-run --ignore-scripts --json` output from `npm run test:package` and fails if the published file list contains generated test artifacts (`__tests__/`, `__fixtures__/`, or `*.test.*`).
- **`npm-pack/`** — CI packed-tarball install smoke test (`.github/workflows/test-package-pack.yml`). Runs `npm pack` and installs the tarball in a tempdir outside the monorepo, mirroring an end-user install. Catches the RC.0 class of bug where the main entry re-exports a symbol from an optional peer dependency.

## Running the Tests

From the root of the project:

```bash
npm run test:package
```

This command builds and installs the SDK locally, runs both ESM and CJS import tests, then verifies the dry-run npm tarball contents. The packed-tarball install smoke test still runs separately in `.github/workflows/test-package-pack.yml`.

## Test Structure

```
test/packages/
├── esm-module/     # ES Module import test (file: install)
│   ├── esm.js      # Uses `import { ... } from '@strands-agents/sdk'`
│   └── package.json
├── cjs-module/     # CommonJS import test (file: install)
│   ├── cjs.js      # Uses `await import('@strands-agents/sdk')` from CommonJS
│   ├── cjs-static.ts # Static `import` from a CommonJS TypeScript project, run with tsx
│   └── package.json
├── npm-pack/       # Packed-tarball install smoke test (CI-only)
│   ├── verify.ts   # Type-checked consumer script
│   ├── package.json
│   └── tsconfig.json
├── assert-package-contents.js
└── README.md
```
