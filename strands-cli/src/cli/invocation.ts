import {
  DEFAULT_HARNESS_AGENT_CONFIG,
  harnessAgentOptionsFromConfig,
  type HarnessAgentConfig,
  type HarnessAgentOptions,
} from '@strands-agents/harness'
import { SessionManager } from '@strands-agents/sdk'
import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { readAgentDefinition } from '../config/store.js'
import type { ResolvedMcpConfig } from '../config/trust.js'
import { expandHome } from '../paths.js'
import { requireBedrockRegion } from '../model/aws-config.js'
import { importAgentProject, type ImportedAgentProject } from '../project/import.js'
import type { AgentFactory } from '../project/typescript.js'
import { isRecord } from '../values.js'
import { agentConfig, projectConfigOverrides, type ParsedArgs } from './arguments.js'
import { profileOptions, runtimeAgentFactory, runtimeOptions, workspaceStateDirectory } from './runtime-options.js'

interface InvocationAgent {
  profile?: HarnessAgentConfig
  options: HarnessAgentOptions
  buildAgent?: AgentFactory
  project?: ImportedAgentProject
}

interface InvocationConfigStore {
  snapshot(): { profile: HarnessAgentConfig; profileBaseDir?: string; agentProject?: string }
  applyProviderEnvironment(): void
}

export async function invocationAgentForRun(
  args: ParsedArgs,
  config: InvocationConfigStore,
  cwd = process.cwd(),
  project?: ImportedAgentProject
): Promise<InvocationAgent> {
  const snapshot = config.snapshot()
  const projectPath = args.agent ?? snapshot.agentProject
  const definition = projectPath?.endsWith('.toml') ? resolve(cwd, expandHome(projectPath)) : undefined
  if (projectPath && !definition) {
    project ??= importAgentProject(projectPath)
    if (args.agent) args.agent = project.entrypoint
    if (project.language !== 'typescript') {
      throw new Error('Python agents must run with the Python runtime.')
    }
    const { loadTypescriptProject } = await import('../project/typescript.js')
    const authored = await loadTypescriptProject(project, () => config.applyProviderEnvironment())
    const options = {
      ...authored.options,
      ...(await projectOverrides(args, cwd, authored.options)),
      printer: false,
    }
    requireBedrockRegion(options.model)
    return {
      options: runtimeOptions(options, cwd, args),
      buildAgent: runtimeAgentFactory(args, authored.createAgent),
      project,
    }
  }
  const baseDir = definition ? dirname(definition) : (snapshot.profileBaseDir ?? cwd)
  const profile = agentConfig(args, definition ? await readAgentDefinition(definition) : snapshot.profile)
  config.applyProviderEnvironment()
  requireBedrockRegion(profile.model)
  const options = {
    ...(await profileOptions(profile, baseDir, cwd)),
    printer: false,
  }
  return {
    profile,
    options: runtimeOptions(options, cwd, args),
    buildAgent: runtimeAgentFactory(args),
  }
}

async function projectOverrides(
  args: ParsedArgs,
  root: string,
  authored: HarnessAgentOptions
): Promise<HarnessAgentOptions> {
  const portableArgs = { ...args, session: undefined, memory: undefined, sessionId: undefined }
  const fields = new Set(Object.keys(projectConfigOverrides(portableArgs)))
  const config = agentConfig(portableArgs, DEFAULT_HARNESS_AGENT_CONFIG)
  const options = await harnessAgentOptionsFromConfig(config, root)
  for (const key of ['builtinTools', 'builtinPlugins', 'caching', 'description', 'instructions'] as const) {
    if (fields.has(key) && options[key] === undefined) Object.assign(options, { [key]: config[key] })
  }
  const aliases: Record<string, string> = {
    subagents: 'tools',
    modelModule: 'model',
    memoryStores: 'memory',
    interventionModules: 'interventions',
  }
  const keys = new Set([...fields].map((field) => aliases[field] ?? field))
  keys.delete('dependencies')
  keys.delete('agentConfig')
  keys.delete('agentConfigModules')
  if (fields.has('agentConfig')) {
    for (const key of Object.keys(config.agentConfig)) keys.add(key)
  }
  if (fields.has('agentConfigModules')) {
    for (const key of Object.keys(config.agentConfigModules)) keys.add(key)
  }
  const overrides: HarnessAgentOptions = Object.fromEntries(
    [...keys].map((key) => [key, options[key as keyof HarnessAgentOptions]])
  )
  const paths = args.configSet.map((assignment) => assignment.slice(0, assignment.indexOf('=')))
  for (const key of keys) {
    if (
      Object.hasOwn(config.agentConfigModules, key) ||
      Object.entries(aliases).some(([field, option]) => fields.has(field) && option === key)
    )
      continue
    const path = Object.hasOwn(config.agentConfig, key) ? `agentConfig.${key}` : key
    if (
      !paths.some((assigned) => assigned.startsWith(`${path}.`)) ||
      portableArgs[key as keyof ParsedArgs] !== undefined
    )
      continue
    let value = authored[key as keyof HarnessAgentOptions]
    if (key === 'mcpServers' && typeof value === 'string') {
      const document = JSON.parse(await readFile(resolve(root, value), 'utf8'))
      value = document.mcpServers ?? document
    }
    Object.assign(overrides, {
      [key]: mergeAssignedOption(value, overrides[key as keyof HarnessAgentOptions], paths, path),
    })
  }
  for (const key of ['session', 'memory'] as const) {
    if (args[key] === 'off') {
      overrides[key] = false
    } else if (args[key] === 'on') {
      Object.assign(overrides, { [key]: (key in overrides ? overrides[key] : authored[key]) || true })
    } else if (args[key] !== undefined) {
      throw new Error(`--${key} must be 'on' or 'off'.`)
    }
  }
  const session = 'session' in overrides ? overrides.session : authored.session
  if (args.sessionId !== undefined && session !== false && session !== null && !(session instanceof SessionManager)) {
    overrides.session = { ...(typeof session === 'object' ? session : {}), id: args.sessionId }
  }
  return overrides
}

function mergeAssignedOption(authored: unknown, converted: unknown, paths: string[], path: string): unknown {
  if (
    paths.some((assigned) => path === assigned || path.startsWith(`${assigned}.`)) ||
    !isRecord(converted) ||
    Object.getPrototypeOf(converted) !== Object.prototype
  )
    return converted
  if (path === 'builtinTools' && Array.isArray(authored)) {
    authored = Object.fromEntries([['*', false], ...authored.map((name) => [name, true])])
  }
  const merged = isRecord(authored) && Object.getPrototypeOf(authored) === Object.prototype ? { ...authored } : {}
  for (const [key, value] of Object.entries(converted)) {
    const child = `${path}.${key}`
    if (paths.some((assigned) => assigned === child || assigned.startsWith(`${child}.`))) {
      merged[key] = mergeAssignedOption(merged[key], value, paths, child)
    }
  }
  return merged
}

export async function pythonInvocationOptions(
  args: ParsedArgs,
  cwd: string,
  settings: { skillDiscovery: boolean },
  mcp: ResolvedMcpConfig
): Promise<import('../project/python.js').PythonOptions> {
  const [{ readMcpDefinitions }, { resolveSkillPaths }] = await Promise.all([
    import('../agent/mcp.js'),
    import('../agent/skills.js'),
  ])
  const { definitions } = await readMcpDefinitions({
    cwd,
    paths: mcp.paths,
    strictPaths: mcp.strictPaths,
    ...(mcp.expectedDigests ? { expectedDigests: mcp.expectedDigests } : {}),
  })
  return {
    cwd,
    stateDirectory: workspaceStateDirectory(cwd, args.stateDir),
    relocateState: args.stateDir !== undefined,
    ...(args.appendInstructions ? { appendInstructions: args.appendInstructions } : {}),
    overrides: projectConfigOverrides({ ...args, session: undefined, memory: undefined, sessionId: undefined }),
    assignments: args.configSet,
    configFlags: { session: args.session, memory: args.memory, sessionId: args.sessionId },
    mcpServers: definitions,
    skillPaths: resolveSkillPaths(undefined, cwd, settings.skillDiscovery),
  }
}

export async function withDiscoveredSkills(
  options: HarnessAgentOptions,
  discovery: boolean
): Promise<HarnessAgentOptions> {
  if (options.skills instanceof AgentSkills || options.plugins?.some((plugin) => plugin instanceof AgentSkills)) {
    return options
  }
  const { resolveSkillSources } = await import('../agent/skills.js')
  const sources = resolveSkillSources(options.skills, process.cwd(), discovery)
  return { ...options, skills: sources.length > 0 ? sources : false }
}
