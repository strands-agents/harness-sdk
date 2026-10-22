import { InterventionHandler } from '../../interventions/handler.js'
import { confirm, proceed, defaultEvaluate } from '../../interventions/actions.js'
import { logger } from '../../logging/logger.js'
import { createDecisionModelRiskClassifier, createLlmRiskClassifier } from './classifier.js'
import type {
  ClassifierResult,
  DecisionModelClassifierConfig,
  HumanInTheLoopClassifier,
  LlmClassifierConfig,
} from './classifier.js'
import type { InterventionAction } from '../../interventions/actions.js'
import type { BeforeToolCallEvent } from '../../hooks/events.js'
import type { JSONValue } from '../../types/json.js'

const TRUST_RESPONSES = new Set(['t', 'trust'])
const TRUSTED_TOOLS_KEY = 'hitl:trustedTools'

/**
 * CLI prompt that reads from stdin.
 * Serializes prompts so concurrent tool calls don't collide on stdin.
 */
function createStdioAsk(includeTrust: boolean): (prompt: string) => Promise<JSONValue> {
  const options = includeTrust ? '(y/n/t)' : '(y/n)'
  let queue: Promise<unknown> = Promise.resolve()

  return (prompt: string) => {
    const task = queue.then(async () => {
      const { createInterface } = await import('node:readline')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      return new Promise<JSONValue>((resolve) => {
        rl.question(`${prompt} ${options}: `, (answer) => {
          rl.close()
          resolve(answer.trim())
        })
      })
    })
    queue = task.catch(() => {})
    return task
  }
}

/**
 * Configuration for the {@link HumanInTheLoop} intervention handler.
 */
export interface HumanInTheLoopConfig {
  /**
   * Tools that can execute WITHOUT human approval.
   *
   * - Use `'*'` to allow all tools.
   * - Prefix with `!` to exclude specific tools (they always require approval).
   *
   * When used with a `classifier`, listed tools bypass classification entirely
   * (fast path). Negated tools still override everything.
   *
   * @example
   * ```typescript
   * // Only readFile and listDir run freely; everything else needs approval
   * { allowedTools: ['readFile', 'listDir'] }
   *
   * // All tools run freely (HITL disabled)
   * { allowedTools: ['*'] }
   *
   * // All tools run freely EXCEPT deleteFile and sendEmail
   * { allowedTools: ['*', '!deleteFile', '!sendEmail'] }
   * ```
   */
  allowedTools?: string[]

  /**
   * Determines how approval decisions are made for tools not in `allowedTools`.
   *
   * - **Omitted / `false`**: all non-allowed tools require approval (default behavior).
   * - **`true`**: uses the built-in LLM risk classifier with defaults.
   * - **Config object** (`{ systemPrompt?, model? }`): built-in LLM classifier with custom settings.
   *   Kept for backwards compatibility; prefer the decision model config for new code.
   * - **Decision model config** (`{ decisionModel, question? }`): asks any `DecisionModel` (e.g.
   *   `LLMDecisionModel`) whether the call requires approval. An `Uncertain` answer requires approval
   *   and carries its reason into the approval prompt; a definite answer carries no reason.
   * - **Custom function**: your own sync or async classification logic.
   */
  classifier?: boolean | LlmClassifierConfig | DecisionModelClassifierConfig | HumanInTheLoopClassifier

  /**
   * When true, trust responses approve the tool AND remember it
   * in `agent.appState` for the rest of the session (won't ask again).
   * Works in both interrupt/resume and inline `ask` modes.
   *
   * Negated tools (`!tool`) cannot be trusted.
   *
   * With a `classifier`, trusting a tool disables argument-level risk
   * classification for that tool name for the rest of the session.
   *
   * Defaults to `false`.
   */
  enableTrust?: boolean

  /**
   * Custom trust response validator. Defaults to accepting `'t'`/`'trust'` (case-insensitive).
   * When this returns true, the tool is approved AND trusted for the session.
   *
   * Only evaluated when `enableTrust` is true.
   */
  evaluateTrust?: (response: JSONValue) => boolean

  /**
   * Custom approval response validator. Defaults to accepting `true`, `'y'`/`'yes'` (case-insensitive).
   */
  evaluate?: (response: JSONValue) => boolean

  /**
   * Controls how the human's response is collected.
   *
   * - **Default** (omitted): uses interrupt/resume — agent pauses, caller resumes with response.
   * - **`'stdio'`**: prompts via CLI readline (Node.js only). Agent blocks inline until human responds.
   * - **Custom function**: your own async prompt logic (Slack, web UI, etc.). Agent blocks inline.
   */
  ask?: ((prompt: string) => Promise<JSONValue>) | 'stdio'
}

/**
 * Human-in-the-loop intervention handler that pauses agent execution
 * before tool calls to request human approval.
 *
 * By default, ALL tools require approval and the agent pauses via interrupt/resume.
 * Use `allowedTools` to whitelist tools that run freely, and `ask` to provide
 * inline prompting (CLI, custom UI).
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'
 *
 * // All tools require approval, agent pauses via interrupt (default)
 * const agent = new Agent({
 *   interventions: [new HumanInTheLoop()],
 * })
 *
 * // readFile runs freely, everything else pauses for approval
 * const agent = new Agent({
 *   interventions: [new HumanInTheLoop({ allowedTools: ['readFile'] })],
 * })
 *
 * // LLM-driven risk classification — only risky calls get escalated
 * const agent = new Agent({
 *   interventions: [new HumanInTheLoop({
 *     allowedTools: ['readFile', 'listDir'],
 *     classifier: true,
 *   })],
 * })
 *
 * // Risk classification via a DecisionModel
 * const agent = new Agent({
 *   interventions: [new HumanInTheLoop({
 *     classifier: { decisionModel: new LLMDecisionModel() },
 *   })],
 * })
 *
 * // CLI mode — prompts in terminal inline
 * const agent = new Agent({
 *   interventions: [new HumanInTheLoop({ ask: 'stdio' })],
 * })
 *
 * // Custom UI — provide your own prompt function
 * const agent = new Agent({
 *   interventions: [new HumanInTheLoop({
 *     ask: async (prompt) => await slackDM(userId, prompt),
 *   })],
 * })
 * ```
 */
export class HumanInTheLoop extends InterventionHandler {
  readonly name = 'strands:human-in-the-loop'

  private readonly _allowedTools: Set<string>
  private readonly _classifier: HumanInTheLoopClassifier | undefined
  private readonly _enableTrust: boolean
  private readonly _evaluateTrust: (response: JSONValue) => boolean
  private readonly _evaluate: ((response: JSONValue) => boolean) | undefined
  private readonly _ask: ((prompt: string) => Promise<JSONValue>) | undefined
  private readonly _classifiedToolUseIds: Set<string> = new Set()

  constructor(config?: HumanInTheLoopConfig) {
    super()
    this._allowedTools = new Set(config?.allowedTools ?? [])
    this._classifier = this._resolveClassifier(config?.classifier)
    if (this._classifier && this._allowedTools.has('*')) {
      logger.warn('classifier has no effect when allowedTools contains "*" — all tools are already allowed')
    }
    this._enableTrust = config?.enableTrust ?? false
    this._evaluateTrust = config?.evaluateTrust ?? ((r: JSONValue): boolean => this._isTrustResponse(r))
    this._evaluate = config?.evaluate
    this._ask = config?.ask === 'stdio' ? createStdioAsk(this._enableTrust) : config?.ask
  }

  override async beforeToolCall(event: BeforeToolCallEvent): Promise<InterventionAction> {
    const toolName = event.toolUse.name

    const classifierResult = await this._requiresApproval(event)
    if (!classifierResult.requiresHumanInTheLoop) {
      return proceed()
    }

    const reason = classifierResult.reason ? ` — ${classifierResult.reason}` : ''
    const input = JSON.stringify(event.toolUse.input)
    const prompt = `Approve "${toolName}"${reason}?\n  Input: ${input}`

    const isNegated = this._allowedTools.has(`!${toolName}`)

    const evaluate = (response: JSONValue): boolean => {
      if (!isNegated && this._enableTrust && this._evaluateTrust(response)) {
        this._trustTool(event, toolName)
        return true
      }
      return this._evaluate ? this._evaluate(response) : defaultEvaluate(response)
    }

    if (!this._ask) {
      return confirm(prompt, { evaluate })
    }

    const response = await this._ask(prompt)

    if (!isNegated && this._enableTrust && this._evaluateTrust(response)) {
      this._trustTool(event, toolName)
      return proceed()
    }

    return confirm(prompt, {
      response,
      evaluate: this._evaluate ?? defaultEvaluate,
    })
  }

  /**
   * Precedence (first match wins):
   * 1. Negated (`!tool`) → always requires approval (cannot be trusted)
   * 2. Trusted at runtime via 't' response (stored in agent.appState) → runs freely
   * 3. Wildcard (`*`) → runs freely
   * 4. Explicitly listed in allowedTools → runs freely
   * 5. Classifier (if provided) → its decision
   * 6. Default (no classifier) → requires approval
   */
  private async _requiresApproval(event: BeforeToolCallEvent): Promise<ClassifierResult> {
    const toolName = event.toolUse.name

    if (this._allowedTools.has(`!${toolName}`)) {
      return { requiresHumanInTheLoop: true }
    }

    const trusted = (event.agent.appState.get(TRUSTED_TOOLS_KEY) as string[] | undefined) ?? []
    if (trusted.includes(toolName)) {
      return { requiresHumanInTheLoop: false }
    }

    if (this._allowedTools.has('*')) return { requiresHumanInTheLoop: false }
    if (this._allowedTools.has(toolName)) return { requiresHumanInTheLoop: false }

    if (this._classifier) {
      const toolUseId = event.toolUse.toolUseId
      if (this._classifiedToolUseIds.has(toolUseId)) {
        return { requiresHumanInTheLoop: true }
      }
      this._classifiedToolUseIds.add(toolUseId)

      try {
        const result = await this._classifier(event)
        if (typeof result?.requiresHumanInTheLoop !== 'boolean') {
          logger.warn(`tool=<${toolName}> | classifier returned malformed result, defaulting to approval required`)
          return { requiresHumanInTheLoop: true }
        }
        return result
      } catch (error) {
        logger.warn(`tool=<${toolName}> | classifier failed, defaulting to approval required`, error)
        return { requiresHumanInTheLoop: true }
      }
    }

    return { requiresHumanInTheLoop: true }
  }

  private _trustTool(event: BeforeToolCallEvent, toolName: string): void {
    const trusted = (event.agent.appState.get(TRUSTED_TOOLS_KEY) as string[] | undefined) ?? []
    if (!trusted.includes(toolName)) {
      event.agent.appState.set(TRUSTED_TOOLS_KEY, [...trusted, toolName])
    }
  }

  private _resolveClassifier(
    classifier: boolean | LlmClassifierConfig | DecisionModelClassifierConfig | HumanInTheLoopClassifier | undefined
  ): HumanInTheLoopClassifier | undefined {
    if (!classifier) return undefined
    if (classifier === true) return createLlmRiskClassifier()
    if (typeof classifier === 'function') return classifier
    if ('decisionModel' in classifier) return createDecisionModelRiskClassifier(classifier)
    return createLlmRiskClassifier(classifier)
  }

  private _isTrustResponse(response: JSONValue): boolean {
    if (typeof response === 'string') return TRUST_RESPONSES.has(response.toLowerCase().trim())
    return false
  }
}
