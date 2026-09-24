/**
 * Delegation tool with a config-derived model-facing schema (design 0017-subagents).
 *
 * Each axis — instructions, tools, model, context — takes an authority mode that decides whether it
 * becomes a model-facing parameter:
 *
 * - `Fixed(value)`  — pinned by the developer; no parameter.
 * - `Inherit()`     — take the parent's value; no parameter.
 * - `Open(...)`     — model writes freely; string parameter.
 * - `Choice(...)`   — model picks from a developer-supplied set of `Option`s by `name`; a
 *   single-value enum, or an array-of-enum when `multiple` is set. The picked name maps back to the
 *   option's `value`. For `tools` the chosen set is re-validated at call time, so a child can never
 *   gain a capability the parent lacked.
 *
 * Named `presets` add an `agent_type` enum. Children are built through an injected `builder`.
 *
 * This mirrors the Python `strands_harness.tools.subagent` module. Two seams differ because the TS SDK
 * models them differently, and both are load-bearing for security (HITL through delegation):
 *
 * - Interrupts propagate by *throwing*, not by yielding a `ToolInterruptEvent`. A child agent's
 *   `stream()` returns an `AgentResult` with `stopReason: 'interrupt'`; to surface that to the
 *   parent, this tool re-raises each child interrupt through `toolContext.interrupt(...)`, which
 *   throws `InterruptError` on the first unanswered one (the parent's tool executor re-throws it to
 *   the parent loop). On resume the parent RE-INVOKES this tool from scratch; the re-run collects
 *   the human's responses from `toolContext.interrupt(...)` and feeds them to the retained child as
 *   `interruptResponse` blocks. `InterruptError` is not exported by the SDK, so it cannot be thrown
 *   directly — `toolContext.interrupt` is the sanctioned bridge.
 * - Cancellation is forwarded by passing the parent tool call's `cancelSignal` straight into
 *   `child.stream(...)` (the TS SDK plumbs `AbortSignal` through), rather than by polling a cancel
 *   event as the Python port does.
 */

import {
  type Agent,
  type ContentBlock,
  InterruptResponseContent,
  type InvokeArgs,
  type JSONSchema,
  type JSONValue,
  type LocalAgent,
  Message,
  type Model,
  type ModelRouter,
  TextBlock,
  Tool,
  type ToolContext,
  ToolResultBlock,
  type ToolSpec,
  ToolStreamEvent,
  type ToolStreamGenerator,
} from '@strands-agents/sdk'

import { DEFAULT_SUBAGENT_MAX_DEPTH } from '../defaults.js'

/** The developer pins the value; the axis contributes no model-facing parameter. */
export class Fixed {
  constructor(readonly value: unknown = null) {}
}

/** The child takes the parent's value; the axis contributes no model-facing parameter. */
export class Inherit {}

/** The model writes the value freely; the axis contributes a string parameter. */
export class Open {}

/**
 * One selectable option. `name` is what the model picks (the enum entry and the key we map back on);
 * `value` is what that choice resolves to, defaulting to `name` so a string-valued axis needs only a
 * name. `description` guides the model.
 */
export class Option {
  readonly value: unknown
  readonly description: string

  constructor(
    readonly name: string,
    options: { value?: unknown; description?: string } = {}
  ) {
    this.value = options.value === undefined ? name : options.value
    this.description = options.description ?? ''
  }
}

/**
 * The model picks from a developer-supplied set by `name`; the axis contributes an enum parameter,
 * or an array-of-enum when `multiple` is set (letting the model pick several).
 *
 * Each entry in `options` is a bare name or an `Option(name, value=name, description='')`. The
 * picked name maps back to the option's `value`; descriptions render into the parameter's
 * `description` (JSON Schema has no per-enum-value doc), the same way `Preset` descriptions surface
 * under `agent_type`. For `tools` the chosen set is re-validated at call time, so a delegate can
 * never exceed the parent's tools.
 */
export class Choice {
  constructor(
    readonly options: readonly unknown[],
    readonly multiple = false
  ) {}

  /** The options as `Option`s (each with `value` defaulted to its `name`), wrapping any bare name. */
  normalized(): Option[] {
    return this.options.map((option) => (option instanceof Option ? option : new Option(String(option))))
  }

  /** The value the picked `name` resolves to; the name itself if it isn't a known option. */
  valueFor(name: string): unknown {
    for (const option of this.normalized()) {
      if (option.name === name) {
        return option.value
      }
    }
    return name
  }

  /** Whether `name` is one of the offered options (used to reject off-enum model input). */
  has(name: string): boolean {
    return this.normalized().some((option) => option.name === name)
  }
}

/** How much of the parent conversation the child sees. */
export type ContextMode = 'none' | 'all' | 'no_tools'

/** Options accepted by the {@link Preset} constructor. */
export interface PresetOptions {
  instructions?: string
  tools?: readonly string[] // omitted inherits the parent's tools
  model?: Model | ModelRouter | string
  context?: ContextMode
  lastMessages?: number | null // cap shared context to the last N messages; null = all
  description?: string
}

/** A named role: a partially applied child configuration selected via `agent_type`. */
export class Preset {
  readonly instructions: string | undefined
  readonly tools: readonly string[] | undefined
  readonly model: Model | ModelRouter | string | undefined
  readonly context: ContextMode
  readonly lastMessages: number | null
  readonly description: string

  constructor(options: PresetOptions = {}) {
    this.instructions = options.instructions
    this.tools = options.tools
    this.model = options.model
    this.context = options.context ?? 'none'
    this.lastMessages = options.lastMessages ?? null
    this.description = options.description ?? ''
  }
}

export const GENERALIST_INSTRUCTIONS =
  'You are a general-purpose subagent handling a focused subtask on behalf of a parent agent. ' +
  'You run in your own fresh conversation and cannot ask follow-up questions, so work from the ' +
  'task as given, make reasonable assumptions where it is underspecified, and see it through to a ' +
  'verified result. Return a self-contained answer: state what you did, what you found, and ' +
  'anything the parent needs to act on. Your final message is the only thing that returns to the ' +
  'parent, so put the substance there rather than in intermediate steps.'

export const GENERALIST = new Preset({
  instructions: GENERALIST_INSTRUCTIONS,
  description: 'a general-purpose agent for a focused subtask that runs in its own context',
})

/** The resolved child configuration handed to the builder: config + the model's arguments. */
export class AgentSpec {
  task: string
  agentType: string | null
  instructions: string | null
  tools: string[] | null // null inherits the parent's tools
  mcpServers: string[] | null // null inherits all the parent's MCP servers
  model: Model | ModelRouter | string | null // null inherits the parent's model
  context: ContextMode
  lastMessages: number | null // cap shared context to the last N messages; null = all

  constructor(task: string, agentType: string | null = null) {
    this.task = task
    this.agentType = agentType
    this.instructions = null
    this.tools = null
    this.mcpServers = null
    this.model = null
    this.context = 'none'
    this.lastMessages = null
  }
}

/** The builder turns a resolved spec into a child agent, built the way the parent was. */
export type AgentBuilder = (spec: AgentSpec) => Agent | Promise<Agent>

/** An axis mode for the `instructions` parameter. */
export type InstructionsMode = Open | Choice | Fixed
/** An axis mode for the `tools` parameter. */
export type ToolsMode = Choice | Fixed | Inherit
/** An axis mode for the `mcp_servers` parameter. */
export type McpServersMode = Choice | Fixed | Inherit
/** An axis mode for the `model` parameter. */
export type ModelMode = Inherit | Choice | Fixed
/** An axis mode for the `context` parameter. */
export type ContextAxis = Fixed | Choice

export const CONTEXT_MODES: readonly ContextMode[] = ['none', 'all', 'no_tools']

// Depth travels on each child's own state, not a build-time parameter.
const DEPTH_STATE_KEY = 'subagentDepth'

/** The option names a `Choice` axis (tools, mcp_servers) admits, or `null` when it exposes none. */
function allowedNames(axis: ToolsMode): string[] | null {
  if (axis instanceof Choice) {
    return axis.normalized().map((option) => option.name)
  }
  return null
}

function describeRoles(base: string, presets: Readonly<Record<string, Preset>>): string {
  const names = Object.keys(presets)
  if (names.length === 0) {
    return base
  }
  const roles = names.map((name) => `- ${name}: ${presets[name]?.description || name}`).join('\n')
  return `${base}\n\nAvailable subagents (agent_type):\n${roles}`
}

/**
 * A `string` enum prop (an array-of-enum when `choice.multiple`); per-option descriptions render
 * into the prop's `description` so each value guides the model (JSON Schema has no per-enum-value
 * doc).
 */
function choiceProp(choice: Choice, base = ''): JSONSchema {
  const options = choice.normalized()
  const values = options.map((option) => option.name)
  const lines = options.filter((o) => o.description).map((o) => `- ${o.name}: ${o.description}`)
  let desc = base
  if (lines.length > 0) {
    const rendered = 'Options:\n' + lines.join('\n')
    desc = base ? `${base}\n${rendered}` : rendered
  }
  const prop: JSONSchema = choice.multiple
    ? { type: 'array', items: { type: 'string', enum: values } }
    : { type: 'string', enum: values }
  if (desc) {
    prop.description = desc
  }
  return prop
}

interface BuildSchemaArgs {
  presets: Readonly<Record<string, Preset>>
  instructions: InstructionsMode
  tools: ToolsMode
  mcpServers: McpServersMode
  model: ModelMode
  context: ContextAxis
}

/** Derive the input schema from the axis modes: each axis adds zero or one parameter. */
function buildSchema({ presets, instructions, tools, mcpServers, model, context }: BuildSchemaArgs): JSONSchema {
  const props: Record<string, JSONSchema> = {
    task: {
      type: 'string',
      description:
        'The self-contained task, including all context the subagent needs. It starts from a ' +
        'blank conversation and cannot ask follow-up questions.',
    },
  }
  const required = ['task']

  const presetNames = Object.keys(presets)
  if (presetNames.length > 0) {
    props.agent_type = {
      type: 'string',
      enum: presetNames,
      description: 'Which subagent role to use. Omit to use the default.',
    }
  }

  if (instructions instanceof Open) {
    props.instructions = { type: 'string', description: "A system prompt defining the subagent's role." }
  } else if (instructions instanceof Choice) {
    props.instructions = choiceProp(instructions, "A system prompt defining the subagent's role.")
  }

  if (tools instanceof Choice) {
    props.tools = choiceProp(tools, 'Subset of tools to grant the subagent. Fewer is safer; it cannot exceed your own.')
  }

  if (mcpServers instanceof Choice) {
    props.mcp_servers = choiceProp(
      mcpServers,
      'Subset of MCP servers whose tools to grant the subagent. Fewer is safer; it cannot exceed ' +
        'your own. Omit to grant all of them.'
    )
  }

  if (model instanceof Choice) {
    props.model = choiceProp(model, 'Which model the subagent runs on.')
  }

  if (context instanceof Choice) {
    const modes = context.normalized().map((option) => String(option.value))
    props.context = choiceProp(
      context,
      "How much of this conversation the subagent sees: 'none' (fresh start), 'all' (full history " +
        "including tool calls and their results — can be large), 'no_tools' (text turns only — tool calls and their results removed). " +
        'More context costs more tokens.'
    )
    if (modes.some((mode) => mode !== 'none')) {
      props.last_messages = {
        type: 'integer',
        description:
          'Optional: limit the shared context to the last N messages. Omit to share all of the ' + 'selected context.',
      }
    }
  }

  return { type: 'object', properties: props, required }
}

interface ResolveArgs {
  presets: Readonly<Record<string, Preset>>
  defaultPreset: string | null
  instructions: InstructionsMode
  tools: ToolsMode
  mcpServers: McpServersMode
  model: ModelMode
  context: ContextAxis
  allowed: readonly string[] | null
  allowedMcp: readonly string[] | null
}

/**
 * Combine the model's arguments, the selected preset, and the fixed axes into a spec.
 *
 * Precedence per axis: a model-supplied argument wins, then the preset's value, then the axis
 * default (`Fixed`/`Inherit`). An omitted `agent_type` falls back to the default preset, so a bare
 * `subagent({ task })` behaves like the default role.
 */
function resolveSpec(raw: Record<string, JSONValue>, args: ResolveArgs): AgentSpec {
  const { presets, defaultPreset, instructions, tools, mcpServers, model, context, allowed, allowedMcp } = args
  const task = String(raw.task)
  // agent_type is a closed enum; `Object.hasOwn` (not `in`) so "constructor" can't resolve as a preset.
  const rawAgentType = raw.agent_type
  const isKnownPreset = typeof rawAgentType === 'string' && Object.hasOwn(presets, rawAgentType)
  if (rawAgentType !== undefined && rawAgentType !== null && !isKnownPreset) {
    throw new Error(
      `Unknown agent_type ${JSON.stringify(rawAgentType)}; valid values: ${Object.keys(presets).join(', ')}.`
    )
  }
  // Ad-hoc instructions (only possible when the axis exposes one) override the default preset.
  const overridingInstructions =
    (instructions instanceof Open || instructions instanceof Choice) && 'instructions' in raw
  const agentType = isKnownPreset ? rawAgentType : overridingInstructions ? null : defaultPreset
  const preset = agentType && Object.hasOwn(presets, agentType) ? presets[agentType] : undefined

  const spec = new AgentSpec(task, agentType ?? null)

  // instructions — honored only when the axis exposes one (Open, or a Choice offering the name).
  if ('instructions' in raw && instructions instanceof Open) {
    spec.instructions = String(raw.instructions)
  } else if ('instructions' in raw && instructions instanceof Choice && instructions.has(String(raw.instructions))) {
    spec.instructions = String(instructions.valueFor(String(raw.instructions)))
  } else if (preset !== undefined) {
    spec.instructions = preset.instructions ?? null
  } else if (instructions instanceof Fixed) {
    spec.instructions = instructions.value === null ? null : String(instructions.value)
  }

  // tools — model picks option names; each maps to its value (the real tool name granted), clamped.
  if ('tools' in raw && allowed !== null && tools instanceof Choice) {
    const requested = Array.isArray(raw.tools) ? raw.tools : typeof raw.tools === 'string' ? [raw.tools] : []
    spec.tools = requested
      .map((t) => String(t))
      .filter((t) => allowed.includes(t))
      .map((t) => String(tools.valueFor(t)))
  } else if (preset !== undefined && preset.tools !== undefined) {
    if (allowed !== null && tools instanceof Choice) {
      const allowedValues = new Set(allowed.map((n) => String(tools.valueFor(n))))
      spec.tools = preset.tools.filter((t) => allowedValues.has(t))
    } else {
      spec.tools = [...preset.tools]
    }
  } else if (tools instanceof Choice && tools.multiple && allowed !== null) {
    spec.tools = allowed.map((n) => String(tools.valueFor(n)))
  } else if (tools instanceof Fixed) {
    spec.tools = Array.isArray(tools.value) ? tools.value.map((t) => String(t)) : null
  }

  // mcp_servers — model picks server names, clamped to the parent's set; omitted inherits all.
  if ('mcp_servers' in raw && allowedMcp !== null && mcpServers instanceof Choice) {
    const requested = Array.isArray(raw.mcp_servers)
      ? raw.mcp_servers
      : typeof raw.mcp_servers === 'string'
        ? [raw.mcp_servers]
        : []
    spec.mcpServers = requested
      .map((n) => String(n))
      .filter((n) => allowedMcp.includes(n))
      .map((n) => String(mcpServers.valueFor(n)))
  } else if (mcpServers instanceof Choice && mcpServers.multiple && allowedMcp !== null) {
    spec.mcpServers = allowedMcp.map((n) => String(mcpServers.valueFor(n)))
  } else if (mcpServers instanceof Fixed) {
    spec.mcpServers = Array.isArray(mcpServers.value) ? mcpServers.value.map((n) => String(n)) : null
  }

  // model — the picked name maps back to its value; an off-enum name is ignored.
  if ('model' in raw && model instanceof Choice && model.has(String(raw.model))) {
    spec.model = model.valueFor(String(raw.model)) as Model | string
  } else if (preset !== undefined && preset.model !== undefined) {
    spec.model = preset.model
  } else if (model instanceof Fixed) {
    spec.model = (model.value ?? null) as Model | string | null
  }

  // context — honored only when the Choice offers the name; off-enum can't flip a Fixed('none') delegate.
  if ('context' in raw && context instanceof Choice && context.has(String(raw.context))) {
    spec.context = String(context.valueFor(String(raw.context))) as ContextMode
  } else if (preset !== undefined) {
    spec.context = preset.context
    spec.lastMessages = preset.lastMessages
  } else if (context instanceof Fixed && context.value !== null && context.value !== undefined) {
    spec.context = String(context.value) as ContextMode
  }

  // last_messages — a model-supplied cap wins when the axis exposes it.
  if ('last_messages' in raw && raw.last_messages !== null && raw.last_messages !== undefined) {
    const parsed = Number(raw.last_messages)
    spec.lastMessages = Number.isFinite(parsed) ? Math.trunc(parsed) : null
  }

  return spec
}

/**
 * Whether the SDK's conversation managers would cut the history at `index` — a user message that is
 * not a tool result and not a tool use without its result right after. Mirrors the SDK's
 * `findValidTrimPoint(messages, index) === index` (`conversation-manager/compression`), duplicated
 * here until the SDK exports it.
 */
function isValidTrimPoint(messages: Message[], index: number): boolean {
  const message = messages[index] as Message
  if (message.role !== 'user' || message.content.some((block) => block.type === 'toolResultBlock')) {
    return false
  }
  if (message.content.some((block) => block.type === 'toolUseBlock')) {
    return messages[index + 1]?.content.some((block) => block.type === 'toolResultBlock') ?? false
  }
  return true
}

/**
 * The parent's messages for `'all'` mode — real content blocks (tool calls, results, images), not a
 * text rendering. Tool calls still in flight — the delegating call itself and any parallel siblings,
 * which nothing has answered yet — are dropped so the history stays valid, and so are reasoning
 * blocks: they are the parent model's own signed state, and other models reject them (Bedrock:
 * "User messages cannot contain reasoning content"). The blocks are deep copies, so nothing the
 * child's SDK does to its history can reach the parent's. `lastN` is widened back
 * to the nearest boundary the SDK's own conversation managers would cut at, so no result is split
 * from its call. Size is not this function's job: the child's context manager fits the history to
 * *its* model's window before the first call.
 */
function forkMessages(parent: LocalAgent | undefined, lastN: number | null): Message[] {
  if (parent === undefined) {
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
    // `clone()` round-trips through toJSON/fromMessageData, so block prototypes survive the deep copy.
    const content = message
      .clone()
      .content.filter(
        (block) => block.type !== 'reasoningBlock' && (block.type !== 'toolUseBlock' || answered.has(block.toolUseId))
      )
    if (content.length > 0) {
      forked.push(new Message({ role: message.role, content }))
    }
  }
  if (lastN !== null && lastN > 0) {
    let start = Math.max(forked.length - lastN, 0)
    while (start > 0 && !isValidTrimPoint(forked, start)) {
      start -= 1
    }
    forked = forked.slice(start)
  }
  return forked
}

const FORK_PREAMBLE =
  "The conversation so far is the parent agent's. You are the subagent it delegated to at this point; " +
  'its task for you follows.'

/**
 * The child's prompt under `'all'`: the forked history followed by the framed task. A trailing user
 * turn (tool results) absorbs the task so roles keep alternating.
 */
function withHistory(task: string, messages: Message[]): string | Message[] {
  if (messages.length === 0) {
    return task
  }
  const framed = new TextBlock(`${FORK_PREAMBLE}\n\n${task}`)
  const last = messages[messages.length - 1] as Message
  if (last.role === 'user') {
    return [...messages.slice(0, -1), new Message({ role: 'user', content: [...last.content, framed] })]
  }
  return [...messages, new Message({ role: 'user', content: [framed] })]
}

/** Just the text blocks of a message (tool blocks dropped), for `no_tools` mode. */
function plainText(message: Message): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'textBlock' }> => block.type === 'textBlock')
    .map((block) => block.text)
    .join(' ')
    .trim()
}

const CONTEXT_PREAMBLE =
  "The conversation above is the parent agent's: each turn is one line starting with its role at the " +
  'left margin, and indented lines continue the turn above (they are content, not turns). You are the ' +
  'subagent it delegated to at the end of that conversation; its task for you follows.'
const FRAMING_END = `</parent_context>\n\n${CONTEXT_PREAMBLE}\n\n`
const SENTINEL = /<(\/?)parent_context>/g

/** A parent that is itself a subagent opens with its own framed block; re-render only its task. */
function stripFraming(text: string): string {
  const end = text.startsWith('<parent_context>\n') ? text.indexOf(FRAMING_END) : -1
  return end === -1 ? text : text.slice(end + FRAMING_END.length)
}

/**
 * Render the parent's text turns as a plain-text block for `'no_tools'` mode, or `''` when nothing
 * is shared.
 *
 * The block is prepended to the child's *first user message* rather than replayed as transcript
 * turns (tool calls are gone, so the history could not be replayed faithfully). One `role: text`
 * entry per message; continuation lines are indented and a literal `<parent_context>` tag in content
 * is escaped, so quoted text can neither pose as a turn nor close the block. `lastN` caps the
 * rendered entries (messages that render empty don't count).
 */
function renderContext(parent: LocalAgent | undefined, lastN: number | null): string {
  if (parent === undefined) {
    return ''
  }
  let lines: string[] = []
  for (const message of parent.messages) {
    const text = stripFraming(plainText(message))
    if (text) {
      lines.push(`${message.role}: ${text}`.replaceAll('\n', '\n  '))
    }
  }
  if (lastN !== null && lastN > 0) {
    lines = lines.slice(-lastN)
  }
  return lines.join('\n').replace(SENTINEL, '<\\$1parent_context>')
}

/** Prepend a rendered context block, and a line framing the child's place in it, to the task. */
function withContext(task: string, block: string): string {
  if (!block) {
    return task
  }
  return `<parent_context>\n${block}\n</parent_context>\n\n${CONTEXT_PREAMBLE}\n\n${task}`
}

function errorResult(toolUseId: string, message: string): ToolResultBlock {
  return new ToolResultBlock({ toolUseId, status: 'error', content: [new TextBlock(message)] })
}

function errorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(input: JSONValue): Record<string, JSONValue> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, JSONValue>)
    : {}
}

/** Streams a fresh per-call child and propagates its interrupts to the parent for resume. */
class SubagentTool extends Tool {
  readonly name: string
  readonly description: string
  readonly toolSpec: ToolSpec
  private readonly resolve: (raw: Record<string, JSONValue>) => AgentSpec
  private readonly builder: AgentBuilder
  private readonly maxDepth: number
  // Children awaiting a resume, keyed by the tool-use id that interrupted.
  readonly pending = new Map<string, Agent>()

  constructor(
    name: string,
    toolSpec: ToolSpec,
    resolve: (raw: Record<string, JSONValue>) => AgentSpec,
    builder: AgentBuilder,
    maxDepth: number
  ) {
    super()
    this.name = name
    this.description = toolSpec.description
    this.toolSpec = toolSpec
    this.resolve = resolve
    this.builder = builder
    this.maxDepth = maxDepth
  }

  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    const { toolUse, invocationState, cancelSignal } = toolContext
    const parent = toolContext.agent
    const toolUseId = toolUse.toolUseId
    const raw = asRecord(toolUse.input)

    let child = this.pending.get(toolUseId)
    let prompt: InvokeArgs

    if (child !== undefined && child._interruptState.activated) {
      // Resume: feed the parent's answers to the retained child; `toolContext.interrupt` throws if unanswered.
      const responses: InterruptResponseContent[] = []
      for (const interrupt of child._interruptState.getInterruptsList()) {
        const response = toolContext.interrupt<JSONValue>({
          name: interrupt.id,
          ...(interrupt.reason !== undefined && { reason: interrupt.reason }),
        })
        responses.push(new InterruptResponseContent({ interruptId: interrupt.id, response }))
      }
      prompt = responses
    } else {
      const storedDepth = parent === undefined ? undefined : parent.appState.get(DEPTH_STATE_KEY)
      // A non-finite stored depth fails closed (0), never slipping past the `<= 0` guard as NaN.
      const parsedDepth = Number(storedDepth)
      const depth = storedDepth === undefined ? this.maxDepth : Number.isFinite(parsedDepth) ? parsedDepth : 0
      if (depth <= 0) {
        return errorResult(
          toolUseId,
          `Delegation depth limit reached (${this.maxDepth} levels); you cannot delegate further. ` +
            'Complete this task yourself instead of calling subagent again.'
        )
      }
      // resolve/build/render can throw; surface it as an error tool result, not an uncaught exception.
      try {
        const spec = this.resolve(raw)
        child = await this.builder(spec)
        child.appState.set(DEPTH_STATE_KEY, depth - 1)
        if (spec.context === 'all') {
          prompt = withHistory(spec.task, forkMessages(parent, spec.lastMessages))
        } else if (spec.context === 'no_tools') {
          prompt = withContext(spec.task, renderContext(parent, spec.lastMessages))
        } else {
          prompt = spec.task
        }
      } catch (error) {
        this.pending.delete(toolUseId)
        return errorResult(toolUseId, `Subagent error: ${errorString(error)}`)
      }
    }

    let result
    try {
      // Forward cancel signal + invocation state (mirrors the SDK's AgentAsTool).
      const gen = child.stream(prompt, { invocationState, cancelSignal })
      let next = await gen.next()
      while (!next.done) {
        yield new ToolStreamEvent({ data: next.value })
        next = await gen.next()
      }
      result = next.value
    } catch (error) {
      this.pending.delete(toolUseId)
      return errorResult(toolUseId, `Subagent error: ${errorString(error)}`)
    }

    if (result === undefined) {
      // A child stream that returns nothing surfaces an error rather than throwing on result.stopReason.
      this.pending.delete(toolUseId)
      return errorResult(toolUseId, 'Subagent produced no result.')
    }

    if (result.stopReason === 'interrupt' && result.interrupts !== undefined && result.interrupts.length > 0) {
      // Retain the child for resume and re-raise its interrupts (OUTSIDE the try, so the throw propagates).
      this.pending.set(toolUseId, child)
      for (const interrupt of result.interrupts) {
        toolContext.interrupt({
          name: interrupt.id,
          ...(interrupt.reason !== undefined && { reason: interrupt.reason }),
        })
      }
    }

    if (result.stopReason === 'cancelled') {
      // Cancellation is data, not an exception: surface it as an error result, not a success.
      this.pending.delete(toolUseId)
      return errorResult(toolUseId, 'Subagent was cancelled.')
    }

    this.pending.delete(toolUseId)
    return new ToolResultBlock({ toolUseId, status: 'success', content: [new TextBlock(result.toString())] })
  }
}

/** Options for {@link makeSubagent}. */
export interface MakeSubagentOptions {
  /** Turns a resolved spec into a child agent, built the way the parent was. */
  builder: AgentBuilder
  /** Named roles selectable via `agent_type`. */
  presets?: Readonly<Record<string, Preset>>
  /** The preset used when the model omits `agent_type`. Defaults to the first preset. */
  defaultPreset?: string | null
  /** Authority mode for `instructions`. Defaults to `Open()`. */
  instructions?: InstructionsMode
  /** Authority mode for `tools`. Defaults to a multiple `Choice` over `inheritedTools`. */
  tools?: ToolsMode
  /** Authority mode for `mcp_servers`. Defaults to a multiple `Choice` over `inheritedMcpServers`. */
  mcpServers?: McpServersMode
  /** Authority mode for `model`. Defaults to `Inherit()`. */
  model?: ModelMode
  /** Authority mode for `context`. Defaults to `Fixed('none')`. */
  context?: ContextAxis
  /** The parent's tool names, used to build the default `tools` Choice. */
  inheritedTools?: readonly string[]
  /** The parent's MCP server names, used to build the default `mcp_servers` Choice. */
  inheritedMcpServers?: readonly string[]
  /** Bounds delegation depth; the tool refuses at 0. Defaults to {@link DEFAULT_SUBAGENT_MAX_DEPTH}. */
  maxDepth?: number
  /** Tool name. Defaults to `'subagent'`. */
  name?: string
}

/**
 * Build a `subagent` tool whose schema follows the axis modes and preset map.
 *
 * `maxDepth` bounds delegation depth: each child's remaining budget is stored on its own
 * `agent.appState` right after it's built (not passed to `builder`), read back the next time this
 * tool is called on that child, and decremented again. At 0 the tool refuses with an error result
 * rather than building another child, so recursion is bounded without threading depth through the
 * builder's construction path.
 */
export function makeSubagent(options: MakeSubagentOptions): Tool {
  const presets: Record<string, Preset> = { ...(options.presets ?? {}) }
  const instructions: InstructionsMode = options.instructions ?? new Open()
  const model: ModelMode = options.model ?? new Inherit()
  const context: ContextAxis = options.context ?? new Fixed('none')
  const inheritedTools = options.inheritedTools ?? []
  const inheritedMcpServers = options.inheritedMcpServers ?? []
  const maxDepth = options.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH
  const name = options.name ?? 'subagent'

  const presetNames = Object.keys(presets)
  let defaultPreset = options.defaultPreset ?? null
  if (defaultPreset === null && presetNames.length > 0) {
    defaultPreset = presetNames[0] ?? null
  }

  // Default the tools axis to a multiple Choice over the inherited tools; a tools Choice must be multiple.
  let tools: ToolsMode
  if (options.tools === undefined) {
    tools = new Choice([...inheritedTools], true)
  } else {
    tools = options.tools
    if (tools instanceof Choice) {
      if (tools.options.length === 0) {
        throw new Error('tools=Choice([]) offers no options; use Fixed([]) for a toolless child, or Inherit().')
      }
      if (!tools.multiple) {
        throw new Error('tools=Choice(...) must be multiple=true; a subagent selects a subset of tools.')
      }
    }
  }

  // mcp_servers mirrors tools: a multiple Choice over the parent's servers, or no parameter (Inherit)
  // when the parent has none.
  let mcpServers: McpServersMode
  if (options.mcpServers === undefined) {
    mcpServers = inheritedMcpServers.length > 0 ? new Choice([...inheritedMcpServers], true) : new Inherit()
  } else {
    mcpServers = options.mcpServers
    if (mcpServers instanceof Choice) {
      if (mcpServers.options.length === 0) {
        throw new Error('mcp_servers=Choice([]) offers no options; use Fixed([]) for no servers, or Inherit().')
      }
      if (!mcpServers.multiple) {
        throw new Error('mcp_servers=Choice(...) must be multiple=true; a subagent selects a subset of servers.')
      }
    }
  }

  const allowed = allowedNames(tools)
  const allowedMcp = allowedNames(mcpServers)
  const schema = buildSchema({ presets, instructions, tools, mcpServers, model, context })
  const baseDescription =
    'Delegate a self-contained task to a subagent that runs in its own context and returns a final ' +
    'report. Reach for this when a subtask would otherwise flood your context with intermediate ' +
    'work and you only need its conclusion. Do not poll for progress or redo its work.'
  const toolSpec: ToolSpec = {
    name,
    description: describeRoles(baseDescription, presets),
    inputSchema: schema,
  }

  const resolve = (raw: Record<string, JSONValue>): AgentSpec =>
    resolveSpec(raw, { presets, defaultPreset, instructions, tools, mcpServers, model, context, allowed, allowedMcp })

  return new SubagentTool(name, toolSpec, resolve, options.builder, maxDepth)
}
