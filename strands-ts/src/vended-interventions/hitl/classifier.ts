import { z } from 'zod'
import { Agent } from '../../agent/agent.js'
import { createAuxiliaryInvocation } from '../../agent/invocation.js'
import type { InvokeOptions } from '../../types/agent.js'
import type { BeforeToolCallEvent } from '../../hooks/events.js'
import type { Model } from '../../models/model.js'

/**
 * Result from a {@link HumanInTheLoopClassifier}.
 */
export interface ClassifierResult {
  /** Whether the tool call requires human-in-the-loop approval. */
  requiresHumanInTheLoop: boolean
  /** Reason shown to the human in the approval prompt. */
  reason?: string
}

/**
 * Function (sync or async) that decides whether a tool call requires human approval.
 */
export type HumanInTheLoopClassifier = (event: BeforeToolCallEvent) => ClassifierResult | Promise<ClassifierResult>

/**
 * Configuration for the built-in LLM risk classifier (used when `classifier: true`).
 */
export interface LlmClassifierConfig {
  /** System prompt describing risk criteria. Defaults to a general-purpose risk prompt. */
  systemPrompt?: string
  /** Model for risk evaluation. Defaults to the parent agent's model. */
  model?: Model
}

const RISK_DECISION = z.object({
  requiresApproval: z.boolean().describe('Whether this tool call requires human approval before executing'),
  reason: z.string().describe('Brief reason (under 10 words) why approval is or is not required'),
})

const DEFAULT_SYSTEM_PROMPT = `You are a risk evaluator for an AI agent's tool calls. Your job is to decide whether each tool call requires human approval before executing.

## When to require approval

Require approval when the tool call:
- Is destructive or irreversible (deleting data, dropping tables, revoking access)
- Modifies important state in production or shared environments
- Accesses or transmits sensitive data (credentials, PII, financial records)
- Communicates externally (sending emails, posting messages, making payments)
- Has a large blast radius (affecting many records, users, or systems)

## When approval is NOT needed

Do not require approval when the tool call:
- Is read-only AND does not access sensitive data (listing non-sensitive files, querying public data, searching)
- Operates on local or temporary resources
- Has easily reversible effects
- Is scoped to a single non-critical resource

Note: even read-only operations that access credentials, secrets, PII, or financial data still require approval.

## Instructions

Evaluate the tool name and its input arguments. Consider what could go wrong if this specific call executes with these specific arguments. When uncertain, require approval.

Keep your reason under 10 words — it is shown to a human in a CLI prompt.`

/**
 * Creates the built-in LLM risk classifier used when `classifier: true`.
 *
 * @internal
 * @param config - Optional configuration for the classifier.
 * @returns A classifier function that uses an inner LLM agent to evaluate risk.
 */
export function createLlmRiskClassifier(config?: LlmClassifierConfig): HumanInTheLoopClassifier {
  const systemPrompt = config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  const configuredModel = config?.model

  return async (event: BeforeToolCallEvent): Promise<ClassifierResult> => {
    const model = configuredModel ?? event.agent.model
    if (!model) {
      throw new Error(
        'LLM risk classifier has no model — pass `model` in `classifier: { model }`, or ensure the parent agent has a model.'
      )
    }

    const inner = new Agent({
      model,
      systemPrompt,
      structuredOutputSchema: RISK_DECISION,
      printer: false,
    })

    const prompt = `Should this tool call require human approval?\n\nTool: ${event.toolUse.name}\nInput: ${JSON.stringify(event.toolUse.input, null, 2)}`
    // Fold the classifier's tokens into the request total without limiting this
    // auxiliary call by the request's limits.
    const auxiliaryInvocation = createAuxiliaryInvocation(event.invocation)
    const invokeOptions: InvokeOptions = {
      ...(auxiliaryInvocation && { invocation: auxiliaryInvocation }),
    }
    const result = await inner.invoke(prompt, invokeOptions)
    const decision = RISK_DECISION.parse(result.structuredOutput)

    return {
      requiresHumanInTheLoop: decision.requiresApproval,
      reason: decision.reason,
    }
  }
}
