// Bundles every browser-facing entry point for the browser and fails if SDK source statically imports
// a Node built-in or a Node-only package. Dynamic imports are allowed: they are only evaluated on the
// code path that needs them (e.g. file-backed session storage), which never runs in a browser.
import { builtinModules } from 'node:module'
import { build } from 'esbuild'

const ENTRIES = [
  'src/index.ts',
  'src/bidi/index.ts',
  'src/bidi/hooks/index.ts',
  'src/bidi/models/google.ts',
  'src/sandbox/browser.ts',
  'src/bidi/io/browser-audio.ts',
]

const NODE_ONLY_PACKAGES = new Set(['@smithy/node-http-handler', 'audify', 'ws'])
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))

const isNodeOnly = (specifier) => {
  if (builtins.has(specifier) || specifier.startsWith('node:')) return true
  const root = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
  return builtins.has(root) || NODE_ONLY_PACKAGES.has(root)
}

const result = await build({
  entryPoints: ENTRIES,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  packages: 'external',
  write: false,
  outdir: 'dist-browser-check',
  metafile: true,
  logLevel: 'error',
})

const violations = []
for (const [file, input] of Object.entries(result.metafile.inputs)) {
  for (const imported of input.imports) {
    if (imported.kind === 'import-statement' && imported.external && isNodeOnly(imported.path)) {
      violations.push(`${file} statically imports ${imported.path}`)
    }
  }
}

if (violations.length > 0) {
  console.error(`Browser bundle check failed: Node-only static imports reachable from browser entries:\n`)
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(`\nLoad Node-only code lazily, or move it behind a Node-only subpath.`)
  process.exit(1)
}

console.log(`Browser bundle check passed (${ENTRIES.length} entries).`)
