import type {
  BuiltinToolName,
  HarnessAgentConfig,
  HarnessAgentOptions,
  HarnessModuleReference,
} from '@strands-agents/harness'
import { supportsWebSearch } from '@strands-agents/harness'
import { enabledBuiltinTools, resolveBuiltinTools } from '@strands-agents/harness/internal'

type AnyBuiltinTools = HarnessAgentConfig['builtinTools'] | HarnessAgentOptions['builtinTools']

/** The built-in tools a `builtinTools` value enables, whichever form (list pin or mapping edits) it uses. */
export function enabledProfileTools(builtinTools: AnyBuiltinTools): BuiltinToolName[] {
  // Enabled-ness only depends on the names and booleans, which the config and options shapes share;
  // a config's `{ module }` model reference never reaches the resolver's tool-config checks.
  return enabledBuiltinTools(resolveBuiltinTools(builtinTools as Parameters<typeof resolveBuiltinTools>[0]))
}

export function profileToolEnabled(builtinTools: AnyBuiltinTools, name: BuiltinToolName): boolean {
  return enabledProfileTools(builtinTools).includes(name)
}

/** Disables `name`, keeping a list pin as a list and a mapping as a mapping. */
export function withoutProfileTool<T extends AnyBuiltinTools>(builtinTools: T, name: BuiltinToolName): T {
  if (Array.isArray(builtinTools)) {
    return (builtinTools as readonly BuiltinToolName[]).filter((tool) => tool !== name) as unknown as T
  }
  return { ...(builtinTools as object), [name]: false } as T
}

/** Enables `name` (with its default config when it takes one). */
export function withProfileTool<T extends AnyBuiltinTools>(builtinTools: T, name: BuiltinToolName): T {
  if (Array.isArray(builtinTools)) {
    const list = builtinTools as readonly BuiltinToolName[]
    return (list.includes(name) ? list : [...list, name]) as unknown as T
  }
  const mapping = builtinTools as Record<string, unknown>
  return (mapping[name] === undefined || mapping[name] === false ? { ...mapping, [name]: true } : mapping) as T
}

/** Shown wherever a profile opts `web_search` into Exa: the wizard, the `strands_config` reply, and the README. */
export const EXA_WEB_SEARCH_WARNING =
  'web_search sends every search query to Exa (exa.ai), a third-party service.\n' +
  "Queries leave your machine · Exa's privacy policy: https://exa.ai/privacy-policy"

/** Whether `builtinTools` opts `web_search` into the third-party Exa fallback. */
export function webSearchFallback(builtinTools: AnyBuiltinTools): 'exa' | undefined {
  if (Array.isArray(builtinTools)) return undefined
  return (builtinTools as Record<string, unknown>).web_search === 'exa' ? 'exa' : undefined
}

/** Opts `web_search` into the Exa fallback; a list pin becomes the equivalent mapping, since a list can't carry `'exa'`. */
export function withWebSearchFallback<T extends AnyBuiltinTools>(builtinTools: T): T {
  const mapping = Array.isArray(builtinTools)
    ? resolveBuiltinTools(builtinTools as readonly BuiltinToolName[])
    : (builtinTools as object)
  return { ...mapping, web_search: 'exa' } as T
}

type WebFetchModelModule = HarnessModuleReference & { kind: 'model' }

function webFetchModel(builtinTools: HarnessAgentConfig['builtinTools']): string | WebFetchModelModule | undefined {
  if (Array.isArray(builtinTools)) return undefined
  const webFetch = (builtinTools as Exclude<HarnessAgentConfig['builtinTools'], readonly BuiltinToolName[]>).web_fetch
  return typeof webFetch === 'object' ? webFetch.model : undefined
}

export function webFetchModelModule(builtinTools: HarnessAgentConfig['builtinTools']): WebFetchModelModule | null {
  const model = webFetchModel(builtinTools)
  return typeof model === 'object' ? model : null
}

export function webFetchModelId(builtinTools: HarnessAgentConfig['builtinTools']): string | null {
  const model = webFetchModel(builtinTools)
  return typeof model === 'string' ? model : null
}

/** Rewrites a module-reference `web_fetch.model` through `map`, leaving everything else as is. */
export function mapWebFetchModelModule(
  builtinTools: HarnessAgentConfig['builtinTools'],
  map: (reference: HarnessModuleReference) => HarnessModuleReference
): HarnessAgentConfig['builtinTools'] {
  const module = webFetchModelModule(builtinTools)
  if (module === null) return builtinTools
  const mapping = builtinTools as Exclude<HarnessAgentConfig['builtinTools'], readonly BuiltinToolName[]>
  return { ...mapping, web_fetch: { ...(mapping.web_fetch as object), model: { ...map(module), kind: module.kind } } }
}

export const BUILTIN_TOOLS = [
  ['shell', 'Run shell commands'],
  ['read', 'Read workspace files'],
  ['write', 'Create files'],
  ['edit', 'Apply targeted file edits'],
  ['web_fetch', 'Fetch and summarize web pages'],
  ['web_search', 'Search the web'],
  ['programmatic_tool_caller', 'Orchestrate tools with sandboxed Python'],
  ['subagent', 'Delegate focused work to a fresh subagent'],
] as const

export interface BuiltinToolChoice {
  id: BuiltinToolName
  description: string
  active: boolean
  /** Enabling it sends queries to Exa, the third-party search fallback. */
  thirdParty: boolean
}

export function builtinToolChoices(profile: HarnessAgentConfig): BuiltinToolChoice[] {
  const nativeSearch = supportsWebSearch(profile.model)
  return BUILTIN_TOOLS.map(([id, description]) => {
    // Without native search, web_search is the third-party Exa fallback: off unless opted into.
    const thirdParty = id === 'web_search' && !nativeSearch
    const active = thirdParty
      ? webSearchFallback(profile.builtinTools) === 'exa'
      : profileToolEnabled(profile.builtinTools, id)
    return { id, description, active, thirdParty }
  })
}

export function withBuiltinToolChoice(
  profile: HarnessAgentConfig,
  choice: BuiltinToolChoice,
  enabled: boolean
): HarnessAgentConfig['builtinTools'] {
  if (!enabled) return withoutProfileTool(profile.builtinTools, choice.id)
  return choice.thirdParty
    ? withWebSearchFallback(profile.builtinTools)
    : withProfileTool(profile.builtinTools, choice.id)
}
