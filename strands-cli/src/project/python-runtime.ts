import { execFile } from 'node:child_process'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { devNull } from 'node:os'
import { promisify } from 'node:util'

import { HARNESS_VERSION } from '../package-version.js'
import { sanitizeTerminalText } from '../terminal/text.js'
import { isRecord } from '../values.js'

const execute = promisify(execFile)
const PROBE_TIMEOUT_MS = 30_000
const INSTALL_TIMEOUT_MS = 180_000
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024
const RUNTIME_PROBE =
  'import importlib.util, sys; sys.exit(42) if importlib.util.find_spec("strands_harness") is None else None; import strands_harness'
const PIP_PROBE = 'import importlib.util, sys; sys.exit(42) if importlib.util.find_spec("pip") is None else None'
const VERSION_PROBE = 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 43)'
const ENVIRONMENT_PROBE = [
  'import sys, sysconfig',
  'from pathlib import Path',
  'root = Path(sys.argv[1]).resolve()',
  'paths = sysconfig.get_paths()',
  'local = sys.prefix != sys.base_prefix and Path(sys.prefix).resolve() == root',
  'local = local and (root / "pyvenv.cfg").is_file()',
  'local = local and all(Path(paths[key]).resolve().is_relative_to(root) for key in ("purelib", "platlib", "scripts", "data"))',
  'sys.exit(0 if local else 44)',
].join('; ')
const INSTALL_DESTINATION_KEYS = new Set([
  'PIP_TARGET',
  'PIP_PREFIX',
  'PIP_USER',
  'PIP_ROOT',
  'PIP_CONFIG_FILE',
  'PIP_PYTHON',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONUSERBASE',
])

export const pythonInstallEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(environment).filter(([key]) => !INSTALL_DESTINATION_KEYS.has(key.toUpperCase()))
  ),
  PIP_CONFIG_FILE: devNull,
  PIP_REQUIRE_VIRTUALENV: 'true',
  PIP_NO_CACHE_DIR: '1',
  PYTHONDONTWRITEBYTECODE: '1',
})

export interface PythonRuntimeCommand {
  command: string
  args: string[]
  cwd: string
  timeout: number
  signal?: AbortSignal
}

type CommandRunner = (request: PythonRuntimeCommand) => Promise<void>

const runCommand: CommandRunner = async ({ command, args, cwd, timeout, signal }) => {
  await execute(command, args, {
    cwd,
    timeout,
    maxBuffer: OUTPUT_LIMIT_BYTES,
    windowsHide: true,
    env: args[0] === '-I' ? pythonInstallEnvironment(process.env) : { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    ...(signal ? { signal } : {}),
  })
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false
    throw error
  }
}

const probe = async (run: CommandRunner, request: PythonRuntimeCommand): Promise<boolean> => {
  try {
    await run(request)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === 42) return false
    throw error
  }
}

const privateDirectory = async (path: string): Promise<void> => {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (!isRecord(error) || error.code !== 'EEXIST') throw error
  }
  const details = await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error(`Python setup directory must not be a symbolic link: ${path}`)
}

export const preparePythonRuntime = async (
  root: string,
  options: {
    signal?: AbortSignal
    run?: CommandRunner
    interpreter?: string
    runtimeOnly?: boolean
    validateEnvironment?: boolean
  } = {}
): Promise<string> => {
  const { signal, run = runCommand } = options
  signal?.throwIfAborted()
  const cwd = await realpath(root)
  const environment = join(cwd, '.venv')
  const python = join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const request = (command: string, args: string[], timeout = PROBE_TIMEOUT_MS): PythonRuntimeCommand => ({
    command,
    args,
    cwd,
    timeout,
    ...(signal ? { signal } : {}),
  })
  try {
    if (
      !options.validateEnvironment &&
      (await exists(python)) &&
      (await probe(run, request(python, ['-c', RUNTIME_PROBE])))
    )
      return python
    if (await exists(environment)) {
      const details = await lstat(environment)
      if (!details.isDirectory() || details.isSymbolicLink())
        throw new Error(`Cannot install into a linked or invalid .venv: ${environment}`)
      if (!(await exists(python))) throw new Error(`The project .venv has no Python executable: ${python}`)
    }
    const metadata = join(cwd, '.strands')
    const state = join(metadata, 'state')
    await privateDirectory(metadata)
    await privateDirectory(state)
    const lock = join(state, 'python-runtime.lock')
    try {
      await mkdir(lock, { mode: 0o700 })
    } catch (error) {
      if (isRecord(error) && error.code === 'EEXIST')
        throw new Error(`Python setup is already running. If no installer is active, remove ${lock} and retry.`, {
          cause: error,
        })
      throw error
    }
    try {
      signal?.throwIfAborted()
      if (
        !options.validateEnvironment &&
        (await exists(python)) &&
        (await probe(run, request(python, ['-c', RUNTIME_PROBE])))
      )
        return python
      if (!(await exists(python))) {
        const interpreter =
          options.interpreter ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
        await run(request(interpreter, ['-c', VERSION_PROBE]))
        await run(request(interpreter, ['-I', '-m', 'venv', '.venv'], INSTALL_TIMEOUT_MS))
      }
      await run(request(python, ['-c', VERSION_PROBE]))
      try {
        await run(request(python, ['-I', '-c', ENVIRONMENT_PROBE, environment]))
      } catch (error) {
        throw new Error(`Python installation paths must stay inside the project virtualenv: ${environment}`, {
          cause: error,
        })
      }
      const available = await probe(run, request(python, ['-c', RUNTIME_PROBE]))
      if (available && !options.runtimeOnly) return python
      if (!(await probe(run, request(python, ['-c', PIP_PROBE]))))
        await run(request(python, ['-I', '-m', 'ensurepip'], INSTALL_TIMEOUT_MS))
      if (available) return python
      const version = /^(\d+)\.(\d+)\./u.exec(HARNESS_VERSION)
      if (!version) throw new Error(`Cannot determine the Python harness version from ${HARNESS_VERSION}.`)
      const dependencies = options.runtimeOnly
        ? []
        : (await exists(join(cwd, 'requirements.txt')))
          ? ['-r', 'requirements.txt']
          : (await exists(join(cwd, 'pyproject.toml')))
            ? ['.']
            : []
      await run(
        request(
          python,
          [
            '-I',
            '-m',
            'pip',
            'install',
            '--disable-pip-version-check',
            ...dependencies,
            `strands-harness~=${version[1]}.${version[2]}.0`,
          ],
          INSTALL_TIMEOUT_MS
        )
      )
      if (!(await probe(run, request(python, ['-c', RUNTIME_PROBE]))))
        throw new Error('The installed environment still cannot import strands_harness.')
      signal?.throwIfAborted()
      return python
    } finally {
      await rm(lock, { recursive: true, force: true })
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Could not prepare the Python agent in ${resolve(root)}. Use Python 3.10 or newer and install this project's dependencies and strands-harness in .venv. ${sanitizeTerminalText(message)}`,
      { cause: error }
    )
  }
}
