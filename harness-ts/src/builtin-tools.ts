/**
 * The harness's built-in tools: normalizing the `builtinTools` option into one record with every name
 * resolved, building the tool objects from it, and the default `subagent` that rebuilds a child
 * from the same record.
 */

import { type Agent, McpClient, MemoryManager, Tool, type ToolList } from '@strands-agents/sdk'
import { makeShell } from '@strands-agents/sdk/vended-tools/bash'

import type { HarnessAgentOptions } from './agent.js'
import {
  BUILTIN_TOOL_NAMES,
  builtinToolConfigKeys,
  type BuiltinToolName,
  type ConfigurableBuiltinToolName,
} from './config.js'
import { DEFAULT_BUILTIN_TOOLS, DEFAULT_MODEL } from './defaults.js'
import { logger } from './logging.js'
import { resolveMemory } from './memory.js'
import { resolveWebFetchModel, supportsMedia, supportsWebSearch } from './models.js'
import { edit, exaWebSearch, makeRead, makeWebFetch, write } from './tools/index.js'
import { makeProgrammaticToolCaller } from './tools/programmatic-tool-caller.js'
import { type AgentBuilder, type AgentSpec, Choice, CONTEXT_MODES, GENERALIST, makeSubagent } from './tools/subagent.js'
import type { BuiltinToolsConfig, ToolConfig, WebSearchSetting } from './types/agent.js'

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
    resolved[name] = setting
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
 * How `web_search` is served for `model`: `'native'` (a model flag), `'exa'` (the third-party tool,
 * opted into with `'exa'`), or `undefined` (off).
 */
export function webSearchMode(
  setting: WebSearchSetting,
  explicit: boolean,
  model: HarnessAgentOptions['model']
): WebSearchMode | undefined {
  if (setting === false) {
    return undefined
  }
  if (supportsWebSearch(model)) {
    return 'native'
  }
  if (setting === 'exa') {
    logger.warn(
      "web_search is opted into Exa (exa.ai), a third-party service: every search query leaves your environment and is subject to Exa's privacy policy (https://exa.ai/privacy-policy)."
    )
    return 'exa'
  }
  const target =
    typeof model === 'string' || model === undefined ? `Model ${model ?? DEFAULT_MODEL}` : 'A pre-built Model instance'
  const message =
    `${target} has no native web search. Pass builtinTools: { web_search: 'exa' } ` +
    "to search through Exa (a third party), or drop 'web_search'."
  if (explicit) {
    throw new Error(message)
  }
  logger.warn(message)
  return undefined
}

/** The `createHarness` factory, injected to avoid a value import from `agent.ts`. */
export type BuildAgent = (options: HarnessAgentOptions) => Promise<Agent>

// `web_fetch` needs the agent's model to pick its default summarizer, and `subagent` the whole
// parent config to rebuild a child. `web_search` here is the Exa fallback; `createHarness` selects
// it only for a model without native search.
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

// The SDK never leaves `clientName` empty: an `McpClient` built without `applicationName` reports this.
const UNNAMED_MCP_CLIENT = 'strands-agents-ts-sdk'

/**
 * Key the parent's `McpClient` entries by `clientName` for the `mcp_servers` axis. The model picks
 * servers by name, so a client without one can't be offered and is left out of delegation; when two
 * share a name the first keeps it and the rest are dropped. Both are warned about.
 */
function mcpClientsByClientName(tools: readonly unknown[]): Map<string, McpClient> {
  const clients = new Map<string, McpClient>()
  for (const client of tools) {
    if (!(client instanceof McpClient)) {
      continue
    }
    const name = client.clientName
    if (name === UNNAMED_MCP_CLIENT) {
      logger.warn(
        "An McpClient in `tools` has no applicationName; it can't be offered to subagents on `mcp_servers`, " +
          "so delegates won't get its tools. Set applicationName to name it."
      )
    } else if (clients.has(name)) {
      logger.warn(
        `Two McpClients in \`tools\` share the name ${JSON.stringify(name)}; only the first is offered to subagents on \`mcp_servers\`.`
      )
    } else {
      clients.set(name, client)
    }
  }
  return clients
}

/**
 * The `subagent` tool the harness wires by default: the `generalist` preset and a builder that rebuilds the
 * child through `buildAgent` with the resolved spec applied.
 *
 * Consumer `tools` join the selectable set (same objects, same inherited `interventions`); the
 * builder splits a selection back into `builtinTools` (names) and `tools` (objects). The parent's live
 * MCP clients are the `McpClient` entries in its `tools` (named by `clientName`); the selected ones stay
 * in the child's `tools` (shared, not reconnected: `connect()` is a no-op once connected) so the delegate
 * keeps the parent's MCP tools, narrowable per server through the `mcp_servers` axis (omitted grants all).
 * The clients are tool providers with no fixed tool name at schema-build time, so the axis selects
 * whole servers, not individual MCP tools.
 *
 * `memory` (default `true`) shares the parent's store(s) with the delegate read-only; `false` builds
 * delegates with no memory. `maxDepth` is the `builtinTools.subagent` config's delegation-depth
 * bound, forwarded to {@link makeSubagent}.
 */
export function buildDefaultSubagent(
  buildAgent: BuildAgent,
  parentConfig: HarnessAgentOptions,
  { memory = true, maxDepth }: { memory?: boolean; maxDepth?: number } = {}
): Tool {
  // Only named `Tool` instances can join the selectable set; the SDK also accepts unnamed forms.
  const consumerByName = new Map<string, Tool>()
  for (const candidate of parentConfig.tools ?? []) {
    if (candidate instanceof Tool) {
      consumerByName.set(candidate.name, candidate)
    }
  }
  const mcpClientsByName = mcpClientsByClientName(parentConfig.tools ?? [])
  const parentBuiltins = resolveBuiltinTools(parentConfig.builtinTools)
  const parentMemory = parentConfig.memory instanceof MemoryManager ? false : parentConfig.memory

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
    if (spec.instructions !== null) {
      childConfig.instructions = spec.instructions
    }
    if (spec.tools !== null) {
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
      childConfig.tools = spec.tools.filter((t) => consumerByName.has(t)).map((t) => consumerByName.get(t)!)
    }
    if (spec.model !== null) {
      childConfig.model = spec.model
    }
    // The clamped selection (or all servers, unnarrowed) replaces any parent clients in `tools`, so the
    // child re-offers exactly these on its own mcp_servers axis and can pass them to a grandchild.
    const selectedNames = spec.mcpServers ?? [...mcpClientsByName.keys()]
    const selected = [...new Set(selectedNames)].flatMap((n) => mcpClientsByName.get(n) ?? [])
    childConfig.tools = [...(childConfig.tools ?? []).filter((t) => !(t instanceof McpClient)), ...selected]
    return buildAgent(childConfig)
  }

  // web_search is resolved per model, not selectable; subagent stays in, bounded by the depth guard.
  const builtinNames = enabledBuiltinTools(parentBuiltins).filter((t) => t !== 'web_search')
  const inheritedTools = [...builtinNames, ...consumerByName.keys()]
  return makeSubagent({
    builder,
    presets: { generalist: GENERALIST },
    inheritedTools,
    inheritedMcpServers: [...mcpClientsByName.keys()],
    // Offer context sharing; the generalist preset defaults to 'none' (isolated).
    context: new Choice([...CONTEXT_MODES]),
    ...(maxDepth === undefined ? {} : { maxDepth }),
  })
}
