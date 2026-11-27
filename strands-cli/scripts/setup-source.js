import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageRoot = resolve(repositoryRoot, 'strands-cli')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

run(packageRoot, ['ci'])
run(packageRoot, ['run', 'build'])
run(repositoryRoot, ['link', '--ignore-scripts', '--no-save', '--package-lock=false'])

function run(cwd, args) {
  const result = spawnSync(npm, args, { cwd, stdio: 'inherit' })
  if (result.status === 0) {
    return
  }
  if (result.error) {
    throw result.error
  }
  process.exit(result.status ?? 1)
}
