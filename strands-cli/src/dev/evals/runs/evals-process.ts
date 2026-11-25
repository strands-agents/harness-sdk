import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, createWriteStream, openSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { delimiter, dirname, resolve } from 'node:path'
import type { Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { fileURLToPath, URL } from 'node:url'

import { redactPreparationOutput } from '../../../project/preparation.js'
import type { EvalsRunEntry } from '../python/entry-files.js'
import type { DevWorkspace } from '../../workspace.js'
import { tailEvalsLines } from '../jobs.js'

export interface EvalsProcess {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  log?: string
  background?: boolean
  detached?: boolean
  onSpawn?: (pid: number) => void
  onLine: (line: string) => void
}

export interface EvalsExit {
  code: number
  stdout: string
  stderrTail: string[]
}

export type EvalsSpawner = (process: EvalsProcess) => Promise<EvalsExit>

type TemporaryTypescriptRunner = Pick<EvalsRunEntry, 'temporaryTypescriptRunner'>

const STDERR_TAIL_LINES = 20
const LOG_TAIL_BYTES = 64 * 1024
const DETACHABLE = process.platform !== 'win32'
const ERROR_LINE = /^strands-evals(?: [a-z-]+)*: error: /u

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export const temporaryTypescriptRunnerOf = ({ config }: DevWorkspace): TemporaryTypescriptRunner => {
  if (config.language !== 'typescript') return {}
  const runner = fileURLToPath(new URL('./typescript-runner-main.js', import.meta.url))
  return { temporaryTypescriptRunner: `${shellQuote(process.execPath)} ${shellQuote(runner)}` }
}

export const evalsWorkspaceDirectory = ({ directory, entrypoint }: DevWorkspace): string => {
  if (!directory)
    throw new Error(
      `${entrypoint} has no strands-dev workspace folder. Run strands dev init in its folder, then try again.`
    )
  return resolve(directory)
}

export const evalsFlagValues = (evalsArguments: readonly string[], flag: string): string[] =>
  evalsArguments.flatMap((argument, index) => {
    if (argument === flag) return evalsArguments.slice(index + 1, index + 2)
    return argument.startsWith(`${flag}=`) ? [argument.slice(flag.length + 1)] : []
  })

export const assertEvalsArguments = (
  evalsArguments: readonly string[],
  owned: readonly string[],
  command: string
): void => {
  const passed = evalsArguments.filter((argument) =>
    owned.some((flag) => argument === flag || argument.startsWith(`${flag}=`))
  )
  if (passed.length > 0)
    throw new Error(
      `${command} sets ${passed.join(', ')} itself. Remove ${passed.length > 1 ? 'them' : 'it'} from the flags after --, ` +
        'then try again.'
    )
}

export const evalsProcessEnvironment = (python: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...environment,
  PATH: [dirname(python), environment.PATH].filter(Boolean).join(delimiter),
  ...(environment.AWS_REGION ? { AWS_DEFAULT_REGION: environment.AWS_REGION } : {}),
})

export const evalsHeadline = ({ stderrTail }: EvalsExit): string => {
  const reported = [...stderrTail].reverse().find((line) => ERROR_LINE.test(line))
  return reported?.replace(ERROR_LINE, '') ?? stderrTail.at(-1) ?? 'it printed no error'
}

export const evalsFailure = (
  command: string,
  exit: EvalsExit,
  environment: NodeJS.ProcessEnv,
  nextStep: string
): Error =>
  new Error(
    redactPreparationOutput(
      `${command} stopped with exit code ${exit.code}: ${evalsHeadline(exit)}\n${nextStep}`,
      environment
    )
  )

const readEvalsLogTail = async (path: string, count = STDERR_TAIL_LINES): Promise<string[]> => {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    return buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim())
      .slice(-count)
  } finally {
    await handle.close()
  }
}

export const stopEvalsProcessGroup = (pid: number): void => {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    process.kill(pid, 'SIGTERM')
  }
}

const spawnDetachedEvals = ({
  command,
  args,
  cwd,
  env,
  signal,
  log,
  onSpawn,
  onLine,
}: EvalsProcess & { log: string }): Promise<EvalsExit> =>
  new Promise((resolveExit, rejectExit) => {
    const output = openSync(log, 'a')
    let child: ChildProcess
    try {
      child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', output, output], windowsHide: true })
    } finally {
      closeSync(output)
    }
    const tail = tailEvalsLines(log, onLine)
    const stop = (): void => {
      if (child.pid !== undefined && child.exitCode === null) stopEvalsProcessGroup(child.pid)
    }
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    child.unref()
    child.once('spawn', () => {
      if (child.pid !== undefined) onSpawn?.(child.pid)
    })
    child.once('error', (error) => {
      signal?.removeEventListener('abort', stop)
      void tail.stop().finally(() => rejectExit(error))
    })
    child.once('exit', (code) => {
      signal?.removeEventListener('abort', stop)
      void tail
        .stop()
        .then(() => readEvalsLogTail(log))
        .then((stderrTail) => resolveExit({ code: code ?? 1, stdout: '', stderrTail }), rejectExit)
    })
  })

export const spawnEvals: EvalsSpawner = (request) =>
  request.detached && request.log && DETACHABLE
    ? spawnDetachedEvals({ ...request, log: request.log })
    : spawnAttachedEvals(request)

const spawnAttachedEvals: EvalsSpawner = ({ command, args, cwd, env, signal, log, background, onSpawn, onLine }) =>
  new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    child.once('spawn', () => {
      if (child.pid !== undefined) onSpawn?.(child.pid)
    })
    const output = log ? createWriteStream(log, { flags: 'a' }) : undefined
    const stdout: string[] = []
    const stderrTail: string[] = []
    const abort = (): void => void child.kill('SIGTERM')
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    process.once('exit', abort)
    if (background) {
      child.unref()
      for (const stream of [child.stdout, child.stderr]) (stream as Partial<Pick<Socket, 'unref'>>).unref?.()
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk))
    createInterface({ input: child.stderr }).on('line', (line) => {
      output?.write(`${line}\n`)
      stderrTail.push(line)
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
      onLine(line)
    })
    child.once('error', rejectExit)
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort)
      process.removeListener('exit', abort)
      output?.end()
      resolveExit({ code: code ?? 1, stdout: stdout.join(''), stderrTail })
    })
  })

/** What a request for an evaluation and for an optimization share. */
export interface EvalsRequest extends Pick<EvalsProcess, 'signal' | 'background' | 'detached' | 'onSpawn'> {
  workspace: DevWorkspace
  experiment?: string
  evalsArguments?: readonly string[]
  onProgress?: (line: string) => void
  prepare?: () => Promise<void>
  now?: () => Date
}

/** Runs the optimizer environment's interpreter in the project, with the process options of the request. */
export const runEvals = (
  spawner: EvalsSpawner = spawnEvals,
  { workspace, signal, background, detached, onSpawn }: EvalsRequest,
  { python, args, log }: { python: string; args: string[]; log: string },
  onLine: (line: string) => void
): Promise<EvalsExit> =>
  spawner({
    command: python,
    args,
    cwd: workspace.root,
    env: evalsProcessEnvironment(python, process.env),
    ...(signal ? { signal } : {}),
    ...(background ? { background: true } : {}),
    ...(detached ? { detached: true } : {}),
    ...(onSpawn ? { onSpawn } : {}),
    log,
    onLine,
  })
