/**
 * Serializable harness configuration shared by the library, CLI, and project format.
 *
 * `HarnessAgentOptions` remains the runtime API and accepts live SDK objects. This config is the
 * portable form of the same agent definition: live values are represented by module references so
 * they can be loaded again instead of being silently omitted.
 */

import { createHash, type Hash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve as resolveImport } from 'import-meta-resolve'
import { z } from 'zod'

import {
  type Agent,
  type MemoryStore,
  type McpServerConfig,
  type Model,
  type Plugin,
  type Sandbox,
  type ToolList,
} from '@strands-agents/sdk'

import type { HarnessAgentOptions } from './agent.js'
import type { InterventionValue } from './interventions.js'
import {
  DEFAULT_BUILTIN_PLUGINS,
  DEFAULT_BUILTIN_TOOLS,
  DEFAULT_CONTEXT_MANAGER,
  DEFAULT_EFFORT,
  DEFAULT_MEMORY_DIR,
  DEFAULT_MODEL,
  DEFAULT_SESSION_DIR,
} from './defaults.js'
import { warnOnce } from './logging.js'
import { canonicalCommonJsLoader, isHostPackage, resolveReloadUrl, shareHostModules } from './config-module-loader.js'
import { EFFORT_LEVELS } from './models.js'
import type {
  BuiltinToolsConfig,
  Effort,
  MemoryConfig,
  SessionConfig,
  ToolConfig,
  WebFetchTransport,
} from './types/agent.js'

let sourceLoader: Promise<void> | undefined
const projectLoaders = new Set<string>()
const syncProjectLoaders = new Set<string>()

export const BUILTIN_TOOL_NAMES = [
  'shell',
  'read',
  'write',
  'edit',
  'web_fetch',
  'web_search',
  'programmatic_tool_caller',
  'subagent',
] as const

export const BUILTIN_PLUGIN_NAMES = ['todos', 'environment'] as const

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number]
export type BuiltinPluginName = (typeof BUILTIN_PLUGIN_NAMES)[number]

// Messages read as predicates so `formatIssues` can prefix the JSON path
// (`builtinTools.shell.description must be a non-empty string.`).
const NonEmptyString = z
  .string({ error: 'must be a non-empty string.' })
  .refine((value) => value.trim() !== '', 'must be a non-empty string.')
const NonEmptyStrings = z.array(NonEmptyString, { error: 'must be an array of non-empty strings.' })
const Bool = z.boolean({ error: 'must be a boolean.' })

function uniqueStrings<S extends z.ZodType<string[]>>(schema: S): S {
  return schema.check((context) => {
    const repeated = new Set(context.value.filter((entry, index) => context.value.indexOf(entry) !== index))
    if (repeated.size > 0) {
      context.issues.push({
        code: 'custom',
        input: context.value,
        message: `has duplicate entries: ${[...repeated].join(', ')}.`,
      })
    }
  })
}

function strictObject<T extends z.core.$ZodShape>(shape: T): z.ZodObject<T, z.core.$strict> {
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `has unknown keys: ${issue.keys.join(', ')}. Allowed: ${Object.keys(shape).join(', ')}.`
        : undefined,
  })
}

export const HARNESS_MODULE_KINDS = [
  'tool',
  'subagent',
  'plugin',
  'sandbox',
  'memory-store',
  'model',
  'intervention',
  'agent-config',
] as const
export type HarnessModuleKind = (typeof HARNESS_MODULE_KINDS)[number]
const HARNESS_MODULE_LANGUAGES = ['typescript', 'python'] as const
export type HarnessModuleLanguage = (typeof HARNESS_MODULE_LANGUAGES)[number]

export interface HarnessModuleReference {
  kind: HarnessModuleKind
  module: string
  export?: string
  language?: HarnessModuleLanguage
  files?: readonly string[]
  dependency?: string
}

function moduleReferenceSchema<K extends HarnessModuleKind>(kind: K): z.ZodType<HarnessModuleReference & { kind: K }> {
  return z
    .looseObject(
      {
        kind: z.literal(kind, { error: `must be ${JSON.stringify(kind)}.` }).default(kind),
        module: NonEmptyString,
        export: NonEmptyString.optional(),
        language: z
          .enum(HARNESS_MODULE_LANGUAGES, { error: `must be one of: ${HARNESS_MODULE_LANGUAGES.join(', ')}.` })
          .optional(),
        files: NonEmptyStrings.optional(),
        dependency: NonEmptyString.optional(),
      },
      { error: `must be a module reference of kind ${JSON.stringify(kind)}.` }
    )
    .transform((reference) => reference as HarnessModuleReference & { kind: K })
}
function moduleReferencesSchema<K extends HarnessModuleKind>(
  kind: K
): z.ZodDefault<z.ZodArray<z.ZodType<HarnessModuleReference & { kind: K }>>> {
  return z.array(moduleReferenceSchema(kind), { error: `must be an array of ${kind} module references.` }).default([])
}

// The interfaces are hand-written rather than inferred: zod would infer `?: T | undefined`, which
// `exactOptionalPropertyTypes` rejects. Each schema is checked against its interface's keys.

export interface ReadConfig {
  /** Return images and binary documents as viewable media. Defaults to whether the model accepts them. */
  media?: boolean
}
export interface ShellConfig {
  /** Tool description shown to the model; omit for the SDK's default. */
  description?: string
}
/** JSON form of `WebFetchConfig`: the summarizer model as a `provider/name` string or a module reference. */
export interface HarnessConfigWebFetch {
  model?: string | (HarnessModuleReference & { kind: 'model' })
  transport?: WebFetchTransport
}
export interface ProgrammaticToolCallerConfig {
  /** Names of the agent's other tools the code may call; omit (or `null`) for all of them. */
  allowedTools?: string[] | null
  /** Wall-clock bound in seconds for one run, tool calls included; `null` for no bound. Defaults to 900. */
  timeout?: number | null
}
export interface SubagentConfig {
  /** How many levels of delegation a child may itself open. Defaults to 2. */
  maxDepth?: number
}
/**
 * `web_search` setting: a boolean, or `'exa'` to fall back to Exa's hosted search on models without
 * native web search (a third party that sees the queries; keyless, `EXA_API_KEY` lifts its rate limit).
 */
export type WebSearchSetting = boolean | 'exa'

const ReadConfigSchema = strictObject({
  media: Bool.optional(),
} satisfies Record<keyof ReadConfig, z.ZodType>)
const ShellConfigSchema = strictObject({
  description: NonEmptyString.optional(),
} satisfies Record<keyof ShellConfig, z.ZodType>)
const WebFetchConfigSchema = strictObject({
  model: z
    .union([NonEmptyString, moduleReferenceSchema('model')], {
      error: 'must be a "provider/name" string or a model module reference.',
    })
    .optional(),
  transport: z.enum(['curl', 'direct'], { error: "must be 'curl' or 'direct'." }).optional(),
} satisfies Record<keyof HarnessConfigWebFetch, z.ZodType>)
const ProgrammaticToolCallerConfigSchema = strictObject({
  allowedTools: z
    .array(NonEmptyString, { error: 'must be an array of non-empty strings or null.' })
    .nullable()
    .optional(),
  timeout: z
    .number({ error: 'must be a positive number or null.' })
    .positive('must be a positive number or null.')
    .nullable()
    .optional(),
} satisfies Record<keyof ProgrammaticToolCallerConfig, z.ZodType>)
const SubagentConfigSchema = strictObject({
  maxDepth: z
    .number({ error: 'must be a non-negative integer.' })
    .int('must be a non-negative integer.')
    .nonnegative('must be a non-negative integer.')
    .optional(),
} satisfies Record<keyof SubagentConfig, z.ZodType>)

const WebSearchSettingSchema = z.union([Bool, z.literal('exa', { error: "must be a boolean or 'exa'." })], {
  error: "must be a boolean or 'exa'.",
}) satisfies z.ZodType<WebSearchSetting>

function toolSetting<T extends z.ZodType>(config: T): z.ZodOptional<z.ZodUnion<readonly [z.ZodBoolean, T]>> {
  return z.union([Bool, config], { error: 'must be a boolean or a config object.' }).optional()
}

/** JSON form of `BuiltinToolsConfig`: the same mapping, with `web_fetch.model` allowed to be a module reference. */
export type HarnessConfigBuiltinTools = { '*'?: boolean } & {
  [K in BuiltinToolName]?: K extends 'web_search'
    ? WebSearchSetting
    : boolean | (K extends 'web_fetch' ? HarnessConfigWebFetch : ToolConfig<K>)
}
const BuiltinToolsMappingSchema = strictObject({
  '*': Bool.optional(),
  shell: toolSetting(ShellConfigSchema),
  read: toolSetting(ReadConfigSchema),
  write: Bool.optional(),
  edit: Bool.optional(),
  web_fetch: toolSetting(WebFetchConfigSchema),
  web_search: WebSearchSettingSchema.optional(),
  programmatic_tool_caller: toolSetting(ProgrammaticToolCallerConfigSchema),
  subagent: toolSetting(SubagentConfigSchema),
} satisfies Record<keyof HarnessConfigBuiltinTools, z.ZodType>)

/** The config keys each configurable built-in accepts (see `ToolConfig`). */
export const BUILTIN_TOOL_CONFIG_KEYS = {
  read: Object.keys(ReadConfigSchema.shape),
  shell: Object.keys(ShellConfigSchema.shape),
  web_fetch: Object.keys(WebFetchConfigSchema.shape),
  programmatic_tool_caller: Object.keys(ProgrammaticToolCallerConfigSchema.shape),
  subagent: Object.keys(SubagentConfigSchema.shape),
} satisfies Partial<Record<BuiltinToolName, readonly string[]>>
export type ConfigurableBuiltinToolName = keyof typeof BUILTIN_TOOL_CONFIG_KEYS

/** The config keys `name` accepts, or `undefined` for a bool-only tool. */
export function builtinToolConfigKeys(name: BuiltinToolName): readonly string[] | undefined {
  return (BUILTIN_TOOL_CONFIG_KEYS as Partial<Record<BuiltinToolName, readonly string[]>>)[name]
}

export type HarnessConfigContextManager = 'auto' | 'agentic' | false
/** JSON form of `MemoryConfig`: stores are declared separately as `memoryStores` module references. */
export interface HarnessConfigMemory {
  dir?: string
}

export interface HarnessDependencies {
  typescript: Record<string, string>
  python: readonly string[]
}

/**
 * The complete portable form of a harness definition.
 *
 * `agentConfig` carries JSON-compatible SDK `AgentConfig` fields that are not owned by the harness. Values
 * requiring executable code belong in a typed module reference instead.
 */
export interface HarnessAgentConfig {
  name: string
  description: string
  instructions: string
  model: string
  modelModule: HarnessModuleReference | null
  effort: Effort
  tools: readonly HarnessModuleReference[]
  subagents: readonly HarnessModuleReference[]
  mcpServers: Record<string, unknown> | string
  builtinTools: readonly BuiltinToolName[] | HarnessConfigBuiltinTools
  caching: boolean
  contextManager: HarnessConfigContextManager
  session: boolean | SessionConfig
  skills: boolean | string | readonly string[]
  memory: boolean | HarnessConfigMemory
  memoryStores: readonly HarnessModuleReference[]
  plugins: readonly HarnessModuleReference[]
  builtinPlugins: readonly BuiltinPluginName[]
  interventions: string | readonly string[] | null
  interventionModules: readonly HarnessModuleReference[]
  sandbox: HarnessModuleReference | null
  agentConfigModules: Record<string, HarnessModuleReference>
  dependencies: HarnessDependencies
  agentConfig: Record<string, unknown>
}

export const DEFAULT_HARNESS_AGENT_CONFIG: HarnessAgentConfig = {
  name: 'Strands harness',
  description: '',
  instructions: '',
  model: DEFAULT_MODEL,
  modelModule: null,
  effort: DEFAULT_EFFORT,
  tools: [],
  subagents: [],
  mcpServers: {},
  builtinTools: [...DEFAULT_BUILTIN_TOOLS],
  caching: true,
  contextManager: DEFAULT_CONTEXT_MANAGER,
  session: true,
  skills: true,
  memory: true,
  memoryStores: [],
  plugins: [],
  builtinPlugins: [...DEFAULT_BUILTIN_PLUGINS],
  interventions: null,
  interventionModules: [],
  sandbox: null,
  agentConfigModules: {},
  dependencies: { typescript: {}, python: [] },
  agentConfig: {},
}

export function defineHarnessAgentConfig(config: Partial<HarnessAgentConfig>): HarnessAgentConfig {
  return normalizeHarnessAgentConfig({ ...DEFAULT_HARNESS_AGENT_CONFIG, ...config })
}

export function normalizeHarnessAgentConfig(value: unknown): HarnessAgentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent config must be an object.')
  }
  const known = Object.keys(HarnessAgentConfigSchema.shape)
  const unknown = Object.keys(value).filter((key) => !known.includes(key))
  if (unknown.length > 0) {
    warnOnce(`Ignoring unknown agent config keys: ${[...unknown].sort().join(', ')}.`)
  }
  const parsed = HarnessAgentConfigSchema.safeParse(
    Object.fromEntries(Object.entries(value).filter(([key]) => known.includes(key)))
  )
  if (!parsed.success) {
    throw new Error(`Invalid agent config:\n${formatIssues(parsed.error.issues).join('\n')}`)
  }
  // Sound: zod only differs by typing absent optional keys as `| undefined`.
  const config = parsed.data as HarnessAgentConfig
  if (config.memory === false && config.memoryStores.length > 0) {
    warnOnce('Ignoring memoryStores because memory is false.')
  }
  return config
}

export async function harnessAgentOptionsFromConfig(
  input: HarnessAgentConfig,
  baseDir = process.cwd()
): Promise<HarnessAgentOptions> {
  const config = normalizeHarnessAgentConfig(input)
  const generation = sourceGeneration(config, baseDir)
  const [tools, subagents, plugins, sandbox, memoryStores, model, builtinTools, interventions, agentConfigModules] =
    await Promise.all([
      loadMany<ToolList[number]>(config.tools, baseDir, generation),
      loadMany<Agent>(config.subagents, baseDir, generation),
      loadMany<Plugin>(config.plugins, baseDir, generation),
      loadOptional<Sandbox | false>(config.sandbox, baseDir, generation),
      loadMany<MemoryStore>(config.memoryStores, baseDir, generation),
      loadOptional<Model>(config.modelModule, baseDir, generation),
      builtinToolsOption(config.builtinTools, baseDir, generation),
      loadMany<InterventionValue>(config.interventionModules, baseDir, generation),
      loadReferenceRecord(config.agentConfigModules, baseDir, generation),
    ])
  return {
    ...config.agentConfig,
    ...agentConfigModules,
    name: config.name,
    ...(config.description ? { description: config.description } : {}),
    ...(config.instructions ? { instructions: config.instructions } : {}),
    model: model ?? config.model,
    effort: config.effort,
    // Specialist agents declared as `subagents` module refs are wired the same way as any tool: each
    // is exposed via `Agent.asTool()` and appended to `tools` (the harness has no separate subagents param).
    ...(tools.length > 0 || subagents.length > 0
      ? { tools: [...tools, ...subagents.map((agent) => agent.asTool())] }
      : {}),
    ...mcpServerOptions(config.mcpServers, baseDir),
    ...(builtinTools === undefined ? {} : { builtinTools }),
    ...(config.caching ? {} : { caching: false }),
    contextManager: config.contextManager,
    session: sessionOption(config.session, baseDir),
    skills: skillsOption(config.skills, baseDir),
    memory: memoryOption(config.memory, memoryStores, baseDir),
    ...(plugins.length > 0 ? { plugins } : {}),
    ...(sameStrings(config.builtinPlugins, DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins)
      ? {}
      : { builtinPlugins: [...config.builtinPlugins] }),
    ...interventionOptions(config.interventions, interventions, baseDir),
    ...(sandbox !== undefined ? { sandbox } : {}),
  }
}

function sourceGeneration(config: HarnessAgentConfig, baseDir: string): string {
  const references = [
    ...config.tools,
    ...config.subagents,
    ...config.plugins,
    ...config.memoryStores,
    ...config.interventionModules,
    ...Object.values(config.agentConfigModules),
    ...(config.modelModule ? [config.modelModule] : []),
    ...(config.sandbox ? [config.sandbox] : []),
  ]
  const webFetch = Array.isArray(config.builtinTools)
    ? undefined
    : (config.builtinTools as HarnessConfigBuiltinTools).web_fetch
  if (typeof webFetch === 'object' && typeof webFetch.model === 'object') {
    references.push(webFetch.model)
  }
  const paths = new Set<string>()
  for (const reference of references) {
    if (reference.module.startsWith('.') || isAbsolute(reference.module)) {
      paths.add(resolve(baseDir, reference.module))
    }
    for (const path of reference.files ?? []) {
      paths.add(resolve(baseDir, path))
    }
  }
  const hash = createHash('sha256')
  for (const path of [...paths].sort()) {
    hashSourcePath(hash, path)
  }
  return hash.digest('hex')
}

function hashSourcePath(hash: Hash, path: string): void {
  hash.update(path)
  let details
  try {
    details = lstatSync(path)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      hash.update('missing')
      return
    }
    throw error
  }
  if (details.isSymbolicLink()) {
    hash.update(`symlink:${readlinkSync(path)}`)
    return
  }
  if (details.isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      if (['.git', '.venv', 'node_modules'].includes(entry)) continue
      hashSourcePath(hash, join(path, entry))
    }
    return
  }
  if (details.isFile()) {
    hash.update(readFileSync(path))
  }
}

// A pinned list equal to the default is omitted so the factory's own default applies.
async function builtinToolsOption(
  value: readonly BuiltinToolName[] | HarnessConfigBuiltinTools,
  baseDir: string,
  generation: string
): Promise<HarnessAgentOptions['builtinTools']> {
  if (Array.isArray(value)) {
    const names = value as readonly BuiltinToolName[]
    return sameStrings(names, DEFAULT_BUILTIN_TOOLS) ? undefined : [...names]
  }
  const mapping = value as HarnessConfigBuiltinTools
  const webFetch = mapping.web_fetch
  if (webFetch === undefined || typeof webFetch === 'boolean') {
    return { ...mapping } as BuiltinToolsConfig
  }
  const { model: modelSetting, ...rest } = webFetch
  const model =
    modelSetting === undefined || typeof modelSetting === 'string'
      ? modelSetting
      : await loadReference<Model>(modelSetting, baseDir, generation)
  return { ...mapping, web_fetch: model === undefined ? rest : { ...rest, model } } as BuiltinToolsConfig
}

// Directory options in a portable config resolve against the project root (`baseDir`) even when
// they are the defaults, so an exported project keeps its state under its own folder wherever it is
// launched from.
function sessionOption(value: boolean | SessionConfig, baseDir: string): false | SessionConfig {
  if (value === false) {
    return false
  }
  const config = value === true ? {} : value
  return { ...config, dir: resolvePath(config.dir ?? DEFAULT_SESSION_DIR, baseDir) }
}

function skillsOption(value: boolean | string | readonly string[], baseDir: string): boolean | string[] {
  if (typeof value === 'boolean') {
    return value
  }
  const sources = typeof value === 'string' ? [value] : value
  return sources.map((source) => (source.startsWith('https://') ? source : resolvePath(source, baseDir)))
}

function memoryOption(
  value: boolean | HarnessConfigMemory,
  stores: MemoryStore[],
  baseDir: string
): false | MemoryConfig {
  if (value === false) {
    return false
  }
  const config = value === true ? {} : value
  return {
    dir: resolvePath(config.dir ?? DEFAULT_MEMORY_DIR, baseDir),
    ...(stores.length > 0 ? { stores } : {}),
  }
}

// Mirrors Python's `_resolve_path`: directory options in a portable config resolve against the
// project root (`baseDir`), not the process cwd, so an exported project keeps its state under
// its own folder wherever it is launched from.
function resolvePath(value: string, baseDir: string): string {
  if (value === '~' || value.startsWith('~/')) {
    return join(homedir(), value.slice(1))
  }
  return resolve(baseDir, value)
}

// Mirrors Python's `_mcp_server_map` + `_expand_env`: a file-backed config is loaded and `${VAR}` /
// `${env:VAR}` placeholders are resolved here, with a missing variable failing loudly, so the same
// manifest behaves identically under both runtimes.
function mcpServerOptions(
  value: HarnessAgentConfig['mcpServers'],
  baseDir: string
): Partial<Pick<HarnessAgentOptions, 'mcpServers'>> {
  const servers = Object.fromEntries(
    Object.entries(mcpServerMap(value, baseDir)).map(([name, server]) => [
      name,
      server &&
      typeof server === 'object' &&
      !Array.isArray(server) &&
      typeof (server as Record<string, unknown>).command === 'string'
        ? {
            ...server,
            cwd:
              typeof (server as Record<string, unknown>).cwd === 'string'
                ? resolvePath((server as Record<string, string>).cwd!, baseDir)
                : baseDir,
          }
        : server,
    ])
  )
  if (Object.keys(servers).length === 0) {
    return {}
  }
  return { mcpServers: expandEnv(servers) as Record<string, McpServerConfig> }
}

function mcpServerMap(value: Record<string, unknown> | string, baseDir: string): Record<string, unknown> {
  let servers = value
  if (typeof servers === 'string') {
    let loaded: unknown
    try {
      loaded = JSON.parse(readFileSync(resolve(baseDir, servers), 'utf8')) as unknown
    } catch (error) {
      throw new Error(`MCP config ${JSON.stringify(value)} must be valid JSON.`, { cause: error })
    }
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      throw new Error(`MCP config ${JSON.stringify(value)} must contain a server map.`)
    }
    servers = loaded as Record<string, unknown>
  }
  const nested = servers.mcpServers
  if (nested === undefined) {
    return servers
  }
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    throw new Error('mcpServers must contain a server map.')
  }
  return nested as Record<string, unknown>
}

function expandEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, name: string) => {
      const resolved = process.env[name]
      if (resolved === undefined) {
        throw new Error(`Environment variable ${JSON.stringify(name)} is not set.`)
      }
      return resolved
    })
  }
  if (Array.isArray(value)) {
    return value.map(expandEnv)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandEnv(entry)]))
  }
  return value
}

function interventionOptions(
  configured: HarnessAgentConfig['interventions'],
  loaded: InterventionValue[],
  baseDir: string
): Partial<Pick<HarnessAgentOptions, 'interventions'>> {
  const strings = configured === null ? [] : Array.isArray(configured) ? [...configured] : [configured as string]
  const values: InterventionValue[] = [
    ...strings.map((value) => (value.trim().endsWith('.cedar') ? resolvePath(value.trim(), baseDir) : value)),
    ...loaded,
  ]
  return values.length === 0 ? {} : { interventions: values.length === 1 ? values[0]! : values }
}

async function loadMany<T>(
  references: readonly HarnessModuleReference[],
  baseDir: string,
  generation: string
): Promise<T[]> {
  const loaded = await Promise.all(
    references.map((reference) => loadReference<T | T[]>(reference, baseDir, generation))
  )
  const values: T[] = []
  for (const value of loaded) {
    values.push(...(Array.isArray(value) ? (value as T[]) : [value as T]))
  }
  return values
}

async function loadOptional<T>(
  reference: HarnessModuleReference | null,
  baseDir: string,
  generation: string
): Promise<T | undefined> {
  return reference ? loadReference<T>(reference, baseDir, generation) : undefined
}

async function loadReferenceRecord(
  references: Record<string, HarnessModuleReference>,
  baseDir: string,
  generation: string
): Promise<Record<string, unknown>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(references).map(async ([key, reference]) => [
        key,
        await loadReference(reference, baseDir, generation),
      ])
    )
  )
}

async function loadReference<T>(reference: HarnessModuleReference, baseDir: string, generation: string): Promise<T> {
  if (reference.language === 'python' || /\.py$/iu.test(reference.module)) {
    throw new Error(`Cannot load Python module ${JSON.stringify(reference.module)} in the TypeScript runtime.`)
  }
  sourceLoader ??= import('tsx/esm/api').then(({ register }) => {
    // Keep the loader active for imports made later inside a tool or plugin.
    register()
  })
  await sourceLoader
  const directory = resolve(baseDir)
  const projectRoot = pathToFileURL(`${existsSync(directory) ? realpathSync(directory) : directory}/`).href
  const { register } = await import('node:module')
  if (!projectLoaders.has(projectRoot)) {
    const loader = new URL(`./config-module-loader.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url)
    loader.searchParams.set('project', projectRoot)
    register(loader, {
      data: { projectRoot, runtimeParent: import.meta.url },
    })
    projectLoaders.add(projectRoot)
  }
  const nodeModule = await import('node:module')
  if (nodeModule.registerHooks && !syncProjectLoaders.has(projectRoot)) {
    await shareHostModules(import.meta.url)
    nodeModule.registerHooks({
      resolve: resolveReloadUrl,
      load: canonicalCommonJsLoader(projectRoot, import.meta.url),
    })
    syncProjectLoaders.add(projectRoot)
  }
  const specifier =
    reference.module.startsWith('.') || isAbsolute(reference.module)
      ? pathToFileURL(resolve(baseDir, reference.module)).href
      : resolveImport(
          reference.module,
          isHostPackage(reference.module) ? import.meta.url : `${projectRoot}package.json`
        )
  const importUrl = new URL(specifier)
  if (
    importUrl.protocol === 'file:' &&
    !importUrl.pathname.split('/').includes('node_modules') &&
    (reference.module.startsWith('.') || isAbsolute(reference.module))
  ) {
    importUrl.hash = `source_reload=${generation}`
  }
  const namespace = (await import(importUrl.href)) as Record<string, unknown>
  const name = reference.export ?? 'default'
  if (!(name in namespace)) {
    throw new Error(`Module ${JSON.stringify(reference.module)} does not export ${JSON.stringify(name)}.`)
  }
  const value = namespace[name]
  return (typeof value === 'function' && reference.kind === 'subagent' ? await value() : value) as T
}

type JsonValue = null | string | number | boolean | readonly JsonValue[] | { readonly [key: string]: JsonValue }
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union(
    [z.null(), z.string(), z.boolean(), z.number(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)],
    { error: 'must contain only JSON-compatible values.' }
  )
)
const JsonRecord = z.record(z.string(), JsonValueSchema, { error: 'must be an object.' })

const SessionSchema = z.union([Bool, strictObject({ id: NonEmptyString.optional(), dir: NonEmptyString.optional() })], {
  error: 'must be a boolean or an object.',
})
const MemorySchema = z.union([Bool, strictObject({ dir: NonEmptyString.optional() })], {
  error: 'must be a boolean or an object.',
})

/** `HarnessAgentConfig` as read from `config.json`; every key is optional and defaults to `DEFAULT_HARNESS_AGENT_CONFIG`. */
const HarnessAgentConfigSchema = z.object({
  name: NonEmptyString.default(DEFAULT_HARNESS_AGENT_CONFIG.name),
  description: z.string({ error: 'must be a string.' }).default(DEFAULT_HARNESS_AGENT_CONFIG.description),
  instructions: z.string({ error: 'must be a string.' }).default(DEFAULT_HARNESS_AGENT_CONFIG.instructions),
  model: NonEmptyString.default(DEFAULT_HARNESS_AGENT_CONFIG.model),
  modelModule: moduleReferenceSchema('model').nullable().default(null),
  effort: z
    .enum(EFFORT_LEVELS, { error: `must be one of: ${EFFORT_LEVELS.join(', ')}.` })
    .default(DEFAULT_HARNESS_AGENT_CONFIG.effort),
  tools: moduleReferencesSchema('tool'),
  subagents: moduleReferencesSchema('subagent'),
  mcpServers: z
    .union([NonEmptyString, JsonRecord], { error: 'must be a path string or a mapping of server name to config.' })
    .default(() => ({})),
  builtinTools: z
    .union(
      [
        z
          .array(z.enum(BUILTIN_TOOL_NAMES, { error: `must be one of: ${BUILTIN_TOOL_NAMES.join(', ')}.` }), {
            error: 'must be an array.',
          })
          .refine((names) => new Set(names).size === names.length, 'must not contain duplicates.'),
        BuiltinToolsMappingSchema,
      ],
      { error: 'must be an array of tool names or a mapping of tool name to setting.' }
    )
    .default(() => [...DEFAULT_BUILTIN_TOOLS]),
  caching: Bool.default(DEFAULT_HARNESS_AGENT_CONFIG.caching),
  // JSON also accepts "off" as the spelling of `false`, matching the CLI flag and the Python loader.
  contextManager: z
    .union([z.enum(['auto', 'agentic', 'off']), z.literal(false)], {
      error: 'must be one of: auto, agentic, off, false.',
    })
    .transform((value) => (value === 'off' ? false : value))
    .default(DEFAULT_CONTEXT_MANAGER),
  session: SessionSchema.default(DEFAULT_HARNESS_AGENT_CONFIG.session),
  skills: z
    .union([Bool, NonEmptyString, uniqueStrings(NonEmptyStrings)], {
      error: 'must be a boolean, a path string, or an array of path strings.',
    })
    .default(true),
  memory: MemorySchema.default(DEFAULT_HARNESS_AGENT_CONFIG.memory),
  memoryStores: moduleReferencesSchema('memory-store'),
  plugins: moduleReferencesSchema('plugin'),
  builtinPlugins: z
    .array(z.enum(BUILTIN_PLUGIN_NAMES, { error: `must be one of: ${BUILTIN_PLUGIN_NAMES.join(', ')}.` }), {
      error: 'must be an array.',
    })
    .refine((names) => new Set(names).size === names.length, 'must not contain duplicates.')
    .default(() => [...DEFAULT_BUILTIN_PLUGINS]),
  interventions: z
    .union([NonEmptyString, NonEmptyStrings, z.null()], {
      error: 'must be a string, an array of strings, or null.',
    })
    .default(null),
  interventionModules: moduleReferencesSchema('intervention'),
  sandbox: moduleReferenceSchema('sandbox').nullable().default(null),
  agentConfigModules: z
    .record(NonEmptyString, moduleReferenceSchema('agent-config'), { error: 'must be an object.' })
    .default(() => ({})),
  dependencies: z
    .object(
      {
        typescript: z
          .record(NonEmptyString, NonEmptyString, { error: 'must map package names to version strings.' })
          .default(() => ({})),
        python: uniqueStrings(
          NonEmptyStrings.refine(
            (entries) => entries.every((entry) => !/[\r\n]/u.test(entry)),
            'entries must not contain line breaks.'
          )
        ).default(() => []),
      },
      { error: 'must be an object.' }
    )
    .default(() => ({ typescript: {}, python: [] })),
  agentConfig: JsonRecord.default(() => ({})),
})

function formatPath(path: readonly PropertyKey[]): string {
  const text = path.reduce<string>(
    (result, segment) =>
      typeof segment === 'number' ? `${result}[${segment}]` : result ? `${result}.${String(segment)}` : String(segment),
    ''
  )
  return text || 'agent config'
}

/**
 * One line per issue, prefixed with the JSON path. A failed union reports the issues of its single
 * branch that matched the input's type (an object branch for an object input, and so on) so that,
 * for example, `builtinTools.shell.description` is named rather than the whole `shell` union. A
 * record key that fails its schema is reported under the record, naming the key.
 */
function formatIssues(issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[] = []): string[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path]
    if (issue.code === 'invalid_union') {
      const matching = issue.errors.filter(
        (branch) => !branch.some((entry) => entry.code === 'invalid_type' && entry.path.length === 0)
      )
      if (matching.length === 1) {
        return formatIssues(matching[0]!, path)
      }
    }
    if (issue.code === 'invalid_key') {
      // zod ends the path with the offending key; its own issues are reported relative to that key.
      const key = String(path.at(-1))
      const messages = formatIssues(issue.issues).map((line) => line.replace(/^agent config /u, ''))
      return [`${formatPath(path.slice(0, -1))} has an invalid key ${JSON.stringify(key)}: ${messages.join(' ')}`]
    }
    return [`${formatPath(path)} ${issue.message}`]
  })
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
