import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, createWriteStream, openSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, delimiter, dirname, join } from 'node:path'
import type { Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { fileURLToPath, URL } from 'node:url'

import { redactPreparationOutput } from '../../project/preparation.js'
import type { DevWorkspace } from '../workspace.js'
import { tailTemporaryLines } from './jobs.js'

export interface TemporaryEvalsProcess {
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

export interface TemporaryEvalsExit {
  code: number
  stdout: string
  stderrTail: string[]
}

export type TemporaryEvalsSpawner = (process: TemporaryEvalsProcess) => Promise<TemporaryEvalsExit>

const STDERR_TAIL_LINES = 20
const LOG_TAIL_BYTES = 64 * 1024
const DETACHABLE = process.platform !== 'win32'
const ERROR_LINE = /^strands-evals(?: [a-z-]+)?: error: /u

export const temporaryExperimentsFolder = (workspaceDirectory: string): string =>
  join(workspaceDirectory, 'tmp', 'experiments')

export const temporaryReportsFolder = (workspaceDirectory: string): string => join(workspaceDirectory, 'tmp', 'reports')

export const temporaryRunName = (experiment: string, now: Date): string =>
  `${now.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)}-${basename(experiment, '.json')}`

const RUN_NAME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)$/u

export const temporaryRunNameParts = (name: string): { startedAt: number; experiment: string } | undefined => {
  const match = RUN_NAME.exec(name)
  if (!match) return undefined
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = match.slice(1, 7).map(Number)
  return { startedAt: Date.UTC(year, month - 1, day, hour, minute, second), experiment: match[7]! }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export const temporaryTypescriptRunnerCommand = (): string => {
  const runner = fileURLToPath(new URL('./typescript-runner-main.js', import.meta.url))
  return `${shellQuote(process.execPath)} ${shellQuote(runner)}`
}

export const temporaryLanguageArguments = ({ config }: DevWorkspace): string[] =>
  config.language === 'typescript' ? ['--typescript-runner', temporaryTypescriptRunnerCommand()] : []

export const temporaryWorkspaceDirectory = ({ directory, entrypoint }: DevWorkspace): string => {
  if (!directory)
    throw new Error(
      `${entrypoint} has no strands-dev workspace folder. Run strands dev init in its folder, then try again.`
    )
  return directory
}

export const assertTemporaryForkArguments = (
  forkArguments: readonly string[],
  owned: readonly string[],
  command: string
): void => {
  const passed = forkArguments.filter((argument) =>
    owned.some((flag) => argument === flag || argument.startsWith(`${flag}=`))
  )
  if (passed.length > 0)
    throw new Error(
      `${command} sets ${passed.join(', ')} itself. Remove ${passed.length > 1 ? 'them' : 'it'} from the flags after --, ` +
        'then try again.'
    )
}

export const temporaryEvalsEnvironment = (python: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...environment,
  PATH: [dirname(python), environment.PATH].filter(Boolean).join(delimiter),
  ...(environment.AWS_REGION ? { AWS_DEFAULT_REGION: environment.AWS_REGION } : {}),
})

export const temporaryEvalsFailure = (
  command: string,
  exit: TemporaryEvalsExit,
  environment: NodeJS.ProcessEnv,
  nextStep: string
): Error => {
  const reported = [...exit.stderrTail].reverse().find((line) => ERROR_LINE.test(line))
  const headline = reported?.replace(ERROR_LINE, '') ?? exit.stderrTail.at(-1) ?? 'it printed no error'
  return new Error(
    redactPreparationOutput(`${command} stopped with exit code ${exit.code}: ${headline}\n${nextStep}`, environment)
  )
}

const releaseEventLoop = (streams: readonly unknown[]): void => {
  for (const stream of streams) (stream as Partial<Pick<Socket, 'unref'>>).unref?.()
}

export const readTemporaryLogTail = async (path: string, count = STDERR_TAIL_LINES): Promise<string[]> => {
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

export const stopTemporaryProcessGroup = (pid: number): void => {
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
}: TemporaryEvalsProcess & { log: string }): Promise<TemporaryEvalsExit> =>
  new Promise((resolveExit, rejectExit) => {
    const output = openSync(log, 'a')
    let child: ChildProcess
    try {
      child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', output, output], windowsHide: true })
    } finally {
      closeSync(output)
    }
    const tail = tailTemporaryLines(log, onLine)
    const stop = (): void => {
      if (child.pid !== undefined && child.exitCode === null) stopTemporaryProcessGroup(child.pid)
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
        .then(() => readTemporaryLogTail(log))
        .then((stderrTail) => resolveExit({ code: code ?? 1, stdout: '', stderrTail }), rejectExit)
    })
  })

export const spawnTemporaryEvals: TemporaryEvalsSpawner = (request) =>
  request.detached && request.log && DETACHABLE
    ? spawnDetachedEvals({ ...request, log: request.log })
    : spawnAttachedEvals(request)

const spawnAttachedEvals: TemporaryEvalsSpawner = ({
  command,
  args,
  cwd,
  env,
  signal,
  log,
  background,
  onSpawn,
  onLine,
}) =>
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
      releaseEventLoop([child.stdout, child.stderr])
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
