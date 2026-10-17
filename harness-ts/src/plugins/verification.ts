/**
 * Verification: run the project's own checks before the agent may report a change as done.
 *
 * When an invocation ends normally and the agent called a tool that can change the workspace, the
 * plugin runs each check command through the agent's `sandbox` (the seam the `shell` tool uses, so a
 * Docker or SSH sandbox runs the checks where the files live). If every check exits `0` the answer
 * stands. If one fails, its exit code and the tail of its output are fed back as a user message through
 * `AfterInvocationEvent.resume` and the agent keeps working. When the attempt budget is spent the agent
 * gets one last turn to tell the user what still fails, so a run never ends on an unverified "done".
 *
 * The outcome of the latest verification is written to `agent.appState` under `verification`.
 *
 * Checks are plain commands, never model calls. An invocation that only read, searched or planned (see
 * `READ_ONLY_TOOLS`) runs no checks. One that ends any other way than a normal end of turn (an
 * interrupt for approval, a cancellation, a limit) runs none either, but keeps its run open, so the
 * changes it made are verified when a later invocation on the agent finishes normally.
 */

import {
  AfterInvocationEvent,
  AfterModelCallEvent,
  AfterToolCallEvent,
  BeforeInvocationEvent,
  SandboxTimeoutError,
  type LocalAgent,
  type Plugin,
} from '@strands-agents/sdk'
import { logger } from '../logging.js'

const DEFAULT_NAME = 'strands:verification'
export const VERIFICATION_STATE_KEY = 'verification'
export const DEFAULT_VERIFY_MAX_ATTEMPTS = 3
export const DEFAULT_VERIFY_TIMEOUT = 600

// Output kept per failed check: the tail, where test runners and compilers print their summary.
const OUTPUT_TAIL_CHARS = 4_000

// Tools that cannot change the workspace. Every other tool (consumer and MCP tools included) counts as
// a possible change, so an unknown tool errs toward running the checks.
const READ_ONLY_TOOLS = new Set(['read', 'web_fetch', 'web_search', 'todo_write', 'search_memory', 'skills'])

// `'auto'` detection, first match wins: [file, text the file must contain, command].
const AUTO_CHECKS: ReadonlyArray<readonly [string, string, string]> = [
  ['package.json', '"test"', 'npm test'],
  ['pyproject.toml', '', 'python -m pytest -q'],
  ['Cargo.toml', '', 'cargo test'],
  ['go.mod', '', 'go test ./...'],
  ['Makefile', 'test:', 'make test'],
]

/** What the latest verification on an agent concluded. */
export type VerificationStatus = 'passed' | 'failed' | 'noChecks'

/** The record written to `agent.appState.verification`. */
export interface VerificationRecord {
  status: VerificationStatus
  /** How many times the checks ran in the invocation. */
  attempts: number
  /** The last result of each check; `exitCode` is `null` when the command timed out. */
  checks: Array<{ command: string; exitCode: number | null }>
}

/** Configuration for the {@link Verification} plugin. */
export interface VerificationConfig {
  /** Shell commands to run in order, or `'auto'` to detect one from the project files. */
  commands: string[] | 'auto'
  /** How many failed verifications the agent may try to fix before it must report. Defaults to 3. */
  maxAttempts?: number
  /** Seconds each command may run; a command that runs longer counts as failed. Defaults to 600. */
  timeout?: number
  /** Plugin name, for logging and duplicate detection. Defaults to `'strands:verification'`. */
  name?: string
}

interface CheckResult {
  command: string
  exitCode: number | null
  output: string
}

interface Run {
  changed: boolean
  attempts: number
  reporting: boolean
  carryOver: boolean
  endedTurn: boolean
  last: CheckResult[]
}

function newRun(): Run {
  return { changed: false, attempts: 0, reporting: false, carryOver: false, endedTurn: false, last: [] }
}

function tail(text: string): string {
  if (text.length <= OUTPUT_TAIL_CHARS) {
    return text
  }
  return `[... ${text.length - OUTPUT_TAIL_CHARS} earlier characters omitted ...]\n${text.slice(-OUTPUT_TAIL_CHARS)}`
}

function failureBlock(check: CheckResult): string {
  const status = check.exitCode === null ? 'timed out' : `exit code ${check.exitCode}`
  return `$ ${check.command}\n${status}\n${tail(check.output)}`
}

function failurePrompt(failed: CheckResult[], attempt: number, maxAttempts: number): string {
  const body = failed.map(failureBlock).join('\n\n')
  return (
    `<verification>\nThe project's checks failed after your changes (attempt ${attempt} of ${maxAttempts}).\n\n` +
    `${body}\n\nFix the cause and make these checks pass. Do not skip, weaken or delete the checks.\n` +
    '</verification>'
  )
}

function reportPrompt(failed: CheckResult[], maxAttempts: number): string {
  const commands = failed.map((check) => `- ${check.command}`).join('\n')
  return (
    `<verification>\nThe project's checks still fail after ${maxAttempts} attempts:\n${commands}\n\n` +
    'Stop changing files. Tell the user plainly that the task is not verified, which checks still fail, ' +
    'and what you believe is wrong.\n</verification>'
  )
}

async function readText(agent: LocalAgent, path: string): Promise<string | undefined> {
  try {
    return await agent.sandbox.readText(path)
  } catch {
    return undefined
  }
}

/** The check `'auto'` resolves to in the agent's working directory, or `[]` when nothing matches. */
export async function detectChecks(agent: LocalAgent): Promise<string[]> {
  for (const [path, marker, command] of AUTO_CHECKS) {
    const text = await readText(agent, path)
    if (text !== undefined && text.includes(marker)) {
      return [command]
    }
  }
  return []
}

function isCommandList(commands: unknown): commands is string[] {
  return (
    Array.isArray(commands) &&
    commands.length > 0 &&
    commands.every((command) => typeof command === 'string' && command.trim() !== '')
  )
}

/**
 * Runs the project's checks when the agent finishes an invocation that changed the workspace.
 *
 * Only one plugin may drive `AfterInvocationEvent.resume` on an agent, so this plugin cannot be
 * combined with a `GoalLoop`. Sharing one instance across agents is safe: run state is per agent.
 */
export class Verification implements Plugin {
  readonly name: string
  readonly commands: string[] | 'auto'
  private readonly _maxAttempts: number
  private readonly _timeout: number
  private readonly _runs = new WeakMap<LocalAgent, Run>()
  private readonly _detected = new WeakMap<LocalAgent, string[]>()

  constructor(config: VerificationConfig) {
    const { commands, maxAttempts = DEFAULT_VERIFY_MAX_ATTEMPTS, timeout = DEFAULT_VERIFY_TIMEOUT } = config
    if (commands !== 'auto' && !isCommandList(commands)) {
      throw new Error(
        `commands=<${JSON.stringify(commands)}> | must be 'auto' or a non-empty list of non-empty strings`
      )
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error(`maxAttempts=<${maxAttempts}> | must be an integer of at least 1`)
    }
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(`timeout=<${timeout}> | must be a positive number of seconds`)
    }
    this.name = config.name ?? DEFAULT_NAME
    this.commands = commands === 'auto' ? 'auto' : [...commands]
    this._maxAttempts = maxAttempts
    this._timeout = timeout
  }

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeInvocationEvent, (event) => this._beforeInvocation(event.agent))
    agent.addHook(AfterModelCallEvent, (event) => this._afterModelCall(event))
    agent.addHook(AfterToolCallEvent, (event) => this._afterToolCall(event))
    agent.addHook(AfterInvocationEvent, async (event) => this._afterInvocation(event))
  }

  private _beforeInvocation(agent: LocalAgent): void {
    const run = this._runs.get(agent)
    if (run?.carryOver) {
      run.carryOver = false
      run.endedTurn = false
      return
    }
    this._runs.set(agent, newRun())
  }

  // The TS AfterInvocationEvent carries no result, so a normal end of turn is read off the last model call.
  private _afterModelCall(event: AfterModelCallEvent): void {
    const run = this._runs.get(event.agent)
    if (run) {
      run.endedTurn = event.stopData?.stopReason === 'endTurn'
    }
  }

  private _afterToolCall(event: AfterToolCallEvent): void {
    const run = this._runs.get(event.agent)
    if (run && !READ_ONLY_TOOLS.has(event.toolUse.name)) {
      run.changed = true
    }
  }

  private async _afterInvocation(event: AfterInvocationEvent): Promise<void> {
    const agent = event.agent
    const run = this._runs.get(agent)
    if (!run) {
      return
    }
    if (!run.endedTurn) {
      run.carryOver = true
      return
    }
    if (run.reporting) {
      this._record(agent, 'failed', run)
      return
    }
    if (!run.changed) {
      return
    }

    const commands = await this._resolveCommands(agent)
    if (commands.length === 0) {
      this._record(agent, 'noChecks', run)
      return
    }

    run.attempts += 1
    run.last = []
    for (const command of commands) {
      run.last.push(await this._runCheck(agent, command))
    }
    const failed = run.last.filter((check) => check.exitCode !== 0)
    if (failed.length === 0) {
      this._record(agent, 'passed', run)
      return
    }

    logger.debug(`plugin=<${this.name}>, attempt=<${run.attempts}>, failed=<${failed.length}> | checks failed`)
    if (run.attempts < this._maxAttempts) {
      event.resume = failurePrompt(failed, run.attempts, this._maxAttempts)
    } else {
      run.reporting = true
      event.resume = reportPrompt(failed, this._maxAttempts)
    }
    run.carryOver = true
  }

  private async _resolveCommands(agent: LocalAgent): Promise<string[]> {
    if (this.commands !== 'auto') {
      return this.commands
    }
    let detected = this._detected.get(agent)
    if (detected === undefined) {
      detected = await detectChecks(agent)
      if (detected.length === 0) {
        logger.warn(`plugin=<${this.name}> | verify='auto' found no test command, no checks will run`)
      }
      this._detected.set(agent, detected)
    }
    return detected
  }

  private async _runCheck(agent: LocalAgent, command: string): Promise<CheckResult> {
    try {
      const result = await agent.sandbox.execute(command, { timeout: this._timeout })
      const output = [result.stdout, result.stderr].filter((part) => part).join('\n')
      return { command, exitCode: result.exitCode, output }
    } catch (error) {
      if (error instanceof SandboxTimeoutError) {
        return { command, exitCode: null, output: `timed out after ${this._timeout}s` }
      }
      return { command, exitCode: -1, output: `could not run the check: ${(error as Error).message}` }
    }
  }

  private _record(agent: LocalAgent, status: VerificationStatus, run: Run): void {
    const record: VerificationRecord = {
      status,
      attempts: run.attempts,
      checks: run.last.map((check) => ({ command: check.command, exitCode: check.exitCode })),
    }
    agent.appState.set(VERIFICATION_STATE_KEY, record)
  }
}
