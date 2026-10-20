import { z } from 'zod'
import { Agent } from '../../agent/agent.js'
import { createAuxiliaryInvocationContext } from '../../agent/invocation-context.js'
import { Uncertain } from '../../decisions/types.js'
import type { DecisionModel } from '../../decisions/decision-model.js'
import type { InvokeOptions } from '../../types/agent.js'
import type { BeforeToolCallEvent } from '../../hooks/events.js'
import type { Model } from '../../models/model.js'

/**
 * How a classifier handles a tool call: `approve` runs it, `escalate` asks a human,
 * and `deny` blocks it without asking a human.
 */
export type ClassifierDecision = 'approve' | 'deny' | 'escalate'

/**
 * Decision returned by a {@link HumanInTheLoopClassifier}.
 */
export interface ClassifierDecisionResult {
  /** How the tool call is handled. */
  decision: ClassifierDecision
  /** Reason shown to the human in the approval prompt, or to the model when the call is denied. */
  reason?: string
}

/**
 * Boolean result returned by a {@link HumanInTheLoopClassifier}.
 *
 * @deprecated Return a {@link ClassifierDecisionResult} instead. `requiresHumanInTheLoop: true`
 * is equivalent to `decision: 'escalate'`, and `false` to `decision: 'approve'`.
 */
export interface LegacyClassifierResult {
  /** Whether the tool call requires human-in-the-loop approval. */
  requiresHumanInTheLoop: boolean
  /** Reason shown to the human in the approval prompt. */
  reason?: string
}

/**
 * Result from a {@link HumanInTheLoopClassifier}.
 */
export type ClassifierResult = ClassifierDecisionResult | LegacyClassifierResult

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

const CLASSIFIER_DECISIONS = ['approve', 'deny', 'escalate'] as const satisfies readonly ClassifierDecision[]

const RISK_DECISION = z.object({
  decision: z
    .enum(CLASSIFIER_DECISIONS)
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

  return async (event: BeforeToolCallEvent): Promise<ClassifierDecisionResult> => {
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

    return { decision: decision.decision, reason: decision.reason }
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

  return async (event: BeforeToolCallEvent): Promise<ClassifierDecisionResult> => {
    const result = await decisionModel.ask(formatToolCall(event), {
      decision: { question, choices: CLASSIFIER_DECISIONS },
    })
    const answer = result.answers.decision

    if (answer instanceof Uncertain) {
      return { decision: 'escalate', ...(answer.reason !== undefined && { reason: answer.reason }) }
    }
    return { decision: answer }
  }
}

/**
 * Normalizes a classifier's return value, including the deprecated boolean shape.
 *
 * @internal
 * @param result - Value returned by a classifier.
 * @returns The decision, or `undefined` when the result is malformed.
 */
export function normalizeClassifierResult(result: unknown): ClassifierDecisionResult | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const { decision, requiresHumanInTheLoop, reason } = result as Record<string, unknown>
  const resolved = isClassifierDecision(decision) ? decision : legacyDecision(requiresHumanInTheLoop)
  if (resolved === undefined) return undefined
  return { decision: resolved, ...(typeof reason === 'string' && { reason }) }
}

function isClassifierDecision(value: unknown): value is ClassifierDecision {
  return (CLASSIFIER_DECISIONS as readonly unknown[]).includes(value)
}

function legacyDecision(requiresHumanInTheLoop: unknown): ClassifierDecision | undefined {
  if (typeof requiresHumanInTheLoop !== 'boolean') return undefined
  return requiresHumanInTheLoop ? 'escalate' : 'approve'
}

function formatToolCall(event: BeforeToolCallEvent): string {
  return `Tool: ${event.toolUse.name}\nInput: ${JSON.stringify(event.toolUse.input, null, 2)}`
}
