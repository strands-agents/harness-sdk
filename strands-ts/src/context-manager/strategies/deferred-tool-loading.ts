/**
 * Deferred tool loading — keeps tools' input schemas out of the model's context until the model loads them. Users
 * build it with `Offload.defer`.
 *
 * The whole feature is experimental: every public export here carries `@experimental`, as does anything added here,
 * so its shape and behavior may change in future versions.
 */

import { logger } from '../../logging/logger.js'
import { warnOnce } from '../../logging/warn-once.js'
import { isManageTool } from '../../background-tasks/background-tasks.js'
import {
  ExecuteToolStage,
  InvokeModelStage,
  type ExecuteToolContext,
  type ExecuteToolResult,
  type InvokeModelContext,
} from '../../middleware/stages.js'
import { DEFAULT_CONTEXT_WINDOW_LIMIT } from '../../models/defaults.js'
import { heuristicJson, type Model, type StreamOptions } from '../../models/model.js'
import { lookupModel } from '../../models/model-info.js'
import { LOAD_TOOLS_TOOL_NAME } from '../../tools/load-tools.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../tools/structured-output-tool.js'
import { TextBlock, ToolReferenceBlock, ToolResultBlock, type Message } from '../../types/messages.js'
import { RETRIEVAL_TOOL_NAME } from '../retrieval-tool.js'
import { parseCondition, type ParsedCondition, type Percent } from './offload/conditions.js'
import { OffloadTargetMatcher } from './offload/target.js'
import type { MiddlewareNextOf } from '../../middleware/types.js'
import type { ToolSpec } from '../../tools/types.js'
import type { AgentStreamEvent, LocalAgent } from '../../types/agent.js'
import type { ContextStrategy } from '../types.js'

/**
 * SDK tools that are never deferred, since SDK-injected text tells the model to call them or they load the rest. The
 * background-tasks manage tool is one too, recognized by `isManageTool` since its name is configurable.
 */
const PROTECTED_TOOL_NAMES = new Set([
  LOAD_TOOLS_TOOL_NAME,
  RETRIEVAL_TOOL_NAME,
  STRUCTURED_OUTPUT_TOOL_NAME,
  // ContextOffloader's and AgentSkills' tools, named here since the core doesn't import the vended plugins.
  'retrieve_offloaded_content',
  'skills',
])

const CONDITION_NAMES = ['toolCount', 'schemaTokens']

/** Input schema keywords that describe no parameter. */
const ANNOTATION_KEYWORDS = new Set(['$schema', 'type', 'title', 'description'])

/**
 * Which tools `Offload.defer` defers: `'toolSpecs'` for every one, or tool names as in other offload targets. Names to
 * defer may be prefixed with `tool::`, and names prefixed with `!` are kept in full. A list of only exclusions defers
 * every other tool.
 *
 * @experimental
 */
export type DeferTarget = 'toolSpecs' | string[]

/**
 * When `Offload.defer` defers tools, checked on every model call against that call's tools. Either condition is
 * enough; with none, it defers at any tool count. The same tools and conditions always defer the same tools, so the
 * tools list stays the same from call to call and after a session restore. A tool change that meets a condition
 * mid-conversation defers from the next call on, so the model then loads tools it was calling directly.
 *
 * @experimental
 */
export interface DeferConditions {
  /**
   * Tools in the call at or above which it defers: a whole number above 0. The SDK's own tools count, but not the
   * structured output tool, so an invocation with structured output defers the same tools as one without.
   */
  toolCount?: number
  /**
   * Estimated tokens of the input schemas it would defer, at or above which it defers: a whole number above 0, or
   * `'5%'` of the context window.
   */
  schemaTokens?: number | Percent
}

/**
 * A strategy that keeps tools' input schemas out of the model's context until the model loads them with `load_tools`.
 * The model still sees each deferred tool's name and description. A call to a deferred tool made before its load
 * doesn't run: the model gets the tool's schema and calls it again. It never changes the messages.
 *
 * @experimental
 */
export interface DeferStrategy extends ContextStrategy {
  /**
   * Returns a copy of this strategy with these conditions in place of its current ones.
   *
   * @throws Error when a condition name is unknown or its value is invalid
   */
  when(conditions?: DeferConditions): DeferStrategy
}

/**
 * The strategy behind `Offload.defer`. On every model call it picks the tools to defer from that call's tools and
 * passes their names on the call as its `deferredTools`. The call's model decides how a deferred tool reaches it
 * (`modelInfo.capabilities.deferredToolLoading`); a model that can't defer tools gets every spec. The model loads a
 * schema with `load_tools`, which the context manager registers, and a call to a deferred tool before its load gets
 * the schema back instead of running. SDK tools such as `load_tools` and `retrieve_context` are never deferred, nor
 * is a tool that takes no parameters, since its stub would leave nothing out.
 *
 * @internal
 */
export class DeferredToolLoadingStrategy implements DeferStrategy {
  readonly name = 'offload:defer'

  private readonly _target: DeferTarget
  /** Matches a list target's tool names; undefined for `'toolSpecs'`, which covers every tool. */
  private readonly _matcher: OffloadTargetMatcher | undefined
  private readonly _toolCount: number | undefined
  private readonly _schemaTokens: ParsedCondition | undefined
  /** The tools each agent's latest model call deferred. */
  private readonly _deferred = new WeakMap<LocalAgent, ReadonlySet<string>>()

  /**
   * @param target - Which tools to defer
   * @param conditions - When to defer; with none, at any tool count
   * @throws Error when the target is neither `'toolSpecs'` nor a list of tool names, is an empty list, lists
   *   `'toolSpecs'`, or excludes every tool it includes, or when a condition is invalid
   */
  constructor(target: DeferTarget = 'toolSpecs', conditions?: DeferConditions) {
    checkTarget(target)
    this._target = target
    this._matcher = Array.isArray(target) ? new OffloadTargetMatcher(target) : undefined
    checkConditionNames(conditions)
    this._toolCount = parseToolCount(conditions?.toolCount)
    this._schemaTokens = parseCondition('blockThreshold', conditions?.schemaTokens, 'schemaTokens')
  }

  when(conditions?: DeferConditions): DeferStrategy {
    return new DeferredToolLoadingStrategy(this._target, conditions)
  }

  init(agent: LocalAgent): void {
    if (this._unconditioned) {
      warnOnce(
        logger,
        `strategy=<${this.name}>, target=<${JSON.stringify(this._target)}> | strategy has no conditions, so it ` +
          'defers every tool it targets at any tool count | use .when() to set toolCount or schemaTokens'
      )
    }
    agent.addMiddleware(InvokeModelStage.Input, (context) => this._render(context))
    agent.addMiddleware(ExecuteToolStage, (context, next) => this._guardUnloaded(context, next))
  }

  /** Messages are never changed; the tools list is rendered on each model call. */
  async apply(): Promise<boolean> {
    return false
  }

  /**
   * The tools `load_tools` loads: the ones the agent's latest model call deferred. Before the agent's first call, as
   * when an interrupted load resumes on a restored agent, every registered tool the target covers, since which of them
   * the next call defers depends on that call's tools and model. A reference to a tool that call doesn't defer reaches
   * the model as text.
   *
   * @param agent - The agent whose call it was
   * @returns Their names; empty when the call deferred none
   */
  deferredTools(agent: LocalAgent): string[] {
    const recorded = this._deferred.get(agent)
    if (recorded) return [...recorded]
    return agent.toolRegistry
      .list()
      .filter((tool) => this._targets(agent, tool.toolSpec))
      .map((tool) => tool.name)
  }

  /**
   * The tools an agent's model call with these tool specs on this model sends: every spec and the names of the ones it
   * defers, or every spec but `load_tools` when it defers none.
   *
   * @param agent - The agent making the call
   * @param toolSpecs - The tool specs of the call
   * @param model - The call's model
   * @returns The call's tool specs, and the names of the deferred ones when there are any
   */
  callTools(
    agent: LocalAgent,
    toolSpecs: readonly ToolSpec[],
    model: Model
  ): Pick<StreamOptions, 'toolSpecs' | 'deferredTools'> {
    const deferred = defersTools(model) ? this._toDefer(agent, toolSpecs, model) : new Set<string>()
    if (deferred.size > 0) return { toolSpecs: [...toolSpecs], deferredTools: deferred }
    return { toolSpecs: toolSpecs.filter((spec) => spec.name !== LOAD_TOOLS_TOOL_NAME) }
  }

  /** Defers this call's tools, or sends every spec without the loader when the call defers none. */
  private _render(context: InvokeModelContext): InvokeModelContext {
    const tools = this.callTools(context.agent, context.toolSpecs, context.model)
    this._record(context.agent, tools.deferredTools ?? new Set(), context.model)
    if (!defersTools(context.model) && this._toDefer(context.agent, context.toolSpecs, context.model).size > 0) {
      warnOnce(
        logger,
        `model_id=<${context.model.modelId}> | model or its config can not defer tool schemas | sending every tool spec`
      )
    }
    if (tools.deferredTools && takesStubsByDefault(context.model)) {
      warnOnce(
        logger,
        `model_id=<${context.model.modelId}> | model is not in the shared model info | sending deferred tools as ` +
          'stubs, set modelInfo.capabilities.deferredToolLoading to unsupported if it calls them badly'
      )
    }
    return { ...context, ...tools }
  }

  /** Records the tools an agent's call defers, and logs when they differ from its previous call's. */
  private _record(agent: LocalAgent, deferred: ReadonlySet<string>, model: Model): void {
    const previous = this._deferred.get(agent) ?? new Set<string>()
    if (deferred.size !== previous.size || [...deferred].some((name) => !previous.has(name))) {
      logger.debug(`model_id=<${model.modelId}>, deferred=<${deferred.size}> | deferred tools changed`)
    }
    this._deferred.set(agent, deferred)
  }

  /** The tools among these specs the target covers, when either condition is met; none otherwise. */
  private _toDefer(agent: LocalAgent, toolSpecs: readonly ToolSpec[], model: Model): Set<string> {
    const candidates = toolSpecs.filter((spec) => this._targets(agent, spec))
    return new Set(this._conditionsMet(candidates, toolSpecs, model) ? candidates.map((spec) => spec.name) : [])
  }

  /** Whether the target covers the agent's tool and the tool may be deferred. */
  private _targets(agent: LocalAgent, spec: ToolSpec): boolean {
    const tool = agent.toolRegistry.get(spec.name)
    return (
      !PROTECTED_TOOL_NAMES.has(spec.name) &&
      !isManageTool(tool) &&
      // The tool's own schema, since background tasks add a parameter to every schema in the call.
      takesParameters(tool?.toolSpec ?? spec) &&
      (this._matcher?.matchesTool(spec.name) ?? true)
    )
  }

  /**
   * Whether either condition is met, or there are none. `toolCount` counts every tool in the call but the structured
   * output tool, the SDK's own and those kept in full included; `schemaTokens` measures what deferring saves.
   */
  private _conditionsMet(candidates: ToolSpec[], toolSpecs: readonly ToolSpec[], model: Model): boolean {
    if (this._unconditioned) return true
    const toolCount = toolSpecs.filter((spec) => spec.name !== STRUCTURED_OUTPUT_TOOL_NAME).length
    if (this._toolCount !== undefined && toolCount >= this._toolCount) return true
    if (this._schemaTokens === undefined) return false
    const contextWindow = model.modelInfo.limits?.contextWindow || DEFAULT_CONTEXT_WINDOW_LIMIT
    const schemaTokens = candidates.reduce((total, spec) => total + heuristicJson(spec.inputSchema ?? {}), 0)
    return schemaTokens >= this._schemaTokens.of(contextWindow)
  }

  /** Whether the strategy has no conditions, so it defers at any tool count. */
  private get _unconditioned(): boolean {
    return this._toolCount === undefined && this._schemaTokens === undefined
  }

  /**
   * Answers a call to a tool the latest model call deferred, made before the conversation loaded its schema, with the
   * schema instead of running the tool: a stub takes any input, and once a summary removes a load the model can call
   * a deferred tool from memory. Loads are read from the messages, so a load that was summarized away is delivered
   * again. Before the agent's first model call, as when an interrupted call resumes on a restored agent, the guard uses
   * the tools a model call would defer with the agent's tools and model, so an approved call to a tool that wouldn't be
   * deferred runs.
   */
  private async *_guardUnloaded(
    context: ExecuteToolContext,
    next: MiddlewareNextOf<typeof ExecuteToolStage>
  ): AsyncGenerator<AgentStreamEvent, ExecuteToolResult, undefined> {
    const { agent, toolUse } = context
    const { name, toolUseId } = toolUse
    const deferred =
      this._deferred.get(agent) ?? this.callTools(agent, agent.toolRegistry.toolSpecs(), agent.model).deferredTools
    if (!context.tool || !deferred?.has(name) || loadedTools(agent.messages).has(name)) {
      return yield* next(context)
    }
    return {
      result: new ToolResultBlock({
        toolUseId,
        status: 'error',
        content: [
          new TextBlock(
            `Not run: ${name} was called before its parameters were loaded. They are loaded now; call it again.`
          ),
          new ToolReferenceBlock({ name }),
        ],
      }),
    }
  }
}

/** Rejects a target `Offload.defer` can't act on, such as another offload target, or `'toolSpecs'` inside a list. */
function checkTarget(target: unknown): void {
  if (target === 'toolSpecs') return
  const shown = JSON.stringify(target)
  if (!Array.isArray(target)) {
    throw new Error(`Offload.defer target ${shown} is invalid: expected 'toolSpecs' or a list of tool names`)
  }
  if (target.includes('toolSpecs') || target.includes('!toolSpecs')) {
    throw new Error(
      `Offload.defer target ${shown} lists 'toolSpecs', which is not a tool name: use 'toolSpecs' alone, ` +
        "or list only the tools to keep in full, such as ['!shell']"
    )
  }
}

/** Rejects a condition `Offload.defer` doesn't take, such as one of the other offload strategies'. */
function checkConditionNames(conditions: DeferConditions | undefined): void {
  for (const name of Object.keys(conditions ?? {})) {
    if (!CONDITION_NAMES.includes(name)) {
      throw new Error(`unknown condition "${name}": expected ${CONDITION_NAMES.join(' or ')}`)
    }
  }
}

/** The tools a tool result in these messages loaded with a `ToolReferenceBlock`. */
function loadedTools(messages: readonly Message[]): Set<string> {
  const names = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'toolResultBlock') continue
      for (const content of block.content) {
        if (content.type === 'toolReferenceBlock') names.add(content.name)
      }
    }
  }
  return names
}

function parseToolCount(raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return raw
  const shown = typeof raw === 'string' ? `"${raw}"` : String(raw)
  throw new Error(`toolCount=${shown} is invalid: expected a whole tool count above 0`)
}

/** Whether a tool's input schema describes parameters, which its stub leaves out. */
function takesParameters(spec: ToolSpec): boolean {
  const { properties = {}, required = [], additionalProperties, ...rest } = spec.inputSchema ?? {}
  return (
    Object.keys(properties).length > 0 ||
    required.length > 0 ||
    typeof additionalProperties === 'object' ||
    Object.keys(rest).some((keyword) => !ANNOTATION_KEYWORDS.has(keyword))
  )
}

/** Whether the model gets stubs only because nothing says otherwise: not the shared model info, not its config. */
function takesStubsByDefault(model: Model): boolean {
  return (
    model.modelInfo.capabilities?.deferredToolLoading === 'stubs' &&
    model.getConfig().modelInfo?.capabilities?.deferredToolLoading === undefined &&
    lookupModel(model.modelId ?? '') === undefined
  )
}

/** Whether the model defers tools, which only a model that sends every full spec doesn't. */
function defersTools(model: Model): boolean {
  return (model.modelInfo.capabilities?.deferredToolLoading ?? 'unsupported') !== 'unsupported'
}
