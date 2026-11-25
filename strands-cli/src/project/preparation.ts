import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import { ProcessLockBusy, withProcessLock, type LockBusyMessage } from '../process-lock.js'
import { pythonInstallEnvironment, preparePythonRuntime } from './python-runtime.js'
import {
  describePreparationCommand,
  planProjectPreparation,
  type PreparationStage,
  type ProjectPreparationPlan,
} from './preparation-plan.js'
import { npmInvocation } from '../terminal/npm.js'
import { terminateProcessTree } from '../terminal/process-tree.js'
import { sanitizeTerminalText } from '../terminal/text.js'
import { isRecord } from '../values.js'
import type { ImportedAgentProject } from './import.js'
import { ignoreStateFolder } from './state-folder.js'

export interface PreparationProgress {
  stage: PreparationStage
  command: string
  logPath: string
}

export interface PreparationFailure {
  stage: PreparationStage
  summary: string
  action: string
  command?: string
  logPath?: string
  details: string
}

export const redactPreparationOutput = (text: string, environment: NodeJS.ProcessEnv = process.env): string => {
  let safe = sanitizeTerminalText(text)
  for (const [key, value] of Object.entries(environment)) {
    if (value && value.length >= 4 && /TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL/i.test(key))
      safe = safe.split(value).join('[redacted]')
  }
  return safe
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;]+/giu, '$1[redacted]')
    .replace(/\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{20,}|AKIA[\w]{16})\b/gu, '[redacted]')
}

export interface PreparationOptions {
  signal?: AbortSignal
  progress?: (progress: PreparationProgress) => void
  runtimeOnly?: boolean
  force?: boolean
}

const preparationBusy: LockBusyMessage = (holders) =>
  `Another strands process (${holders.join(', ')}) is still preparing this project.`

const lockBusy = (error: unknown): boolean =>
  error instanceof ProcessLockBusy || (error instanceof Error && lockBusy(error.cause))

export const preparationFailure = (error: unknown, progress?: PreparationProgress): PreparationFailure => {
  const detail = redactPreparationOutput(error instanceof Error ? error.message : String(error))
  const stage = progress?.stage ?? 'entrypoint'
  let action = 'Fix the error in the selected project, then Retry. Choose Back if this is not the correct project root.'
  const missing = /(?:No module named|Cannot find (?:module|package))\s+["'‘]?([^"'’\s]+)/u.exec(detail)?.[1]
  if (lockBusy(error)) action = 'Wait until the other strands process finishes, then Retry.'
  else if (missing)
    action = `Check the selected project root and dependency manifest for ${missing}. For Python src-layout packages, install the project itself with an editable install. Do not infer a registry package name from this import.`
  else if (/ENOENT|not found|not recognized/iu.test(detail))
    action =
      'Install the named runtime or package manager, ensure it is on PATH, and restart strands dev. Or prepare the project manually and validate it.'
  else if (/version|requires-python|engines.node/iu.test(detail))
    action = 'Select a runtime version supported by the project manifest, then restart strands dev.'
  else if (/lock ?file|package-lock|shrinkwrap|uv\.lock|--locked|frozen/iu.test(detail))
    action =
      'Fix the manifest and lockfile mismatch with the project package manager. Dev will not rewrite the lockfile. Then Retry.'
  else if (/401|403|authentication|credentials/iu.test(detail))
    action =
      'Configure credentials for the package index or provider outside the workspace files, then Retry. Do not paste credentials into the log.'
  return {
    stage,
    summary: `Project ${stage} failed`,
    action,
    ...(progress ? { command: redactPreparationOutput(progress.command), logPath: progress.logPath } : {}),
    details: detail.slice(-8000),
  }
}

export class ProjectPreparationError extends Error {
  readonly failure: PreparationFailure
  constructor(error: unknown, progress?: PreparationProgress) {
    const failure = preparationFailure(error, progress)
    super(`${failure.summary}. ${failure.action}\n${failure.details}`, { cause: error })
    this.failure = failure
  }
}

const privateLogs = async (root: string): Promise<string> => {
  let directory = await realpath(root)
  for (const name of ['.strands', 'state', 'setup']) {
    directory = join(directory, name)
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if (!isRecord(error) || error.code !== 'EEXIST') throw error
    }
    if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
      throw new Error(`Setup log directory must not be a symbolic link: ${directory}`)
  }
  ignoreStateFolder(dirname(directory))
  return join(directory, `${randomUUID()}.log`)
}

export const recordEntrypointFailure = async (
  project: ImportedAgentProject,
  error: unknown
): Promise<PreparationFailure> => {
  const logPath = await privateLogs(project.root)
  const file = await open(logPath, 'wx', 0o600)
  try {
    const details = error instanceof Error ? (error.stack ?? error.message) : String(error)
    await file.writeFile(redactPreparationOutput(details))
  } finally {
    await file.close()
  }
  return preparationFailure(error, { stage: 'entrypoint', command: `Load ${project.entrypoint}`, logPath })
}

export const executePreparation = async (
  plan: ProjectPreparationPlan,
  options: PreparationOptions = {}
): Promise<string> => {
  options.signal?.throwIfAborted()
  const current = await planProjectPreparation(plan.project)
  if (current.fingerprint !== plan.fingerprint)
    throw new ProjectPreparationError(
      new Error('Project manifests changed during preparation. Retry to use the latest project settings.')
    )
  const logPath = await privateLogs(plan.project.root)
  try {
    return await withProcessLock(
      join(dirname(logPath), 'prepare.lock'),
      () => runPreparation(plan, options, logPath),
      preparationBusy
    )
  } catch (error) {
    throw error instanceof ProcessLockBusy ? new ProjectPreparationError(error) : error
  }
}

const runPreparation = async (
  plan: ProjectPreparationPlan,
  options: PreparationOptions,
  logPath: string
): Promise<string> => {
  const { signal } = options
  const log = await open(logPath, 'wx', 0o600)
  const cachePath = join(dirname(logPath), 'prepared.json')
  let progress: PreparationProgress | undefined
  const record = async (message: string): Promise<void> => {
    await log.writeFile(`${redactPreparationOutput(message)}\n`)
  }
  const execute = async (stage: PreparationStage, command: string, args: string[], timeout = 180000): Promise<void> => {
    signal?.throwIfAborted()
    progress = {
      stage,
      command: redactPreparationOutput(describePreparationCommand({ stage, command, args })),
      logPath,
    }
    options.progress?.(progress)
    await record(progress.command)
    const invocation = command === 'npm' ? npmInvocation(args) : { command, args }
    const python = plan.project.language === 'python'
    const env = python ? pythonInstallEnvironment(process.env) : { ...process.env }
    if (command === 'npm') {
      for (const key of Object.keys(env)) {
        if (/^npm_config_(global|prefix|location|workspace|workspaces)$/iu.test(key)) Reflect.deleteProperty(env, key)
      }
      env.npm_config_global = 'false'
      env.npm_config_location = 'project'
      env.npm_config_prefix = plan.project.root
    }
    if (command === 'uv') {
      const environment = join(plan.project.root, '.venv')
      try {
        const entry = await lstat(environment)
        if (!entry.isDirectory() || entry.isSymbolicLink() || (await realpath(environment)) !== environment)
          throw new Error(`Refusing to sync a linked Python environment: ${environment}`)
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error
      }
      for (const key of [
        'UV_PROJECT_ENVIRONMENT',
        'UV_WORKING_DIR',
        'UV_PROJECT',
        'UV_NO_SYNC',
        'UV_NO_LOCK',
        'UV_FROZEN',
        'UV_LOCKED',
        'UV_UPGRADE',
        'UV_NO_PROJECT',
        'UV_CONFIG_FILE',
        'UV_NO_CONFIG',
        'UV_PYTHON',
        'UV_PYTHON_INSTALL_DIR',
        'VIRTUAL_ENV',
      ])
        Reflect.deleteProperty(env, key)
      env.UV_NO_CONFIG = '1'

      env.UV_PROJECT_ENVIRONMENT = join(plan.project.root, '.venv')
      delete env.VIRTUAL_ENV
      delete env.UV_WORKING_DIR
      delete env.UV_PROJECT
    }
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: plan.project.root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
      let output = ''
      let failure: Error | undefined
      let stopping: Promise<void> | undefined
      const stop = (error: Error): void => {
        failure ??= error
        stopping ??= terminateProcessTree(child)
      }
      const timer = setTimeout(
        () => stop(new Error(`Setup command timed out after ${timeout / 1000} seconds.`)),
        timeout
      )
      const cancel = (): void => stop(new Error('Project preparation cancelled.'))
      signal?.addEventListener('abort', cancel, { once: true })
      for (const stream of [child.stdout, child.stderr])
        stream?.on('data', (chunk: Buffer) => {
          output += chunk.toString()
          if (output.length > 4 * 1024 * 1024) {
            output = output.slice(-4 * 1024 * 1024)
            stop(new Error('Setup command exceeded the 4 MB log limit.'))
          }
        })
      child.once('error', (error): void => {
        failure ??= error
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        void (async (): Promise<void> => {
          await stopping
          await record(output)
          if (failure) throw failure
          if (code !== 0) throw Object.assign(new Error(`Command exited with code ${code}:\n${output}`), { code })
        })().then(resolvePromise, reject)
      })
      if (signal?.aborted) cancel()
    })
  }
  try {
    const initialState = await preparationCacheState(plan)
    const cached = options.force
      ? { dependencies: false, build: false }
      : await cachedPreparation(cachePath, initialState)
    if (plan.manager === 'manual') return logPath
    for (const step of plan.commands) {
      if (step.stage === 'build' ? cached.build : cached.dependencies) continue
      if (options.runtimeOnly && step.stage !== 'runtime') continue
      if (step.stage === 'runtime' && plan.project.language === 'python') {
        await preparePythonRuntime(plan.project.root, {
          ...(signal ? { signal } : {}),
          runtimeOnly: true,
          validateEnvironment: true,
          run: ({ command, args, timeout }) => execute('runtime', command, args, timeout),
        })
        if (plan.pythonRequirement) {
          await execute('runtime', step.command, [
            '-c',
            'import sys; from packaging.specifiers import SpecifierSet; sys.exit(0 if SpecifierSet(sys.argv[1]).contains(".".join(map(str, sys.version_info[:3]))) else 43)',
            plan.pythonRequirement,
          ])
        }
      } else {
        await execute(step.stage, step.command, step.args)
      }
    }
    const after = await planProjectPreparation(plan.project)
    if (after.fingerprint !== plan.fingerprint)
      throw new Error(
        'A setup command changed a manifest or lockfile. Inspect the changes before continuing; dev did not restore or overwrite them.'
      )
    if (!options.runtimeOnly) await savePreparationCache(cachePath, await preparationCacheState(plan), logPath)
    if (cached.dependencies && cached.build)
      await record('Reused unchanged project preparation; entrypoint validation still runs.')
    return logPath
  } catch (error) {
    await record(error instanceof Error ? error.message : String(error))
    if (signal?.aborted) throw signal.reason
    throw new ProjectPreparationError(error, progress)
  } finally {
    await log.close()
  }
}

const IGNORED_INPUTS = new Set([
  '.git',
  '.strands',
  '.agent',
  '.venv',
  'node_modules',
  'dist',
  'build',
  '__pycache__',
  'tmp',
  '.config',
])
const MAX_INPUT_BYTES = 32 * 1024 * 1024
const MAX_INPUT_FILES = 10000
const SETUP_INPUTS = ['.npmrc', '.python-version', 'setup.py', 'setup.cfg', 'uv.toml']

export interface PreparationCacheState {
  dependencies: string | undefined
  build: string | undefined
  environmentReady: boolean
}

interface PreparedRecord {
  version: 1
  dependencies?: string
  build?: string
  environment: string
  log: string
}

const fileState = async (path: string): Promise<string> => {
  try {
    const stat = await lstat(path)
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.isSymbolicLink() ? await realpath(path) : ''}`
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return 'missing'
    throw error
  }
}

const sourceFingerprint = async (root: string, output = false): Promise<string | undefined> => {
  const hash = createHash('sha256')
  let bytes = 0
  let files = 0
  const visit = async (directory: string): Promise<boolean> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (!output && (IGNORED_INPUTS.has(entry.name) || entry.name.endsWith('.egg-info'))) continue
      const path = join(directory, entry.name)
      hash.update(relative(root, path)).update('\0')
      if (entry.isSymbolicLink()) hash.update(await readlink(path))
      else if (entry.isDirectory()) {
        if (!(await visit(path))) return false
      } else if (entry.isFile()) {
        const stat = await lstat(path)
        bytes += stat.size
        files++
        if (bytes > MAX_INPUT_BYTES || files > MAX_INPUT_FILES) return false
        hash.update(await readFile(path))
      }
    }
    return true
  }
  return (await visit(root)) ? hash.digest('hex') : undefined
}

const requirementsFingerprint = async (root: string): Promise<string | undefined> => {
  const hash = createHash('sha256')
  const visited = new Set<string>()
  let bytes = 0
  const visit = async (path: string): Promise<boolean> => {
    if (visited.has(path)) return true
    visited.add(path)
    if (visited.size > 256) return false
    let source: string
    try {
      const details = await lstat(path)
      if (!details.isFile() || details.isSymbolicLink() || (await realpath(path)) !== path) return false
      bytes += details.size
      if (bytes > MAX_INPUT_BYTES) return false
      source = await readFile(path, 'utf8')
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        hash.update(path).update('missing')
        return true
      }
      throw error
    }
    hash.update(path).update('\0').update(source).update('\0')
    for (const line of source.replace(/\\\r?\n/gu, '').split(/\r?\n/u)) {
      const include = /^\s*(?:-r\s*|-c\s*|--requirement(?:=|\s+)|--constraint(?:=|\s+))(.+?)\s*(?:\s+#.*)?$/u.exec(line)
      if (!include) continue
      const value = include[1]!.trim().replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2')
      if (!value || value.includes('$') || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return false
      if (!(await visit(resolve(dirname(path), value)))) return false
    }
    return true
  }
  return (await visit(join(root, 'requirements.txt'))) ? hash.digest('hex') : undefined
}

const environmentFingerprint = async (plan: ProjectPreparationPlan): Promise<{ value: string; ready: boolean }> => {
  const root = plan.project.root
  const paths =
    plan.project.language === 'typescript'
      ? [join(root, 'node_modules'), join(root, 'node_modules/.package-lock.json')]
      : [
          join(root, '.venv/pyvenv.cfg'),
          join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
        ]
  if (plan.project.language === 'typescript') {
    try {
      const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
      if (isRecord(manifest))
        for (const field of ['dependencies', 'devDependencies']) {
          const values = manifest[field]
          if (isRecord(values))
            for (const name of Object.keys(values)) paths.push(join(root, 'node_modules', name, 'package.json'))
        }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error
    }
  } else {
    for (const base of [join(root, '.venv/lib'), join(root, '.venv/Lib')]) {
      try {
        const entries = await readdir(base, { withFileTypes: true })
        const directories =
          process.platform === 'win32'
            ? [join(base, 'site-packages')]
            : entries
                .filter((entry) => entry.isDirectory() && entry.name.startsWith('python'))
                .map((entry) => join(base, entry.name, 'site-packages'))
        for (const directory of directories) {
          paths.push(directory)
          for (const name of (await readdir(directory)).filter(
            (value) => value.endsWith('.dist-info') || value.endsWith('.pth') || value.includes('strands')
          ))
            paths.push(join(directory, name))
        }
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error
      }
    }
  }
  const states = await Promise.all(paths.map(fileState))
  const requiredStart = plan.project.language === 'typescript' ? 2 : 0
  const ready =
    plan.project.language === 'typescript'
      ? paths.length === 2 ||
        (states[0] !== 'missing' && states.slice(requiredStart).every((state) => state !== 'missing'))
      : states[0] !== 'missing' && states[1] !== 'missing' && paths.some((path) => path.includes('site-packages'))
  return { value: createHash('sha256').update(JSON.stringify(states)).digest('hex'), ready }
}

export const preparationCacheState = async (
  plan: ProjectPreparationPlan
): Promise<PreparationCacheState & { environment: string }> => {
  const environment = await environmentFingerprint(plan)
  const source = await sourceFingerprint(plan.project.root)
  const outputs = await Promise.all(
    ['dist', 'build'].map(async (name) => {
      const path = join(plan.project.root, name)
      const state = await fileState(path)
      if (state === 'missing') return { state, fingerprint: state }
      const details = await lstat(path)
      return {
        state,
        fingerprint: details.isSymbolicLink()
          ? undefined
          : details.isDirectory()
            ? await sourceFingerprint(path, true)
            : details.isFile() && details.size <= MAX_INPUT_BYTES
              ? createHash('sha256')
                  .update(await readFile(path))
                  .digest('hex')
              : undefined,
      }
    })
  )
  const setupInputs = await Promise.all(
    SETUP_INPUTS.map(async (name) => {
      const path = join(plan.project.root, name)
      const state = await fileState(path)
      if (state === 'missing') return [name, state]
      const details = await lstat(path)
      return [
        name,
        details.isFile() && !details.isSymbolicLink() && details.size <= MAX_INPUT_BYTES
          ? createHash('sha256')
              .update(await readFile(path))
              .digest('hex')
          : state,
      ]
    })
  )
  const requirements =
    plan.project.language === 'python' ? await requirementsFingerprint(plan.project.root) : 'not-python'
  const dependencies =
    requirements === undefined
      ? undefined
      : createHash('sha256')
          .update(
            JSON.stringify([
              plan.fingerprint,
              setupInputs,
              requirements,
              process.versions.node,
              process.platform,
              process.arch,
              plan.commands.filter((step) => step.stage !== 'build'),
            ])
          )
          .digest('hex')
  return {
    dependencies,
    environment: environment.value,
    environmentReady: environment.ready,
    build:
      source && outputs.every((output) => output.fingerprint !== undefined)
        ? createHash('sha256')
            .update(JSON.stringify([source, outputs, plan.commands.filter((step) => step.stage === 'build')]))
            .digest('hex')
        : undefined,
  }
}

export const cachedPreparation = async (
  path: string,
  state: PreparationCacheState & { environment: string }
): Promise<{ dependencies: boolean; build: boolean; log?: string }> => {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return { dependencies: false, build: false }
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(value) || value.version !== 1) return { dependencies: false, build: false }
    const dependencies =
      state.dependencies !== undefined &&
      state.environmentReady &&
      state.dependencies === value.dependencies &&
      state.environment === value.environment
    return {
      dependencies,
      build: dependencies && state.build !== undefined && state.build === value.build,
      ...(typeof value.log === 'string' ? { log: value.log } : {}),
    }
  } catch (error) {
    if (error instanceof SyntaxError || (isRecord(error) && error.code === 'ENOENT'))
      return { dependencies: false, build: false }
    throw error
  }
}

export const savePreparationCache = async (
  path: string,
  state: PreparationCacheState & { environment: string },
  log: string
): Promise<void> => {
  const record: PreparedRecord = {
    version: 1,
    ...(state.dependencies ? { dependencies: state.dependencies } : {}),
    environment: state.environment,
    log,
    ...(state.build ? { build: state.build } : {}),
  }
  const staging = join(dirname(path), `.prepared-${randomUUID()}.json`)
  try {
    await writeFile(staging, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(staging, path)
  } finally {
    await rm(staging, { force: true })
  }
}
