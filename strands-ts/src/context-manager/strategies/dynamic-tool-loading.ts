/**
 * Dynamic tool loading — keeps tools' input schemas out of the model's context until the model loads them.
 *
 * @internal
 */

import { logger } from '../../logging/logger.js'
import { warnOnce } from '../../logging/warn-once.js'
import { MANAGE_TOOL_NAME } from '../../background-tasks/background-tasks.js'
import { InvokeModelStage, type InvokeModelContext } from '../../middleware/stages.js'
import { heuristicJson } from '../../models/model.js'
import { createLoadTools, LOAD_TOOLS_TOOL_NAME } from '../../tools/load-tools.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../tools/structured-output-tool.js'
import { RETRIEVAL_TOOL_NAME as OFFLOADED_CONTENT_RETRIEVAL_TOOL_NAME } from '../../vended-plugins/context-offloader/plugin.js'
import { RETRIEVAL_TOOL_NAME } from '../retrieval-tool.js'
import type { Tool } from '../../tools/tool.js'
import type { ToolSpec } from '../../tools/types.js'
import type { LocalAgent } from '../../types/agent.js'
import type { ContextStrategy } from '../types.js'

const DYNAMIC_TOOL_LOADING_STATE_KEY = 'strands.dynamicToolLoading'

/** SDK tools that are never deferred, since SDK-injected text tells the model to call them or they load the rest. */
const PROTECTED_TOOL_NAMES = new Set([
  LOAD_TOOLS_TOOL_NAME,
  RETRIEVAL_TOOL_NAME,
  OFFLOADED_CONTENT_RETRIEVAL_TOOL_NAME,
  STRUCTURED_OUTPUT_TOOL_NAME,
  MANAGE_TOOL_NAME,
])

/**
 * When {@link DynamicToolLoadingStrategy} defers tools. It defers only when the deferrable tools reach every minimum.
 *
 * @internal
 */
export interface DynamicToolLoadingConfig {
  /** Fewest deferrable tools to defer; defaults to 0. */
  minTools?: number
  /** Fewest estimated tokens in the deferrable tools' input schemas to defer; defaults to 0. */
  minSchemaTokens?: number
}

/**
 * Which tools a conversation defers. Made on the conversation's first model call and saved in `appState`, so later
 * calls and restored sessions send the same tools list.
 */
interface DynamicToolLoadingPlan {
  /** Names of the deferred tools; empty when nothing is deferred. */
  deferred: string[]
}

/**
 * Defers every tool's input schema. On the conversation's first model call it picks the tools to defer and saves the
 * choice. Every call then marks those specs `deferLoading`, and the model loads a schema by calling
 * `strands_load_tools`. The call's model decides how a deferred tool reaches it
 * (`modelInfo.capabilities.deferredTools`); a model that can't defer gets every spec. Messages are never changed. SDK
 * tools such as `strands_load_tools` and `retrieve_context` are never deferred; pinning a user tool comes with tool
 * selection. The `dynamicToolLoading` preset sets the minimums.
 *
 * @internal
 */
export class DynamicToolLoadingStrategy implements ContextStrategy {
  readonly name = 'dynamic-tool-loading'

  private readonly _config: DynamicToolLoadingConfig
  private readonly _loadTools = createLoadTools((agent) => readPlan(agent)?.deferred ?? [])

  /**
   * @param config - The minimums the deferrable tools must reach before the strategy defers them
   */
  constructor(config: DynamicToolLoadingConfig = {}) {
    this._config = config
  }

  init(agent: LocalAgent): void {
    agent.addMiddleware(InvokeModelStage.Input, (context) => this._render(context))
  }

  getTools(): Tool[] {
    return [this._loadTools]
  }

  /** Messages are never changed; the tools list is rendered on each model call. */
  async apply(): Promise<boolean> {
    return false
  }

  /** Marks the deferred specs for this call, or sends every spec without the loader when the call can't defer any. */
  private _render(context: InvokeModelContext): InvokeModelContext {
    const deferred = new Set(this._planFor(context).deferred)
    if (deferred.size > 0 && defersTools(context)) {
      const toolSpecs = context.toolSpecs.map((spec) =>
        deferred.has(spec.name) ? { ...spec, deferLoading: true } : spec
      )
      return { ...context, toolSpecs }
    }
    if (deferred.size > 0) {
      warnOnce(
        logger,
        `model_id=<${context.model.modelId}> | model can not defer tool schemas | sending every tool spec`
      )
    }
    return { ...context, toolSpecs: context.toolSpecs.filter((spec) => spec.name !== LOAD_TOOLS_TOOL_NAME) }
  }

  /** Returns the saved plan, or makes it from this call's tools and saves it. */
  private _planFor(context: InvokeModelContext): DynamicToolLoadingPlan {
    const saved = readPlan(context.agent)
    if (saved) return saved
    const candidates = context.toolSpecs.filter((spec) => !PROTECTED_TOOL_NAMES.has(spec.name))
    const plan = { deferred: this._reachesMinimums(candidates) ? candidates.map((spec) => spec.name) : [] }
    context.agent.appState.set(DYNAMIC_TOOL_LOADING_STATE_KEY, plan)
    return plan
  }

  private _reachesMinimums(candidates: ToolSpec[]): boolean {
    if (candidates.length < (this._config.minTools ?? 0)) return false
    const schemaTokens = candidates.reduce((total, spec) => total + heuristicJson(spec.inputSchema ?? {}), 0)
    return schemaTokens >= (this._config.minSchemaTokens ?? 0)
  }
}

function defersTools(context: InvokeModelContext): boolean {
  return (context.model.modelInfo.capabilities?.deferredTools ?? 'unsupported') !== 'unsupported'
}

function readPlan(agent: LocalAgent): DynamicToolLoadingPlan | undefined {
  return agent.appState.get(DYNAMIC_TOOL_LOADING_STATE_KEY) as DynamicToolLoadingPlan | undefined
}
