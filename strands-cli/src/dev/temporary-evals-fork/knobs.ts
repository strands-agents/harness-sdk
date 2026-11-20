import { PROVIDER_ENVIRONMENT_KEYS, type DetectedProviderEnvironment, type ProviderId } from '../../config/store.js'
import { discoverProviderModels } from '../../model/discovery.js'
import { effortOptions } from '../../model/selection.js'
import { agentOptionDefault, readAgentOptions, type AgentOptionEdit, type AgentOptionValue } from '../agent-options.js'
import type { Knob, KnobGroup, KnobKind, ModelOption } from '../panels/model.js'
import type { DevWorkspace } from '../workspace.js'

export type TemporaryKnobValue = string | boolean | null

export type TemporarySwitchItem = { readonly index: number } | { readonly key: string } | { readonly name: string }

export type TemporarySpaceVariable =
  | {
      readonly key: string
      readonly kind: 'text'
      readonly option: string
      readonly about: string
      readonly default?: string
    }
  | {
      readonly key: string
      readonly kind: 'choice'
      readonly option: string
      readonly values: readonly TemporaryKnobValue[]
      readonly default: TemporaryKnobValue
    }
  | {
      readonly key: string
      readonly kind: 'switch'
      readonly option: string
      readonly item: TemporarySwitchItem
      readonly default: true
    }

interface TemporarySwitchEntry {
  readonly label: string
  readonly item: TemporarySwitchItem
}

export interface TemporaryKnob extends Knob {
  readonly option: string
  readonly current?: TemporaryKnobValue
  readonly choices?: readonly TemporaryKnobValue[]
  readonly entries?: readonly TemporarySwitchEntry[]
  readonly sourceItems?: readonly string[]
  readonly about?: string
}

export interface TemporaryKnobChange {
  readonly knob: TemporaryKnob
  readonly kind: 'text' | 'value'
  readonly before: string
  readonly after: string
  readonly edit?: AgentOptionEdit
}

type Language = 'typescript' | 'python'

interface OptionSpec {
  readonly name: string
  readonly python: string
  readonly group: KnobGroup
  readonly label: string
}

const OPTION_SPECS = {
  instructions: { name: 'instructions', python: 'instructions', group: 'prompt', label: 'instructions' },
  systemPrompt: { name: 'systemPrompt', python: 'system_prompt', group: 'prompt', label: 'system prompt' },
  model: { name: 'model', python: 'model', group: 'model', label: 'model' },
  effort: { name: 'effort', python: 'effort', group: 'model', label: 'effort' },
  caching: { name: 'caching', python: 'caching', group: 'model', label: 'prompt caching' },
  builtinTools: { name: 'builtinTools', python: 'builtin_tools', group: 'tools', label: 'built-in tools' },
  tools: { name: 'tools', python: 'tools', group: 'tools', label: 'tools' },
  mcpServers: { name: 'mcpServers', python: 'mcp_servers', group: 'tools', label: 'MCP servers' },
  backgroundTasks: { name: 'backgroundTasks', python: 'background_tasks', group: 'tools', label: 'background tasks' },
  contextManager: { name: 'contextManager', python: 'context_manager', group: 'context', label: 'context manager' },
  session: { name: 'session', python: 'session', group: 'context', label: 'session' },
  memory: { name: 'memory', python: 'memory', group: 'context', label: 'memory' },
  skills: { name: 'skills', python: 'skills', group: 'skills', label: 'skills' },
  builtinPlugins: { name: 'builtinPlugins', python: 'builtin_plugins', group: 'plugins', label: 'built-in plugins' },
  plugins: { name: 'plugins', python: 'plugins', group: 'plugins', label: 'plugins' },
  interventions: { name: 'interventions', python: 'interventions', group: 'plugins', label: 'interventions' },
} as const satisfies Record<string, OptionSpec>

type OptionName = keyof typeof OPTION_SPECS

export const TEMPORARY_KNOB_NAMES: readonly string[] = Object.keys(OPTION_SPECS)

const GROUP_ORDER: readonly KnobGroup[] = ['prompt', 'model', 'tools', 'context', 'skills', 'plugins']

const SET_IN_CODE = 'set in code, so strands dev cannot read or change it'
const NOT_SET = 'not set'

const shownValue = (value: TemporaryKnobValue | undefined): string =>
  value === true ? 'on' : value === false ? 'off' : value === null || value === undefined ? 'none' : value

const scalarOf = (value: AgentOptionValue | undefined): TemporaryKnobValue | undefined => {
  if (!value) return undefined
  if (value.kind === 'string' || value.kind === 'boolean') return value.value
  if (value.kind === 'null') return null
  return undefined
}

const unset = (name: OptionName): TemporaryKnobValue | undefined => {
  const value = agentOptionDefault(name)
  return typeof value === 'string' || typeof value === 'boolean' ? value : undefined
}

const unsetList = (name: OptionName): readonly string[] => {
  const value = agentOptionDefault(name)
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

interface Reading {
  readonly options: ReadonlyMap<string, AgentOptionValue>
  readonly language: Language
}

const optionName = (name: OptionName, language: Language): string =>
  language === 'python' ? OPTION_SPECS[name].python : OPTION_SPECS[name].name

const knobBase = (
  name: OptionName,
  reading: Reading,
  kind: KnobKind,
  detail: string,
  unavailable?: string
): TemporaryKnob => ({
  key: name,
  option: optionName(name, reading.language),
  label: OPTION_SPECS[name].label,
  group: OPTION_SPECS[name].group,
  kind,
  detail,
  enabled: false,
  ...(unavailable ? { unavailable } : {}),
})

const valueOf = (name: OptionName, reading: Reading): AgentOptionValue | undefined =>
  reading.options.get(optionName(name, reading.language))

const textKnob = (name: 'instructions' | 'systemPrompt', reading: Reading): TemporaryKnob | undefined => {
  const value = valueOf(name, reading)
  if (name === 'systemPrompt') {
    if (!value) return undefined
    if (value.kind !== 'string') return knobBase(name, reading, 'text', 'text', SET_IN_CODE)
    return {
      ...knobBase(name, reading, 'text', 'text rewritten by the optimizer'),
      current: value.value,
      about: 'the full system prompt',
    }
  }
  if (valueOf('systemPrompt', reading))
    return knobBase(name, reading, 'text', 'text', 'the full system prompt replaces the instructions; tune it instead')
  return {
    ...knobBase(name, reading, 'text', "your agent's instructions (system prompt)"),
    enabled: true,
    ...(value?.kind === 'string' ? { current: value.value } : {}),
    about: 'the agent instructions, which the harness adds to its own system prompt',
  }
}

const choiceKnob = (name: OptionName, reading: Reading, choices: readonly TemporaryKnobValue[]): TemporaryKnob => {
  const value = valueOf(name, reading)
  const current = value ? scalarOf(value) : unset(name)
  if (current === undefined || !choices.includes(current))
    return knobBase(
      name,
      reading,
      'choice',
      'choice',
      value?.kind === 'code' ? SET_IN_CODE : 'set to a value that strands dev does not tune'
    )
  return {
    ...knobBase(name, reading, 'choice', choices.map(shownValue).join(' · ')),
    current,
    choices,
  }
}

const switchesKnob = (name: OptionName, reading: Reading, defaults?: readonly string[]): TemporaryKnob => {
  const value = valueOf(name, reading)
  const listed = value?.kind === 'list' ? value : undefined
  const mapped = value?.kind === 'map' ? value : undefined
  const entries: TemporarySwitchEntry[] = listed
    ? listed.items.map((item, index) => ({ label: item.literal ?? item.text, item: { index } }))
    : mapped
      ? mapped.keys.map((key) => ({ label: key, item: { key } }))
      : !value && defaults
        ? defaults.map((entry) => ({ label: entry, item: { name: entry } }))
        : []
  if (entries.length === 0) return knobBase(name, reading, 'switches', 'on/off', value ? SET_IN_CODE : NOT_SET)
  return {
    ...knobBase(name, reading, 'switches', `on/off for each: ${entries.map(({ label }) => label).join(', ')}`),
    entries,
    ...(listed ? { sourceItems: listed.items.map((item) => item.text) } : {}),
  }
}

const skillsKnob = (reading: Reading): TemporaryKnob => {
  const value = valueOf('skills', reading)
  return value?.kind === 'list' ? switchesKnob('skills', reading) : choiceKnob('skills', reading, [true, false])
}

const effortKnob = (reading: Reading, model: TemporaryKnobValue | undefined): TemporaryKnob => {
  const levels =
    typeof model === 'string' ? effortOptions(model, 'auto').map(({ id }) => (id === 'none' ? 'off' : id)) : []
  const choices = [...new Set(['auto', ...levels])]
  if (choices.length < 2)
    return knobBase('effort', reading, 'choice', 'choice', 'the model has no reasoning levels to choose from')
  return choiceKnob('effort', reading, choices)
}

const modelKnob = (reading: Reading): TemporaryKnob => {
  const value = valueOf('model', reading)
  const current = value ? scalarOf(value) : unset('model')
  if (typeof current !== 'string') return knobBase('model', reading, 'models', 'choice', SET_IN_CODE)
  return { ...knobBase('model', reading, 'models', 'choose models to try'), current }
}

const trialOnly = (name: 'session' | 'memory', reading: Reading): TemporaryKnob =>
  knobBase(
    name,
    reading,
    'choice',
    'choice',
    valueOf(name, reading) ? `every trial runs without ${name === 'session' ? 'a session' : 'memory'}` : NOT_SET
  )

export const readTemporaryKnobs = async (workspace: DevWorkspace): Promise<TemporaryKnob[]> => {
  const options = await readAgentOptions(workspace)
  const reading: Reading = { options: options ?? new Map(), language: workspace.config.language }
  const model = modelKnob(reading)
  const knobs = [
    textKnob('instructions', reading),
    textKnob('systemPrompt', reading),
    model,
    effortKnob(reading, model.current),
    choiceKnob('caching', reading, ['auto', true, false]),
    switchesKnob('builtinTools', reading, unsetList('builtinTools')),
    switchesKnob('tools', reading),
    switchesKnob('mcpServers', reading),
    choiceKnob('backgroundTasks', reading, [true, false]),
    choiceKnob('contextManager', reading, ['auto', 'agentic', false]),
    trialOnly('session', reading),
    trialOnly('memory', reading),
    skillsKnob(reading),
    switchesKnob('builtinPlugins', reading, unsetList('builtinPlugins')),
    switchesKnob('plugins', reading),
    switchesKnob('interventions', reading),
  ].filter((knob): knob is TemporaryKnob => knob !== undefined && knob.unavailable !== NOT_SET)
  return [...knobs].sort((left, right) => GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group))
}

const switchKey = (knob: TemporaryKnob, index: number): string => `${knob.option}_${index}`

export const temporarySpaceVariables = (
  knobs: readonly TemporaryKnob[],
  models: readonly string[]
): TemporarySpaceVariable[] =>
  knobs
    .filter((knob) => knob.enabled && !knob.unavailable)
    .flatMap((knob): TemporarySpaceVariable[] => {
      if (knob.kind === 'text')
        return [
          {
            key: knob.option,
            kind: 'text',
            option: knob.option,
            about: knob.about ?? '',
            ...(typeof knob.current === 'string' ? { default: knob.current } : {}),
          },
        ]
      if (knob.kind === 'models') {
        const values = [...new Set([knob.current as string, ...models])]
        return values.length < 2
          ? []
          : [{ key: knob.option, kind: 'choice', option: knob.option, values, default: knob.current ?? null }]
      }
      if (knob.kind === 'choice')
        return [
          {
            key: knob.option,
            kind: 'choice',
            option: knob.option,
            values: knob.choices ?? [],
            default: knob.current ?? null,
          },
        ]
      return (knob.entries ?? []).map((entry, index) => ({
        key: switchKey(knob, index),
        kind: 'switch',
        option: knob.option,
        item: entry.item,
        default: true,
      }))
    })

type Params = Readonly<Record<string, unknown>>

const valueChange = (knob: TemporaryKnob, before: unknown, after: unknown): TemporaryKnobChange | undefined => {
  if (JSON.stringify(before) === JSON.stringify(after) || after === undefined) return undefined
  const value = after as TemporaryKnobValue
  if (typeof value !== 'string' && typeof value !== 'boolean') return undefined
  return {
    knob,
    kind: 'value',
    before: shownValue(before as TemporaryKnobValue),
    after: shownValue(value),
    edit: {
      option: knob.option,
      value,
      ...(typeof before === 'string' || typeof before === 'boolean' ? { expected: before } : {}),
    },
  }
}

const switchesChange = (knob: TemporaryKnob, best: Params): TemporaryKnobChange | undefined => {
  const entries = knob.entries ?? []
  const off = entries.flatMap((entry, index) => (best[switchKey(knob, index)] === false ? [{ entry, index }] : []))
  if (off.length === 0) return undefined
  const labels = off.map(({ entry }) => entry.label).join(', ')
  const listed = entries.every(({ item }) => 'index' in item)
  const edit: AgentOptionEdit = listed
    ? { option: knob.option, removeItems: off.map(({ index }) => index), expectedItems: knob.sourceItems ?? [] }
    : entries.every(({ item }) => 'key' in item)
      ? { option: knob.option, removeKeys: off.map(({ entry }) => (entry.item as { key: string }).key) }
      : {
          option: knob.option,
          value: entries
            .filter((_, index) => !off.some((removed) => removed.index === index))
            .map(({ label }) => label),
          expected: entries.map(({ label }) => label),
        }
  return { knob, kind: 'value', before: `${labels} on`, after: `${labels} off`, edit }
}

export const temporaryKnobChanges = (
  knobs: readonly TemporaryKnob[],
  baseline: Params,
  best: Params
): TemporaryKnobChange[] =>
  knobs
    .filter((knob) => knob.enabled && !knob.unavailable)
    .flatMap((knob) => {
      if (knob.kind === 'switches') return [switchesChange(knob, best)]
      const before = baseline[knob.option]
      const after = best[knob.option]
      if (knob.kind === 'text')
        return typeof before === 'string' && typeof after === 'string' && before !== after
          ? [{ knob, kind: 'text' as const, before, after }]
          : []
      return [valueChange(knob, before, after)]
    })
    .filter((change): change is TemporaryKnobChange => change !== undefined)

export const temporaryKnobLabels = (knobs: readonly TemporaryKnob[]): Record<string, string> =>
  Object.fromEntries(
    knobs.flatMap((knob) =>
      knob.kind === 'switches'
        ? (knob.entries ?? []).map((entry, index) => [switchKey(knob, index), `${knob.label}: ${entry.label}`])
        : [[knob.option, knob.label]]
    )
  )

export interface TemporaryModelDiscovery {
  readonly options?: readonly ModelOption[]
  readonly error?: string
}

const processEnvironment = (): DetectedProviderEnvironment =>
  Object.fromEntries(
    PROVIDER_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = process.env[key]
      return value ? [[key, { value, source: 'process' as const }]] : []
    })
  )

export const discoverTemporaryModels = async (provider: string): Promise<TemporaryModelDiscovery> => {
  const discovery = await discoverProviderModels(provider as ProviderId, processEnvironment())
  if (!discovery.available) return { error: discovery.error ?? `No ${provider} models could be listed.` }
  return { options: discovery.models.map(({ id, name }) => ({ id: `${provider}/${id}`, name: name || id })) }
}
