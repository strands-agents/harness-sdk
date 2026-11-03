import type { Plugin } from '../../plugins/plugin.js'
import type { LocalAgent } from '../../types/agent.js'
import { addInjection } from '../../injection/message-injection.js'
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
   * On a model with temporary messages it is sent as a system message, which the model ranks above the user,
   * so never put content from outside the conversation (tool output, retrieved documents) in it.
   * A callback that throws fails open (injection is skipped, the model call proceeds).
   */
  renderContent: (context: InjectionContext) => Promise<string | undefined>
}

/**
 * Plugin that injects just-in-time context into the model input before each call.
 *
 * Before each model call, the plugin asks {@link ContextInjectorConfig.renderContent} for text, gated by
 * {@link ContextInjectorConfig.trigger}, and writes it into the latest user message as an
 * `InjectedBlock`. The block stays in the conversation and the session. A model whose `modelInfo` has
 * `temporaryMessages` (recent Claude models on `AnthropicModel`) receives each block as a system message
 * it reads only until the next user message, so the stored history is sent unchanged on every call.
 * Every other model receives only the latest user message's blocks, as text.
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

  constructor(config: ContextInjectorConfig) {
    this.name = config.name ?? 'strands:context-injector'
    this._config = config
  }

  initAgent(agent: LocalAgent): void {
    const config = this._config
    addInjection(agent, {
      source: this.name,
      ...(config.trigger !== undefined && { trigger: config.trigger }),
      renderContent: config.renderContent,
    })
  }
}
