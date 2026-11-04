import { BeforeModelCallEvent } from '../../hooks/events.js'
import { HookOrder } from '../../hooks/types.js'
import { resolveTrigger } from '../../injection/message-injection.js'
import { logger } from '../../logging/logger.js'
import { normalizeError } from '../../errors.js'
import { InjectedBlock, Message } from '../../types/messages.js'
import type { ContentBlock } from '../../types/messages.js'
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
   * On a model whose provider sends temporary messages it arrives as a system message, which the model ranks above
   * the user, so never put content from outside the conversation (tool output, retrieved documents) in it.
   * A callback that throws fails open (injection is skipped, the model call proceeds).
   */
  renderContent: (context: InjectionContext) => Promise<string | undefined>
}

/**
 * Plugin that injects just-in-time context into the model input before each call.
 *
 * Before each model call, the plugin asks {@link ContextInjectorConfig.renderContent} for text, gated by
 * {@link ContextInjectorConfig.trigger}, and writes it into the latest user message as an
 * `InjectedBlock`. The block stays in the conversation and the session. When the model's provider sends
 * temporary messages (`AnthropicModel` on supported Claude models), the model receives each block as a system
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
    // Runs after the SDK's other hooks, so the write lands in any user message they added.
    agent.addHook(BeforeModelCallEvent, (event) => this._inject(event), { order: HookOrder.SDK_LAST })
  }

  /**
   * Writes the rendered text into the latest user message, which the model has not answered yet, so the stored
   * history before it never changes. A message gets at most one block from this injector, so a retry, a forced
   * structured output call or a resume sends the same request again, also after a session restore. Anything
   * that skips leaves the conversation unchanged so the model call proceeds (fail open).
   */
  private async _inject(event: BeforeModelCallEvent): Promise<void> {
    const messages = event.agent.messages
    const latest = messages.at(-1)
    if (event.cancel || latest?.role !== 'user' || latest.content.some((block) => this._wrote(block))) return
    const context: InjectionContext = {
      messages: messages.map((message) => message.toJSON()),
      appState: event.agent.appState,
      agent: event.agent,
    }
    if (!this._trigger(context)) return
    const text = await this._render(context)
    if (!text?.trim()) return
    messages[messages.length - 1] = new Message({
      role: 'user',
      content: [...latest.content, new InjectedBlock({ text, source: this.name })],
      trackingId: latest.trackingId,
      ...(latest.metadata !== undefined && { metadata: latest.metadata }),
    })
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
