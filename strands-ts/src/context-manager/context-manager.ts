/**
 * ContextManager: first-class agent component for strategy-driven context management.
 *
 * On overflow, runs the strategy pipeline (including an emergency truncation as the final step).
 */

import type { Plugin } from '../plugins/plugin.js'
import type { Tool } from '../tools/tool.js'
import type { ToolSpec } from '../tools/types.js'
import type { CallTools, Model } from '../models/model.js'
import { createAuxiliaryInvocationContext, type InvocationContext } from '../agent/invocation-context.js'
import type { LocalAgent } from '../types/agent.js'
import { AfterModelCallEvent, BeforeModelCallEvent, MessageAddedEvent } from '../hooks/events.js'
import { ContextWindowOverflowError } from '../errors.js'
import { InMemoryStorage } from '../storage/in-memory-storage.js'
import { EPHEMERAL } from '../storage/storage.js'
import type { Storage } from '../storage/storage.js'
import { logger } from '../logging/logger.js'
import { countRequestTokens } from '../models/model-proxy.js'
import type { ContextManagerConfig, ContextStrategy, ContextState } from './types.js'
import { EmergencyTruncateStrategy, Offload } from './strategies/offload/index.js'
import { DeferredToolLoadingStrategy } from './strategies/deferred-tool-loading.js'
import { resolveStrategies } from './presets.js'
import { Archive } from './archive.js'
import { createRetrievalTool, RETRIEVAL_TOOL_NAME } from './retrieval-tool.js'
import { createLoadTools, LOAD_TOOLS_TOOL_NAME } from '../tools/load-tools.js'
import { createSearchTools, SEARCH_TOOLS_TOOL_NAME } from '../tools/search-tools.js'
import { ToolUseBlock, type Message } from '../types/messages.js'

/**
 * The retrieval tool calls answered by the message at `index`. Their results are copies of
 * archived content, so the archive leaves them out. A tool result follows the message that called it.
 */
function retrievalCallsBefore(messages: readonly Message[], index: number): Set<string> {
  const ids = new Set<string>()
  for (const block of messages[index - 1]?.content ?? []) {
    if (block instanceof ToolUseBlock && block.name === RETRIEVAL_TOOL_NAME) ids.add(block.toolUseId)
  }
  return ids
}

const TRUNCATE_PREVIEW_TOKENS = 750

/** @internal */
export const CONTEXT_MANAGER_PRESETS = ['auto', 'agentic'] as const

/** @internal */
export type ContextManagerPreset = (typeof CONTEXT_MANAGER_PRESETS)[number]

/** The strategy pipeline of each preset. `auto` is also the default for a config that names none. */
const PRESET_STRATEGIES: Record<ContextManagerPreset, () => ContextStrategy[]> = {
  auto: () => [
    Offload.truncate('toolResults', { previewTokens: TRUNCATE_PREVIEW_TOKENS }).when({ blockThreshold: 1_500 }),
    Offload.summarize('*').when({ contextUtilization: '85%', preserveRecent: 4 }),
  ],
  agentic: () => [
    Offload.truncate('toolResults', { previewTokens: TRUNCATE_PREVIEW_TOKENS }).when({ blockThreshold: 8_000 }),
    Offload.summarize('*').when({ contextUtilization: '100%', preserveRecent: 4 }),
  ],
}

/**
 * Supported values for the `contextManager` parameter.
 *
 * - `"auto"`: Managed context with proactive compression + offloading.
 * - `"agentic"`: (Experimental) Model-driven context management via injected tools.
 *   This mode may change in future versions.
 * - {@link ContextManagerConfig}: Custom strategy pipeline and archive configuration.
 * - {@link ContextManager}: A pre-built instance, used as-is. An instance binds to one agent;
 *   construct one per `Agent`.
 * - `false`: Explicitly disable all context management (no compression, no offloading).
 */
export type ContextManagerStrategy = ContextManagerPreset | ContextManagerConfig | ContextManager | false

/**
 * Manages context reduction for an agent's conversation.
 *
 * On context overflow, runs the strategy pipeline (offload, summarize, emergency truncate).
 * The emergency truncation is always appended as the final strategy — it fires only if the
 * window is still overflowing after the user strategies have run.
 *
 * Configured through the Agent's `contextManager` parameter — pass a preset
 * string (`'auto'`, or the experimental `'agentic'`), a `ContextManagerConfig`, or a
 * `ContextManager` instance; the Agent registers the manager. When present, it owns overflow
 * recovery and proactive compression — no separate ConversationManager is needed.
 */
export class ContextManager implements Plugin {
  readonly name = 'strands:context-manager'

  private readonly _strategies: ContextStrategy[]
  private readonly _archiveStorage: Storage | false | undefined
  private readonly _enableRetrievalTool: boolean
  private _tools: Tool[] = []
  private _archive: Archive | undefined
  private _archiveIsDurable = false

  /**
   * @param config - The strategies and archive to use; the default pipeline when omitted
   * @throws Error when the strategies hold more than one `Offload.defer` strategy, the `deferredToolLoading` preset
   *   included
   */
  constructor(config?: ContextManagerConfig) {
    const userStrategies = config?.strategies ? resolveStrategies(config.strategies) : PRESET_STRATEGIES.auto()
    checkOneToolLoadingStrategy(userStrategies)
    this._strategies = [...userStrategies, new EmergencyTruncateStrategy()]
    const archiveConfig = config?.archive ?? config?.stash
    if (config?.archive === undefined && config?.stash !== undefined) {
      logger.warn('config_key=<stash> | stash was renamed to archive, the stash key is removed in the next minor')
    }
    const archiveObj = typeof archiveConfig === 'object' ? archiveConfig : undefined
    this._archiveStorage = archiveConfig === false ? false : archiveObj?.storage
    this._enableRetrievalTool = archiveConfig !== false && archiveObj?.retrievalTool !== false
  }

  /**
   * Resolves a `ContextManagerStrategy` value into a `ContextManager` instance.
   *
   * @param strategy - A preset string, config object, ContextManager instance, false, or undefined
   * @returns The instance as-is; a new ContextManager for preset strings and configs; undefined for false/undefined
   */
  static from(strategy: ContextManagerStrategy | undefined): ContextManager | undefined {
    if (strategy === false || strategy === undefined) return undefined
    if (strategy instanceof ContextManager) return strategy
    if (typeof strategy === 'string') {
      if (!(CONTEXT_MANAGER_PRESETS as readonly string[]).includes(strategy)) {
        throw new Error(
          `Unknown contextManager preset: "${strategy}". Valid presets: ${CONTEXT_MANAGER_PRESETS.map((s) => `"${s}"`).join(', ')}`
        )
      }
      return new ContextManager({ strategies: PRESET_STRATEGIES[strategy]() })
    }
    return new ContextManager(strategy)
  }

  getTools(): Tool[] {
    return [...this._tools]
  }

  /**
   * The tools an agent's model call with these tool specs on this model sends, so a count or a summary replay of the
   * request carries the same tools.
   *
   * @param agent - The agent making the call
   * @param toolSpecs - The tool specs of the call
   * @param model - The call's model
   * @param messages - The messages of the call
   * @returns The call's tool specs, and the names of the ones it defers; every spec without an `Offload.defer` strategy
   * @internal
   */
  callTools(agent: LocalAgent, toolSpecs: readonly ToolSpec[], model: Model, messages?: readonly Message[]): CallTools {
    const strategy = toolLoadingStrategy(this._strategies)
    return strategy?.callTools(agent, toolSpecs, model, messages) ?? { toolSpecs: [...toolSpecs] }
  }

  async initAgent(agent: LocalAgent): Promise<void> {
    if (this._archiveStorage !== false) {
      const storage = this._archiveStorage ?? agent.storage ?? new InMemoryStorage()
      this._archiveIsDurable = !(EPHEMERAL in storage)
      // Only explicit archive storage may be a shared root; agent.storage is shared with other subsystems.
      // Plain (non-namespaced) explicit storage still gets the per-agent prefix. Mirrors strands-py.
      this._archive = new Archive(storage, agent.sessionId, agent.id, {
        customArchiveNamespace: this._archiveStorage !== undefined,
      })
    }

    if (this._archive) {
      const archive = this._archive
      const storedKeys = new Set(await archive.list())
      for (const [index, message] of agent.messages.entries()) {
        await archive.storeMessage(message, retrievalCallsBefore(agent.messages, index), storedKeys)
      }
      agent.addHook(MessageAddedEvent, async (event) => {
        const messages = event.agent.messages
        const index = messages.indexOf(event.message)
        await archive.storeMessage(
          event.message,
          retrievalCallsBefore(messages, index === -1 ? messages.length : index)
        )
      })
    }

    for (const strategy of this._strategies) {
      strategy.init?.(agent, this._archive)
    }

    const retrievalTools = this._enableRetrievalTool && this._archive ? [createRetrievalTool(this._archive)] : []
    this._tools = [...retrievalTools, ...loaderFor(toolLoadingStrategy(this._strategies), agent)]

    agent.addHook(BeforeModelCallEvent, async (event) => {
      await this._runStrategies(event.agent, event.projectedInputTokens, undefined, event.invocationContext)
    })

    // Assumes sequential invocations on this agent (no concurrent calls)
    let overflowRetries = 0
    agent.addHook(AfterModelCallEvent, async (event) => {
      if (!(event.error instanceof ContextWindowOverflowError)) {
        overflowRetries = 0
        return
      }

      if (overflowRetries >= 3) {
        logger.warn(`agentId=<${event.agent.id}> | overflow retry limit reached, giving up`)
        overflowRetries = 0
        return
      }

      const acted = await this._runStrategies(event.agent, undefined, true, event.invocationContext)
      if (!acted) {
        logger.warn(`agentId=<${event.agent.id}> | no strategy made progress, skipping retry`)
        return
      }

      overflowRetries++
      event.retry = true
    })
  }

  /**
   * The L1 archive instance, if archive is enabled and the agent has been initialized.
   *
   * @returns The archive, or undefined if archive is disabled or initAgent has not run
   */
  get archive(): Archive | undefined {
    return this._archive
  }

  /**
   * Whether the archive is backed by durable storage that survives process restarts.
   * When true, archive data does not need to be embedded in session snapshots.
   *
   * @returns true if the archive storage is not ephemeral
   */
  get archiveIsDurable(): boolean {
    return this._archiveIsDurable
  }

  /**
   * @deprecated Renamed to {@link ContextManager.archive}. Removed in the next minor.
   * @returns The archive, or undefined if archive is disabled or initAgent has not run
   */
  get stash(): Archive | undefined {
    return this._archive
  }

  /**
   * @deprecated Renamed to {@link ContextManager.archiveIsDurable}. Removed in the next minor.
   * @returns true if the archive storage is not ephemeral
   */
  get stashIsDurable(): boolean {
    return this._archiveIsDurable
  }

  private async _runStrategies(
    agent: LocalAgent,
    precomputedInputTokens?: number,
    overflow?: boolean,
    invocationContext?: InvocationContext
  ): Promise<boolean> {
    const messages = agent.messages
    const inputTokens = precomputedInputTokens ?? (await countRequestTokens(agent, messages))
    const auxiliaryInvocationContext = createAuxiliaryInvocationContext(invocationContext)

    const strategyContext: ContextState = {
      messages,
      agent,
      utilization: agent.model.estimateUtilization(inputTokens),
      ...(overflow ? { overflow: true } : {}),
      ...(this._archive ? { archive: this._archive, stash: this._archive } : {}),
      ...(auxiliaryInvocationContext && { invocationContext: auxiliaryInvocationContext }),
    }

    let anyActed = false
    for (const strategy of this._strategies) {
      try {
        if (strategy instanceof EmergencyTruncateStrategy && anyActed) strategyContext.overflow = false
        const acted = await strategy.apply(strategyContext)
        if (acted) {
          anyActed = true
          strategyContext.utilization = agent.model.estimateUtilization(await countRequestTokens(agent, messages))
          logger.debug(`strategy=<${strategy.name}>, agentId=<${agent.id}> | strategy applied`)
        }
      } catch (error) {
        logger.warn(
          `strategy=<${strategy.name}>, agentId=<${agent.id}>, error=<${error}> | strategy failed, continuing`
        )
      }
    }
    return anyActed
  }
}

/**
 * The loader for the `Offload.defer` strategy, if there is one: `search_tools` when the model searches, `load_tools`
 * otherwise. It loads the tools the strategy deferred on the agent's latest model call.
 *
 * @throws Error when the agent already has a tool with the loader's name
 */
function loaderFor(strategy: DeferredToolLoadingStrategy | undefined, agent: LocalAgent): Tool[] {
  if (!strategy) return []
  const name = strategy.searches ? SEARCH_TOOLS_TOOL_NAME : LOAD_TOOLS_TOOL_NAME
  if (agent.toolRegistry.get(name)) {
    throw new Error(
      `contextManager adds a tool named '${name}' for Offload.defer and the 'deferredToolLoading' preset, and the ` +
        "agent already has one; rename the agent's tool"
    )
  }
  const deferredTools = (callingAgent: LocalAgent): string[] => strategy.deferredTools(callingAgent)
  return [strategy.searches ? createSearchTools(deferredTools, strategy.searcher) : createLoadTools(deferredTools)]
}

/** The `Offload.defer` strategy among these, if there is one. */
function toolLoadingStrategy(strategies: ContextStrategy[]): DeferredToolLoadingStrategy | undefined {
  return strategies.find(
    (strategy): strategy is DeferredToolLoadingStrategy => strategy instanceof DeferredToolLoadingStrategy
  )
}

/** Two `Offload.defer` strategies can't share an agent's tools list, which holds one loader. */
function checkOneToolLoadingStrategy(strategies: ContextStrategy[]): void {
  if (strategies.filter((strategy) => strategy instanceof DeferredToolLoadingStrategy).length < 2) return
  throw new Error(
    "contextManager takes one Offload.defer strategy, and the 'deferredToolLoading' preset is one; " +
      'to change what the preset defers or when, use Offload.defer(target).when(conditions) in its place'
  )
}
