import { z } from 'zod'
import { Agent } from '../../agent/agent.js'
import { createAuxiliaryInvocationContext } from '../../agent/invocation-context.js'
import { Uncertain } from '../../decisions/types.js'
import type { DecisionModel } from '../../decisions/decision-model.js'
import type { InvokeOptions } from '../../types/agent.js'
import type { BeforeToolCallEvent } from '../../hooks/events.js'
import type { Model } from '../../models/model.js'

/**
 * Result from a {@link HumanInTheLoopClassifier}.
 */
export interface ClassifierResult {
  /** Whether the tool call requires human-in-the-loop approval. */
  requiresHumanInTheLoop: boolean
  /** Block the tool call without asking a human. Takes precedence over `requiresHumanInTheLoop`. */
  deny?: boolean
  /** Reason shown to the human in the approval prompt, or to the model when the call is denied. */
  reason?: string
}

/**
 * Function (sync or async) that decides whether a tool call runs, is denied, or requires human approval.
 */
export type HumanInTheLoopClassifier = (event: BeforeToolCallEvent) => ClassifierResult | Promise<ClassifierResult>

/**
 * Configuration for the built-in LLM risk classifier (used when `classifier: true`).
 */
export interface LlmClassifierConfig {
  /** System prompt describing risk criteria. Defaults to a general-purpose risk prompt. */
  systemPrompt?: string
  /** Model for risk evaluation. Resolution order: `this model > agent.auxModel > agent.model`. */
  model?: Model
}

/**
 * Configuration for a {@link DecisionModel}-backed risk classifier.
 */
export interface DecisionModelClassifierConfig {
  /** Decision model that chooses whether a tool call is approved, denied, or escalated to a human. */
  decisionModel: DecisionModel
  /** Question posed to the decision model. Defaults to a general-purpose risk question. */
  question?: string
}

const RISK_DECISIONS = ['approve', 'deny', 'escalate'] as const

type RiskDecision = (typeof RISK_DECISIONS)[number]

const DECISION_RESULTS: Record<RiskDecision, ClassifierResult> = {
  approve: { requiresHumanInTheLoop: false },
  deny: { requiresHumanInTheLoop: false, deny: true },
  escalate: { requiresHumanInTheLoop: true },
}

const RISK_DECISION = z.object({
  decision: z
    .enum(RISK_DECISIONS)
    .describe('approve: run without approval; escalate: ask a human for approval; deny: block without asking a human'),
  reason: z.string().describe('Brief reason (under 10 words) for the decision'),
})

const RISK_CRITERIA = `## Deny

Deny the tool call, without asking a human, only when no reasonable human would approve it:
- Is destructive at a scale no task justifies (wiping a filesystem root, dropping every database)
- Sends credentials, secrets, or PII to an external or unknown destination
- Contains obfuscated or encoded commands whose effect cannot be determined from the arguments

## Escalate

Ask a human for approval when the tool call:
- Is destructive or irreversible (deleting data, dropping tables, revoking access)
- Modifies important state in production or shared environments
- Accesses or transmits sensitive data (credentials, PII, financial records)
- Communicates externally (sending emails, posting messages, making payments)
- Has a large blast radius (affecting many records, users, or systems)

## Approve

Run the tool call without approval when it:
- Is read-only AND does not access sensitive data (listing non-sensitive files, querying public data, searching)
- Operates on local or temporary resources
- Has easily reversible effects
- Is scoped to a single non-critical resource

Note: even read-only operations that access credentials, secrets, PII, or financial data still require escalation.`

const DEFAULT_SYSTEM_PROMPT = `You are a risk evaluator for an AI agent's tool calls. Your job is to decide whether each tool call is approved, escalated to a human for approval, or denied.

${RISK_CRITERIA}

## Instructions

Evaluate the tool name and its input arguments. Consider what could go wrong if this specific call executes with these specific arguments. When uncertain whether to approve, escalate. When uncertain whether to deny, escalate.

Keep your reason under 10 words — it is shown to a human in a CLI prompt, or to the agent when the call is denied.`

const DEFAULT_RISK_QUESTION = `Should this AI agent tool call be approved, escalated to a human for approval, or denied? Consider what could go wrong if this specific call executes with these specific arguments. When uncertain, escalate.

${RISK_CRITERIA}`

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
    const model = configuredModel ?? event.agent.auxModel
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

    const prompt = `Should this tool call be approved, escalated, or denied?\n\n${formatToolCall(event)}`
    const auxiliaryInvocationContext = createAuxiliaryInvocationContext(event.invocationContext)
    const invokeOptions: InvokeOptions = {
      ...(auxiliaryInvocationContext && { invocationContext: auxiliaryInvocationContext }),
    }
    const result = await inner.invoke(prompt, invokeOptions)
    const decision = RISK_DECISION.parse(result.structuredOutput)

    return toClassifierResult(decision.decision, decision.reason)
  }
}

/**
 * Creates a risk classifier that asks a {@link DecisionModel} whether a tool call is approved,
 * denied, or escalated to a human. An `Uncertain` answer escalates.
 *
 * @internal
 * @param config - Decision model and optional question override.
 * @returns A classifier function backed by the decision model.
 */
export function createDecisionModelRiskClassifier(config: DecisionModelClassifierConfig): HumanInTheLoopClassifier {
  const { decisionModel } = config
  const question = config.question ?? DEFAULT_RISK_QUESTION

  return async (event: BeforeToolCallEvent): Promise<ClassifierResult> => {
    const result = await decisionModel.ask(formatToolCall(event), {
      decision: { question, choices: RISK_DECISIONS },
    })
    const answer = result.answers.decision

    if (answer instanceof Uncertain) return toClassifierResult('escalate', answer.reason)
    return toClassifierResult(answer)
  }
}

function toClassifierResult(decision: RiskDecision, reason?: string): ClassifierResult {
  return { ...DECISION_RESULTS[decision], ...(reason !== undefined && { reason }) }
}

function formatToolCall(event: BeforeToolCallEvent): string {
  return `Tool: ${event.toolUse.name}\nInput: ${JSON.stringify(event.toolUse.input, null, 2)}`
}
