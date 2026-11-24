import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'

import { strandsUserPath } from '../../paths.js'
import { redactPreparationOutput } from '../../project/preparation.js'
import { PIP_CONFIG_LIST_ARGUMENTS, pythonInstallEnvironment } from '../../project/python-runtime.js'
import { isRecord } from '../../values.js'
import { STRANDS_EVALS_LABEL, STRANDS_EVALS_REQUIREMENT, STRANDS_EVALS_VERSION } from '../evals-package.js'
import { temporaryEvalsEnvironmentFolder } from './layout.js'

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
const PROJECT_SITE_PROBE = [
  'import json, platform, site, sys, sysconfig',
  'tag = sys.implementation.cache_tag + ("t" if sysconfig.get_config_var("Py_GIL_DISABLED") else "")',
  'print(json.dumps({"version": platform.python_version(), "tag": f"{tag}-{sysconfig.get_platform()}", "paths": site.getsitepackages()}))',
].join('; ')
const OPTIMIZER_SITE_PROBE = 'import site; print(site.getsitepackages()[0])'
const EVALS_PACKAGE_PROBE =
  "import importlib.util; print(importlib.util.find_spec('strands_evals').submodule_search_locations[0])"
const EVALS_SKILLS = ['.agents', 'skills'] as const
const PACKAGES_FILE = 'temporary_strands_dev_packages.pth'
const MARKER_FILE = 'temporary-evals-fork.json'
const SHARED_FOLDER = 'temporary-evals'
const SHARED_UNUSED_MS = 7 * 24 * 60 * 60 * 1000
const UNSAFE_PATH_CHARACTERS = /[^A-Za-z0-9._-]/gu
const TAKEN_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'])
const MINIMUM_PYTHON_MINOR = 10
const DETAIL_LINES = 3

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

export const installedEvalsSkill = async (
  python: string,
  name: string,
  run: TemporaryCommandRunner = runCommand
): Promise<string> => {
  const where = await run({
    command: python,
    args: ['-c', EVALS_PACKAGE_PROBE],
    cwd: dirname(python),
    timeout: PROBE_TIMEOUT_MS,
  })
  const folder = join(where.trim(), ...EVALS_SKILLS, name)
  if (!existsSync(join(folder, 'SKILL.md')))
    throw new Error(
      `The installed ${STRANDS_EVALS_LABEL} has no ${name} skill in ${folder}. Restart strands dev, then try again.`
    )
  return folder
}

interface ProjectPython {
  readonly version: string
  readonly tag?: string
  readonly paths: string[]
}

const pythonTag = ({ version, tag }: ProjectPython): string =>
  tag ?? `python${version.split('.').slice(0, 2).join('.')}`

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
): Promise<ProjectPython> => {
  const output = await run({
    command: python,
    args: ['-c', PROJECT_SITE_PROBE],
    cwd,
    timeout: PROBE_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
  return JSON.parse(output) as ProjectPython
}

interface TemporaryOptimizerTarget {
  workspaceDirectory: string
  projectRoot: string
  language?: 'python' | 'typescript'
}

const basePython = ({ projectRoot, language = 'python' }: TemporaryOptimizerTarget): string => {
  if (language === 'typescript') return process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const projectPython = temporaryVenvPython(join(projectRoot, '.venv'))
  if (!existsSync(projectPython))
    throw new Error(
      `The project has no Python environment at ${projectPython}. Restart strands dev on this agent so that it ` +
        'prepares the project, then try again.'
    )
  return projectPython
}

const PYTHON_UPGRADE_HINT = {
  python: 'Recreate the project .venv with a newer Python.',
  typescript: 'Set PYTHON to a newer interpreter.',
} as const

const assertSupportedPython = (python: string, version: string, language: 'python' | 'typescript'): void => {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  if (major < 3 || (major === 3 && minor < MINIMUM_PYTHON_MINOR))
    throw new Error(
      `Optimization needs Python 3.${MINIMUM_PYTHON_MINOR} or later, but ${python} is Python ${version}. ` +
        PYTHON_UPGRADE_HINT[language]
    )
}

const IMPORTANT_LINE = /^\s*(?:ERROR|error|fatal)\b/u

const failureDetail = (error: unknown): string => {
  const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr : ''
  const lines = stderr.split('\n').filter((line) => line.trim().length > 0)
  const important = lines.filter((line) => IMPORTANT_LINE.test(line))
  const shown = (important.length > 0 ? important : lines).slice(-DETAIL_LINES)
  const detail = shown.length > 0 ? shown.join('\n') : String(isRecord(error) ? error.message : error)
  return redactPreparationOutput(detail)
}

const step = async <T>(work: Promise<T>, explain: (detail: string) => string): Promise<T> => {
  try {
    return await work
  } catch (error) {
    throw new Error(explain(failureDetail(error)), { cause: error })
  }
}

const PYTHON_START_HINT = {
  python: 'Restart strands dev on this agent so that it prepares the project again, then try again.',
  typescript: 'Set PYTHON to a working Python 3.10 or later, then try again.',
} as const

const preparing = new Map<string, Promise<string>>()

const untilAborted = <Value>(work: Promise<Value>, signal: AbortSignal | undefined): Promise<Value> => {
  if (!signal) return work
  return new Promise((resolve, reject) => {
    const stop = (): void => reject(signal.reason)
    if (signal.aborted) {
      stop()
      return
    }
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

export const prepareTemporaryOptimizerEnvironment = async (
  target: TemporaryOptimizerTarget,
  { signal, ...options }: TemporaryEnvironmentOptions = {}
): Promise<string> => {
  const key = temporaryEvalsEnvironmentFolder(target.workspaceDirectory)
  let work = preparing.get(key)
  if (!work) {
    work = prepareEnvironment(target, options).finally(() => preparing.delete(key))
    preparing.set(key, work)
  }
  return untilAborted(work, signal)
}

interface Build {
  readonly run: TemporaryCommandRunner
  readonly signal: AbortSignal | undefined
  readonly onProgress: (line: string) => void
}

const commandRequest =
  ({ signal }: Build, cwd: string) =>
  (command: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv): TemporaryCommandRequest => ({
    command,
    args,
    cwd,
    timeout,
    ...(env ? { env } : {}),
    ...(signal ? { signal } : {}),
  })

const sharedFolder = (tag: string): string =>
  strandsUserPath(SHARED_FOLDER, `${STRANDS_EVALS_VERSION}-${tag.replace(UNSAFE_PATH_CHARACTERS, '_')}`)

const sharedMarker = (tag: string, sitePackages: string): string =>
  JSON.stringify({ requirement: STRANDS_EVALS_REQUIREMENT, tag, sitePackages })

const readySharedPackages = async (folder: string, tag: string): Promise<string | undefined> => {
  const text = await readMarker(join(folder, MARKER_FILE))
  if (text === undefined) return undefined
  let marker: unknown
  try {
    marker = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(marker) || typeof marker.sitePackages !== 'string') return undefined
  if (text !== sharedMarker(tag, marker.sitePackages)) return undefined
  const sitePackages = join(folder, marker.sitePackages)
  return existsSync(sitePackages) ? sitePackages : undefined
}

const pipConfigList = async (
  build: Build,
  request: ReturnType<typeof commandRequest>,
  python: string
): Promise<string> => {
  try {
    return await build.run(request(python, [...PIP_CONFIG_LIST_ARGUMENTS], PROBE_TIMEOUT_MS))
  } catch {
    return ''
  }
}

const settle = async (building: string, folder: string, tag: string): Promise<void> => {
  try {
    await rename(building, folder)
    return
  } catch (error) {
    if (!isRecord(error) || typeof error.code !== 'string' || !TAKEN_CODES.has(error.code)) throw error
  }
  if (await readySharedPackages(folder, tag)) {
    await rm(building, { recursive: true, force: true })
    return
  }
  const aside = `${folder}.${process.pid}.old`
  await rename(folder, aside)
  await rename(building, folder)
  await rm(aside, { recursive: true, force: true })
}

const pruneSharedEnvironments = async (kept: string): Promise<void> => {
  const parent = dirname(kept)
  const now = Date.now()
  for (const name of await readdir(parent).catch(() => [])) {
    const folder = join(parent, name)
    if (folder === kept) continue
    const marker = await stat(join(folder, MARKER_FILE)).catch(() => undefined)
    const used = marker?.mtimeMs ?? (await stat(folder).catch(() => undefined))?.mtimeMs ?? now
    if (now - used > SHARED_UNUSED_MS) await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}

const buildSharedPackages = async (build: Build, projectPython: string, tag: string): Promise<string> => {
  const folder = sharedFolder(tag)
  const ready = await readySharedPackages(folder, tag)
  if (ready) {
    const now = new Date()
    await utimes(join(folder, MARKER_FILE), now, now).catch(() => undefined)
    return ready
  }
  const building = `${folder}.${process.pid}.tmp`
  const request = commandRequest(build, dirname(folder))
  const python = temporaryVenvPython(building)
  build.onProgress(`Creating the shared evals environment in ${folder}`)
  await mkdir(dirname(folder), { recursive: true })
  await rm(building, { recursive: true, force: true })
  const cannotCreate = (detail: string): string =>
    `Could not create the optimizer environment in ${folder}:\n${detail}\n` +
    `Check that ${projectPython} -m venv works (some Linux systems need the python3-venv package), then try again.`
  await step(build.run(request(projectPython, ['-m', 'venv', '--clear', building], VENV_TIMEOUT_MS)), cannotCreate)
  const sitePackages = (
    await step(build.run(request(python, ['-c', OPTIMIZER_SITE_PROBE], PROBE_TIMEOUT_MS)), cannotCreate)
  ).trim()
  const configured = await pipConfigList(build, request, python)
  build.onProgress(`Installing ${STRANDS_EVALS_LABEL}. This takes about a minute, once for each version.`)
  await step(
    build.run(
      request(
        python,
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--prefer-binary', STRANDS_EVALS_REQUIREMENT],
        INSTALL_TIMEOUT_MS,
        pythonInstallEnvironment(process.env, configured)
      )
    ),
    (detail) =>
      `Could not install ${STRANDS_EVALS_LABEL}:\n${detail}\n` +
      'Check your network connection and your pip index settings, then try again.'
  )
  const inside = relative(building, sitePackages)
  await writeFile(join(building, MARKER_FILE), sharedMarker(tag, inside))
  await settle(building, folder, tag)
  await pruneSharedEnvironments(folder)
  return join(folder, inside)
}

const sharing = new Map<string, Promise<string>>()

const sharedPackages = (build: Build, projectPython: string, tag: string): Promise<string> => {
  const key = sharedFolder(tag)
  let work = sharing.get(key)
  if (!work) {
    work = buildSharedPackages(build, projectPython, tag).finally(() => sharing.delete(key))
    sharing.set(key, work)
  }
  return work
}

const prepareEnvironment = async (
  target: TemporaryOptimizerTarget,
  { run = runCommand, signal, onProgress = ignoreProgress }: TemporaryEnvironmentOptions = {}
): Promise<string> => {
  const { workspaceDirectory, projectRoot, language = 'python' } = target
  const build: Build = { run, signal, onProgress }
  const projectPython = basePython(target)
  const probed = await step(
    projectSitePackages(run, projectPython, projectRoot, signal),
    (detail) => `Could not start ${projectPython}:\n${detail}\n${PYTHON_START_HINT[language]}`
  )
  assertSupportedPython(projectPython, probed.version, language)
  const shared = await sharedPackages(build, projectPython, pythonTag(probed))
  const paths = [shared, ...(language === 'python' ? probed.paths : [])]
  const venv = temporaryEvalsEnvironmentFolder(workspaceDirectory)
  const python = temporaryVenvPython(venv)
  const marker = join(venv, MARKER_FILE)
  const expected = JSON.stringify({ version: probed.version, hook: projectPackagesHook(paths) })
  if (existsSync(python) && (await readMarker(marker)) === expected) return python
  const request = commandRequest(build, dirname(venv))
  const cannotCreate = (detail: string): string =>
    `Could not create the optimizer environment in ${venv}:\n${detail}\n` +
    `Check that ${projectPython} -m venv works (some Linux systems need the python3-venv package), then try again.`
  await mkdir(dirname(venv), { recursive: true })
  await step(run(request(projectPython, ['-m', 'venv', '--without-pip', venv], VENV_TIMEOUT_MS)), cannotCreate)
  const sitePackages = (
    await step(run(request(python, ['-c', OPTIMIZER_SITE_PROBE], PROBE_TIMEOUT_MS)), cannotCreate)
  ).trim()
  await writeFile(join(sitePackages, PACKAGES_FILE), projectPackagesHook(paths))
  await writeFile(marker, expected)
  return python
}
