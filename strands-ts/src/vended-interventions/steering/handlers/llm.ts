/**
 * LLM-based steering handler that uses an LLM to provide contextual guidance.
 */

import { z } from 'zod'
import { Agent } from '../../../agent/agent.js'
import { confirm, guide, proceed, type Confirm, type Guide, type Proceed } from '../../../interventions/actions.js'
import type { Model } from '../../../models/model.js'
import type { ContentBlock, SystemPrompt } from '../../../types/messages.js'
import { CachePointBlock, TextBlock } from '../../../types/messages.js'
import type { ToolUse } from '../../../tools/types.js'
import type { BeforeToolCallEvent } from '../../../hooks/events.js'
import type { SteeringContextData, SteeringContextProvider } from '../providers/context-provider.js'
import { ToolLedgerProvider } from '../providers/tool-ledger.js'
import { SteeringHandler } from './handler.js'

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/**
 * Builds the evaluation prompt sent to the steering LLM.
 * Return a string for simple prompts, or ContentBlock[] to use cache points.
 */
export type PromptBuilder = (context: SteeringContextData[], toolUse?: ToolUse) => string | ContentBlock[]

/**
 * Default prompt builder. Returns content blocks with a cache point
 * between static instructions and dynamic context/event data.
 *
 * See: https://github.com/strands-agents/agent-sop
 */
function defaultPromptBuilder(context: SteeringContextData[], toolUse?: ToolUse): ContentBlock[] {
  const contextStr = context.length > 0 ? JSON.stringify(context, null, 2) : 'No context available'

  const actionType = toolUse ? 'tool call' : 'action'
  const actionTypeTitle = toolUse ? 'Tool Call' : 'Action'
  const eventDescription = toolUse
    ? `Tool: ${toolUse.name}\nArguments: ${JSON.stringify(toolUse.input, null, 2)}`
    : 'General evaluation'

  const hasLedger = context.some((c) => c.type === 'toolLedger')
  const ledgerExplanation = hasLedger
    ? `

### Understanding Ledger Tool States

If the context includes a ledger with tool_calls, the "status" field indicates:

- **"pending"**: The tool is CURRENTLY being evaluated by you (the steering agent).
This is NOT a duplicate call — it's the tool you're deciding whether to approve.
The tool has NOT started executing yet.
- **"success"**: The tool completed successfully in a previous turn
- **"error"**: The tool failed or was cancelled in a previous turn

**IMPORTANT**: When you see a tool with status="pending" that matches the tool you're evaluating,
that IS the current tool being evaluated. It is NOT already executing or a duplicate.`
    : ''

  // Static framing (cached): role, constraints, decision criteria, ledger semantics.
  const instructions = `# Steering Evaluation

## Overview

You are a STEERING AGENT that evaluates a ${actionType} that ANOTHER AGENT is attempting to make.
Your job is to provide contextual guidance to help the other agent navigate workflows effectively.
You act as a safety net that can intervene when patterns in the context data suggest the agent
should try a different approach or get human input.

**YOUR ROLE:**
- Analyze context data for concerning patterns (repeated failures, inappropriate timing, etc.)
- Provide just-in-time guidance when the agent is going down an ineffective path
- Allow normal operations to proceed when context shows no issues

**CRITICAL CONSTRAINTS:**
- Base decisions ONLY on the context data provided
- Do NOT use external knowledge about domains, URLs, or tool purposes
- Do NOT make assumptions about what tools "should" or "shouldn't" do
- Focus ONLY on patterns in the context data${ledgerExplanation}

## Steps

### 1. Analyze the ${actionTypeTitle}

Review ONLY the context data. Look for patterns in the data that indicate:

- Previous failures or successes with this tool
- Frequency of attempts
- Any relevant tracking information

**Constraints:**
- You MUST base analysis ONLY on the provided context data
- You MUST NOT use external knowledge about tool purposes or domains
- You SHOULD identify patterns in the context data
- You MAY reference relevant context data to inform your decision

### 2. Make Steering Decision

**Constraints:**
- You MUST respond with exactly one of: "proceed", "guide", or "confirm"
- You MUST base the decision ONLY on context data patterns
- Your reason will be shown to the AGENT as guidance

**Decision Options:**
- "proceed" if context data shows no concerning patterns
- "guide" if context data shows patterns requiring intervention
- "confirm" if context data shows patterns requiring human input`

  // Dynamic block (uncached): per-call context and event payload.
  const dynamic = `## Context

${contextStr}

## Event to Evaluate

${eventDescription}`

  return [new TextBlock(instructions), new CachePointBlock({ cacheType: 'default' }), new TextBlock(dynamic)]
}

// ---------------------------------------------------------------------------
// LLM steering handler
// ---------------------------------------------------------------------------

/**
 * Configuration for the LLMSteeringHandler.
 */
export interface LLMSteeringHandlerConfig {
  /** System prompt defining the steering guidance rules. */
  systemPrompt: SystemPrompt

  /** Model for steering evaluation. Resolution order: `this model > agent.auxModel > agent.model`. */
  model?: Model

  /** Custom prompt builder for evaluation prompts. Defaults to defaultPromptBuilder. */
  promptBuilder?: PromptBuilder

  /**
   * Context providers for populating steering context.
   * Defaults to [new ToolLedgerProvider()] if undefined. Pass an empty array to disable.
   */
  contextProviders?: SteeringContextProvider[]

  /**
   * Identifier for this handler instance. Defaults to `'strands:llm-steering-handler'`.
   * Override when attaching multiple LLM steering handlers to the same agent.
   */
  name?: string
}

/** Schema returned by the steering LLM. */
const STEERING_DECISION = z.object({
  type: z
    .enum(['proceed', 'guide', 'confirm'])
    .describe(
      "Steering decision: 'proceed' to continue, 'guide' to provide feedback, 'confirm' to pause for human approval"
    ),
  reason: z.string().describe('Clear explanation of the steering decision and any guidance provided'),
})

type SteeringDecision = z.infer<typeof STEERING_DECISION>

/**
 * Steering handler that uses an LLM to provide contextual guidance.
 *
 * Uses natural language prompts to evaluate tool calls and produce an
 * intervention action.
 *
 * Only `beforeToolCall` is implemented — model-output steering is not
 * delegated to the LLM. Subclass and override `afterModelCall` (which
 * carries the narrowed `Proceed | Guide` return) to add LLM-driven
 * evaluation of model responses.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { LLMSteeringHandler } from '@strands-agents/sdk/vended-interventions/steering'
 *
 * const handler = new LLMSteeringHandler({
 *   systemPrompt: `You ensure emails maintain a cheerful, positive tone.`,
 * })
 *
 * const agent = new Agent({ tools: [sendEmail], interventions: [handler] })
 * ```
 */
export class LLMSteeringHandler extends SteeringHandler {
  override readonly name: string

  private readonly _promptBuilder: PromptBuilder
  private readonly _configuredModel: Model | undefined
  private readonly _systemPrompt: SystemPrompt

  constructor(config: LLMSteeringHandlerConfig) {
    const contextProviders =
      config.contextProviders === undefined ? [new ToolLedgerProvider()] : config.contextProviders
    super({ contextProviders })

    this.name = config.name ?? 'strands:llm-steering-handler'
    this._promptBuilder = config.promptBuilder ?? defaultPromptBuilder
    this._configuredModel = config.model
    this._systemPrompt = config.systemPrompt
  }

  override async beforeToolCall(event: BeforeToolCallEvent): Promise<Proceed | Guide | Confirm> {
    const context = this.getSteeringContext()
    const prompt = this._promptBuilder(context, event.toolUse)
    const decision = await this._invoke(prompt, this._configuredModel ?? event.agent.auxModel)

    switch (decision.type) {
      case 'proceed':
        return proceed({ reason: decision.reason })
      case 'guide':
        return guide(decision.reason)
      case 'confirm':
        return confirm(decision.reason, { reason: decision.reason })
    }
  }

  // Constructs a fresh inner agent per call so the handler has no shared
  // mutable state between invocations — this keeps it safe to attach to
  // multiple parent agents (whose tool calls may evaluate concurrently).
  private async _invoke(prompt: string | ContentBlock[], model: Model): Promise<SteeringDecision> {
    const inner = new Agent({
      model,
      systemPrompt: this._systemPrompt,
      structuredOutputSchema: STEERING_DECISION,
      printer: false,
    })
    const result = await inner.invoke(prompt)
    return STEERING_DECISION.parse(result.structuredOutput)
  }
}
