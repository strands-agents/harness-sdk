import { cpSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

// tsc emits only the .ts modules, so the CLI's own Python runtime file has to be copied next to its
// compiled sibling by hand. python.ts loads it as `new URL('./worker.py', import.meta.url)`, i.e.
// dist/src/tui/project/worker.py. (sidecar.py ships via package.json `files` with a src fallback.)
const worker = fileURLToPath(new URL('../src/tui/project/worker.py', import.meta.url))
const destination = fileURLToPath(new URL('../dist/src/tui/project/worker.py', import.meta.url))
cpSync(worker, destination)
