/**
 * Multi-agent specification and resolution.
 *
 * Provides the authority-mode system for model-driven multi-agent patterns, where the
 * model configures child agents at runtime. The developer sets axis policies that shape
 * the parameters the model sees and govern what values it can supply:
 *
 * - {@link Fixed}   — developer-pinned value; hidden from the model.
 * - {@link Inherit} — value taken from the parent agent; hidden from the model.
 * - {@link Open}    — model supplies a free-form value.
 * - {@link Choice}  — model picks from a developer-supplied set.
 */

import type { Model } from '../models/model.js'
import type { ModelRouter } from '../models/routing/router.js'
import { Agent } from '../agent/agent.js'
import type { Tool } from '../tools/tool.js'
import { logger } from '../logging/logger.js'
import type { Sandbox } from '../sandbox/base.js'
import type { Printer } from '../agent/printer.js'
import type { Tracer } from '../telemetry/tracer.js'
import type { AttributeValue } from '@opentelemetry/api'
import type { InterventionRegistry } from '../interventions/registry.js'

/** Turns a resolved spec into a child agent, built the way the parent was. */
export type AgentBuilder = (spec: AgentSpec) => Agent

/**
 * Sentinel so `undefined` can be a legitimate {@link Option.value}.
 *
 * @internal
 */
export const UNSET: unique symbol = Symbol('UNSET')

/**
 * Model-facing description of each axis property.
 *
 * @internal
 */
export const AXIS_DESCRIPTIONS = {
  agent_type: 'Role to assign this agent.',
  instructions: "A system prompt defining this agent's role.",
  tools:
    'Subset of tools to grant this agent. Fewer is safer; it cannot exceed your own. ' +
    'Omit to grant all inherited tools.',
  model: "Which model this agent runs on. Omit to inherit the parent's model.",
} as const

/** The developer pins the value; the axis contributes no model-facing parameter. */
export class Fixed {
  readonly value: unknown

  constructor(value: unknown = undefined) {
    this.value = value
    Object.freeze(this)
  }
}

/** The child takes the parent's value; the axis contributes no model-facing parameter. */
export class Inherit {
  constructor() {
    Object.freeze(this)
  }
}

/** The model writes the value freely; the axis contributes a string parameter. */
export class Open {
  constructor() {
    Object.freeze(this)
  }
}

/** A selectable entry in a {@link Choice}. */
export class Option {
  readonly name: string
  readonly value: unknown
  readonly description: string

  constructor(name: string, value: unknown = UNSET, description: string = '') {
    this.name = name
    this.value = value
    this.description = description
    Object.freeze(this)
  }
}

/**
 * The model picks from a developer-supplied set.
 *
 * Each entry is a bare name or an {@link Option}. Set `multiple` to `true` to let the model
 * pick more than one.
 */
export class Choice {
  readonly options: readonly (string | Option)[]
  readonly multiple: boolean

  /**
   * @param options - Bare names or {@link Option} instances the model can pick from.
   * @param multiple - When `true`, the axis produces an array enum allowing multiple selections.
   */
  constructor(options: readonly (string | Option)[], multiple: boolean = false) {
    this.options = options
    this.multiple = multiple
    Object.freeze(this)
  }

  /**
   * Returns the options as {@link Option} instances with `value` resolved, wrapping bare names.
   *
   * @returns Normalized options with {@link UNSET} values filled from their name.
   */
  normalized(): Option[] {
    const result: Option[] = []
    for (const entry of this.options) {
      if (entry instanceof Option) {
        result.push(entry.value !== UNSET ? entry : new Option(entry.name, entry.name, entry.description))
      } else {
        const name = String(entry)
        result.push(new Option(name, name))
      }
    }
    return result
  }

  /**
   * Returns the resolved value behind `name`, or `name` itself if unknown (passthrough).
   *
   * @param name - The option name selected by the model.
   * @returns The mapped value, or `name` when no matching option exists.
   */
  valueFor(name: string): unknown {
    for (const option of this.normalized()) {
      if (option.name === name) {
        return option.value
      }
    }
    return name
  }
}

/** Any authority mode an axis can take. */
export type Axis = Fixed | Inherit | Open | Choice

/** Options for constructing a {@link Preset}. */
export interface PresetOptions {
  instructions?: string
  tools?: readonly string[]
  model?: Model | ModelRouter | string
  description?: string
}

/**
 * A named role: a partially applied child configuration selected via `agent_type`.
 */
export class Preset {
  readonly instructions: string | undefined
  readonly tools: readonly string[] | undefined
  readonly model: Model | ModelRouter | string | undefined
  readonly description: string

  /**
   * @param options - Partial preset configuration.
   */
  constructor(options: PresetOptions = {}) {
    this.instructions = options.instructions
    this.tools = options.tools
    this.model = options.model
    this.description = options.description ?? ''
    Object.freeze(this)
  }
}

/**
 * Resolved child configuration handed to the builder.
 */
export class AgentSpec {
  name: string | undefined
  agentType: string | undefined
  instructions: string | undefined
  tools: string[] | undefined
  model: Model | ModelRouter | string | undefined

  /**
   * @param data - Partial spec fields; unset fields receive safe defaults.
   */
  constructor(data: Partial<AgentSpec> = {}) {
    this.name = data.name
    this.agentType = data.agentType
    this.instructions = data.instructions
    this.tools = data.tools
    this.model = data.model
  }
}

/**
 * Axes passed to {@link _toSchemaProperties}; omitted axes are hidden from the model.
 * @internal Not part of the public API.
 */
export interface SchemaAxes {
  presets: Record<string, Preset>
  defaultPreset: string | undefined
  instructions?: Axis | undefined
  tools?: Axis | undefined
  model?: Axis | undefined
}

/**
 * Renders each model-visible axis, plus an `agent_type` choice over the presets, as JSON Schema properties.
 *
 * @param axes - Presets and axis policies.
 * @returns JSON Schema properties keyed by axis name.
 * @throws Error if a {@link Choice} axis has no options, or a `tools` {@link Choice} is not `multiple`.
 * @internal Not part of the public API.
 */
export function _toSchemaProperties(axes: SchemaAxes): Record<string, unknown> {
  const { presets, defaultPreset } = axes
  const presetEntries = Object.entries(presets)
  const agentType =
    presetEntries.length > 0
      ? new Choice(presetEntries.map(([name, preset]) => new Option(name, UNSET, describePreset(preset))))
      : undefined
  const entries: [keyof typeof AXIS_DESCRIPTIONS, Axis | undefined][] = [
    ['agent_type', agentType],
    ['instructions', axes.instructions],
    ['tools', axes.tools],
    ['model', axes.model],
  ]
  const properties: Record<string, unknown> = {}
  for (const [key, axis] of entries) {
    let description: string = AXIS_DESCRIPTIONS[key]
    if (key === 'agent_type' && defaultPreset !== undefined) {
      description = `${description} Omit to use the default ('${defaultPreset}').`
    }
    if (axis instanceof Open) {
      properties[key] = { type: 'string', description }
      continue
    }
    if (!(axis instanceof Choice)) {
      continue
    }
    const options = axis.normalized()
    if (options.length === 0) {
      throw new Error(
        `${key}: new Choice([]) offers no options; use new Fixed(...), or omit ${key} to use its default.`
      )
    }
    if (key === 'tools' && !axis.multiple) {
      throw new Error(`${key}: new Choice(...) must set multiple to true; a child agent selects a subset of ${key}.`)
    }
    const values = options.map((option) => option.name)
    const lines = options
      .filter((option) => option.description)
      .map((option) => `- ${option.name}: ${option.description}`)
    if (lines.length > 0) {
      description = `${description}\nOptions:\n${lines.join('\n')}`
    }
    properties[key] = axis.multiple
      ? { type: 'array', items: { type: 'string', enum: values }, description }
      : { type: 'string', enum: values, description }
  }
  return properties
}

/**
 * Describes a preset by its description plus which fields it sets, omitting instruction text to keep the schema
 * small.
 */
function describePreset(preset: Preset): string {
  const parts: string[] = []
  if (preset.instructions !== undefined) parts.push('instructions')
  if (preset.tools !== undefined) parts.push(`tools: ${preset.tools.join(', ') || 'none'}`)
  if (preset.model !== undefined) parts.push(typeof preset.model === 'string' ? `model: ${preset.model}` : 'model')
  if (parts.length === 0) return preset.description
  const sets = `sets ${parts.join('; ')}`
  return preset.description ? `${preset.description} (${sets})` : sets
}

/**
 * Resolves a scalar axis: model-supplied value → preset → axis default.
 *
 * @param modelValue - The value the model supplied, or {@link UNSET}.
 * @param axis - The axis policy governing this parameter.
 * @param presetValue - The preset's value for this axis, if any.
 * @returns The resolved value.
 */
function resolveScalar(
  modelValue: unknown,
  axis: Open | Choice | Fixed | Inherit,
  presetValue: unknown = undefined
): unknown {
  if (modelValue !== UNSET) {
    if (axis instanceof Open) return modelValue
    if (axis instanceof Choice && axis.normalized().some((option) => option.name === modelValue)) {
      return axis.valueFor(modelValue as string)
    }
  }
  if (presetValue !== undefined) return presetValue
  if (axis instanceof Fixed) return axis.value
  return undefined
}

/**
 * Resolves a list axis: model-supplied value → preset → axis default → `undefined`.
 *
 * When the axis is a {@link Choice}, ignores values that are not valid options.
 *
 * @param modelValue - The value the model supplied, or {@link UNSET}.
 * @param axis - The axis policy governing this parameter.
 * @param presetValues - The preset's values for this axis, if any.
 * @returns The resolved list, or `undefined` to inherit from the parent.
 */
function resolveList(
  modelValue: unknown,
  axis: Choice | Fixed | Inherit,
  presetValues: readonly string[] | undefined = undefined
): string[] | undefined {
  const allowed = axis instanceof Choice ? axis.normalized().map((option) => option.name) : undefined

  // Model-supplied value
  if (modelValue !== UNSET && allowed !== undefined) {
    const choice = axis as Choice
    let requested: string[]
    if (typeof modelValue === 'string') {
      requested = [modelValue]
    } else if (Array.isArray(modelValue)) {
      requested = modelValue as string[]
    } else {
      requested = []
    }
    return requested
      .filter((toolName) => allowed.includes(toolName))
      .map((toolName) => choice.valueFor(toolName) as string)
  }

  // Preset value
  if (presetValues !== undefined) {
    if (allowed !== undefined) {
      const choice = axis as Choice
      const allowedValues = new Set(allowed.map((name) => choice.valueFor(name)))
      return presetValues.filter((t) => allowedValues.has(t))
    }
    return [...presetValues]
  }

  // All choices
  if (axis instanceof Choice && axis.multiple && allowed !== undefined) {
    return allowed.map((name) => (axis as Choice).valueFor(name) as string)
  }
  if (axis instanceof Fixed) {
    return axis.value != null ? [...(axis.value as string[])] : undefined
  }
  return undefined
}

/**
 * Axes passed to {@link _resolveSpecs}.
 * @internal Not part of the public API.
 */
export interface ResolveSpecAxes {
  presets: Record<string, Preset>
  defaultPreset: string | undefined
  instructions: Open | Choice | Fixed
  /** Defaults to {@link Inherit} when omitted. */
  tools?: Choice | Fixed | Inherit | undefined
  /** Defaults to {@link Inherit} when omitted. */
  model?: Inherit | Choice | Fixed | undefined
}

/**
 * Combines each model-supplied agent input with the axis policies into a spec.
 *
 * Precedence per axis: a model-supplied argument wins, then the preset's value, then the axis
 * default ({@link Fixed}/{@link Inherit}). An omitted `agent_type` falls back to the default
 * preset, so a bare model input behaves like the default role.
 *
 * @param modelInputs - The model-supplied arguments, one object per agent.
 * @param axes - Axis policies, presets, and the default preset name.
 * @returns The resolved {@link AgentSpec} for each input, in order.
 * @throws Error if `modelInputs` is not an array, an input is not an object, a name is missing, empty, or
 * duplicated, or an `agent_type` is not found in `axes.presets`.
 * @internal Not part of the public API.
 */
export function _resolveSpecs(modelInputs: unknown, axes: ResolveSpecAxes): AgentSpec[] {
  const { presets, defaultPreset, instructions } = axes
  const tools = axes.tools ?? new Inherit()
  const model = axes.model ?? new Inherit()

  if (!Array.isArray(modelInputs)) {
    throw new Error('agents must be an array')
  }

  const seenNames = new Set<string>()
  const specs: AgentSpec[] = []
  for (const [index, input] of (modelInputs as unknown[]).entries()) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error(`Agent at index ${index} must be an object`)
    }
    const modelInput = input as Record<string, unknown>

    const rawName = modelInput['name']
    if (typeof rawName !== 'string' || !rawName.trim()) {
      throw new Error(`Agent at index ${index} must have a non-empty 'name' string`)
    }
    const name = rawName.trim()
    if (seenNames.has(name)) {
      throw new Error(`Duplicate agent name ${JSON.stringify(name)} at index ${index}`)
    }
    seenNames.add(name)

    // agent_type is a closed enum: a provided value must be an exact preset name.
    const modelAgentType = modelInput['agent_type']
    const isKnownPreset = typeof modelAgentType === 'string' && Object.hasOwn(presets, modelAgentType)
    if (modelAgentType != null && !isKnownPreset) {
      throw new Error(
        `Unknown agent_type ${JSON.stringify(modelAgentType)}; valid values: ${Object.keys(presets).sort().join(', ')}.`
      )
    }
    // Ad-hoc instructions (only possible when the axis exposes one) override the default preset.
    const overridingInstructions =
      (instructions instanceof Open || instructions instanceof Choice) && 'instructions' in modelInput

    let agentType: string | undefined
    if (isKnownPreset) {
      agentType = modelAgentType as string
    } else if (!overridingInstructions) {
      agentType = defaultPreset
    }
    const preset = agentType ? presets[agentType] : undefined

    const spec = new AgentSpec({ name, agentType })
    spec.instructions = resolveScalar(modelInput['instructions'] ?? UNSET, instructions, preset?.instructions) as
      string | undefined
    spec.tools = resolveList(modelInput['tools'] ?? UNSET, tools, preset?.tools)
    spec.model = resolveScalar(modelInput['model'] ?? UNSET, model, preset?.model) as
      Model | ModelRouter | string | undefined
    specs.push(spec)
  }

  return specs
}

/**
 * Creates a builder that produces child agents inheriting the parent's model, tools, and
 * interventions.
 *
 * Used by the vended multi-agent tools when no custom builder is supplied.
 * Resolves `spec.tools` against the parent's tool registry, including MCP tools, which keep
 * calling through the parent's MCP client, skipping (with a warning) names the parent does
 * not own. `spec.name` becomes the child's name and id. Children also inherit the parent's sandbox, printer setting, and trace
 * attributes, and get `contextManager: 'auto'` unless their model is stateful. Children share
 * the parent's intervention handler instances, so tool calls made by a child are subject to
 * the same approval and authorization checks as the parent's.
 *
 * @param parent - The parent agent whose resources child agents inherit.
 * @returns An {@link AgentBuilder} that creates configured child agents from a spec.
 * @internal Not part of the public API.
 */
export function _defaultBuilder(parent: Agent): AgentBuilder {
  return (spec: AgentSpec): Agent => {
    const parentTools: Map<string, Tool> = new Map()
    // The child's own context manager registers its tools (e.g. retrieve_context); skip the parent's.
    const managedTools = new Set(parent.contextManager?.getTools() ?? [])
    for (const tool of parent.toolRegistry.list()) {
      if (!managedTools.has(tool)) {
        parentTools.set(tool.name, tool)
      }
    }

    // tools=undefined means inherit all; a list means only those.
    const childTools: Tool[] = spec.tools === undefined ? [...parentTools.values()] : []
    for (const toolName of spec.tools ?? []) {
      const tool = parentTools.get(toolName)
      if (tool) {
        childTools.push(tool)
      } else {
        logger.warn(`tool_name=<${toolName}> | subagent requested tool but parent does not own it, skipping`)
      }
    }

    const childModel = (spec.model as Model | ModelRouter | string | undefined) ?? parent.model
    const stateful = typeof childModel === 'object' && 'stateful' in childModel && childModel.stateful
    const sandbox = (parent as unknown as { _sandbox?: Sandbox | false })._sandbox
    const printer = (parent as unknown as { _printer?: Printer })._printer
    const tracer = (parent as unknown as { _tracer: Tracer })._tracer
    const traceAttributes = (tracer as unknown as { _traceAttributes: Record<string, AttributeValue> })._traceAttributes
    const interventionRegistry = (parent as unknown as { _interventionRegistry: InterventionRegistry })
      ._interventionRegistry
    return new Agent({
      systemPrompt: spec.instructions ?? '',
      tools: childTools,
      model: childModel,
      ...(spec.name !== undefined && { name: spec.name, id: spec.name }),
      ...(!stateful && { contextManager: 'auto' }),
      ...(sandbox !== undefined && { sandbox }),
      printer: printer !== undefined,
      traceAttributes: { ...traceAttributes },
      interventions: [...interventionRegistry.handlers],
    })
  }
}
