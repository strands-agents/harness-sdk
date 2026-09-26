import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  DEFAULT_HARNESS_AGENT_CONFIG,
  harnessAgentOptionsFromConfig,
  type HarnessAgentConfig,
  type HarnessAgentOptions,
} from '@strands-agents/harness'
import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills'

import { agentConfig, projectConfigOverrides, type ParsedArgs } from './arguments.js'
import { restoreSessionAgentDefinition } from '../tui/session/agent-definition.js'
import { importAgentProject, type ImportedAgentProject } from '../tui/project/import.js'
import type { AgentFactory } from '../tui/project/typescript.js'
import { requireBedrockRegion } from '../tui/provider/aws-config.js'
import type { ResolvedMcpConfig } from '../tui/workspace/trust.js'

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
  project?: ImportedAgentProject,
  restoreDefinition = false
): Promise<InvocationAgent> {
  const snapshot = config.snapshot()
  const projectPath = args.agent ?? snapshot.agentProject
  if (projectPath) {
    project ??= importAgentProject(projectPath)
    if (args.agent) args.agent = project.entrypoint
    if (project.language !== 'typescript') {
      throw new Error('Python agents must run with the Python runtime.')
    }
    const { loadTypescriptProject } = await import('../tui/project/typescript.js')
    const authored = await loadTypescriptProject(project, () => config.applyProviderEnvironment())
    const options = {
      ...authored.options,
      ...(await projectOverrides(args, cwd, authored.options)),
      printer: false,
    }
    requireBedrockRegion(options.model)
    return {
      options,
      buildAgent: authored.createAgent,
      project,
    }
  }
  const baseDir = snapshot.profileBaseDir ?? cwd
  const profile = agentConfig(args, snapshot.profile)
  config.applyProviderEnvironment()
  requireBedrockRegion(profile.model)
  const options = {
    ...(await harnessAgentOptionsFromConfig(profile, baseDir)),
    printer: false,
  }
  return {
    profile,
    options: restoreDefinition ? await restoreSessionAgentDefinition(options, cwd) : options,
  }
}

async function projectOverrides(
  args: ParsedArgs,
  root: string,
  authored: HarnessAgentOptions
): Promise<HarnessAgentOptions> {
  const fields = new Set(Object.keys(projectConfigOverrides(args)))
  const base = { ...DEFAULT_HARNESS_AGENT_CONFIG }
  for (const assignment of args.configSet) {
    const path = assignment.slice(0, assignment.indexOf('=')).split('.')
    const field = path[0]!
    const option = field === 'agentConfig' ? path[1] : field
    if (
      path.length > (field === 'agentConfig' ? 2 : 1) &&
      option &&
      option in authored &&
      field !== 'agentConfigModules'
    ) {
      let value = authored[option as keyof HarnessAgentOptions]
      if (field === 'mcpServers' && typeof value === 'string') {
        const document = JSON.parse(await readFile(resolve(root, value), 'utf8'))
        value = document.mcpServers ?? document
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (field === 'agentConfig') {
          base.agentConfig = { ...base.agentConfig, [option]: globalThis.structuredClone(value) }
        } else {
          Object.assign(base, { [field]: globalThis.structuredClone(value) })
        }
      }
    }
  }
  const config = agentConfig(args, base)
  const options = await harnessAgentOptionsFromConfig(config, root)
  for (const key of ['builtinTools', 'builtinPlugins', 'caching', 'description', 'instructions'] as const) {
    if (fields.has(key)) Object.assign(options, { [key]: config[key] })
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
  return Object.fromEntries([...keys].map((key) => [key, options[key as keyof HarnessAgentOptions]]))
}

export async function pythonInvocationOptions(
  args: ParsedArgs,
  cwd: string,
  settings: { skillDiscovery: boolean },
  mcp: ResolvedMcpConfig
): Promise<import('../tui/project/python.js').PythonOptions> {
  const [{ readMcpDefinitions }, { resolveSkillPaths }] = await Promise.all([
    import('../tui/mcp.js'),
    import('../tui/skills.js'),
  ])
  const { definitions } = await readMcpDefinitions({
    cwd,
    paths: mcp.paths,
    strictPaths: mcp.strictPaths,
    ...(mcp.expectedDigests ? { expectedDigests: mcp.expectedDigests } : {}),
  })
  return {
    cwd,
    overrides: projectConfigOverrides(args),
    assignments: args.configSet,
    mcpServers: definitions,
    skillPaths: resolveSkillPaths(undefined, cwd, settings.skillDiscovery),
  }
}

export async function withDiscoveredSkills(
  options: HarnessAgentOptions,
  discovery: boolean
): Promise<HarnessAgentOptions> {
  const cwd = process.cwd()
  const { resolveSkillPaths } = await import('../tui/skills.js')
  const skills = options.skills instanceof AgentSkills ? undefined : options.skills
  const skillPaths = resolveSkillPaths(skills, cwd, discovery)
  return { ...options, skills: skillPaths.length > 0 ? skillPaths : false }
}
