/**
 * The harness factory: a preconfigured Strands `Agent` in one call.
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Agent,
  type AgentConfig,
  type BackgroundTasksConfig,
  FileStorage as SessionFileStorage,
  InitializedEvent,
  McpClient,
  type McpServerConfig,
  MemoryManager,
  type Model,
  type ModelRouter,
  type Plugin,
  SessionManager,
  Tool,
  type ToolList,
} from '@strands-agents/sdk'
import { ContextOffloader, FileStorage } from '@strands-agents/sdk/vended-plugins/context-offloader'
import { AgentSkills, type SkillSource } from '@strands-agents/sdk/vended-plugins/skills'
import { EnvironmentContext, Todos } from './plugins/index.js'
import {
  buildBuiltinTools,
  builtinToolConfig,
  enabledBuiltinTools,
  resolveBuiltinTools,
  selectBuiltinTools,
  webSearchExplicit,
  webSearchMode,
  type ResolvedBuiltinTools,
} from './builtin-tools.js'
import {
  DEFAULT_BUILTIN_PLUGINS,
  DEFAULT_CACHING,
  DEFAULT_CONTEXT_MANAGER,
  DEFAULT_EFFORT,
  DEFAULT_MEMORY,
  DEFAULT_MODEL,
  DEFAULT_SESSION,
  DEFAULT_SESSION_DIR,
  DEFAULT_SKILLS,
  DEFAULT_SKILLS_DIR,
} from './defaults.js'
import { type InterventionsOption, resolveInterventions } from './interventions.js'
import { resolveMemory } from './memory.js'
import { resolveModel } from './models.js'
import { buildSystemPrompt } from './prompt.js'
import { setupTelemetry } from './telemetry.js'
import type { BuiltinPluginName, BuiltinToolName } from './config.js'
import type { BuiltinToolsConfig, ContextManagerOption, Effort, MemoryConfig, SessionConfig } from './types/agent.js'

/**
 * Built-in plugins, each toggled by name via `builtinPlugins`. Unlike the offloader and skills
 * plugins (wired from their own options), these are opt-out feature plugins that only bundle a tool
 * and a loop-level behavior; the map is the seam to grow the set (e.g. memories) later.
 */
const BUILTIN_PLUGINS = { todos: Todos, environment: EnvironmentContext } as const

// The delegation tool always runs in the background: its calls are long-running subtasks whose
// intermediate work should stay out of the parent's turn.
const ALWAYS_BACKGROUND_TOOL_NAMES = new Set(['subagent'])

const AUTO_MAX_RESULT_TOKENS = 1_500
const AUTO_PREVIEW_TOKENS = 750

/**
 * Options for {@link createHarness}. Every field is optional.
 *
 * Any {@link AgentConfig} field not named here (e.g. `retryStrategy`) may still be passed through
 * and is forwarded verbatim to the `Agent` constructor; an explicit value always takes precedence
 * over the harness default it corresponds to.
 */
export interface HarnessAgentOptions extends Omit<
  AgentConfig,
  'model' | 'tools' | 'plugins' | 'interventions' | 'backgroundTasks' | 'contextManager'
> {
  /**
   * A `Model` or `ModelRouter` instance, a `"provider/name"` string (e.g.
   * `"anthropic/claude-fable-5"`), a bare Bedrock model id, or `undefined` for the harness default
   * (Bedrock Opus 5).
   */
  model?: Model | ModelRouter | string
  /**
   * Reasoning effort applied to the resolved model, mapped to each provider's request fields.
   * `'auto'` (the default) uses the provider's recommended level, `'off'` turns reasoning off
   * (the provider's `none` level where it has one), and a named level (`'minimal'`, `'low'`,
   * `'medium'`, `'high'`, `'xhigh'`, `'max'`) sets it explicitly; a level the resolved provider
   * does not support throws. Ignored when `model` is a `Model` or `ModelRouter` instance.
   */
  effort?: Effort
  /** A domain block appended after the harness contract. Ignored when `systemPrompt` is passed. */
  instructions?: string
  /**
   * Consumer tools, added alongside the built-in tools. To expose a specialist `Agent` as a tool,
   * wrap it with `Agent.asTool()` and pass it here. A tool name must be unique across all sources
   * (built-in tools, `tools`, plugins); a collision throws at construction. To replace a built-in,
   * drop it first via `builtinTools` so the name is free. Consumer tools also join the `subagent`
   * tool's narrowable set, so a delegate can be granted them too; a connected `McpClient` passed here
   * is offered on its `mcp_servers` axis under its `clientName` (set `applicationName`), like the
   * servers loaded from `mcpServers`; an unnamed or same-named client is warned about and left off it.
   */
  tools?: ToolList
  /**
   * Consumer plugins, registered alongside the harness's. A `ContextOffloader` or `AgentSkills` instance
   * passed here replaces the one the harness would add; a `Todos`/`EnvironmentContext` instance replaces
   * the matching built-in plugin. A `subagent` child inherits these plugins.
   */
  plugins?: Plugin[]
  /**
   * MCP servers to connect, given as the standard `mcpServers` config: either a path to a JSON
   * file (a flat `{ name: {...} }` map, or that map under an `mcpServers` key) or the flat map
   * itself. Each server's tools are discovered and added to the tool list, and the SDK manages
   * connection and lifecycle. A server that fails to start yields no tools rather than failing
   * construction; set `continueOnError: false` on a server to make its failure fatal. Each server's
   * tools are prefixed with its name by default (`<server>_<tool>`) so servers don't clash; set a
   * server's `prefix` to override, or `prefix: ''` to opt out.
   */
  mcpServers?: string | Record<string, McpServerConfig>
  /**
   * Which built-in tools to enable. A list pins exactly those names (`[]` disables them all); a
   * mapping edits the defaults (`DEFAULT_BUILTIN_TOOLS`): `'*'` (default `true`) is the baseline,
   * `false` drops a tool, `true` adds one, and a config object enables and configures one
   * (`ToolConfig`; the keys per tool are `BUILTIN_TOOL_CONFIG_KEYS`). `web_search` turns on the
   * provider's native web search (OpenAI, Google, GPT-5/GPT-6 models on bedrock-mantle); elsewhere it
   * is off, and naming it there throws. `{ web_search: 'exa' }` instead gives the model a
   * `web_search` tool backed by Exa's hosted search on any model, a third party that receives the
   * queries (keyless; `EXA_API_KEY` lifts its rate limit). A `subagent` child inherits this agent's
   * configuration, bounded by a delegation-depth guard.
   */
  builtinTools?: readonly BuiltinToolName[] | BuiltinToolsConfig
  /**
   * SDK Background Tasks policy. The `subagent` tool always runs in the background; by default, the model
   * may choose background execution for any other compatible tool. The invocation waits for
   * completion and continues with the result. Pass `false` to disable Background Tasks, or provide
   * a policy to control other tools, concurrency, completion, and timeouts.
   */
  backgroundTasks?: boolean | BackgroundTasksConfig
  /**
   * Enables prompt caching to save cost and latency where the provider supports it (Bedrock and
   * Anthropic direct set cache points and cached tools; OpenAI, Google, and bedrock-mantle cache
   * automatically server-side). Defaults to on. `false`/`null` turns off what the harness configures, and
   * has no effect where caching is automatic. On a pre-built `Model`/`ModelRouter` the option is
   * not applied; the harness warns once and passes the instance through — configure caching on the
   * instance.
   */
  caching?: 'auto' | boolean | null
  /**
   * SDK context management: `'auto'` (the default) or `'agentic'` selects an SDK-managed strategy,
   * a `ContextManager` instance is used as-is, and `false`/`null` disables it. With a preset, large
   * tool results are also offloaded to disk (a preview and reference are kept in context) so the
   * agent can run longer before compacting; an instance or `false` turns the harness's offloader off too,
   * and a `ContextOffloader` in `plugins` replaces it.
   */
  contextManager?: ContextManagerOption
  /**
   * File-backed conversation persistence, on by default. `true` snapshots the run to
   * `./.agent/sessions` under a fresh random id via a `SessionManager`, and offloaded artifacts
   * stay durable there; `{ id, dir }` picks the id (pass a previous run's `agent.sessionId` to
   * resume that conversation) and/or the root directory; a `SessionManager` instance is used
   * as-is. `false`/`null` disables it (the conversation is in-memory and artifacts go to a
   * temporary directory that does not outlive the process). Ignored when an explicit
   * `sessionManager` is passed.
   */
  session?: boolean | SessionConfig | SessionManager | null
  /**
   * Agent Skills, loaded via the SDK's `AgentSkills` plugin for progressive disclosure. `true`
   * (the default) scans `./.agent/skills` when it exists; a directory path, `https://` URL to a
   * `SKILL.md`, `Skill` instance, or list of those is passed to the plugin (missing local
   * directories are skipped); an `AgentSkills` instance is used as-is. `false`/`null` disables
   * skills. Ignored when an `AgentSkills` instance is in `plugins`.
   */
  skills?: boolean | SkillSource | SkillSource[] | AgentSkills | null
  /**
   * File-based long-term memory, on by default. `true` distills durable facts into markdown files
   * under `./.agent/memory`, searches them before each turn, and folds the top matches into
   * context; memory is independent of any session, so it survives across sessions. `{ dir,
   * stores }` moves the directory or swaps the backend (one or more stores under the harness's memory
   * policy: injection on, `search_memory` on, no `add_memory` tool; the `subagent` delegate shares
   * them read-only); a `MemoryManager` instance is used as-is. `false`/`null` disables it. Ignored
   * when an explicit `memoryManager` is passed.
   *
   * Extraction is background and turn-triggered, so a short run may end before the first extraction
   * fires and the latest turns are unsaved when the agent responds. Call
   * `await agent.memoryManager?.flush()` at your shutdown boundary to persist what's pending.
   */
  memory?: boolean | MemoryConfig | MemoryManager | null
  /**
   * Names of the built-in feature plugins to enable. Defaults to `['todos', 'environment']`:
   * `todos` adds a `todo_write` tool that tracks multi-step work and re-surfaces the list before
   * each step; `environment` injects the platform, date, working directory, and the project's
   * `AGENTS.md` (plus links to nearby `AGENTS.md`/`README.md` files) before each user turn. Pass
   * `[]` to disable them.
   */
  builtinPlugins?: readonly BuiltinPluginName[]
  /**
   * Gate tool calls behind approval or a policy; defaults to `undefined` (off — every call runs).
   * Accepts a preset (`'ask'` approves every call, `'smart'` lets the SDK's LLM risk classifier flag
   * risky ones), a natural-language policy used as that classifier's prompt, a `.cedar` policy file
   * (needs `@cedar-policy/cedar-wasm`), a `HumanInTheLoop`/`CedarAuthorization` instance for full
   * control, or an array layering a Cedar policy with one human gate. Sugar over the SDK's handlers;
   * a `subagent` child inherits the policy so a delegate cannot bypass it.
   */
  interventions?: InterventionsOption
}

function sanitizeSessionId(sessionId: string): string {
  return (
    sessionId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/gu, '-') || 'default'
  )
}

function durableOffloader(offloadDir: string): Plugin {
  return new ContextOffloader({
    storage: new FileStorage({ artifactDir: offloadDir }),
    maxResultTokens: AUTO_MAX_RESULT_TOKENS,
    previewTokens: AUTO_PREVIEW_TOKENS,
  })
}

function hasOffloader(plugins: readonly Plugin[]): boolean {
  return plugins.some((p) => p instanceof ContextOffloader)
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the `skills` option into an `AgentSkills` plugin, or `null` when nothing was requested.
 * `true` is best-effort: it loads the default directory only when it exists locally. Explicit
 * sources are passed through unfiltered (they are read through the agent's sandbox at init, so a
 * host-side check would be wrong for remote sandboxes); the SDK warns on a missing path.
 */
function skillsPlugin(skills: true | SkillSource | SkillSource[] | AgentSkills): Plugin | null {
  if (skills instanceof AgentSkills) {
    return skills
  }
  if (skills === true) {
    return isDir(DEFAULT_SKILLS_DIR) ? new AgentSkills({ skills: [DEFAULT_SKILLS_DIR] }) : null
  }
  const sources = Array.isArray(skills) ? skills : [skills]
  if (sources.length === 0) {
    return null
  }
  return new AgentSkills({ skills: sources })
}

function hasSkills(plugins: readonly Plugin[]): boolean {
  return plugins.some((p) => p instanceof AgentSkills)
}

function selectBuiltinPlugins(names: readonly string[], existing: readonly Plugin[]): Plugin[] {
  const selected: Plugin[] = []
  for (const name of names) {
    if (!(name in BUILTIN_PLUGINS)) {
      const available = Object.keys(BUILTIN_PLUGINS).sort().join(', ')
      throw new Error(`Unknown built-in plugin ${JSON.stringify(name)}. Available: ${available}.`)
    }
    const PluginClass = BUILTIN_PLUGINS[name as BuiltinPluginName]
    if (!existing.some((p) => p instanceof PluginClass)) {
      selected.push(new PluginClass())
    }
  }
  return selected
}

/**
 * Throw if two tools would register under the same name, so a collision fails at construction with
 * the losing source named rather than one tool silently disappearing. Names differing only by
 * `-`/`_` collide, matching the SDK tool registry. Each source is `[label, isBuiltin, tools]`; the
 * remedy only mentions dropping a built-in when a built-in is actually one of the two sources.
 */
function checkNameCollisions(sources: ReadonlyArray<readonly [string, boolean, ToolList]>): void {
  const seen = new Map<string, { label: string; isBuiltin: boolean }>()
  for (const [label, isBuiltin, tools] of sources) {
    for (const tool of tools) {
      // Only resolved Tool instances have a fixed name here; Agents/McpClients resolve later.
      if (!(tool instanceof Tool)) {
        continue
      }
      const key = tool.name.replaceAll('-', '_')
      const prior = seen.get(key)
      if (prior !== undefined) {
        const where = prior.label === label ? label : `${prior.label} and ${label}`
        const remedy =
          isBuiltin || prior.isBuiltin
            ? 'Rename the tool you passed, or drop the built-in via builtinTools / builtinPlugins.'
            : 'Rename one so each tool has a unique name.'
        throw new Error(
          `Tool name ${JSON.stringify(tool.name)} is registered more than once (from ${where}). ${remedy}`
        )
      }
      seen.set(key, { label, isBuiltin })
    }
  }
}

/** The tools each plugin vends (e.g. the todos plugin's `todo_write`), via the SDK's `getTools()`. */
function pluginTools(plugins: readonly Plugin[]): ToolList {
  return plugins.flatMap((plugin) => plugin.getTools?.() ?? [])
}

/** Drop the tools the sandbox vends (e.g. `sandbox_bash`); the harness's built-ins already route through it. */
function dropSandboxTools(agent: Agent): void {
  for (const tool of agent.sandbox.getTools()) {
    agent.toolRegistry.remove(tool.name)
  }
}

function resolveBackgroundTasks(
  configured: boolean | BackgroundTasksConfig | undefined,
  forced: readonly Tool[]
): false | BackgroundTasksConfig {
  if (configured === false) {
    return false
  }

  const policy: BackgroundTasksConfig =
    configured === undefined || configured === true ? { agentic: ['*'] } : configured
  const forcedNames = new Set(forced.map((tool) => tool.name))
  const omitForced = (
    selectors: NonNullable<BackgroundTasksConfig['agentic']>
  ): NonNullable<BackgroundTasksConfig['agentic']> =>
    selectors.filter(
      (selector) => selector === '*' || !forcedNames.has(typeof selector === 'string' ? selector : selector.name)
    )
  const always = [...omitForced(policy.always ?? []), ...forced]

  return {
    ...policy,
    ...(policy.agentic !== undefined ? { agentic: omitForced(policy.agentic) } : {}),
    ...(always.length > 0 || policy.always !== undefined ? { always } : {}),
    ...(policy.never !== undefined ? { never: omitForced(policy.never) } : {}),
  }
}

/**
 * Build a preconfigured Strands agent with the harness's defaults enabled.
 *
 * Every default is overridable, and the return value is a plain `Agent` that can be modified
 * further after construction. Any `AgentConfig` field may be passed through `options`; an
 * explicit value takes precedence over the default it corresponds to.
 *
 * Resolution is async because model providers are imported on demand: only the provider you
 * use needs its peer dependency installed.
 *
 * @param options - Harness options; see {@link HarnessAgentOptions}. All fields optional.
 * @returns A configured `Agent`.
 */
export async function createHarness(options: HarnessAgentOptions = {}): Promise<Agent> {
  const {
    model,
    effort = DEFAULT_EFFORT,
    instructions,
    tools,
    plugins: consumerPluginsOption,
    mcpServers,
    builtinTools,
    backgroundTasks,
    caching,
    contextManager: contextManagerOption = DEFAULT_CONTEXT_MANAGER,
    session = DEFAULT_SESSION,
    skills = DEFAULT_SKILLS,
    memory = DEFAULT_MEMORY,
    builtinPlugins,
    interventions,
    ...agentConfig
  } = options

  await setupTelemetry()

  // A `subagent` child inherits this record, so it only ever sees the normalized shape.
  const resolvedBuiltins: ResolvedBuiltinTools = resolveBuiltinTools(builtinTools)
  const webSearch = webSearchMode(resolvedBuiltins.web_search, webSearchExplicit(builtinTools), model)
  const webFetch = builtinToolConfig(resolvedBuiltins, 'web_fetch')

  // Not passing `caching` uses the default (on) and warns on unsupported providers; passing any
  // value is an explicit request, so `'auto'`/`true` raises there instead (a `Model`/`ModelRouter`
  // instance warns instead, since the option cannot be applied to a pre-built model).
  const cachingExplicit = caching !== undefined
  const cachingOn = cachingExplicit ? Boolean(caching) : Boolean(DEFAULT_CACHING)
  const resolvedModel = await resolveModel(
    model,
    DEFAULT_MODEL,
    effort,
    webSearch === 'native',
    cachingOn,
    cachingExplicit
  )

  if (agentConfig.systemPrompt === undefined) {
    agentConfig.systemPrompt = buildSystemPrompt(instructions)
  }

  // MCP clients are tool providers the SDK connects at load time; loaded ones join `tools` as consumer tools.
  const consumer: ToolList = [
    ...(tools ?? []),
    ...(mcpServers
      ? await McpClient.loadServers(mcpServers, { continueOnError: true }, { prefixWithServerName: true })
      : []),
  ]

  // The config a `subagent` child is rebuilt from (see buildDefaultSubagent). Sessions are forced
  // off so a throwaway delegate never persists its own session state.
  const memoryInstance = memory instanceof MemoryManager || agentConfig.memoryManager !== undefined
  const forwardedBuiltins: BuiltinToolsConfig = { '*': true, ...resolvedBuiltins }
  if (webSearch === undefined) {
    // Off, or default-on but unavailable here: forward it off so a child with the same model stays quiet.
    forwardedBuiltins.web_search = false
  } else if (!webSearchExplicit(builtinTools)) {
    // Forward the default as a default, so a child on a model without native search warns, not throws.
    delete forwardedBuiltins.web_search
  }
  const parentConfig: HarnessAgentOptions = {
    effort,
    contextManager: contextManagerOption,
    skills,
    memory: memoryInstance ? false : memory,
    session: false,
    tools: consumer,
    builtinTools: forwardedBuiltins,
    ...(model !== undefined && { model }),
    ...(caching !== undefined && { caching }),
    ...(builtinPlugins !== undefined && { builtinPlugins }),
    ...(consumerPluginsOption !== undefined && { plugins: consumerPluginsOption }),
    ...(interventions !== undefined && { interventions }),
    ...(backgroundTasks !== undefined && { backgroundTasks }),
    ...(agentConfig.sandbox !== undefined && { sandbox: agentConfig.sandbox }),
  }

  const builtin = selectBuiltinTools(
    enabledBuiltinTools({ ...resolvedBuiltins, web_search: webSearch === 'exa' }),
    await buildBuiltinTools(createHarness, parentConfig, resolvedBuiltins)
  )
  const contextEnabled = contextManagerOption !== false && contextManagerOption !== null
  // A caller-built `ContextManager` is the whole strategy; the harness only adds its offloader to the presets.
  const contextCustom = typeof contextManagerOption === 'object' && contextManagerOption !== null

  // Assemble plugins before the collision check so plugin-vended tools are checked too; consumer
  // plugins stay first so the tail is the harness's own.
  const consumerPlugins: Plugin[] = [...(consumerPluginsOption ?? [])]
  const plugins: Plugin[] = [...consumerPlugins]

  // Resolved before the offloader so its artifacts land under the session directory when a session
  // is active and in a throwaway temp dir otherwise.
  let sessionManager = agentConfig.sessionManager
  let sessionDir = DEFAULT_SESSION_DIR
  if (session && sessionManager === undefined) {
    if (session instanceof SessionManager) {
      sessionManager = session
    } else {
      const sessionConfig: SessionConfig = session === true ? {} : session
      if (sessionConfig.id !== undefined && sessionConfig.id.trim() === '') {
        throw new Error('session.id must be a non-empty string.')
      }
      sessionDir = sessionConfig.dir ?? DEFAULT_SESSION_DIR
      sessionManager = new SessionManager({
        sessionId: sessionConfig.id ? sanitizeSessionId(sessionConfig.id) : randomUUID().slice(0, 8),
        storage: { snapshot: new SessionFileStorage(sessionDir) },
        saveLatestOn: 'message',
      })
    }
  }

  if (contextEnabled && !contextCustom && !hasOffloader(plugins)) {
    const offloadDir =
      sessionManager !== undefined ? `${sessionDir}/offloaded` : mkdtempSync(join(tmpdir(), 'strands-offload-'))
    plugins.push(durableOffloader(offloadDir))
  }

  if (skills && !hasSkills(plugins)) {
    const skillsPluginInstance = skillsPlugin(skills)
    if (skillsPluginInstance !== null) {
      plugins.push(skillsPluginInstance)
    }
  }

  plugins.push(...selectBuiltinPlugins(builtinPlugins ?? DEFAULT_BUILTIN_PLUGINS, plugins))
  const harnessPlugins = plugins.slice(consumerPlugins.length)

  let memoryManager = agentConfig.memoryManager
  if (memory && memoryManager === undefined) {
    if (memory instanceof MemoryManager) {
      memoryManager = memory
    } else {
      const memoryConfig: MemoryConfig = memory === true ? {} : memory
      memoryManager = await resolveMemory({
        stores: memoryConfig.stores,
        model,
        dir: memoryConfig.dir,
        webFetch,
      })
    }
  }
  // A MemoryManager instance already carries its resolved tools (`search_memory` by default); a bare
  // config does not, so only an instance can be pre-flighted for name collisions here.
  const memoryTools = memoryManager instanceof MemoryManager ? memoryManager.getTools() : []

  checkNameCollisions([
    ['a built-in tool', true, builtin],
    ['tools', false, consumer],
    ['a built-in plugin', true, pluginTools(harnessPlugins)],
    ['plugins', false, pluginTools(consumerPlugins)],
    ['memory', true, memoryTools],
  ])
  // MCP tool names are only known once a client connects, so the pre-flight above skips them. They are
  // namespaced by server (`prefixWithServerName`) so cross-server names don't clash, but a server keyed
  // to a built-in name (e.g. `web` exposing `fetch` -> `web_fetch`) still can.
  const agentTools: ToolList = [...builtin, ...consumer]

  const contextManager: AgentConfig['contextManager'] = contextEnabled ? contextManagerOption : false

  const resolvedInterventions = await resolveInterventions(interventions)
  const resolvedBackgroundTasks = resolveBackgroundTasks(
    backgroundTasks,
    agentTools.filter(
      (candidate): candidate is Tool => candidate instanceof Tool && ALWAYS_BACKGROUND_TOOL_NAMES.has(candidate.name)
    )
  )

  const agent = new Agent({
    ...agentConfig,
    model: resolvedModel,
    tools: agentTools,
    plugins,
    backgroundTasks: resolvedBackgroundTasks,
    contextManager,
    ...(sessionManager !== undefined && { sessionManager }),
    ...(memoryManager !== undefined && { memoryManager }),
    interventions: resolvedInterventions,
  })
  if (agentConfig.sandbox) {
    // The SDK registers sandbox tools lazily in initialize(), so dedupe once that has run.
    agent.addHook(InitializedEvent, () => dropSandboxTools(agent))
  }
  return agent
}
