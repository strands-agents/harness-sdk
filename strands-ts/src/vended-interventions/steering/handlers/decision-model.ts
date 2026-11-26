/**
 * Steering handler that asks a {@link DecisionModel} whether to proceed, guide, or confirm a tool call.
 */

import { Agent } from '../../../agent/agent.js'
import { createAuxiliaryInvocationContext } from '../../../agent/invocation-context.js'
import type { DecisionModel } from '../../../decisions/decision-model.js'
import { Uncertain } from '../../../decisions/types.js'
import type { BeforeToolCallEvent } from '../../../hooks/events.js'
import { confirm, guide, proceed, type Confirm, type Guide, type Proceed } from '../../../interventions/actions.js'
import type { Model } from '../../../models/model.js'
import type { ToolUse } from '../../../tools/types.js'
import type { InvokeOptions } from '../../../types/agent.js'
import { TextBlock, type ContentBlock } from '../../../types/messages.js'
import type { SteeringContextData, SteeringContextProvider } from '../providers/context-provider.js'
import { ToolLedgerProvider } from '../providers/tool-ledger.js'
import { SteeringHandler } from './handler.js'
import { DECISION_OPTIONS, formatEvaluationState, ledgerExplanation, type PromptBuilder } from './llm.js'

const STEERING_CHOICES = ['proceed', 'guide', 'confirm'] as const

const DEFAULT_QUESTION = `You are a STEERING AGENT evaluating a tool call that ANOTHER AGENT is attempting to make.
Should the agent proceed, receive guidance to try a different approach, or pause for human confirmation?
Base the decision ONLY on patterns in the context data and the steering rules below.
Do NOT use external knowledge about domains, URLs, or tool purposes.`

const GUIDANCE_INSTRUCTIONS = `# Steering Guidance

A steering check flagged the tool call below as needing intervention under your steering rules.
Write brief, actionable guidance telling the agent what to do instead.
Base it ONLY on the context data and your steering rules.
Respond with the guidance text only — it is shown directly to the agent.`

/** Input passed to a {@link GuidanceBuilder}. */
export interface GuidanceInput {
  /** The tool call the decision model flagged for guidance. */
  toolUse: ToolUse
  /** Snapshots from the handler's context providers. */
  context: SteeringContextData[]
  /** The intercepted event, for access to the agent and its `invocationContext`. */
  event: BeforeToolCallEvent
}

/** Builds the feedback shown to the agent when the decision model answers `'guide'`. */
export type GuidanceBuilder = (input: GuidanceInput) => string | Promise<string>

/**
 * Configuration for the {@link DecisionModelSteeringHandler}.
 */
export interface DecisionModelSteeringHandlerConfig {
  /** Decision model that picks proceed, guide, or confirm for each tool call. */
  decisionModel: DecisionModel

  /** Steering rules the decision is made against, and the system prompt for LLM-written guidance. */
  systemPrompt: string

  /** Framing posed to the decision model ahead of the steering rules. Defaults to a general-purpose steering question. */
  question?: string

  /** Builds the state the decision model evaluates. Defaults to the steering context and tool call as text. */
  promptBuilder?: PromptBuilder

  /**
   * Context providers for populating steering context.
   * Defaults to [new ToolLedgerProvider()] if undefined. Pass an empty array to disable.
   */
  contextProviders?: SteeringContextProvider[]

  /**
   * Feedback shown to the agent when the decision model answers `'guide'`. A decision model returns
   * no reason, so the feedback comes from here:
   * - string: fixed feedback for every guided call.
   * - function: computed per guided call.
   * - omitted: written by an LLM from the steering rules, context, and tool call.
   */
  guidance?: string | GuidanceBuilder

  /** Model that writes guidance when `guidance` is omitted. Resolution order: `this model > agent.auxModel > agent.model`. */
  model?: Model

  /**
   * Identifier for this handler instance. Defaults to `'strands:decision-model-steering-handler'`.
   * Override when attaching multiple decision model steering handlers to the same agent.
   */
  name?: string
}

/**
 * Steering handler that asks a {@link DecisionModel} to steer each tool call.
 *
 * Poses one closed question — proceed, guide, or confirm — over the steering context and the
 * pending tool call. A `'guide'` answer cancels the call with feedback from `guidance`; a
 * `'confirm'` answer pauses for human approval; an `Uncertain` answer proceeds.
 *
 * Only `beforeToolCall` is implemented, matching `LLMSteeringHandler`.
 *
 * @example
 * ```typescript
 * import { Agent, LLMDecisionModel } from '@strands-agents/sdk'
 * import { DecisionModelSteeringHandler } from '@strands-agents/sdk/vended-interventions/steering'
 *
 * const handler = new DecisionModelSteeringHandler({
 *   decisionModel: new LLMDecisionModel(),
 *   systemPrompt: 'Send at most one email per request.',
 *   guidance: 'An email was already sent. Summarize the result for the user instead.',
 * })
 *
 * const agent = new Agent({ tools: [sendEmail], interventions: [handler] })
 * ```
 */
export class DecisionModelSteeringHandler extends SteeringHandler {
  override readonly name: string

  private readonly _decisionModel: DecisionModel
  private readonly _systemPrompt: string
  private readonly _question: string
  private readonly _promptBuilder: PromptBuilder
  private readonly _guidance: string | GuidanceBuilder | undefined
  private readonly _configuredModel: Model | undefined

  constructor(config: DecisionModelSteeringHandlerConfig) {
    const contextProviders =
      config.contextProviders === undefined ? [new ToolLedgerProvider()] : config.contextProviders
    super({ contextProviders })

    this.name = config.name ?? 'strands:decision-model-steering-handler'
    this._decisionModel = config.decisionModel
    this._systemPrompt = config.systemPrompt
    this._question = config.question ?? DEFAULT_QUESTION
    this._promptBuilder = config.promptBuilder ?? formatEvaluationState
    this._guidance = config.guidance
    this._configuredModel = config.model
  }

  override async beforeToolCall(event: BeforeToolCallEvent): Promise<Proceed | Guide | Confirm> {
    const context = this.getSteeringContext()
    const state = this._promptBuilder(context, event.toolUse)
    const result = await this._decisionModel.ask(
      state,
      { decision: { question: this._buildQuestion(context), choices: STEERING_CHOICES } },
      { ...(event.invocationContext && { invocationContext: event.invocationContext }) }
    )
    const answer = result.answers.decision

    if (answer instanceof Uncertain) {
      return proceed(answer.reason !== undefined ? { reason: answer.reason } : undefined)
    }
    switch (answer) {
      case 'proceed':
        return proceed()
      case 'guide':
        return guide(await this._resolveGuidance({ toolUse: event.toolUse, context, event }, state))
      case 'confirm':
        return confirm(`Approve "${event.toolUse.name}"?`)
    }
  }

  private _buildQuestion(context: SteeringContextData[]): string {
    return `${this._question}${ledgerExplanation(context)}\n\n${DECISION_OPTIONS}\n\n## Steering Rules\n\n${this._systemPrompt}`
  }

  private async _resolveGuidance(input: GuidanceInput, state: string | ContentBlock[]): Promise<string> {
    if (typeof this._guidance === 'string') return this._guidance
    if (this._guidance !== undefined) return this._guidance(input)
    return this._writeGuidance(input.event, state)
  }

  // Constructs a fresh inner agent per call so the handler has no shared
  // mutable state between invocations — this keeps it safe to attach to
  // multiple parent agents (whose tool calls may evaluate concurrently).
  private async _writeGuidance(event: BeforeToolCallEvent, state: string | ContentBlock[]): Promise<string> {
    const inner = new Agent({
      model: this._configuredModel ?? event.agent.auxModel,
      systemPrompt: this._systemPrompt,
      printer: false,
    })
    const auxiliaryInvocationContext = createAuxiliaryInvocationContext(event.invocationContext)
    const invokeOptions: InvokeOptions = {
      ...(auxiliaryInvocationContext && { invocationContext: auxiliaryInvocationContext }),
    }
    const result = await inner.invoke(guidancePrompt(state), invokeOptions)
    return result.lastMessage.content
      .filter((block): block is TextBlock => block.type === 'textBlock')
      .map((block) => block.text)
      .join('\n')
  }
}

function guidancePrompt(state: string | ContentBlock[]): string | ContentBlock[] {
  if (typeof state === 'string') return `${GUIDANCE_INSTRUCTIONS}\n\n${state}`
  return [new TextBlock(GUIDANCE_INSTRUCTIONS), ...state]
}
