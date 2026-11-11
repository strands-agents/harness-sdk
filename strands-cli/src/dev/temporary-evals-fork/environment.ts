import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { pythonInstallEnvironment } from '../../project/python-runtime.js'
import { isRecord } from '../../values.js'
import { TEMPORARY_EVALS_FORK_REQUIREMENT } from './fork.js'

export interface TemporaryCommandRequest {
  command: string
  args: string[]
  cwd: string
  timeout: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

export type TemporaryCommandRunner = (request: TemporaryCommandRequest) => Promise<string>

export interface TemporaryEnvironmentOptions {
  run?: TemporaryCommandRunner
  signal?: AbortSignal
  onProgress?: (line: string) => void
}

const PROBE_TIMEOUT_MS = 30_000
const VENV_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 900_000
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024
const PROJECT_SITE_PROBE =
  'import json, platform, site; print(json.dumps({"version": platform.python_version(), "paths": site.getsitepackages()}))'
const OPTIMIZER_SITE_PROBE = 'import site; print(site.getsitepackages()[0])'
const PROJECT_PACKAGES_FILE = 'temporary_strands_dev_project.pth'
const MARKER_FILE = 'temporary-evals-fork.json'

const execute = promisify(execFile)

export const ignoreProgress = (): void => {}

const runCommand: TemporaryCommandRunner = async ({ command, args, cwd, timeout, env, signal }) => {
  const { stdout } = await execute(command, args, {
    cwd,
    timeout,
    env: env ?? process.env,
    maxBuffer: OUTPUT_LIMIT_BYTES,
    windowsHide: true,
    ...(signal ? { signal } : {}),
  })
  return stdout
}

const projectPackagesHook = (paths: readonly string[]): string =>
  paths.map((path) => `import site; site.addsitedir(${JSON.stringify(path)})\n`).join('')

export const temporaryVenvPython = (venv: string): string =>
  join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

export const temporaryOptimizationFolder = (workspaceDirectory: string): string =>
  join(workspaceDirectory, 'tmp', 'optimization')

const readMarker = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

const projectSitePackages = async (
  run: TemporaryCommandRunner,
  python: string,
  cwd: string,
  signal: AbortSignal | undefined
): Promise<{ version: string; paths: string[] }> => {
  const output = await run({
    command: python,
    args: ['-c', PROJECT_SITE_PROBE],
    cwd,
    timeout: PROBE_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
  return JSON.parse(output) as { version: string; paths: string[] }
}

export const prepareTemporaryOptimizerEnvironment = async (
  { workspaceDirectory, projectRoot }: { workspaceDirectory: string; projectRoot: string },
  { run = runCommand, signal, onProgress = ignoreProgress }: TemporaryEnvironmentOptions = {}
): Promise<string> => {
  const projectPython = temporaryVenvPython(join(projectRoot, '.venv'))
  if (!existsSync(projectPython))
    throw new Error(`The project has no Python environment at ${projectPython}. Start strands dev once to prepare it.`)
  const folder = temporaryOptimizationFolder(workspaceDirectory)
  const venv = join(folder, '.venv')
  const python = temporaryVenvPython(venv)
  const marker = join(venv, MARKER_FILE)
  const project = await projectSitePackages(run, projectPython, projectRoot, signal)
  const expected = JSON.stringify({
    requirement: TEMPORARY_EVALS_FORK_REQUIREMENT,
    project,
    hook: projectPackagesHook(project.paths),
  })
  if (existsSync(python) && (await readMarker(marker)) === expected) return python
  const request = (
    command: string,
    args: string[],
    timeout: number,
    env?: NodeJS.ProcessEnv
  ): TemporaryCommandRequest => ({
    command,
    args,
    cwd: folder,
    timeout,
    ...(env ? { env } : {}),
    ...(signal ? { signal } : {}),
  })
  onProgress(`Creating the TEMPORARY optimizer environment in ${venv}`)
  await mkdir(folder, { recursive: true })
  await run(request(projectPython, ['-m', 'venv', '--clear', venv], VENV_TIMEOUT_MS))
  const sitePackages = (await run(request(python, ['-c', OPTIMIZER_SITE_PROBE], PROBE_TIMEOUT_MS))).trim()
  await writeFile(join(sitePackages, PROJECT_PACKAGES_FILE), projectPackagesHook(project.paths))
  onProgress(`Installing ${TEMPORARY_EVALS_FORK_REQUIREMENT}`)
  await run(
    request(
      python,
      ['-m', 'pip', 'install', '--disable-pip-version-check', '--prefer-binary', TEMPORARY_EVALS_FORK_REQUIREMENT],
      INSTALL_TIMEOUT_MS,
      pythonInstallEnvironment(process.env)
    )
  )
  await writeFile(marker, expected)
  return python
}
