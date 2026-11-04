import type { MessageData } from '../types/messages.js'
import type { LocalAgent } from '../types/agent.js'
import type { StateStore } from '../state-store.js'

/**
 * Determines when injection runs before a model call.
 *
 * - `'userTurn'`: only when the latest message is a fresh user ask (a `user` message with no tool
 *   result) — the common case for chat agents, where it keeps the user's ask the final message the
 *   model sees.
 * - `'everyTurn'`: before every model call, including mid-task tool-result turns — for autonomous
 *   agents that should consult injected context at each step.
 *
 * For finer control, pass a predicate as {@link InjectionConfig.trigger} instead.
 */
export type InjectionTrigger = 'userTurn' | 'everyTurn'

/**
 * The context an injection consumer receives on each model call, passed to `renderContent` and to a
 * predicate {@link InjectionConfig.trigger}.
 */
export interface InjectionContext {
  /** The current conversation, as data. */
  messages: MessageData[]
  /** Durable app state shared across calls, hooks, and tools — read what a tool stashed last turn. */
  appState: StateStore
  /** The agent the injection is attached to (escape hatch for advanced consumers). */
  agent: LocalAgent
}

/**
 * Configuration common to every injection consumer: when to inject. What text to inject is a consumer
 * concern, added by the interfaces that extend this one (e.g. {@link MemoryInjectionConfig}).
 */
export interface InjectionConfig {
  /**
   * When injection runs. An {@link InjectionTrigger} name selects a built-in policy; a predicate is
   * the escape hatch — it receives the {@link InjectionContext} and returns whether to inject this
   * call. A predicate that throws fails open (injection is skipped, the model call proceeds).
   *
   * @defaultValue 'userTurn'
   */
  trigger?: InjectionTrigger | ((context: InjectionContext) => boolean)
}

/**
 * Options for {@link createInjectionMiddleware}.
 *
 * The engine is text-in: it knows nothing about queries, search, or rendering. A consumer supplies a
 * single {@link InjectionMiddlewareOptions.renderContent} callback that returns the text to fold into
 * the conversation, and (optionally) a trigger that gates when to do so.
 *
 * @internal Engine options. Consumers configure injection via `ContextInjectorConfig` or
 * `MemoryInjectionConfig`, not this type.
 */
export interface InjectionMiddlewareOptions {
  /**
   * When to inject. See {@link InjectionConfig.trigger}. Defaults to `'userTurn'`.
   */
  trigger?: InjectionTrigger | ((context: InjectionContext) => boolean)
  /**
   * Returns the text to fold into the latest user message, or `undefined`/`''` to skip this call. A
   * callback that throws fails open (injection is skipped, the model call proceeds).
   */
  renderContent: (context: InjectionContext) => Promise<string | undefined>
}
