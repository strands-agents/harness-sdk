/**
 * Internal continuation handling for agent invocations.
 *
 * Coordinates continuation inputs contributed by hooks, including preparation,
 * interrupt deferral, input combination, and append or abandonment callbacks.
 */

import { AfterInvocationEvent, BeforeModelCallEvent } from '../hooks/events.js'
import { logger } from '../logging/logger.js'

import type { InvokeArgs, LocalAgent } from '../types/agent.js'
import type { Message, StopReason } from '../types/messages.js'

/**
 * One internal input contribution to an agent or model invocation.
 *
 * When both callbacks are supplied, exactly one runs once. Callback failures
 * are logged and do not change the agent result.
 */
interface ContinuationInput {
  /** Input that normalizes to one or more complete messages. */
  readonly args: InvokeArgs
  /** Runs after the input is incorporated into agent history. */
  readonly onAppended?: () => void | Promise<void>
  /** Runs when the input cannot be incorporated into agent history. */
  readonly onAbandoned?: (reason: unknown) => void | Promise<void>
}

interface ContinuationState {
  readonly inputs: ContinuationInput[]
  readonly messages?: readonly Message[]
}

const stateByEvent = new WeakMap<AfterInvocationEvent | BeforeModelCallEvent, ContinuationState>()
const deferredInputsByAgent = new WeakMap<LocalAgent, ContinuationInput[]>()

/**
 * Internal continuation operations used by the agent loop.
 *
 * @internal
 */
export const continuations = {
  abandon,
  addInput,
  combine,
  markAppended,
  prepare,
}

/**
 * Adds an input contribution for an invocation event.
 *
 * @param event - Event that owns the continuation input.
 * @param input - Input and optional settlement callbacks to register.
 */
function addInput(event: AfterInvocationEvent | BeforeModelCallEvent, input: ContinuationInput): void {
  const state = stateByEvent.get(event) ?? { inputs: [] }
  state.inputs.push(input)
  stateByEvent.set(event, state)
}

/**
 * Normalizes the inputs registered for an event and prepares those that form complete message sequences.
 *
 * @param event - Event whose continuation inputs should be prepared.
 * @param normalizeInput - Converts invocation input into messages.
 * @param stopReason - Stop reason that determines whether inputs can continue now or must be deferred.
 * @returns The prepared messages, or `undefined` when no continuation is ready.
 */
async function prepare(
  event: AfterInvocationEvent | BeforeModelCallEvent,
  normalizeInput: (args: InvokeArgs) => Message[],
  stopReason?: StopReason
): Promise<readonly Message[] | undefined> {
  if (stopReason === 'interrupt') {
    const inputs = consumeInputs(event)
    if (inputs.length > 0) {
      deferredInputsByAgent.set(event.agent, [...(deferredInputsByAgent.get(event.agent) ?? []), ...inputs])
    }
    return undefined
  }
  if (stopReason !== undefined && stopReason !== 'endTurn' && stopReason !== 'stopSequence') return undefined

  const deferredInputs = event instanceof AfterInvocationEvent ? deferredInputsByAgent.get(event.agent) : undefined
  if (deferredInputs) deferredInputsByAgent.delete(event.agent)
  const inputs = [...(deferredInputs ?? []), ...(stateByEvent.get(event)?.inputs ?? [])]
  const acceptedInputs: ContinuationInput[] = []
  const messages: Message[] = []

  for (const input of inputs) {
    try {
      const normalized = normalizeInput(input.args)
      if (!isCompleteMessageInput(normalized)) {
        throw new TypeError('Continuation input must contain a complete message sequence')
      }
      messages.push(...normalized)
      acceptedInputs.push(input)
    } catch (error) {
      await notifyAbandoned(input, error)
    }
  }

  if (acceptedInputs.length === 0) {
    stateByEvent.delete(event)
    return undefined
  }

  stateByEvent.set(event, { inputs: acceptedInputs, messages })
  return messages
}

/**
 * Prepends prepared continuation messages to invocation input.
 *
 * @param event - Event whose prepared messages should be applied.
 * @param args - Invocation input to combine with the prepared messages.
 * @param normalizeInput - Converts invocation input into messages.
 * @returns The combined input, or the original input when no prepared messages can be applied.
 */
function combine(
  event: AfterInvocationEvent | BeforeModelCallEvent | undefined,
  args: InvokeArgs,
  normalizeInput: (args: InvokeArgs) => Message[]
): InvokeArgs {
  const messages = event ? stateByEvent.get(event)?.messages : undefined
  if (!messages) return args

  const publicMessages = normalizeInput(args)
  const emptyInput = Array.isArray(args) && args.length === 0
  if (publicMessages.length === 0 && !emptyInput) {
    return args
  }

  return [...messages, ...publicMessages]
}

/**
 * Marks prepared inputs as incorporated into agent history.
 *
 * @param event - Event whose prepared inputs were appended.
 * @returns A promise that resolves after append callbacks finish.
 */
async function markAppended(event: AfterInvocationEvent | BeforeModelCallEvent | undefined): Promise<void> {
  if (!event || !stateByEvent.get(event)?.messages) return
  for (const input of consumeInputs(event)) {
    try {
      await input.onAppended?.()
    } catch (error) {
      logger.warn(`error=<${error}> | continuation append callback failed`)
    }
  }
}

/**
 * Abandons the inputs registered for an event.
 *
 * @param event - Event whose inputs should be abandoned.
 * @param reason - Reason the inputs could not be incorporated.
 * @returns A promise that resolves after abandonment callbacks finish.
 */
async function abandon(event: AfterInvocationEvent | BeforeModelCallEvent | undefined, reason: unknown): Promise<void> {
  if (!event) return
  for (const input of consumeInputs(event)) {
    await notifyAbandoned(input, reason)
  }
}

function consumeInputs(event: AfterInvocationEvent | BeforeModelCallEvent): readonly ContinuationInput[] {
  const state = stateByEvent.get(event)
  stateByEvent.delete(event)
  return state?.inputs ?? []
}

function isCompleteMessageInput(messages: readonly Message[]): boolean {
  if (messages.length === 0 || messages.at(-1)?.role !== 'user') return false

  let pendingToolUseIds = new Set<string>()
  for (const message of messages) {
    if (pendingToolUseIds.size > 0 && message.role !== 'user') return false

    const nextToolUseIds = new Set<string>()
    for (const block of message.content) {
      if (block.type === 'toolUseBlock') {
        if (message.role !== 'assistant' || nextToolUseIds.has(block.toolUseId)) return false
        nextToolUseIds.add(block.toolUseId)
      } else if (block.type === 'toolResultBlock') {
        if (message.role !== 'user' || !pendingToolUseIds.delete(block.toolUseId)) return false
      }
    }

    if (message.role === 'user' && pendingToolUseIds.size > 0) return false
    pendingToolUseIds = nextToolUseIds
  }
  return pendingToolUseIds.size === 0
}

async function notifyAbandoned(input: ContinuationInput, reason: unknown): Promise<void> {
  try {
    await input.onAbandoned?.(reason)
  } catch (error) {
    logger.warn(`error=<${error}> | continuation abandon callback failed`)
  }
}
