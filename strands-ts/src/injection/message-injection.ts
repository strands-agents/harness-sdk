import { Message, TextBlock } from '../types/messages.js'
import type { MessageData } from '../types/messages.js'
import { logger } from '../logging/logger.js'
import { normalizeError } from '../errors.js'
import type { InvokeModelContext } from '../middleware/index.js'
import type { InjectionMiddlewareOptions, InjectionTrigger, InjectionContext } from './types.js'

/**
 * Builds an `InvokeModelStage` `Input` handler that folds {@link InjectionMiddlewareOptions.renderContent}'s
 * text into the latest user message, ephemerally — the model sees the augmented input for this one call
 * while the agent's durable history is never touched.
 *
 * Runs as an input-phase transformer (`(ctx) => ctx`): it gates on the resolved trigger, asks
 * `renderContent` for the text, and returns a context with the folded messages. Anything that skips —
 * the trigger not firing, `renderContent` returning empty, or any callback throwing — returns the
 * context unchanged so the model call proceeds (fail open). The injected text never enters durable
 * history because the input phase only rewrites the per-call context, not the agent's stored messages.
 *
 * @param opts - The trigger and `renderContent` callback the handler uses
 * @returns An `InvokeModelStage.Input` handler that returns a (possibly) folded context
 * @internal Delivery primitive. Reach injection through `ContextInjector` or `MemoryManager`.
 */
export function createInjectionMiddleware(
  opts: InjectionMiddlewareOptions
): (context: InvokeModelContext) => Promise<InvokeModelContext> {
  const trigger = resolveTrigger(opts.trigger)
  return async (context) => {
    const agent = context.agent
    const injectionContext: InjectionContext = {
      messages: context.messages.map((message) => message.toJSON()),
      appState: agent.appState,
      agent,
    }
    if (!trigger(injectionContext)) {
      return context
    }

    let text: string | undefined
    try {
      text = await opts.renderContent(injectionContext)
    } catch (error) {
      logger.warn(`reason=<${normalizeError(error).message}> | injection renderContent threw; skipping injection`)
      return context
    }
    if (!text?.trim()) {
      return context
    }

    const { messages: folded, appended } = foldIntoLastUserMessage([...context.messages], text)
    // Accumulate: several producers may append on one call, and the cache point precedes all of it.
    return { ...context, messages: folded, dynamicTrailingBlocks: (context.dynamicTrailingBlocks ?? 0) + appended }
  }
}

/**
 * Resolves an {@link InjectionTrigger} name or predicate into a single gate predicate over the
 * {@link InjectionContext}.
 *
 * `'userTurn'` maps to {@link isUserTurn} (over `ctx.messages`); `'everyTurn'` to an always-true gate;
 * a user-supplied predicate is wrapped so that a throw fails open (logs and skips injection rather than
 * aborting the model call).
 *
 * @param trigger - An {@link InjectionTrigger} name, a predicate, or `undefined` (defaults to `'userTurn'`)
 * @returns A predicate that, given the {@link InjectionContext}, returns whether to inject this call
 * @internal Delivery primitive. Reach injection through `ContextInjector` or `MemoryManager`.
 */
export function resolveTrigger(
  trigger: InjectionTrigger | ((context: InjectionContext) => boolean) | undefined
): (context: InjectionContext) => boolean {
  if (trigger === undefined || trigger === 'userTurn') {
    return (context) => isUserTurn(context.messages)
  }
  if (trigger === 'everyTurn') {
    return () => true
  }
  const predicate = trigger
  return (context) => {
    try {
      return predicate(context)
    } catch (error) {
      logger.warn(`reason=<${normalizeError(error).message}> | injection trigger threw; skipping injection`)
      return false
    }
  }
}

/**
 * Whether the latest message is a fresh user ask: a `user` message carrying no tool result. This is
 * the `'userTurn'` policy — it distinguishes a new chat ask from an autonomous tool-result turn.
 *
 * @param messages - The current conversation, as data
 * @returns `true` when the latest message is a plain user ask, otherwise `false`
 * @internal Delivery primitive. Reach injection through `ContextInjector` or `MemoryManager`.
 */
export function isUserTurn(messages: MessageData[]): boolean {
  const last = messages[messages.length - 1]
  return !!last && last.role === 'user' && !last.content.some((block) => 'toolResult' in block)
}

/**
 * Folds `text` into the most recent `user` message as a {@link TextBlock}, returning a NEW array. Other
 * messages are returned as-is.
 *
 * Folding into the existing user message (rather than inserting a standalone message) keeps role
 * alternation valid in both chat and the autonomous tool loop.
 *
 * The text is always **appended**. A tool result has to stay the first content block in the turn that
 * answers a tool use, and a trailing run is the only placement a provider can keep out of its cached
 * prefix — text ahead of the stable conversation would invalidate the cache from the first block onward.
 *
 * {@link Message} fields are readonly, so the target is rebuilt as a new {@link Message}. When there is
 * no `user` message, the input array is returned unchanged.
 *
 * @param messages - The conversation to fold into
 * @param text - The text to fold into the most recent user message
 * @returns The folded conversation and how many trailing blocks of its last message are per-call
 *   content: 1 when the fold landed on the last message, 0 otherwise (including when there is no user
 *   message to fold into, in which case the input array is returned unchanged)
 * @internal Delivery primitive. Reach injection through `ContextInjector` or `MemoryManager`.
 */
export function foldIntoLastUserMessage(messages: Message[], text: string): { messages: Message[]; appended: number } {
  let targetIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      targetIndex = i
      break
    }
  }
  if (targetIndex < 0) {
    return { messages, appended: 0 }
  }

  const target = messages[targetIndex]!
  // Some providers concatenate adjacent text blocks, which would run this onto the user's own words.
  const separator = target.content.length > 0 && !text.startsWith('\n') ? '\n\n' : ''
  const injected = new TextBlock(`${separator}${text}`)
  const content = [...target.content, injected]
  const folded = new Message({
    role: target.role,
    content,
    // Folding injects content into the same logical message, so keep its tracking id.
    trackingId: target.trackingId,
    ...(target.metadata !== undefined && { metadata: target.metadata }),
  })

  const result = [...messages]
  result[targetIndex] = folded
  return { messages: result, appended: targetIndex === messages.length - 1 ? 1 : 0 }
}
