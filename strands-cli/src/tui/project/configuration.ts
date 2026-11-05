import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import type { HarnessAgentConfig, HarnessModuleReference } from '@strands-agents/harness'
import { normalizeHarnessAgentConfig } from '@strands-agents/harness/internal'

import { mapWebFetchModelModule } from '../builtin-tools.js'

import { scanConfigSecrets } from './configuration-secrets.js'
import type { AgentProjectLanguage } from './import.js'
import { containsPath, packageName, packageSources, realSource, sourceBase, type PackagedSource } from './packaging.js'
import { validatePortableDependencies } from './portable-dependencies.js'
import { packageMcpServers } from './portable-mcp.js'

function configurationModules(config: HarnessAgentConfig): (HarnessModuleReference | null)[] {
  return [
    config.modelModule,
    ...config.tools,
    ...config.subagents,
    ...config.plugins,
    ...config.memoryStores,
    ...config.interventionModules,
    config.sandbox,
    ...Object.values(config.agentConfigModules),
  ]
}

export function portableConfig(
  profile: HarnessAgentConfig,
  language: AgentProjectLanguage,
  hasSkills: boolean,
  sources: PackagedSource[],
  baseDir = process.cwd()
): HarnessAgentConfig {
  const config = normalizeHarnessAgentConfig(profile)
  const mcpServers = portableMcpServers(config.mcpServers, baseDir)
  validateNoConfigSecrets(config, mcpServers)
  validatePortableDependencies(config.dependencies, language)
  if (language === 'python') {
    validatePortableDependencies(config.dependencies, 'typescript')
    validatePythonMcp(mcpServers)
  }
  const packagedModules = packageModuleSources(config, baseDir, sources)
  const policy = (value: string): string => {
    if (!value.trim().endsWith('.cedar')) {
      return value
    }
    const source = realSource(value.trim(), true, baseDir)
    const destination = `policies/${sources.length}/${basename(source)}`
    sources.push({ source, destination })
    return `./agent/${destination}`
  }
  const reference = (value: HarnessModuleReference): HarnessModuleReference => {
    const referenceLanguage = value.language ?? inferredLanguage(value.module)
    if (referenceLanguage && referenceLanguage !== language) {
      throw new Error(
        `Cannot export ${referenceLanguage} ${value.kind} module ${JSON.stringify(value.module)} as ${language}.`
      )
    }
    if (!isLocalModule(value.module)) {
      requireDependency(config, language, value.module, value.dependency)
      return { ...value, language }
    }
    const roots = value.files?.map((path) => realSource(path, false, baseDir)) ?? []
    const sourceModule =
      language === 'typescript' && !existsSync(resolve(baseDir, value.module))
        ? value.module.replace(/\.([cm]?)js$/u, '.$1ts')
        : value.module
    const modulePath = realSource(sourceModule, language !== 'python', baseDir)
    const packagedPath = packagedModules.get(value)
    if (!packagedPath || !roots.some((root) => containsPath(root, modulePath))) {
      throw new Error(
        `Local ${value.kind} module ${JSON.stringify(value.module)} must declare a files entry containing it.`
      )
    }
    const packagedModule = packagedPath(modulePath)
    return {
      ...value,
      language,
      module: `./agent/${language === 'typescript' ? packagedModule.replace(/\.([cm]?)ts$/u, '.$1js') : packagedModule}`,
      files: roots.map((root) => `./agent/${packagedPath(root)}`),
    }
  }
  return {
    ...config,
    mcpServers: packageMcpServers(mcpServers, baseDir, sources, language, config.dependencies),
    interventions: Array.isArray(config.interventions)
      ? config.interventions.map(policy)
      : typeof config.interventions === 'string'
        ? policy(config.interventions)
        : null,
    modelModule: config.modelModule ? reference(config.modelModule) : null,
    tools: config.tools.map(reference),
    subagents: config.subagents.map(reference),
    plugins: config.plugins.map(reference),
    memoryStores: config.memoryStores.map(reference),
    builtinTools: mapWebFetchModelModule(config.builtinTools, reference),
    interventionModules: config.interventionModules.map(reference),
    sandbox: config.sandbox ? reference(config.sandbox) : null,
    agentConfigModules: Object.fromEntries(
      Object.entries(config.agentConfigModules).map(([key, value]) => [key, reference(value)])
    ),
    skills: hasSkills ? ['./agent/skills'] : false,
    session: config.session === true ? { dir: './.agent/sessions' } : config.session,
    memory: config.memory === true ? { dir: './.agent/memory' } : config.memory,
  }
}

function packageModuleSources(
  config: HarnessAgentConfig,
  baseDir: string,
  sources: PackagedSource[]
): Map<HarnessModuleReference, (path: string) => string> {
  const groups: { references: HarnessModuleReference[]; roots: string[]; base: string }[] = []
  for (const reference of configurationModules(config)) {
    if (!reference || !isLocalModule(reference.module)) continue
    const roots = reference.files?.map((path) => realSource(path, false, baseDir)) ?? []
    if (roots.length === 0) continue
    const base = sourceBase(roots)
    const group = { references: [reference], roots, base }
    for (let index = groups.length - 1; index >= 0; index--) {
      const other = groups[index]!
      if (containsPath(group.base, other.base) || containsPath(other.base, group.base)) {
        group.references.push(...other.references)
        group.roots.push(...other.roots)
        group.base = sourceBase(group.roots)
        groups.splice(index, 1)
      }
    }
    groups.push(group)
  }
  const categories = groups.map(({ references }) => {
    const kinds = new Set(references.map((reference) => reference.kind))
    if (kinds.size > 1) return 'shared'
    const kind = references[0]!.kind
    return kind === 'tool' || kind === 'plugin' || kind === 'subagent' ? `${kind}s` : `extensions/${kind}`
  })
  const names = new Set<string>()
  const packaged = new Map<HarnessModuleReference, (path: string) => string>()
  for (const [index, group] of groups.entries()) {
    const category = categories[index]!
    const destination =
      categories.filter((value) => value === category).length > 1
        ? `${category}/${packageName(basename(group.base), names)}`
        : category
    const target = packageSources(group.roots, destination, sources)
    for (const reference of group.references) {
      packaged.set(reference, target)
    }
  }
  return packaged
}

function portableMcpServers(value: HarnessAgentConfig['mcpServers'], baseDir = process.cwd()): Record<string, unknown> {
  if (typeof value !== 'string') {
    return mcpServerMap(value)
  }
  const path = realSource(value, true, baseDir)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`MCP config ${JSON.stringify(value)} must be valid JSON.`, { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`MCP config ${JSON.stringify(value)} must contain a server map.`)
  }
  return mcpServerMap(parsed as Record<string, unknown>)
}

function mcpServerMap(value: Record<string, unknown>): Record<string, unknown> {
  const nested = value.mcpServers
  if (nested === undefined) {
    return value
  }
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    throw new Error('mcpServers must contain a server map.')
  }
  return nested as Record<string, unknown>
}

function inferredLanguage(module: string): AgentProjectLanguage | undefined {
  if (/\.(?:cjs|js|jsx|mjs|ts|tsx)$/iu.test(module)) {
    return 'typescript'
  }
  return /\.py$/iu.test(module) ? 'python' : undefined
}

function requireDependency(
  config: HarnessAgentConfig,
  language: AgentProjectLanguage,
  module: string,
  explicitDependency?: string
): void {
  const packageName =
    explicitDependency ??
    (language === 'typescript'
      ? module.startsWith('@')
        ? module.split('/').slice(0, 2).join('/')
        : module.split('/')[0]!
      : module.split('.')[0]!)
  if (language === 'typescript') {
    if (!config.dependencies.typescript[packageName]) {
      throw new Error(
        `Module ${JSON.stringify(module)} requires dependencies.typescript[${JSON.stringify(packageName)}].`
      )
    }
    return
  }
  const normalized = packageName.toLowerCase().replace(/[-_.]+/gu, '-')
  const declared = config.dependencies.python.some(
    (dependency) =>
      dependency
        .split(/(?:<|>|=|!|~|\[)/u, 1)[0]!
        .trim()
        .toLowerCase()
        .replace(/[-_.]+/gu, '-') === normalized
  )
  if (!declared) {
    throw new Error(`Module ${JSON.stringify(module)} requires a matching dependencies.python entry.`)
  }
}

// Shared by export and configuration editing: resolved MCP servers are scanned so file-backed
// configuration receives the same credential checks as an inline map.
export function validateNoConfigSecrets(
  config: HarnessAgentConfig,
  mcpServers: Record<string, unknown> = portableMcpServers(config.mcpServers)
): void {
  scanConfigSecrets(config, mcpServers)
}

function validatePythonMcp(servers: Record<string, unknown>): void {
  for (const [name, raw] of Object.entries(servers)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'tasksConfig' in raw) {
      throw new Error(`MCP server ${JSON.stringify(name)} uses tasksConfig, which the Python harness cannot reproduce.`)
    }
  }
}

function isLocalModule(module: string): boolean {
  return module.startsWith('.') || isAbsolute(module)
}
