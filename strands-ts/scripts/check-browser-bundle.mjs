import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// Check both public browser entry points without writing bundles into the package.
await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['./src/index.ts', './src/testing/index.ts'],
  outdir: 'dist/browser-check',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  packages: 'external',
  write: false,
})
