import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, URL } from 'node:url'

import { redactPreparationOutput } from '../../project/preparation.js'
import type { DevWorkspace } from '../workspace.js'

export interface TemporaryEvalsProcess {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  log?: string
  onLine: (line: string) => void
}

export interface TemporaryEvalsExit {
  code: number
  stdout: string
  stderrTail: string[]
}

export type TemporaryEvalsSpawner = (process: TemporaryEvalsProcess) => Promise<TemporaryEvalsExit>

const STDERR_TAIL_LINES = 20
const ERROR_LINE = /^strands-evals(?: [a-z-]+)?: error: /u

export const temporaryExperimentsFolder = (workspaceDirectory: string): string =>
  join(workspaceDirectory, 'tmp', 'experiments')

export const temporaryReportsFolder = (workspaceDirectory: string): string => join(workspaceDirectory, 'tmp', 'reports')

export const temporaryRunName = (experiment: string, now: Date): string =>
  `${now.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)}-${basename(experiment, '.json')}`

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

export const spawnTemporaryEvals: TemporaryEvalsSpawner = ({ command, args, cwd, env, signal, log, onLine }) =>
  new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const output = log ? createWriteStream(log, { flags: 'a' }) : undefined
    const stdout: string[] = []
    const stderrTail: string[] = []
    const abort = (): void => void child.kill('SIGTERM')
    signal?.addEventListener('abort', abort, { once: true })
    process.once('exit', abort)
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
