import { resolveTrigger } from '../../injection/message-injection.js'
import { InvokeModelStage } from '../../middleware/index.js'
import { logger } from '../../logging/logger.js'
import { normalizeError } from '../../errors.js'
import { InjectedBlock, Message } from '../../types/messages.js'
import type { ContentBlock } from '../../types/messages.js'
import type { InvokeModelContext } from '../../middleware/index.js'
import type { Plugin } from '../../plugins/plugin.js'
import type { LocalAgent } from '../../types/agent.js'
import type { InjectionTrigger, InjectionContext } from '../../injection/types.js'

/** Configuration for the {@link ContextInjector} plugin. */
export interface ContextInjectorConfig {
  /**
   * Plugin name, for logging and duplicate detection. Defaults to `'strands:context-injector'`. The name is
   * stored with every block the injector writes and keeps a retried call from writing again, including after a
   * session restore, so keep it stable and give each injector its own.
   */
  name?: string
  /**
   * When to inject. An {@link InjectionTrigger} name selects a built-in policy (`'userTurn'` —
   * default — or `'everyTurn'`); a predicate over the {@link InjectionContext} is the escape hatch. A
   * predicate that throws fails open (injection is skipped).
   *
   * @defaultValue 'userTurn'
   */
  trigger?: InjectionTrigger | ((context: InjectionContext) => boolean)
  /**
   * Renders the text to write into the latest user message, or `undefined`/`''` to skip. The text reaches
   * the model verbatim, so it is a prompt-injection surface: escape any attacker-influenced fields yourself.
   * On a model that takes temporary messages it arrives as a system message, which the model ranks above
   * the user, so never put content from outside the conversation (tool output, retrieved documents) in it.
   * Called at most once per user message: a retry, a forced structured output call or a resume sends the text it
   * returned the first time. A callback that throws fails open (injection is skipped, the model call proceeds).
   */
  renderContent: (context: InjectionContext) => Promise<string | undefined>
}

/**
 * Plugin that injects just-in-time context into the model input before each call.
 *
 * Before each model call, the plugin asks {@link ContextInjectorConfig.renderContent} for text, gated by
 * {@link ContextInjectorConfig.trigger}, and writes it into the latest user message as an
 * `InjectedBlock`. The block stays in the conversation and the session. When the model takes temporary
 * messages (`AnthropicModel` on supported Claude models), the model receives each block as a system
 * message it reads only until the next user message, so the stored history is sent unchanged on every call. Every
 * other model receives only the latest user message's blocks, as text.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { ContextInjector } from '@strands-agents/sdk/vended-plugins/context-injector'
 *
 * const agent = new Agent({
 *   model,
 *   plugins: [new ContextInjector({ renderContent: async () => `<now>${new Date().toISOString()}</now>` })],
 * })
 * ```
 *
 * @remarks
 * Multiple injectors may be registered; each contributes its text independently, in plugin-registration
 * order.
 */
export class ContextInjector implements Plugin {
  readonly name: string
  private readonly _config: ContextInjectorConfig
  private readonly _trigger: (context: InjectionContext) => boolean

  constructor(config: ContextInjectorConfig) {
    this.name = config.name ?? 'strands:context-injector'
    this._config = config
    this._trigger = resolveTrigger(config.trigger)
  }

  initAgent(agent: LocalAgent): void {
    agent.addMiddleware(InvokeModelStage.Input, (context) => this._inject(context))
  }

  /**
   * Writes the rendered text into the latest user message of the conversation and of this call. It runs as model
   * input, after hooks and background task results have added their messages, and the model has not answered that
   * message yet, so the stored history before it never changes. A message gets at most one block from this
   * injector, so a retry, a forced structured output call or a resume sends the same request again, also after a
   * session restore. Anything that skips leaves the conversation unchanged (fail open).
   */
  private async _inject(context: InvokeModelContext): Promise<InvokeModelContext> {
    const history = context.agent.messages
    const latest = history.at(-1)
    if (latest?.role !== 'user' || latest.content.some((block) => this._wrote(block))) return context
    // Another middleware may have replaced this call's messages.
    const index = context.messages.findIndex((message) => message.trackingId === latest.trackingId)
    if (index < 0) return context
    const injectionContext: InjectionContext = {
      messages: context.messages.map((message) => message.toJSON()),
      appState: context.agent.appState,
      agent: context.agent,
    }
    if (!this._trigger(injectionContext)) return context
    const text = await this._render(injectionContext)
    if (!text?.trim()) return context
    const block = new InjectedBlock({ text, source: this.name })
    // After the stored content, so text other middleware adds for this call only stays last.
    const position = latest.content.length
    history[history.length - 1] = withBlock(latest, block, position)
    const messages = [...context.messages]
    messages[index] = withBlock(messages[index]!, block, position)
    return { ...context, messages }
  }

  private async _render(context: InjectionContext): Promise<string | undefined> {
    try {
      return await this._config.renderContent(context)
    } catch (error) {
      logger.warn(`reason=<${normalizeError(error).message}> | injection renderContent threw; skipping injection`)
      return undefined
    }
  }

  private _wrote(block: ContentBlock): boolean {
    return block.type === 'injectedBlock' && block.injected.source === this.name
  }
}

function withBlock(message: Message, block: InjectedBlock, position: number): Message {
  return new Message({
    role: message.role,
    content: [...message.content.slice(0, position), block, ...message.content.slice(position)],
    trackingId: message.trackingId,
    ...(message.metadata !== undefined && { metadata: message.metadata }),
  })
}
