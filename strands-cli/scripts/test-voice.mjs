import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { parse } from 'smol-toml'

const sidecar = readFileSync(new URL('../src/agent/voice-sidecar.py', import.meta.url), 'utf8')
const metadata = sidecar.match(/^# \/\/\/ script\r?\n([\s\S]*?)^# \/\/\/\r?$/m)?.[1]
if (!metadata) throw new Error('Voice sidecar dependency metadata is missing.')
const { dependencies } = parse(metadata.replace(/^# ?/gm, ''))
if (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== 'string')) {
  throw new Error('Voice sidecar dependencies must be a list of package requirements.')
}
const [script = fileURLToPath(new URL('../test/voice.test.py', import.meta.url)), ...args] = process.argv.slice(2)
const result = spawnSync(
  'uv',
  [
    'run',
    '--no-project',
    '--python',
    '3.13',
    ...dependencies.flatMap((dependency) => ['--with', dependency]),
    'python',
    script,
    ...args,
  ],
  { stdio: 'inherit' }
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
