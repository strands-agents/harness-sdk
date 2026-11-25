import { DEFAULT_HARNESS_AGENT_CONFIG, supportsWebSearch } from '@strands-agents/harness'

import { effortOptions } from '../../model/selection.js'
import { errorMessage } from '../../terminal/text.js'
import {
  projectPython,
  readAgentOptions,
  readPythonSource,
  type AgentOptionEdit,
  type AgentOptionValue,
} from '../agent-options.js'
import type { Knob, KnobGroup, KnobKind } from './model.js'
import type { DevWorkspace } from '../workspace.js'

type EvalsKnobValue = string | boolean | null

type EvalsSwitchItem = { readonly index: number } | { readonly key: string } | { readonly name: string }

export type EvalsSpaceVariable =
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
      readonly values: readonly EvalsKnobValue[]
      readonly default: EvalsKnobValue
    }
  | {
      readonly key: string
      readonly kind: 'switch'
      readonly option: string
      readonly item: EvalsSwitchItem
      readonly default: true
    }

interface EvalsSwitchEntry {
  readonly label: string
  readonly item: EvalsSwitchItem
}

export interface EvalsKnob extends Knob {
  readonly option: string
  readonly current?: EvalsKnobValue
  readonly choices?: readonly EvalsKnobValue[]
  readonly entries?: readonly EvalsSwitchEntry[]
  readonly sourceItems?: readonly string[]
  readonly about?: string
}

export interface EvalsKnobChange {
  readonly knob: EvalsKnob
  readonly kind: 'text' | 'value'
  readonly before: string
  readonly after: string
  readonly edit?: AgentOptionEdit
  /** What applying writes into the call for an option that it does not set yet. */
  readonly added?: string
}

/** The model of the call, for the harness's own default of built-in tools. */
type EvalsModelReading =
  { readonly kind: 'set'; readonly model: string } | { readonly kind: 'unset' } | { readonly kind: 'code' }

interface EvalsHarnessDefaults {
  /** DEFAULT_HARNESS_AGENT_CONFIG of the harness in the agent's language, with camelCase keys. */
  readonly options: Readonly<Record<string, unknown>>
  /** Whether the call's model gets native web search, without which the harness leaves web_search off. */
  readonly webSearch: boolean
}

export type EvalsHarnessDefaultsReader = (
  workspace: DevWorkspace,
  model: EvalsModelReading
) => Promise<EvalsHarnessDefaults>

const PYTHON_DEFAULTS = `import json, sys
from strands_harness import DEFAULT_HARNESS_AGENT_CONFIG, supports_web_search
model = json.loads(sys.stdin.read())
search = model["kind"] != "code" and supports_web_search(model.get("model"))
print(json.dumps({"options": DEFAULT_HARNESS_AGENT_CONFIG, "webSearch": search}, default=str))`

/** The defaults of strands-harness itself: the project's Python package, or the TypeScript package. */
export const readEvalsHarnessDefaults: EvalsHarnessDefaultsReader = async (workspace, model) => {
  if (workspace.config.language === 'python')
    return readPythonSource(PYTHON_DEFAULTS, JSON.stringify(model), projectPython(workspace.root))
  return {
    options: DEFAULT_HARNESS_AGENT_CONFIG as unknown as Readonly<Record<string, unknown>>,
    webSearch: model.kind !== 'code' && supportsWebSearch(model.kind === 'set' ? model.model : undefined),
  }
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
  skills: { name: 'skills', python: 'skills', group: 'skills', label: 'skills' },
  builtinPlugins: { name: 'builtinPlugins', python: 'builtin_plugins', group: 'plugins', label: 'built-in plugins' },
  plugins: { name: 'plugins', python: 'plugins', group: 'plugins', label: 'plugins' },
  interventions: { name: 'interventions', python: 'interventions', group: 'plugins', label: 'interventions' },
} as const satisfies Record<string, OptionSpec>

type OptionName = keyof typeof OPTION_SPECS

// Session and memory stay out: every trial runs without them.
export const EVALS_KNOB_NAMES: readonly string[] = Object.keys(OPTION_SPECS)

const GROUP_ORDER: readonly KnobGroup[] = ['prompt', 'model', 'tools', 'context', 'skills', 'plugins']

const SET_IN_CODE = 'set in code, so strands dev cannot read or change it'
const NOT_TUNED = 'set to a value that strands dev does not tune'
const FROM_DEFAULT = 'not in the call, so the run starts from the harness default'
// Both harnesses resolve an unset backgroundTasks to on (resolveBackgroundTasks, _resolve_background_tasks).
const BACKGROUND_TASKS_DEFAULT = true

const shownValue = (value: EvalsKnobValue | undefined): string =>
  value === true ? 'on' : value === false ? 'off' : value === null || value === undefined ? 'none' : value

const scalarOf = (value: AgentOptionValue | undefined): EvalsKnobValue | undefined => {
  if (!value) return undefined
  if (value.kind === 'string' || value.kind === 'boolean') return value.value
  if (value.kind === 'null') return null
  return undefined
}

interface Reading {
  readonly options: ReadonlyMap<string, AgentOptionValue>
  readonly language: Language
  readonly defaults?: EvalsHarnessDefaults
  readonly defaultsProblem?: string
}

const harnessDefault = (name: OptionName, { defaults }: Reading): unknown =>
  name === 'backgroundTasks' ? BACKGROUND_TASKS_DEFAULT : defaults?.options[name]

const asScalar = (value: unknown): EvalsKnobValue | undefined =>
  typeof value === 'string' || typeof value === 'boolean' || value === null ? value : undefined

const optionName = (name: OptionName, language: Language): string =>
  language === 'python' ? OPTION_SPECS[name].python : OPTION_SPECS[name].name

const knobBase = (
  name: OptionName,
  reading: Reading,
  kind: KnobKind,
  detail: string,
  unavailable?: string
): EvalsKnob => ({
  key: name,
  option: optionName(name, reading.language),
  label: OPTION_SPECS[name].label,
  group: OPTION_SPECS[name].group,
  kind,
  detail,
  enabled: false,
  ...(unavailable ? { unavailable } : {}),
})

const fromDefault = (knob: EvalsKnob): EvalsKnob => ({
  ...knob,
  detail: `${knob.detail}; ${FROM_DEFAULT}`,
  notInCall: true,
})

const valueOf = (name: OptionName, reading: Reading): AgentOptionValue | undefined =>
  reading.options.get(optionName(name, reading.language))

const textKnob = (name: 'instructions' | 'systemPrompt', reading: Reading): EvalsKnob => {
  const value = valueOf(name, reading)
  if (name === 'systemPrompt') {
    if (!value)
      return knobBase(
        name,
        reading,
        'text',
        'text',
        'the call passes no system prompt, so the harness builds its own; tune the instructions instead'
      )
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

const choiceKnob = (name: OptionName, reading: Reading, choices: readonly EvalsKnobValue[]): EvalsKnob => {
  const value = valueOf(name, reading)
  if (!value && reading.defaultsProblem) return knobBase(name, reading, 'choice', 'choice', reading.defaultsProblem)
  const current = value ? scalarOf(value) : asScalar(harnessDefault(name, reading))
  if (current === undefined || !choices.includes(current))
    return knobBase(name, reading, 'choice', 'choice', value?.kind === 'code' ? SET_IN_CODE : NOT_TUNED)
  const knob = { ...knobBase(name, reading, 'choice', choices.map(shownValue).join(' · ')), current, choices }
  return value ? knob : fromDefault(knob)
}

const namesOf = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined

const isEmpty = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && Object.keys(value).length === 0)

// An option the call leaves out switches the entries of the harness default.
const defaultSwitches = (name: OptionName, reading: Reading): EvalsKnob => {
  const { label } = OPTION_SPECS[name]
  if (reading.defaultsProblem) return knobBase(name, reading, 'switches', 'on/off', reading.defaultsProblem)
  const fallback = harnessDefault(name, reading)
  const names = namesOf(fallback)?.filter((entry) => entry !== 'web_search' || reading.defaults?.webSearch)
  if (!names || names.length === 0)
    return knobBase(
      name,
      reading,
      'switches',
      'on/off',
      isEmpty(fallback) || names
        ? `the call passes no ${label}, and the harness adds none by default`
        : `the harness default ${label} are not a list of names that strands dev can switch`
    )
  const entries = names.map((entry) => ({ label: entry, item: { name: entry } }))
  return fromDefault({ ...knobBase(name, reading, 'switches', `on/off for each: ${names.join(', ')}`), entries })
}

const switchesKnob = (name: OptionName, reading: Reading): EvalsKnob => {
  const value = valueOf(name, reading)
  if (!value) return defaultSwitches(name, reading)
  if (value.kind !== 'list' && value.kind !== 'map')
    return knobBase(name, reading, 'switches', 'on/off', value.kind === 'code' ? SET_IN_CODE : NOT_TUNED)
  const entries: EvalsSwitchEntry[] =
    value.kind === 'list'
      ? value.items.map((item, index) => ({ label: item.literal ?? item.text, item: { index } }))
      : value.keys.map((key) => ({ label: key, item: { key } }))
  if (entries.length === 0)
    return knobBase(
      name,
      reading,
      'switches',
      'on/off',
      `the call lists no ${OPTION_SPECS[name].label}, so there is nothing to switch off`
    )
  return {
    ...knobBase(name, reading, 'switches', `on/off for each: ${entries.map(({ label }) => label).join(', ')}`),
    entries,
    ...(value.kind === 'list' ? { sourceItems: value.items.map((item) => item.text) } : {}),
  }
}

const skillsKnob = (reading: Reading): EvalsKnob =>
  valueOf('skills', reading)?.kind === 'list'
    ? switchesKnob('skills', reading)
    : choiceKnob('skills', reading, [true, false])

const effortKnob = (reading: Reading, model: EvalsKnobValue | undefined): EvalsKnob => {
  const levels =
    typeof model === 'string' ? effortOptions(model, 'auto').map(({ id }) => (id === 'none' ? 'off' : id)) : []
  const choices = [...new Set(['auto', ...levels])]
  if (choices.length < 2)
    return knobBase('effort', reading, 'choice', 'choice', 'the model has no reasoning levels to choose from')
  return choiceKnob('effort', reading, choices)
}

const modelKnob = (reading: Reading): EvalsKnob => {
  const value = valueOf('model', reading)
  if (!value && reading.defaultsProblem) return knobBase('model', reading, 'models', 'choice', reading.defaultsProblem)
  const current = value ? scalarOf(value) : asScalar(harnessDefault('model', reading))
  if (typeof current !== 'string') return knobBase('model', reading, 'models', 'choice', SET_IN_CODE)
  const knob = { ...knobBase('model', reading, 'models', 'choose models to try'), current }
  return value ? knob : { ...knob, notInCall: true }
}

const modelReading = (value: AgentOptionValue | undefined): EvalsModelReading =>
  !value ? { kind: 'unset' } : value.kind === 'string' ? { kind: 'set', model: value.value } : { kind: 'code' }

const withDefaults = async (
  workspace: DevWorkspace,
  base: Reading,
  read: EvalsHarnessDefaultsReader
): Promise<Reading> => {
  try {
    return { ...base, defaults: await read(workspace, modelReading(valueOf('model', base))) }
  } catch (error) {
    return {
      ...base,
      defaultsProblem: `strands dev could not read the strands-harness defaults: ${errorMessage(error)}`,
    }
  }
}

export const readEvalsKnobs = async (
  workspace: DevWorkspace,
  readDefaults: EvalsHarnessDefaultsReader = readEvalsHarnessDefaults
): Promise<EvalsKnob[]> => {
  const options = await readAgentOptions(workspace)
  const base: Reading = { options: options ?? new Map(), language: workspace.config.language }
  const reading = await withDefaults(workspace, base, readDefaults)
  const model = modelKnob(reading)
  const knobs = [
    textKnob('instructions', reading),
    textKnob('systemPrompt', reading),
    model,
    effortKnob(reading, model.current),
    choiceKnob('caching', reading, ['auto', true, false]),
    switchesKnob('builtinTools', reading),
    switchesKnob('tools', reading),
    switchesKnob('mcpServers', reading),
    choiceKnob('backgroundTasks', reading, [true, false]),
    choiceKnob('contextManager', reading, ['auto', 'agentic', false]),
    skillsKnob(reading),
    switchesKnob('builtinPlugins', reading),
    switchesKnob('plugins', reading),
    switchesKnob('interventions', reading),
  ]
  return [...knobs].sort((left, right) => GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group))
}

const switchKey = (knob: EvalsKnob, index: number): string => `${knob.option}_${index}`

export const evalsSpaceVariables = (knobs: readonly EvalsKnob[], models: readonly string[]): EvalsSpaceVariable[] =>
  knobs
    .filter((knob) => knob.enabled && !knob.unavailable)
    .flatMap((knob): EvalsSpaceVariable[] => {
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

const NEW_IN_CALL = ' (the harness default; not in the call)'

// An option the call leaves out is written in full, and only while the call still leaves it out.
const addedChange = (
  knob: EvalsKnob,
  before: string,
  after: string,
  value: string | boolean | readonly string[]
): EvalsKnobChange => ({
  knob,
  kind: 'value',
  before: `${before}${NEW_IN_CALL}`,
  after,
  edit: { option: knob.option, value, absent: true },
  added: `${knob.option} is new in the call: applying writes ${knob.option} = ${JSON.stringify(value)}`,
})

const valueChange = (knob: EvalsKnob, before: unknown, after: unknown): EvalsKnobChange | undefined => {
  if (JSON.stringify(before) === JSON.stringify(after) || after === undefined) return undefined
  const value = after as EvalsKnobValue
  if (typeof value !== 'string' && typeof value !== 'boolean') return undefined
  const shown = shownValue(before as EvalsKnobValue)
  if (knob.notInCall) return addedChange(knob, shown, shownValue(value), value)
  return {
    knob,
    kind: 'value',
    before: shown,
    after: shownValue(value),
    edit: {
      option: knob.option,
      value,
      ...(typeof before === 'string' || typeof before === 'boolean' ? { expected: before } : {}),
    },
  }
}

const switchesChange = (knob: EvalsKnob, best: Params): EvalsKnobChange | undefined => {
  const entries = knob.entries ?? []
  const off = entries.flatMap((entry, index) => (best[switchKey(knob, index)] === false ? [{ entry, index }] : []))
  if (off.length === 0) return undefined
  const labels = off.map(({ entry }) => entry.label).join(', ')
  if (knob.notInCall) {
    const kept = entries.filter((_, index) => !off.some((removed) => removed.index === index)).map(({ label }) => label)
    return addedChange(knob, `${labels} on`, `${labels} off`, kept)
  }
  const edit: AgentOptionEdit = entries.every(({ item }) => 'index' in item)
    ? { option: knob.option, removeItems: off.map(({ index }) => index), expectedItems: knob.sourceItems ?? [] }
    : { option: knob.option, removeKeys: off.map(({ entry }) => (entry.item as { key: string }).key) }
  return { knob, kind: 'value', before: `${labels} on`, after: `${labels} off`, edit }
}

export const evalsKnobChanges = (knobs: readonly EvalsKnob[], baseline: Params, best: Params): EvalsKnobChange[] =>
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
    .filter((change): change is EvalsKnobChange => change !== undefined)
