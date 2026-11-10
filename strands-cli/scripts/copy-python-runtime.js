import { cpSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

// tsc does not copy the Python worker loaded beside the compiled bridge.
const worker = fileURLToPath(new URL('../src/project/worker.py', import.meta.url))
const destination = fileURLToPath(new URL('../dist/src/project/worker.py', import.meta.url))
cpSync(worker, destination)
