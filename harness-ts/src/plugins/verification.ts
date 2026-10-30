/**
 * Verification: run the project's own checks before the agent may report a change as done.
 *
 * `Verification` is a `GoalLoop` whose goal is "the project's checks pass". When an invocation that changed the
 * workspace ends normally (end of turn, stop sequence, `AfterToolsEvent.endTurn`, or structured output), the validator
 * runs each check through `agent.sandbox`. A failing check's exit code and output tail become the GoalLoop feedback,
 * so the agent keeps working. After `maxAttempts` failed check runs the last answer is returned unverified, with a
 * warning. The outcome is written to `agent.appState` under `verification`.
 *
 * An invocation that stops early (interrupt, cancel, `maxTokens`, limit) runs no checks: its changes are carried to
 * the next invocation and recorded as `pending`, and their attempt count carries with them.
 *
 * A validator sees only the last message, so read-only hooks record what it cannot: which tools ran and how the
 * invocation ended. A validator cannot say "not graded" either, so it passes an invocation it does not grade, and
 * `lastResult` reports Verification's own outcome instead of GoalLoop's.
 */

import {
  AfterInvocationEvent,
  AfterModelCallEvent,
  AfterToolCallEvent,
  AfterToolsEvent,
  HookOrder,
  SandboxTimeoutError,
  type LocalAgent,
} from '@strands-agents/sdk'
import {
  GoalLoop,
  type GoalAttempt,
  type GoalResult,
  type ValidationOutcome,
} from '@strands-agents/sdk/vended-plugins/goal'
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

// Model stop reasons that end an invocation normally, so its changes are graded.
const NORMAL_STOPS = new Set(['endTurn', 'stopSequence'])

// The SDK's `STRUCTURED_OUTPUT_TOOL_NAME` (`tools/structured-output-tool.ts`), which its package does not export.
const STRUCTURED_OUTPUT_TOOL = 'strands_structured_output'

// `'auto'` detection, first match wins: [file, text the file must contain, command]. `package.json` is checked by
// parsing it instead (see `hasNpmTest`).
const AUTO_CHECKS: ReadonlyArray<readonly [string, string, string]> = [
  ['package.json', '', 'npm test'],
  ['pyproject.toml', '', 'python -m pytest -q'],
  ['Cargo.toml', '', 'cargo test'],
  ['go.mod', '', 'go test ./...'],
  ['Makefile', 'test:', 'make test'],
]

/** What the latest verification on an agent concluded. */
export type VerificationStatus = 'passed' | 'failed' | 'noChecks' | 'pending'

/** The record written to `agent.appState.verification`. */
export interface VerificationRecord {
  status: VerificationStatus
  /** How many times the checks ran in the request. */
  attempts: number
  /** The last result of each check; `exitCode` is `null` when the command timed out. */
  checks: Array<{ command: string; exitCode: number | null }>
}

/** Configuration for the {@link Verification} plugin. */
export interface VerificationConfig {
  /** Shell commands to run in order, or `'auto'` to detect one from the project files. */
  commands: string[] | 'auto'
  /**
   * Most times the checks run in one request; every failure before the last sends the agent back to fix it.
   * Defaults to 3.
   */
  maxAttempts?: number
  /** Seconds each command may run; a command that runs longer counts as failed. Defaults to 600. */
  timeout?: number
  /** Plugin name, for logging. Defaults to `'strands:verification'`. */
  name?: string
}

interface CheckResult {
  command: string
  exitCode: number | null
  output: string
}

/**
 * One request: a set of changes from the first edit until an invocation ends normally and they are graded. It spans
 * GoalLoop's retries and any invocation that stopped early (interrupt, cancel, `maxTokens`, limit).
 */
interface Run {
  changed: boolean
  /** A change landed after the last check run: the record no longer describes the workspace. */
  dirty: boolean
  endedTurn: boolean
  attempts: number
  failed: boolean
  last: CheckResult[]
  history: GoalAttempt[]
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

// The feedback is already the whole retry message; GoalLoop's default wording asks for a rewritten answer.
function retryPrompt(feedback: string | undefined): string {
  return feedback ?? "<verification>\nThe project's checks failed. Fix the cause and make them pass.\n</verification>"
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
    if (text === undefined || !text.includes(marker)) {
      continue
    }
    if (path === 'package.json' && !hasNpmTest(text)) {
      continue
    }
    return [command]
  }
  return []
}

/** Whether a `package.json` defines a non-empty `scripts.test`; malformed JSON counts as no. */
function hasNpmTest(text: string): boolean {
  try {
    const test = (JSON.parse(text) as { scripts?: { test?: unknown } } | null)?.scripts?.test
    return typeof test === 'string' && test.trim() !== ''
  } catch {
    return false
  }
}

function isCommandList(commands: unknown): commands is string[] {
  return (
    Array.isArray(commands) &&
    commands.length > 0 &&
    commands.every((command) => typeof command === 'string' && command.trim() !== '')
  )
}

/**
 * The checks and the per-agent request state behind a {@link Verification}. A separate object because the
 * GoalLoop validator is passed to `super()`, before a derived constructor may touch `this`.
 */
class ChangeChecks {
  readonly name: string
  readonly commands: string[] | 'auto'
  readonly maxAttempts: number
  private readonly _timeout: number
  private readonly _requests = new WeakMap<LocalAgent, Run>()
  private readonly _results = new WeakMap<LocalAgent, GoalResult>()
  private readonly _warnedNoChecks = new WeakSet<LocalAgent>()

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
    this.maxAttempts = maxAttempts
    this._timeout = timeout
  }

  observe(agent: LocalAgent, goalResult: (agent: LocalAgent) => GoalResult | undefined): void {
    agent.addHook(AfterModelCallEvent, (event) => {
      const stopReason = event.stopData?.stopReason
      this._run(event.agent).endedTurn = stopReason !== undefined && NORMAL_STOPS.has(stopReason)
    })
    agent.addHook(AfterToolCallEvent, (event) => {
      if (event.toolUse.name === STRUCTURED_OUTPUT_TOOL) {
        // The structured-output tool records the answer; it changes nothing. Its success ends the invocation.
        if (event.error === undefined && event.result.status === 'success') {
          this._run(event.agent).endedTurn = true
        }
        return
      }
      if (!READ_ONLY_TOOLS.has(event.toolUse.name)) {
        const run = this._run(event.agent)
        run.changed = true
        run.dirty = true
      }
    })
    // SDK_LAST: runs after every default-order hook, so it reads the final `endTurn` whoever set it.
    agent.addHook(
      AfterToolsEvent,
      (event) => {
        if (event.endTurn) {
          this._run(event.agent).endedTurn = true
        }
      },
      { order: HookOrder.SDK_LAST }
    )
    agent.addHook(AfterInvocationEvent, (event) => this._afterInvocation(event, goalResult))
  }

  /** Verification's own outcome; `undefined` while changes are unverified, `null` when no check ran. */
  result(agent: LocalAgent): GoalResult | undefined | null {
    if (this._requests.has(agent)) {
      return undefined
    }
    return this._results.get(agent) ?? null
  }

  /** The GoalLoop validator: pass unless a finished invocation changed the workspace and a check fails. */
  async verify(agent: LocalAgent): Promise<boolean | ValidationOutcome> {
    const run = this._requests.get(agent)
    // Nothing to grade when the invocation stopped early (its changes are checked once a later one finishes) or
    // changed nothing. Passing is also what keeps GoalLoop from resuming a run paused for approval.
    if (!run?.endedTurn || !run.changed) {
      return true
    }

    let commands: string[] | undefined
    try {
      commands = await this._resolveCommands(agent)
    } catch (error) {
      // A custom sandbox's readText may throw anything; never let it read as a pass.
      run.last = [
        { command: 'verify', exitCode: -1, output: `could not resolve the checks: ${(error as Error).message}` },
      ]
    }
    if (commands !== undefined) {
      if (commands.length === 0) {
        run.dirty = false
        this._record(agent, 'noChecks', run)
        return true
      }
      run.last = []
      for (const command of commands) {
        run.last.push(await this._runCheck(agent, command))
      }
    }

    run.attempts += 1
    run.dirty = false
    const failed = run.last.filter((check) => check.exitCode !== 0)
    run.failed = failed.length > 0
    const feedback = run.failed ? failurePrompt(failed, run.attempts, this.maxAttempts) : undefined
    run.history.push({ attempt: run.attempts, passed: !run.failed, ...(feedback !== undefined && { feedback }) })
    this._record(agent, run.failed ? 'failed' : 'passed', run)
    if (!run.failed) {
      return true
    }
    logger.debug(`plugin=<${this.name}>, attempt=<${run.attempts}>, failed=<${failed.length}> | checks failed`)
    if (run.attempts >= this.maxAttempts) {
      // Out of attempts. Passing is the only answer that stops GoalLoop: after an interrupt its own count restarted,
      // so a failure would arm another retry. `lastResult` reports the failure instead.
      return true
    }
    return { passed: false, feedback: feedback! }
  }

  private _run(agent: LocalAgent): Run {
    let run = this._requests.get(agent)
    if (run === undefined) {
      run = { changed: false, dirty: false, endedTurn: false, attempts: 0, failed: false, last: [], history: [] }
      this._requests.set(agent, run)
    }
    return run
  }

  private _afterInvocation(
    event: AfterInvocationEvent,
    goalResult: (agent: LocalAgent) => GoalResult | undefined
  ): void {
    const run = this._requests.get(event.agent)
    if (run === undefined) {
      return
    }
    const endedTurn = run.endedTurn
    run.endedTurn = false
    if (event.resume !== undefined) {
      return // GoalLoop retries after a failed check: the same request continues
    }
    if (run.dirty || (run.changed && !endedTurn)) {
      // Stopped early (or GoalLoop never graded the pass): carry the changes, attempts included, to the next
      // invocation. The request is unfinished, so the record says so: `pending` exactly while `lastResult` is
      // `undefined`.
      this._record(event.agent, 'pending', run)
      return
    }
    this._requests.delete(event.agent)
    if (run.history.length === 0) {
      this._results.delete(event.agent)
      return
    }
    if (!run.failed) {
      this._results.set(event.agent, { passed: true, stopReason: 'satisfied', attempts: run.history })
      return
    }
    const goal = goalResult(event.agent)
    const stopReason = goal !== undefined && goal.stopReason !== 'satisfied' ? goal.stopReason : 'maxAttempts'
    this._results.set(event.agent, { passed: false, stopReason, attempts: run.history })
    logger.warn(
      `plugin=<${this.name}>, attempts=<${run.attempts}> | checks still fail, returning the answer unverified`
    )
  }

  private async _resolveCommands(agent: LocalAgent): Promise<string[]> {
    if (this.commands !== 'auto') {
      return this.commands
    }
    // Detected on every graded run, not cached: an agent that scaffolds a project later gets its checks.
    const detected = await detectChecks(agent)
    if (detected.length === 0 && !this._warnedNoChecks.has(agent)) {
      this._warnedNoChecks.add(agent)
      logger.warn(`plugin=<${this.name}> | verify='auto' found no test command, no checks will run`)
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

/**
 * A `GoalLoop` whose goal is the project's checks passing after the agent changed the workspace.
 *
 * Only one GoalLoop may drive an agent, so this plugin cannot be combined with another one. Sharing one instance
 * across agents is safe: run state is per agent.
 */
export class Verification extends GoalLoop {
  readonly commands: string[] | 'auto'
  private readonly _checks: ChangeChecks

  constructor(config: VerificationConfig) {
    const checks = new ChangeChecks(config)
    super({
      goal: (_response, agent) => checks.verify(agent),
      maxAttempts: checks.maxAttempts,
      name: checks.name,
      resumePromptTemplate: retryPrompt,
    })
    this._checks = checks
    this.commands = checks.commands
  }

  /**
   * Outcome of the latest finished request on `agent`, from Verification's own check runs. `undefined` while changes
   * are still unverified (a request in flight, or one carried over after an early stop). A request that ran no check
   * falls back to GoalLoop's result.
   */
  override lastResult(agent: LocalAgent): GoalResult | undefined {
    const result = this._checks.result(agent)
    return result === null ? super.lastResult(agent) : result
  }

  override initAgent(agent: LocalAgent): void {
    // Registered before GoalLoop's on purpose: After* callbacks run in reverse registration order, so the
    // AfterInvocationEvent observer runs after GoalLoop's and sees whether it armed a retry.
    this._checks.observe(agent, (a) => super.lastResult(a))
    super.initAgent(agent)
  }
}
