import { cpSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

// tsc does not copy the Python worker loaded beside the compiled bridge.
const worker = fileURLToPath(new URL('../src/project/worker.py', import.meta.url))
const destination = fileURLToPath(new URL('../dist/src/project/worker.py', import.meta.url))
cpSync(worker, destination)

const evalsAgent = fileURLToPath(new URL('../src/dev/evals/python/strands_dev_evals', import.meta.url))
const evalsAgentDestination = fileURLToPath(new URL('../dist/src/dev/evals/python/strands_dev_evals', import.meta.url))
rmSync(evalsAgentDestination, { recursive: true, force: true })
cpSync(evalsAgent, evalsAgentDestination, { recursive: true, filter: (source) => basename(source) !== '__pycache__' })
