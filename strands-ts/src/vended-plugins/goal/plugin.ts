/**
 * Iterative-refinement plugin for Strands agents
 * Validates the agent's response after each invocation; if it doesn't
 * satisfy the goal, feeds validator feedback back as a user message and re-enters the
 * agent loop via `AfterInvocationEvent.resume`. Loops until validation passes,
 * `maxAttempts` is reached, `timeout` elapses, or the request hits one of its `limits`.
 *
 * @example
 * ```ts
 * import { Agent } from '@strands-agents/sdk'
 * import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal'
 *
 * // Natural-language goal — judged by an internal Agent built from the host's model.
 * const concise = new GoalLoop({
 *   goal: 'At most 3 sentences, accessible to a 10-year-old, no jargon.',
 *   maxAttempts: 3,
 * })
 * const agent = new Agent({ model, plugins: [concise] })
 * await agent.invoke('Explain how rainbows form.')
 * console.log(concise.lastResult(agent))
 * ```
 *
 * @example
 * ```ts
 * // Programmatic validator — pass a function as `goal` to run your own check
 * // (here, a word-count cap).
 * const wordCount = new GoalLoop({
 *   goal: (response) => {
 *     const text = response.content.flatMap((b) => (b.type === 'textBlock' ? [b.text] : [])).join(' ')
 *     const words = text.trim().split(/\s+/).length
 *     return words <= 50 || { passed: false, feedback: `Too long (${words} words). Cap at 50.` }
 *   },
 *   maxAttempts: 5,
 *   timeout: 30_000,
 * })
 * ```
 *
 * @example
 * ```ts
 * // Toolchain-driven validator — runs `npm test` after each attempt and gates
 * // on exit code (a Ralph-shaped use). Pair with file-editor / bash tools so the
 * // agent can actually fix what the test runner reports.
 * import { exec } from 'node:child_process'
 * import { promisify } from 'node:util'
 * const execAsync = promisify(exec)
 *
 * new GoalLoop({
 *   goal: async () => {
 *     try {
 *       await execAsync('npm test')
 *       return true
 *     } catch (err) {
 *       const e = err as { stdout?: string; stderr?: string; code?: number }
 *       const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(-4000)
 *       return { passed: false, feedback: `npm test exited ${e.code}.\n\n${out}` }
 *     }
 *   },
 *   maxAttempts: 10,
 * })
 * ```
 */

import { Agent } from '../../agent/agent.js'
import { createAuxiliaryInvocation, reachedLimit, toInternal, type Invocation } from '../../agent/invocation.js'
import { AfterInvocationEvent, BeforeInvocationEvent, BeforeModelCallEvent } from '../../hooks/events.js'
import { logger } from '../../logging/logger.js'
import { warnOnce } from '../../logging/warn-once.js'
import type { Model } from '../../models/model.js'
import type { Plugin } from '../../plugins/plugin.js'
import type { InvokeOptions, LocalAgent } from '../../types/agent.js'
import type { ContentBlock, Message } from '../../types/messages.js'
import type { Snapshot } from '../../types/snapshot.js'
import { JUDGE_OUTCOME_SCHEMA, JUDGE_SYSTEM_PROMPT, buildJudgePrompt } from './judge.js'

/** Outcome a validator returns. */
export interface ValidationOutcome {
  passed: boolean
  /** Feedback fed to the agent as a user message before the next attempt. */
  feedback?: string
}

/**
 * Programmatic validator. Must return `true`, `false`, or a `ValidationOutcome`.
 * Booleans are shorthand: `true` → pass, `false` → fail with no feedback. Use
 * the object form when you have actionable feedback for the next attempt.
 *
 * The second argument is the host agent — read `agent.messages` for the full
 * transcript (the same view the built-in NL judge sees), or any other state
 * the validator needs.
 */
export type Validator = (
  response: Message,
  agent: LocalAgent
) => boolean | ValidationOutcome | Promise<boolean | ValidationOutcome>

/** Why a goal run ended. `'limit'` means the request hit one of its `limits`, so no further attempt could run. */
export type GoalStopReason = 'satisfied' | 'maxAttempts' | 'timeout' | 'limit'

/** Single attempt summary preserved on `GoalResult`. */
export interface GoalAttempt {
  /** 1-indexed attempt number. */
  attempt: number
  passed: boolean
  feedback?: string
}

/** Aggregate result of a goal run, exposed via `GoalLoop.lastResult`. */
export interface GoalResult {
  passed: boolean
  stopReason: GoalStopReason
  attempts: readonly GoalAttempt[]
}

/**
 * Tuning for the auto-built judge used when {@link GoalLoopOptions.goal} is a
 * natural-language string. Harmlessly ignored when `goal` is a validator
 * function — no judge is built in that case.
 */
export interface JudgeConfig {
  /**
   * Model the judge agent uses. Defaults to the host agent's model. Consider
   * passing a cheaper or faster model (e.g. Haiku) to keep judging cheap.
   */
  model?: Model
  /**
   * System prompt for the judge agent. Defaults to {@link JUDGE_SYSTEM_PROMPT}.
   * Override to retune the judging rubric, localize the instructions, or
   * tighten/relax the pass criteria.
   */
  systemPrompt?: string
}

/**
 * Configuration for {@link GoalLoop}.
 */
export interface GoalLoopOptions {
  /**
   * What "done" means for this loop. Either:
   *
   * - a **natural-language goal** (`string`) — an internal judge Agent grades
   *   each attempt against it and returns feedback on failure; or
   * - a **programmatic validator** ({@link Validator}) — your own predicate that
   *   inspects the response (and host agent) and returns pass/fail plus optional
   *   feedback.
   */
  goal: string | Validator
  /** Tuning for the auto-built judge used when `goal` is a natural-language string. */
  judge?: JudgeConfig
  /** Max attempts. Defaults to `Infinity`. `warnOnce` when both this and `timeout` are unbounded. */
  maxAttempts?: number
  /**
   * Wall-clock budget for the whole run, in ms. Defaults to `Infinity`.
   * Checked between attempts (after each `AfterInvocationEvent`), so an
   * in-flight invocation isn't interrupted mid-stream — actual wall-clock
   * may exceed this by one attempt's duration.
   */
  timeout?: number
  /**
   * Plugin name. Defaults to `'strands:goal-loop'`. Only one goal-loop plugin
   * is supported per agent; if you need multiple constraints, compose them in
   * a single validator function rather than attaching multiple instances.
   */
  name?: string
  /**
   * Whether to preserve the agent's conversation history across retry attempts.
   *
   * When `true` (default), the agent sees its own prior responses and the
   * validator's feedback messages — use when prior attempts inform the next.
   *
   * When `false` (Ralph-Wiggum mode), each failed attempt restores the agent's
   * full model-visible session (messages, systemPrompt, modelState, interrupts)
   * to the state captured immediately before attempt 1's first model call,
   * then re-runs the goal with the latest validator feedback as a fresh user
   * message. The snapshot is taken *after* any conversation manager or other
   * pre-model hook has run, so retries restore to what the model actually saw,
   * not the raw user input. The agent never sees its own prior attempts —
   * including via server-side conversation chaining (e.g. OpenAI's
   * `previous_response_id`). Only `appState` accumulates across attempts,
   * since that's plugin scratch space invisible to the model.
   *
   * @defaultValue true
   */
  preserveContext?: boolean
  /**
   * Builds the user message fed to the agent before each retry. Receives the
   * trimmed validator feedback (or `undefined` if the validator gave none).
   * Override to localize the default English, retune the framing, or embed
   * feedback in a domain-specific structure. Return a string for plain text or
   * a `ContentBlock[]` to mix in non-text content (e.g. an image block).
   */
  resumePromptTemplate?: (feedback: string | undefined) => string | ContentBlock[]
}

/**
 * Single source of truth for an in-progress or just-finished goal run.
 *
 * - `result` undefined → run is mid-flight; `lastResult` returns undefined.
 * - `result` set → run terminated with that outcome; survives until the next
 *   top-level invoke, when the Before hook clears the run.
 * - `resumed` true between After arming `event.resume` and the next Before
 *   consuming it; lets Before tell a continuation from a fresh invoke.
 */
interface RunState {
  startTime: number
  attempts: GoalAttempt[]
  result?: GoalResult
  resumed?: boolean
  /**
   * Set on attempt 1 when `preserveContext` is `false`. Captures the full
   * model-visible session (messages, systemPrompt, modelState, interrupts) and
   * is restored before each retry so the agent — and any server-side stateful
   * model — sees the original input and nothing else. `appState` is excluded
   * deliberately: it's plugin scratch space invisible to the model, and other
   * plugins (rate-limiters, cost-trackers, custom counters) rely on their
   * mutations surviving across attempts.
   */
  initialSnapshot?: Snapshot
}

/**
 * Tracks which agents already have a GoalLoop attached so a second attachment
 * fails loudly instead of silently overwriting `event.resume` on every After
 * hook (last-writer-wins). Note: this is per-agent, not per-plugin-instance —
 * one GoalLoop instance can be shared across multiple agents.
 */
const agentsWithGoalLoop = new WeakSet<LocalAgent>()

/**
 * Iterative-refinement plugin. A single `GoalLoop` instance can be attached to
 * multiple `Agent`s; per-agent run state is keyed off the agent, so concurrent
 * runs on different agents don't interfere. Only one GoalLoop is supported per
 * individual agent — see {@link agentsWithGoalLoop}.
 */
export class GoalLoop implements Plugin {
  readonly name: string

  /** Set when a programmatic validator was supplied as `goal`; mutually exclusive with `_goal`. */
  private readonly _validator?: Validator
  /** Set when a natural-language goal string was supplied; mutually exclusive with `_validator`. */
  private readonly _goal?: string
  private readonly _judgeModel?: Model
  private readonly _judgeSystemPrompt: string
  private readonly _maxAttempts: number
  private readonly _timeout: number
  private readonly _preserveContext: boolean
  private readonly _resumePromptTemplate: (feedback: string | undefined) => string | ContentBlock[]
  /** Per-agent run state. Keyed by agent so one plugin instance can serve many. */
  private readonly _runs = new WeakMap<LocalAgent, RunState>()

  constructor(opts: GoalLoopOptions) {
    if (opts.goal === undefined) {
      throw new Error('GoalLoop: `goal` is required (a natural-language string or a validator function)')
    }
    if ((opts.maxAttempts ?? Infinity) < 1) {
      throw new Error(`maxAttempts=<${opts.maxAttempts}> | must be at least 1`)
    }
    if ((opts.timeout ?? Infinity) < 1) {
      throw new Error(`timeout=<${opts.timeout}> | must be at least 1`)
    }
    this.name = opts.name ?? 'strands:goal-loop'
    if (typeof opts.goal === 'string') this._goal = opts.goal
    else this._validator = opts.goal
    if (opts.judge?.model !== undefined) this._judgeModel = opts.judge.model
    this._judgeSystemPrompt = opts.judge?.systemPrompt ?? JUDGE_SYSTEM_PROMPT
    this._maxAttempts = opts.maxAttempts ?? Infinity
    this._timeout = opts.timeout ?? Infinity
    this._preserveContext = opts.preserveContext ?? true
    this._resumePromptTemplate = opts.resumePromptTemplate ?? defaultResumePrompt
    if (this._maxAttempts === Infinity && this._timeout === Infinity) {
      warnOnce(logger, `${this.name} has no maxAttempts or timeout; execution is unbounded`)
    }
  }

  /**
   * Result of the most recent completed run on `agent`, or `undefined` if no
   * run has finished on that agent since this plugin was constructed. Reads
   * while a run is in-flight, or after a thrown invoke that left a run
   * half-finished, return `undefined` rather than stale data — the previous
   * run's snapshot is dropped on the next invoke.
   */
  lastResult(agent: LocalAgent): GoalResult | undefined {
    return this._runs.get(agent)?.result
  }

  initAgent(agent: LocalAgent): void {
    // Two GoalLoops on the same agent both register an AfterInvocationEvent
    // hook and both write `event.resume` — last writer wins, so one's feedback
    // would be silently dropped. Compose constraints in a single validator
    // function instead.
    if (agentsWithGoalLoop.has(agent)) {
      throw new Error(
        `${this.name}: another GoalLoop is already attached to this agent; only one GoalLoop is supported per agent`
      )
    }
    agentsWithGoalLoop.add(agent)
    const validator = this._buildValidator(agent)

    // Tells the next After call whether to start a fresh run or continue the
    // current one. Clears stale state from a prior invoke that threw mid-run,
    // and starts a fresh RunState so later hooks (BeforeModelCall, After) can
    // attach to it without each having to lazy-create.
    agent.addHook(BeforeInvocationEvent, () => {
      const existing = this._runs.get(agent)
      if (existing?.resumed) {
        existing.resumed = false
        return
      }
      this._runs.set(agent, { startTime: Date.now(), attempts: [] })
    })

    // On attempt 1 only, snapshot the model-visible session while
    // messages = [user: input] (no assistant turn yet) so retries restore to
    // that exact state. `state` (appState) is excluded deliberately: it's
    // plugin scratch space invisible to the model, and other plugins
    // (rate-limiters, cost-trackers, custom counters) rely on their mutations
    // surviving across attempts. Everything else in the `session` preset
    // (messages, systemPrompt, modelState, interrupts) is what the model sees
    // — including via server-side chaining like OpenAI's `previous_response_id`
    // stashed in `modelState` — so all of it must rewind for Ralph mode to
    // actually hide prior attempts from the model.
    if (!this._preserveContext) {
      agent.addHook(BeforeModelCallEvent, () => {
        const run = this._runs.get(agent)
        if (run && !run.initialSnapshot) {
          run.initialSnapshot = agent.takeSnapshot({ preset: 'session', exclude: ['state'] })
        }
      })
    }

    // Validates the assistant's reply, terminates the run on pass / budget
    // exhausted, or arms `event.resume` with feedback for another attempt.
    agent.addHook(AfterInvocationEvent, async (event) => {
      const run = this._runs.get(agent)
      // Defensive: BeforeInvocationEvent always creates a run before this hook
      // fires under normal operation.
      if (!run) return

      // `startTime` is wall-clock for the whole run, not per-attempt — the
      // budget caps total time including the agent invocations between
      // attempts. Checked before validation so an expensive validator
      // (e.g. a judge agent) can't blow the budget.
      if (Date.now() - run.startTime >= this._timeout) {
        finishRun(run, 'timeout')
        return
      }

      // Cancelled or model-threw before emitting an assistant message.
      const response = lastAssistantMessage(agent.messages)
      if (!response) return

      const attemptNumber = run.attempts.length + 1

      let outcome: ValidationOutcome
      try {
        outcome = await validator(response, event.invocation)
      } catch (validatorError) {
        // Surface validator throws so a buggy validator (e.g. a TypeError that
        // fails identically on every attempt) is visible in logs rather than
        // silently burning the attempt budget.
        logger.warn(`${this.name}: validator threw: ${(validatorError as Error).message}`)
        outcome = { passed: false, feedback: `Validator error: ${(validatorError as Error).message}` }
      }

      run.attempts.push({
        attempt: attemptNumber,
        passed: outcome.passed,
        ...(outcome.feedback !== undefined && { feedback: outcome.feedback }),
      })

      if (outcome.passed) {
        finishRun(run, 'satisfied')
        return
      }
      if (attemptNumber >= this._maxAttempts) {
        finishRun(run, 'maxAttempts')
        return
      }
      // A retry would stop at once on the request's limit, so keep this attempt instead of rolling it back.
      const invocation = toInternal(event.invocation)
      if (invocation && reachedLimit(invocation)) {
        finishRun(run, 'limit')
        return
      }

      if (run.initialSnapshot) {
        agent.loadSnapshot(run.initialSnapshot)
      }
      event.resume = this._resumePromptTemplate(outcome.feedback?.trim())
      run.resumed = true
    })
  }

  /**
   * Compiles the configured `goal` (a natural-language string or a `Validator`
   * function) into the canonical `(response) => Promise<ValidationOutcome>`
   * shape used by the After hook. The string path builds a fresh judge `Agent`
   * per call so prior judgements' prompts don't leak into the next judgement's
   * context.
   */
  private _buildValidator(
    hostAgent: LocalAgent
  ): (response: Message, invocation?: Invocation) => Promise<ValidationOutcome> {
    const validator = this._validator
    if (validator) {
      return async (response) => {
        const outcome = await validator(response, hostAgent)
        if (typeof outcome === 'boolean') return { passed: outcome }
        return outcome
      }
    }
    // Constructor guarantees exactly one of `_validator` / `_goal` is set.
    const goalDescription = this._goal!
    // The NL judge intentionally ignores the `response` argument — its prompt
    // includes the full host transcript (via `buildJudgePrompt`) so the judge
    // can evaluate against context, not just the last assistant turn.
    return async (_response, invocation) => {
      const judge = new Agent({
        model: this._judgeModel ?? hostAgent.model,
        printer: false,
        systemPrompt: this._judgeSystemPrompt,
      })
      // Fold the judge's tokens into the request total without limiting this
      // auxiliary call by the request's limits.
      const auxiliaryInvocation = createAuxiliaryInvocation(invocation)
      const invokeOptions: InvokeOptions = {
        structuredOutputSchema: JUDGE_OUTCOME_SCHEMA,
        ...(auxiliaryInvocation && { invocation: auxiliaryInvocation }),
      }
      const judgeResult = await judge.invoke(buildJudgePrompt(goalDescription, hostAgent.messages), invokeOptions)
      return (
        (judgeResult.structuredOutput as ValidationOutcome | undefined) ?? {
          passed: false,
          feedback: 'Judge produced no structured outcome.',
        }
      )
    }
  }
}

function finishRun(run: RunState, stopReason: GoalStopReason): void {
  run.result = {
    passed: stopReason === 'satisfied',
    stopReason,
    attempts: run.attempts.slice(),
  }
  run.resumed = false
}

function defaultResumePrompt(feedback: string | undefined): string {
  if (!feedback) {
    return 'Your previous attempt did not satisfy the goal. Produce a new, corrected response that fully satisfies it — do not restate or lightly edit the previous attempt.'
  }
  return `Your previous attempt did not satisfy the goal.

Feedback on what was wrong:
${feedback}

Address every point above and produce a new, corrected response that fully satisfies the goal. Do not restate or lightly edit the previous attempt — fix the specific problems called out.`
}

/** `undefined` when the invocation was cancelled before the model replied. */
function lastAssistantMessage(messages: readonly Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') return messages[i]
  }
  return undefined
}
