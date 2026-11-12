/**
 * The harness's built-in tools: normalizing the `builtinTools` option into one record with every name
 * resolved, building the tool objects from it, and the default `subagent` that rebuilds a child
 * from the same record.
 */

import { type Agent, McpClient, MemoryManager, Tool, type ToolList } from '@strands-agents/sdk'
import { type AgentBuilder, type AgentSpec, Choice, Fixed } from '@strands-agents/sdk/multiagent'
import { makeShell } from '@strands-agents/sdk/vended-tools/bash'
import { GENERALIST, makeSubagent } from '@strands-agents/sdk/vended-tools/subagent'

import type { HarnessAgentOptions } from './agent.js'
import {
  BUILTIN_TOOL_NAMES,
  builtinToolConfigKeys,
  type BuiltinToolName,
  type ConfigurableBuiltinToolName,
} from './config.js'
import { DEFAULT_BUILTIN_TOOLS, DEFAULT_MODEL, DEFAULT_SUBAGENT_MAX_DEPTH } from './defaults.js'
import { logger } from './logging.js'
import { resolveMemory } from './memory.js'
import { resolveWebFetchModel, supportsMedia, supportsWebSearch } from './models.js'
import { edit, exaWebSearch, makeRead, makeWebFetch, write } from './tools/index.js'
import { makeProgrammaticToolCaller } from './tools/programmatic-tool-caller.js'
import type { BuiltinToolsConfig, SubagentConfig, ToolConfig, WebSearchSetting } from './types/agent.js'

export type ResolvedBuiltinTools = {
  readonly [K in BuiltinToolName]: K extends 'web_search' ? WebSearchSetting : boolean | ToolConfig<K>
}

/**
 * Resolve `builtinTools` to one entry per built-in name. `undefined` selects the harness's defaults; a
 * list pins exactly those names; a mapping edits the defaults (or nothing, with `'*': false`).
 */
export function resolveBuiltinTools(
  value: readonly BuiltinToolName[] | BuiltinToolsConfig | undefined
): ResolvedBuiltinTools {
  const names = BUILTIN_TOOL_NAMES as readonly string[]
  const mapping: Record<string, unknown> = Array.isArray(value)
    ? Object.fromEntries([['*', false], ...(value as readonly string[]).map((name) => [name, true])])
    : (value ?? {})
  if (typeof mapping !== 'object' || mapping === null) {
    throw new TypeError(
      `builtinTools must be a list of names or a mapping of name to boolean/config, got ${JSON.stringify(value)}; [] turns every built-in off.`
    )
  }
  const star = '*' in mapping ? mapping['*'] : true
  if (typeof star !== 'boolean') {
    throw new TypeError(`builtinTools['*'] must be a boolean, got ${JSON.stringify(star)}.`)
  }
  const resolved: Record<string, boolean | object | 'exa'> = Object.fromEntries(
    names.map((name) => [name, star && DEFAULT_BUILTIN_TOOLS.includes(name as BuiltinToolName)])
  )
  for (const [name, setting] of Object.entries(mapping)) {
    if (name === '*') continue
    if (!names.includes(name)) {
      throw new Error(`Unknown built-in tool ${JSON.stringify(name)}. Available: ${names.join(', ')}.`)
    }
    if (typeof setting === 'boolean' || (name === 'web_search' && setting === 'exa')) {
      resolved[name] = setting
      continue
    }
    if (name === 'web_search') {
      throw new TypeError(`builtinTools.web_search must be a boolean or 'exa', got ${JSON.stringify(setting)}.`)
    }
    if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) {
      throw new TypeError(`builtinTools.${name} must be a boolean or a config object, got ${JSON.stringify(setting)}.`)
    }
    const allowed = builtinToolConfigKeys(name as BuiltinToolName)
    if (allowed === undefined) {
      throw new TypeError(`Built-in tool ${JSON.stringify(name)} takes no config; pass true or false.`)
    }
    const unknown = Object.keys(setting).filter((key) => !allowed.includes(key))
    if (unknown.length > 0) {
      throw new TypeError(`Unknown ${name} config keys: ${unknown.sort().join(', ')}. Allowed: ${allowed.join(', ')}.`)
    }
    // A subagent that may not delegate even once is not registered at all.
    resolved[name] = name === 'subagent' && (setting as SubagentConfig).maxDepth === 0 ? false : setting
  }
  return resolved as ResolvedBuiltinTools
}

/** The names enabled in a resolved record, in canonical (`BUILTIN_TOOL_NAMES`) order. */
export function enabledBuiltinTools(resolved: ResolvedBuiltinTools): BuiltinToolName[] {
  return BUILTIN_TOOL_NAMES.filter((name) => resolved[name] !== false)
}

/** A configurable built-in's config in a resolved record: `{}` when enabled without one, `undefined` when off. */
export function builtinToolConfig<K extends ConfigurableBuiltinToolName>(
  resolved: ResolvedBuiltinTools,
  name: K
): ToolConfig<K> | undefined {
  const setting = resolved[name]
  return setting === false ? undefined : ((setting === true ? {} : setting) as ToolConfig<K>)
}

/**
 * Whether the caller named `web_search` themselves (in a list, or as a mapping key) rather than
 * getting it from the defaults; an explicit request on a model without native search throws
 * instead of warning.
 */
export function webSearchExplicit(value: readonly BuiltinToolName[] | BuiltinToolsConfig | undefined): boolean {
  return Array.isArray(value)
    ? (value as readonly string[]).includes('web_search')
    : (value as BuiltinToolsConfig | undefined)?.web_search !== undefined
}

export type WebSearchMode = 'native' | 'exa'

/**
 * How `web_search` is served for `model`: `'exa'` (the third-party tool, whenever opted into with
 * `'exa'`), `'native'` (a model flag), or `undefined` (off).
 */
export function webSearchMode(
  setting: WebSearchSetting,
  explicit: boolean,
  model: HarnessAgentOptions['model']
): WebSearchMode | undefined {
  if (setting === false) {
    return undefined
  }
  if (setting === 'exa') {
    logger.warn(
      "web_search is opted into Exa (exa.ai), a third-party service: every search query leaves your environment and is subject to Exa's privacy policy (https://exa.ai/privacy-policy)."
    )
    return 'exa'
  }
  if (supportsWebSearch(model)) {
    return 'native'
  }
  const target =
    typeof model === 'string' || model === undefined ? `Model ${model ?? DEFAULT_MODEL}` : 'A pre-built Model instance'
  if (explicit) {
    throw new Error(
      `${target} has no built-in web search. Pass builtinTools: { web_search: 'exa' } to search ` +
        "through Exa (a third party), or remove 'web_search' from builtinTools. See https://strandsagents.com/docs/user-guide/harness/tools/web-access/#web_search"
    )
  }
  // Info, not a warning: the user didn't ask for search, and nothing failed.
  logger.info(
    `${target} has no built-in web search, so the web_search tool is disabled. To enable it through Exa ` +
      "(a third party), pass builtinTools: { web_search: 'exa' }. See https://strandsagents.com/docs/user-guide/harness/tools/web-access/#web_search"
  )
  return undefined
}

/** The `createHarness` factory, injected to avoid a value import from `agent.ts`. */
export type BuildAgent = (options: HarnessAgentOptions) => Promise<Agent>

// `web_fetch` needs the agent's model to pick its default summarizer, and `subagent` the whole
// parent config to rebuild a child. `web_search` here is the Exa tool; `createHarness` selects
// it only when the setting is `'exa'`.
export async function buildBuiltinTools(
  buildAgent: BuildAgent,
  parentConfig: HarnessAgentOptions,
  builtins: ResolvedBuiltinTools
): Promise<Record<BuiltinToolName, Tool>> {
  const webFetch = builtinToolConfig(builtins, 'web_fetch')
  const caller = builtinToolConfig(builtins, 'programmatic_tool_caller') ?? {}
  const subagent = builtinToolConfig(builtins, 'subagent') ?? {}
  return {
    // Stateless, sandbox-routed shell: each call runs fresh, so its schema is just `command`/`timeout`
    // with no `mode` discriminator for the model to omit.
    shell: makeShell(builtinToolConfig(builtins, 'shell') ?? {}),
    read: makeRead({
      media: builtinToolConfig(builtins, 'read')?.media ?? (await supportsMedia(parentConfig.model)),
    }),
    write,
    edit,
    web_fetch: makeWebFetch({
      model: await resolveWebFetchModel(parentConfig.model, webFetch?.model),
      transport: webFetch?.transport,
    }),
    web_search: exaWebSearch,
    // The portable config spells the bound in seconds (`timeout`); the factory takes `timeoutMs`.
    programmatic_tool_caller: makeProgrammaticToolCaller({
      ...(caller.allowedTools === undefined || caller.allowedTools === null
        ? {}
        : { allowedTools: caller.allowedTools }),
      ...(caller.timeout === undefined ? {} : { timeoutMs: caller.timeout === null ? null : caller.timeout * 1000 }),
    }),
    subagent: buildDefaultSubagent(buildAgent, parentConfig, subagent),
  }
}

/** The tool objects for `names`. */
export function selectBuiltinTools(names: readonly BuiltinToolName[], tools: Record<BuiltinToolName, Tool>): ToolList {
  return names.map((name) => tools[name])
}

const SUBAGENT_DESCRIPTION =
  'Delegate a self-contained task to a subagent that runs in its own context and returns a final ' +
  'report. Reach for this when a subtask would otherwise flood your context with intermediate ' +
  'work and you only need its conclusion. Do not poll for progress or redo its work.'

/**
 * The `subagent` tool the harness wires by default: the SDK's tool with the `generalist` preset and a
 * builder that rebuilds the child through `buildAgent` with the resolved spec applied.
 *
 * Consumer `tools` join the selectable set (same objects, same inherited `interventions`); the
 * builder splits a selection back into `builtinTools` (names) and `tools` (objects). The parent's
 * `McpClient` entries always stay in the child's `tools` (shared, not reconnected: `connect()` is a
 * no-op once connected), so the delegate keeps every MCP tool.
 *
 * `memory` (default `true`) shares the parent's store(s) with the delegate read-only; `false` builds
 * delegates with no memory. `maxDepth` is the `builtinTools.subagent` config's delegation-depth
 * bound, forwarded to `makeSubagent`.
 */
export function buildDefaultSubagent(
  buildAgent: BuildAgent,
  parentConfig: HarnessAgentOptions,
  { memory = true, maxDepth = DEFAULT_SUBAGENT_MAX_DEPTH }: { memory?: boolean; maxDepth?: number } = {}
): Tool {
  // Only named `Tool` instances can join the selectable set; the SDK also accepts unnamed forms.
  const consumerByName = new Map<string, Tool>()
  for (const candidate of parentConfig.tools ?? []) {
    if (candidate instanceof Tool) {
      consumerByName.set(candidate.name, candidate)
    }
  }
  const mcpClients = (parentConfig.tools ?? []).filter((candidate) => candidate instanceof McpClient)
  const parentBuiltins = resolveBuiltinTools(parentConfig.builtinTools)
  const parentMemory = parentConfig.memory instanceof MemoryManager ? false : parentConfig.memory
  // web_search is resolved per model, not selectable; subagent stays in, bounded by the depth guard.
  const inheritedTools = [
    ...enabledBuiltinTools(parentBuiltins).filter((name) => name !== 'web_search'),
    ...consumerByName.keys(),
  ]

  const builder: AgentBuilder = async (spec: AgentSpec): Promise<Agent> => {
    const childConfig: HarnessAgentOptions = { ...parentConfig, printer: false }
    // Recall-only memory view; force `memory: false` so a memory-off delegate builds no writable store.
    if (memory && parentMemory && parentConfig.memoryManager === undefined) {
      const memoryConfig = parentMemory === true ? {} : parentMemory
      childConfig.memoryManager = await resolveMemory({
        stores: memoryConfig.stores,
        model: parentConfig.model,
        dir: memoryConfig.dir,
        webFetch: builtinToolConfig(parentBuiltins, 'web_fetch'),
        writable: false,
      })
    }
    childConfig.memory = false
    if (spec.instructions !== undefined) {
      childConfig.instructions = spec.instructions
    }
    if (spec.tools !== undefined) {
      // spec.tools is already clamped to the allowed set; split it back into the two channels. The
      // selection pins a mapping so each tool keeps its parent config (e.g. `web_fetch.model`).
      const builtinNames = spec.tools.filter((t): t is BuiltinToolName => !consumerByName.has(t))
      // web_search isn't selectable; a parent that named it passes its setting on for the child to
      // resolve against its own model.
      childConfig.builtinTools = Object.fromEntries(
        BUILTIN_TOOL_NAMES.filter((name) => name !== 'web_search' || webSearchExplicit(parentConfig.builtinTools)).map(
          (name) => [name, builtinNames.includes(name) || name === 'web_search' ? parentBuiltins[name] : false]
        )
      ) as BuiltinToolsConfig
      childConfig.tools = [
        ...spec.tools.filter((t) => consumerByName.has(t)).map((t) => consumerByName.get(t)!),
        ...mcpClients,
      ]
    }
    if (spec.model !== undefined) {
      childConfig.model = spec.model
    }
    return buildAgent(childConfig)
  }

  return makeSubagent({
    builder,
    presets: { generalist: GENERALIST },
    // The tool is built even when `subagent` is off, so the selectable set can be empty.
    tools: inheritedTools.length > 0 ? new Choice(inheritedTools, true) : new Fixed([]),
    // Offer context sharing; omitted, the child starts isolated ('none').
    context: new Choice(['none', 'all', 'no_tools']),
    maxDepth,
    description: SUBAGENT_DESCRIPTION,
  })
}
