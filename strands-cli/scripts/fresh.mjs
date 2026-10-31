import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath, URL } from 'node:url'

// Development loop: `npm run fresh [-- <strands args>]` keeps `tsc --watch` running and restarts
// the CLI from dist/ after every clean rebuild, resuming the same conversation via --session-id.
// It launches dist/src/main.js directly, bypassing bin/strands.js and its full source rebuild.

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const entrypoint = fileURLToPath(new URL('../dist/src/main.js', import.meta.url))

const forwardedArgs = process.argv.slice(2)
const sessionArgs = forwardedArgs.includes('--session-id') ? [] : ['--session-id', `fresh-${Date.now().toString(36)}`]

let child
let restarting = false
let built = false

const compiler = spawn(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '--project', 'src/tsconfig.json', '--watch', '--preserveWatchOutput'],
  { cwd: packageRoot, stdio: ['ignore', 'pipe', 'inherit'] }
)

let pending = ''
compiler.stdout.on('data', (chunk) => {
  pending += chunk.toString()
  const lines = pending.split('\n')
  pending = lines.pop() ?? ''
  for (const line of lines) {
    onCompilerLine(stripAnsi(line))
  }
})

compiler.on('exit', (code) => {
  process.stderr.write('fresh: tsc --watch exited.\n')
  shutdown(code ?? 1)
})

function onCompilerLine(line) {
  const finished = line.match(/Found (\d+) errors?\. Watching for file changes\./)
  if (!finished) {
    return
  }
  if (Number(finished[1]) > 0) {
    process.stderr.write('fresh: build has errors; keeping the current session running.\n')
    return
  }
  if (!built) {
    built = true
    copyPythonRuntime()
    start()
    return
  }
  void restart()
}

function copyPythonRuntime() {
  const copy = spawnSync(process.execPath, ['scripts/copy-python-runtime.js'], {
    cwd: packageRoot,
    stdio: 'inherit',
  })
  if (copy.error || copy.status !== 0) {
    process.stderr.write('fresh: copying the Python runtime failed.\n')
    shutdown(1)
  }
}

function start() {
  child = spawn(process.execPath, [entrypoint, ...sessionArgs, ...forwardedArgs], {
    cwd: process.env.FRESH_CWD ?? process.cwd(),
    stdio: 'inherit',
  })
  child.on('exit', (code) => {
    if (restarting) {
      return
    }
    shutdown(code ?? 0)
  })
}

async function restart() {
  if (restarting) {
    return
  }
  restarting = true
  await stopChild()
  restarting = false
  process.stderr.write('\nfresh: rebuilt; resuming the session.\n')
  start()
}

function stopChild() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

function shutdown(code) {
  compiler.kill()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
  }
  process.exit(code)
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}
