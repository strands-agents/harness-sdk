import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { URL, fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../../harness-py', import.meta.url))
const destination = fileURLToPath(new URL('../dist/python', import.meta.url))

rmSync(destination, { recursive: true, force: true })
mkdirSync(destination, { recursive: true })
for (const name of ['pyproject.toml', 'README.md', 'LICENSE', 'NOTICE']) {
  cpSync(join(source, name), join(destination, name))
}
cpSync(join(source, 'src'), join(destination, 'src'), {
  recursive: true,
  filter: (path) => basename(path) !== '__pycache__',
})
const worker = fileURLToPath(new URL('../src/tui/project/worker.py', import.meta.url))
const workerDestination = fileURLToPath(new URL('../dist/src/tui/project/worker.py', import.meta.url))
cpSync(worker, workerDestination)
