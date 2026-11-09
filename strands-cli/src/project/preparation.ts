import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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

export const preparationFailure = (error: unknown, progress?: PreparationProgress): PreparationFailure => {
  const detail = redactPreparationOutput(error instanceof Error ? error.message : String(error))
  const stage = progress?.stage ?? 'entrypoint'
  let action = 'Fix the error in the selected project, then Retry. Choose Back if this is not the correct project root.'
  const missing = /(?:No module named|Cannot find (?:module|package))\s+["'‘]?([^"'’\s]+)/u.exec(detail)?.[1]
  if (missing)
    action = `Check the selected project root and dependency manifest for ${missing}. For Python src-layout packages, install the project itself with an editable install. Do not infer a registry package name from this import.`
  else if (/ENOENT|not found|not recognized/iu.test(detail))
    action =
      'Install the named runtime or package manager, ensure it is on PATH, and restart strands dev. Or prepare the project manually and validate it.'
  else if (/version|requires-python|engines.node/iu.test(detail))
    action = 'Select a runtime version supported by the project manifest, then restart strands dev.'
  else if (/lock|frozen/iu.test(detail))
    action =
      'Fix the manifest and lockfile mismatch with the project package manager. Dev will not rewrite the lockfile. Then Retry.'
  else if (/401|403|authentication|credentials/iu.test(detail))
    action =
      'Configure credentials for the package index or provider outside the workspace files, then Retry. Do not paste credentials into the log.'
  return {
    stage,
    summary: `Project ${stage} failed`,
    action,
    ...(progress ? { command: progress.command, logPath: progress.logPath } : {}),
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
  options: { signal?: AbortSignal; progress?: (progress: PreparationProgress) => void; runtimeOnly?: boolean } = {}
): Promise<string> => {
  const { signal } = options
  signal?.throwIfAborted()
  const current = await planProjectPreparation(plan.project)
  if (current.fingerprint !== plan.fingerprint)
    throw new ProjectPreparationError(
      new Error('Project manifests changed after the preview. Return to setup and inspect the new commands.')
    )
  const logPath = await privateLogs(plan.project.root)
  const lock = join(dirname(logPath), 'prepare.lock')
  try {
    await mkdir(lock, { mode: 0o700 })
  } catch (error) {
    throw new ProjectPreparationError(
      new Error(
        `Project preparation is already running, or its lock cannot be created: ${lock}. Stop any active installer before removing a stale lock.`,
        { cause: error }
      )
    )
  }
  const log = await open(logPath, 'wx', 0o600).catch(async (error) => {
    await rm(lock, { recursive: true, force: true })
    throw error
  })
  let progress: PreparationProgress | undefined
  const record = async (message: string): Promise<void> => {
    await log.writeFile(`${redactPreparationOutput(message)}\n`)
  }
  const execute = async (stage: PreparationStage, command: string, args: string[], timeout = 180000): Promise<void> => {
    signal?.throwIfAborted()
    progress = { stage, command: describePreparationCommand({ stage, command, args }), logPath }
    options.progress?.(progress)
    await record(progress.command)
    const invocation = command === 'npm' ? npmInvocation(args) : { command, args }
    const python = plan.project.language === 'python'
    const env = python ? pythonInstallEnvironment(process.env) : { ...process.env }
    if (command === 'uv') {
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
    if (plan.manager === 'manual') return logPath
    for (const step of plan.commands) {
      if (options.runtimeOnly && step.stage !== 'runtime') continue
      if (step.stage === 'runtime' && plan.project.language === 'python') {
        await preparePythonRuntime(plan.project.root, {
          ...(signal ? { signal } : {}),
          runtimeOnly: true,
          validateEnvironment: true,
          run: ({ command, args, timeout }) => execute('runtime', command, args, timeout),
        })
      } else {
        await execute(step.stage, step.command, step.args)
      }
    }
    const after = await planProjectPreparation(plan.project)
    if (after.fingerprint !== plan.fingerprint)
      throw new Error(
        'A setup command changed a manifest or lockfile. Inspect the changes before continuing; dev did not restore or overwrite them.'
      )
    return logPath
  } catch (error) {
    await record(error instanceof Error ? error.message : String(error))
    if (signal?.aborted) throw signal.reason
    throw new ProjectPreparationError(error, progress)
  } finally {
    await log.close()
    await rm(lock, { recursive: true, force: true })
  }
}
