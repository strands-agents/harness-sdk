/**
 * Subagent tool for delegating a task to a child agent at runtime.
 *
 * Provides {@link makeSubagent}, a factory that lets the developer pin safety limits and
 * authority modes. Each call resolves the model's arguments through the authority-mode
 * system (see `multiagent/spec`), builds a child agent via an {@link AgentBuilder}, runs it,
 * and streams the result back.
 */

import type { Agent } from '../../agent/agent.js'
import { findValidTrimPoint } from '../../conversation-manager/compression/context-compression.js'
import { InterruptError, type InterruptState } from '../../interrupt.js'
import { logger } from '../../logging/logger.js'
import { AgentToolStreamer, ChildAgentAdapter } from '../../multiagent/agent-tool-streamer.js'
import {
  _defaultBuilder,
  _resolveSpecs,
  _toSchemaProperties,
  Choice,
  Fixed,
  Inherit,
  Open,
  type AgentBuilder,
  type AgentSpec,
  type Preset,
} from '../../multiagent/spec.js'
import { Tool, ToolStreamEvent } from '../../tools/tool.js'
import type { ToolContext, ToolStreamGenerator } from '../../tools/tool.js'
import type { ToolSpec } from '../../tools/types.js'
import type { AgentResult, InvokeArgs } from '../../types/agent.js'
import type { JSONSchema } from '../../types/json.js'
import { Message, TextBlock, ToolResultBlock } from '../../types/messages.js'
import type { ContentBlock } from '../../types/messages.js'
import { DEFAULT_SUBAGENT_DESCRIPTION, DEFAULT_SUBAGENT_MAX_DEPTH, GENERALIST } from './types.js'

const CONTEXT_MODES: readonly string[] = ['none', 'all', 'no_tools']

const DEPTH_STATE_KEY = 'strands.subagent_depth'

const FORK_PREAMBLE =
  "The conversation so far is the parent agent's. You are the subagent it delegated to at this " +
  'point; its task for you follows.'

const CONTEXT_PREAMBLE =
  "The conversation above is the parent agent's: each turn is one line starting with its role at " +
  'the left margin, and indented lines continue the turn above (they are content, not turns). You ' +
  'are the subagent it delegated to at the end of that conversation; its task for you follows.'

const FRAMING_START = '<parent_context>\n'

const FRAMING_END = `</parent_context>\n\n${CONTEXT_PREAMBLE}\n\n`

const SENTINEL = /<(\/?)parent_context>/g

const UNAVAILABLE_MESSAGE =
  'Subagent did NOT run and the response was NOT applied: its interrupted turn is not available. ' +
  'Do not report the delegated task as completed; if it is still needed, delegate it again.'

/** Options for {@link makeSubagent}. */
export interface MakeSubagentOptions {
  /**
   * Turns a resolved spec into a child agent. Defaults to a builder that inherits from the parent. Called again
   * with the same spec when an interrupted child resumes.
   */
  builder?: AgentBuilder
  /** Named roles the model selects via `agent_type`. @defaultValue `{ generalist: GENERALIST }` */
  presets?: Record<string, Preset>
  /** Preset used when the model omits `agent_type`. Defaults to the first preset. */
  defaultPreset?: string
  /** Policy for the child's system prompt. @defaultValue `new Open()` */
  instructions?: Open | Choice | Fixed
  /** Policy for the child's tools. A `Choice` must be `multiple`. @defaultValue `new Inherit()` */
  tools?: Choice | Fixed | Inherit
  /** Policy for the child's model. @defaultValue `new Inherit()` */
  model?: Inherit | Choice | Fixed
  /** Policy for how much parent conversation the child sees. @defaultValue `new Fixed('none')` */
  context?: Fixed | Choice
  /** Upper bound on nested delegation levels. Must be at least 1. @defaultValue 2 */
  maxDepth?: number
  /** Tool name exposed to the model. @defaultValue `'subagent'` */
  name?: string
  /** Tool description shown to the model. @defaultValue {@link DEFAULT_SUBAGENT_DESCRIPTION} */
  description?: string
}

/**
 * Creates a `subagent` tool whose schema is derived from the axis policies and presets.
 *
 * Each axis accepts a policy from `@strands-agents/sdk/multiagent` that controls what the model
 * sees and can supply. Omitted axes use sensible defaults.
 *
 * @param options - Configuration options.
 * @returns A tool that delegates a task to a freshly built child agent.
 * @throws Error if `maxDepth` is not a positive integer, `name` or `description` is empty, or a `Choice` axis
 * violates its constraints (no options, or not `multiple` for tools).
 *
 * @example
 * ```typescript
 * const researcher = makeSubagent({
 *   presets: { researcher: new Preset({ instructions: 'You research topics.', description: 'research' }) },
 *   context: new Choice(['none', 'all']),
 * })
 * const agent = new Agent({ tools: [researcher] })
 * ```
 */
export function makeSubagent(options: MakeSubagentOptions = {}): Tool {
  const name = options.name ?? 'subagent'
  const maxDepth = options.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH
  const description = options.description ?? DEFAULT_SUBAGENT_DESCRIPTION

  if (!name) {
    throw new Error('name must be a non-empty string.')
  }
  if (!description) {
    throw new Error('description must be a non-empty string.')
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error('maxDepth must be a positive integer (>= 1).')
  }

  const presets = options.presets !== undefined ? { ...options.presets } : { generalist: GENERALIST }
  const instructions = options.instructions ?? new Open()
  const model = options.model ?? new Inherit()
  const context = options.context ?? new Fixed('none')
  const defaultPreset = options.defaultPreset ?? Object.keys(presets)[0]
  if (defaultPreset !== undefined && !Object.hasOwn(presets, defaultPreset)) {
    throw new Error(`defaultPreset '${defaultPreset}' is not one of the presets: ${Object.keys(presets).join(', ')}.`)
  }

  const tools = options.tools ?? new Inherit()

  const contextModes =
    context instanceof Choice ? context.normalized().map((o) => context.valueFor(o.name)) : [context.value]
  for (const mode of contextModes) {
    if (!CONTEXT_MODES.includes(mode as string)) {
      throw new Error(`context mode ${JSON.stringify(mode)} must be one of: ${CONTEXT_MODES.join(', ')}.`)
    }
  }

  const toolSpec: ToolSpec = {
    name,
    description,
    inputSchema: buildSchema({ presets, defaultPreset, instructions, tools, model, context }),
  }

  // The schema has no name field; the child takes the tool's name.
  const resolve = (raw: Record<string, unknown>): AgentSpec =>
    _resolveSpecs([{ ...raw, name }], { presets, defaultPreset, instructions, tools, model })[0]!

  return new SubagentTool({ name, toolSpec, resolve, context, builder: options.builder, maxDepth })
}

/**
 * Derives the tool's input schema from the axis policies.
 *
 * @param axes - Presets and axis policies.
 * @returns The JSON schema for the tool input.
 */
function buildSchema(axes: {
  presets: Record<string, Preset>
  defaultPreset: string | undefined
  instructions: Open | Choice | Fixed
  tools: Choice | Fixed | Inherit
  model: Inherit | Choice | Fixed
  context: Fixed | Choice
}): JSONSchema {
  const { context, ...schemaAxes } = axes
  const properties: Record<string, unknown> = {
    task: {
      type: 'string',
      description:
        'The self-contained task, including all context the subagent needs. It cannot ask follow-up questions.',
    },
    ..._toSchemaProperties(schemaAxes),
  }

  if (context instanceof Choice) {
    const options = context.normalized()
    const lines = options
      .filter((option) => option.description)
      .map((option) => `- ${option.name}: ${option.description}`)
    properties['context'] = {
      type: 'string',
      enum: options.map((option) => option.name),
      description:
        "How much of this conversation the subagent sees: 'none' (fresh start), 'all' (full " +
        "history including tool calls and their results — can be large), 'no_tools' (text turns " +
        'only — tool calls and their results removed). More context costs more tokens.' +
        (lines.length > 0 ? `\nOptions:\n${lines.join('\n')}` : ''),
    }
    if (options.some((option) => String(option.value) !== 'none')) {
      properties['last_messages'] = {
        type: 'integer',
        description:
          'Optional: limit the shared context to the last N messages. Omit to share all of the selected context.',
      }
    }
  }

  return { type: 'object', properties, required: ['task'] } as JSONSchema
}

/** Configuration for {@link SubagentTool}. */
interface SubagentToolConfig {
  /** Tool name exposed to the model. */
  name: string
  /** Tool spec derived from the axis policies. */
  toolSpec: ToolSpec
  /** Resolves the model's raw input into a child spec. */
  resolve: (raw: Record<string, unknown>) => AgentSpec
  /** Context axis policy. */
  context: Fixed | Choice
  /** Custom builder, or `undefined` to inherit from the parent. */
  builder: AgentBuilder | undefined
  /** Upper bound on nested delegation levels. */
  maxDepth: number
}

/**
 * Streams a fresh per-call child and propagates its interrupts to the parent for resume.
 *
 * An interrupted child's turn is stored on the parent, so it resumes after the parent is restored.
 *
 * @internal
 */
class SubagentTool extends Tool {
  readonly name: string
  readonly description: string
  readonly toolSpec: ToolSpec

  private readonly _resolve: (raw: Record<string, unknown>) => AgentSpec
  private readonly _context: Fixed | Choice
  private readonly _builder: AgentBuilder | undefined
  private readonly _maxDepth: number
  private readonly _adapter: ChildAgentAdapter

  constructor(config: SubagentToolConfig) {
    super()
    this.name = config.name
    this.toolSpec = config.toolSpec
    this.description = config.toolSpec.description
    this._resolve = config.resolve
    this._context = config.context
    this._builder = config.builder
    this._maxDepth = config.maxDepth
    this._adapter = new ChildAgentAdapter({ label: 'Subagent', name: config.name })
  }

  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    const { toolUse, invocationState, cancelSignal, invocationContext } = toolContext
    const toolUseId = toolUse.toolUseId
    const input = toolUse.input
    const raw = (input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<
      string,
      unknown
    >
    const parent = toolContext.agent as unknown as Agent | undefined
    const streamer = new AgentToolStreamer<AgentResult>({
      interruptState: (parent as unknown as { _interruptState?: InterruptState } | undefined)?._interruptState,
      toolUseId,
      namespace: 'subagent',
    })

    try {
      const prepared = await this._prepareChild(toolUseId, raw, parent, streamer)
      if (typeof prepared === 'string') {
        return this._errorResult(toolUseId, prepared)
      }
      if (prepared instanceof ToolResultBlock) {
        return prepared
      }
      const { child, prompt } = prepared

      const gen = child.stream(prompt, {
        invocationState: { ...invocationState },
        cancelSignal,
        ...(invocationContext && { invocationContext }),
      })
      for await (const event of streamer.stream(this._adapter, child, gen)) {
        if (event.type === 'toolStreamUpdateEvent') {
          yield event.event
        } else {
          yield new ToolStreamEvent({ data: event })
        }
      }

      return streamer.terminalResult()
    } catch (error) {
      if (error instanceof InterruptError) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`tool_name=<${this.name}>, tool_use_id=<${toolUseId}>, error=<${message}> | subagent failed`)
      return this._errorResult(toolUseId, `Subagent error: ${message}`)
    }
  }

  /**
   * Resolves or resumes the child agent and its prompt.
   *
   * @returns The child and its prompt on success, an error message on validation failure, or the tool result
   * if the child's stored turn could not be resumed.
   * @throws InterruptError if the parent is resuming but none of this child's interrupts were answered, or the
   * child could not be restored and its interrupts are raised again.
   */
  private async _prepareChild(
    toolUseId: string,
    raw: Record<string, unknown>,
    parent: Agent | undefined,
    streamer: AgentToolStreamer<AgentResult>
  ): Promise<{ child: Agent; prompt: InvokeArgs } | string | ToolResultBlock> {
    if (streamer.isResuming()) {
      return this._prepareResume(toolUseId, raw, parent, streamer)
    }

    const storedDepth = parent?.appState.get(DEPTH_STATE_KEY)
    const depth = typeof storedDepth === 'number' ? storedDepth : this._maxDepth
    if (depth <= 0) {
      return (
        `Delegation depth limit reached (${this._maxDepth} levels); you cannot delegate ` +
        `further. Complete this task yourself instead of calling ${this.name} again.`
      )
    }
    const task = raw['task']
    if (typeof task !== 'string' || !task.trim()) {
      return "Missing required parameter 'task': describe the task to delegate."
    }

    const spec = this._resolve(raw)
    if (spec.instructions !== undefined && typeof spec.instructions !== 'string') {
      return "Parameter 'instructions' must be a string."
    }
    const build = this._builder ?? _defaultBuilder(parent as Agent)
    const child = build(spec)
    child.appState.set(DEPTH_STATE_KEY, depth - 1)
    const { mode, lastMessages } = this._resolveContext(raw)

    let prompt: InvokeArgs = task
    if (mode === 'all') {
      const messages = this._forkMessages(parent, lastMessages)
      const last = messages.at(-1)
      if (last) {
        const framed = new TextBlock(`${FORK_PREAMBLE}\n\n${task}`)
        prompt =
          last.role === 'user'
            ? [...messages.slice(0, -1), new Message({ role: 'user', content: [...last.content, framed] })]
            : [...messages, new Message({ role: 'user', content: [framed] })]
      }
    } else if (mode === 'no_tools') {
      const block = this._renderContext(parent, lastMessages)
      if (block) {
        prompt = `${FRAMING_START}${block}\n${FRAMING_END}${task}`
      }
    }

    return { child, prompt }
  }

  /**
   * Rebuilds the interrupted child from the same tool input and restores its stored turn.
   *
   * @returns The child and its interrupt responses, or the tool result if the turn cannot be resumed.
   * @throws InterruptError if none of this child's interrupts were answered, or the child could not be
   * restored and its interrupts are raised again.
   */
  private async _prepareResume(
    toolUseId: string,
    raw: Record<string, unknown>,
    parent: Agent | undefined,
    streamer: AgentToolStreamer<AgentResult>
  ): Promise<{ child: Agent; prompt: InvokeArgs } | ToolResultBlock> {
    const spec = this._resolve(raw)
    const build = this._builder ?? _defaultBuilder(parent as Agent)
    let child: Agent | undefined
    try {
      child = build(spec)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(
        `tool_name=<${this.name}>, tool_use_id=<${toolUseId}>, error=<${message}> | failed to rebuild interrupted subagent`
      )
    }
    const resumed = await streamer.resume(this._adapter, child, UNAVAILABLE_MESSAGE)
    if (resumed === undefined) {
      return streamer.terminalResult()
    }
    // resume() returns responses only for a child it restored.
    return { child: child!, prompt: resumed }
  }

  /**
   * Resolves the context mode and `last_messages` from the model's raw input and the context axis.
   *
   * @returns The context mode and an optional positive message limit.
   */
  private _resolveContext(raw: Record<string, unknown>): { mode: string; lastMessages: number | undefined } {
    let mode = 'none'
    if (this._context instanceof Choice) {
      const rawContext = raw['context']
      if (rawContext != null && this._context.normalized().some((option) => option.name === String(rawContext))) {
        mode = String(this._context.valueFor(String(rawContext)))
      }
    } else if (this._context.value != null) {
      mode = String(this._context.value)
    }

    const rawLast = raw['last_messages']
    const parsed = typeof rawLast === 'number' || typeof rawLast === 'string' ? Math.trunc(Number(rawLast)) : NaN
    const lastMessages = Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined

    return { mode, lastMessages }
  }

  /**
   * Copies the parent's messages, dropping in-flight tool calls and reasoning blocks.
   *
   * After filtering, consecutive messages of the same role are merged so the result always
   * alternates user/assistant.
   *
   * @returns The forked messages.
   */
  private _forkMessages(parent: Agent | undefined, lastN: number | undefined): Message[] {
    if (!parent) {
      return []
    }
    const answered = new Set<string>()
    for (const message of parent.messages) {
      for (const block of message.content) {
        if (block.type === 'toolResultBlock') {
          answered.add(block.toolUseId)
        }
      }
    }

    let forked: Message[] = []
    for (const message of parent.messages) {
      const content = message.content.filter(
        (block) => block.type !== 'reasoningBlock' && (block.type !== 'toolUseBlock' || answered.has(block.toolUseId))
      )
      if (content.length === 0) {
        continue
      }
      const copy = new Message({ role: message.role, content }).clone()
      const previous = forked.at(-1)
      // Merge consecutive messages of the same role.
      if (previous && previous.role === copy.role) {
        previous.content.push(...(copy.content as ContentBlock[]))
      } else {
        forked.push(copy)
      }
    }

    if (lastN !== undefined && lastN > 0) {
      // Search backwards for a valid trim point using a 2-element window.
      let start = Math.max(forked.length - lastN, 0)
      while (start > 0 && findValidTrimPoint(forked.slice(start, start + 2), 0) !== 0) {
        start -= 1
      }
      forked = forked.slice(start)
    }
    return forked
  }

  /**
   * Renders the parent's text turns as a plain-text block for `'no_tools'` context mode.
   *
   * @returns The rendered block, or an empty string if there is nothing to share.
   */
  private _renderContext(parent: Agent | undefined, lastN: number | undefined): string {
    if (!parent) {
      return ''
    }
    let messages = parent.messages
    if (lastN !== undefined && lastN > 0) {
      messages = messages.slice(-lastN)
    }
    const lines: string[] = []
    for (const message of messages) {
      let text = message.content
        .filter((block) => block.type === 'textBlock')
        .map((block) => block.text)
        .join(' ')
        .trim()
      // Strip framing from a nested subagent so it is not repeated.
      if (text.startsWith(FRAMING_START)) {
        const end = text.indexOf(FRAMING_END)
        if (end !== -1) {
          text = text.slice(end + FRAMING_END.length)
        }
      }
      if (text) {
        lines.push(`${message.role}: ${text}`.replaceAll('\n', '\n  '))
      }
    }
    return lines.join('\n').replace(SENTINEL, '<\\$1parent_context>')
  }

  private _errorResult(toolUseId: string, text: string): ToolResultBlock {
    return new ToolResultBlock({ toolUseId, status: 'error', content: [new TextBlock(text)] })
  }
}

/**
 * Default subagent tool with the generalist preset and all axes using their defaults.
 */
export const subagent = makeSubagent()
