import { Command } from 'commander'
import { DEFAULT_HARNESS_AGENT_CONFIG, type HarnessAgentConfig } from '@strands-agents/harness'
import { EFFORT_LEVELS, normalizeHarnessAgentConfig } from '@strands-agents/harness/internal'

import { readCliVersion } from '../tui/package-version.js'

export interface ParsedArgs {
  request: string | undefined
  oneShot: boolean
  acpServer: boolean
  setup: boolean
  agent: string | undefined
  configSet: string[]
  envFiles: string[]
  name: string | undefined
  description: string | undefined
  model: string | undefined
  effort: string | undefined
  instructions: string | undefined
  builtinTools: string | undefined
  builtinPlugins: string | undefined
  caching: string | undefined
  contextManager: string | undefined
  session: string | undefined
  sessionId: string | undefined
  skills: string | undefined
  memory: string | undefined
  interventions: string | undefined
  mcpConfig: string[]
}

export type CliRunMode = 'acp' | 'ink' | 'plain' | 'print'

const DIRECT_CONFIG_FLAGS = ['name', 'description', 'effort', 'instructions', 'interventions'] as const

export function parseArgs(argv: string[]): ParsedArgs {
  const collect = (value: string, previous: string[]): string[] => [...previous, value]
  const program = new Command()
  program
    .name('strands')
    .description('Chat with a Strands harness agent.')
    .version(readCliVersion())
    .argument('[request]', 'an initial request to answer')
    .option('-p, --print', 'answer the request and exit, without entering the chat loop')
    .option('--prompt <text>', 'initial request (equivalent to the positional request)')
    .option('--acp-server', 'serve the agent over ACP on stdin/stdout')
    .option('--setup', 'open the interactive provider and agent setup wizard')
    .option('--agent <path>', 'load an agent project ZIP, folder, or agent.ts/agent.py')
    .option('--set <field=value>', 'override any portable agent config field (repeatable)', collect, [])
    .option('--env-file <path>', 'load an explicitly trusted env file (repeatable)', collect, [])
    .option('--name <name>', 'agent name')
    .option('--description <text>', 'agent description')
    .option('--model <model>', 'provider/model string, or a bare Bedrock model id')
    .option('--effort <level>', `reasoning effort: ${EFFORT_LEVELS.join(', ')}`)
    .option('--instructions <text>', 'domain instructions appended to the system prompt')
    .option('--builtin-tools <tools>', "comma-separated built-in tools, or '' for none")
    .option('--builtin-plugins <plugins>', "comma-separated built-in plugins, or '' for none")
    .option('--caching <mode>', "prompt caching: 'auto' (on) or 'off'")
    .option('--context-manager <mode>', "context management: 'auto', 'agentic', or 'off'")
    .option('--session <mode>', "conversation persistence: 'on' or 'off'")
    .option('--session-id <id>', 'persist and resume this conversation by id')
    .option('--skills <dirs>', "comma-separated directories to load skills from, or 'off' to disable")
    .option('--memory <mode>', "long-term memory: 'on' or 'off'")
    .option(
      '--interventions <policy>',
      "gate tool calls: 'ask', 'smart', a .cedar file path, or a natural-language rule"
    )
    .option('--mcp-config <path>', 'additional MCP configuration file (repeatable)', collect, [])
    .allowExcessArguments(false)
    .exitOverride()

  program.parse(argv, { from: 'user' })
  const opts = program.opts()
  if (opts.prompt !== undefined && program.args[0] !== undefined) {
    program.error('error: pass the initial request either positionally or with --prompt, not both.')
  }
  return {
    request: opts.prompt ?? program.args[0],
    oneShot: Boolean(opts.print),
    acpServer: Boolean(opts.acpServer),
    setup: Boolean(opts.setup),
    agent: opts.agent,
    configSet: opts.set,
    envFiles: opts.envFile,
    name: opts.name,
    description: opts.description,
    model: opts.model,
    effort: opts.effort,
    instructions: opts.instructions,
    builtinTools: opts.builtinTools,
    builtinPlugins: opts.builtinPlugins,
    caching: opts.caching,
    contextManager: opts.contextManager,
    session: opts.session,
    sessionId: opts.sessionId,
    skills: opts.skills,
    memory: opts.memory,
    interventions: opts.interventions,
    mcpConfig: opts.mcpConfig,
  }
}

/** Apply arbitrary portable config values, followed by the dedicated CLI flag shorthands. */
export function agentConfig(args: ParsedArgs, defaults: HarnessAgentConfig): HarnessAgentConfig {
  const config = globalThis.structuredClone(defaults) as unknown as Record<string, unknown>
  for (const assignment of args.configSet) {
    applyConfigAssignment(config, assignment)
  }
  for (const key of DIRECT_CONFIG_FLAGS) {
    if (args[key] !== undefined) {
      config[key] = args[key]
    }
  }
  if (args.model !== undefined) {
    config.model = modelSpecifier(args.model, '--model')
  }
  if (args.builtinTools !== undefined) {
    config.builtinTools = commaSeparated(args.builtinTools)
  }
  if (args.builtinPlugins !== undefined) {
    config.builtinPlugins = commaSeparated(args.builtinPlugins)
  }
  if (args.caching !== undefined) {
    config.caching = args.caching !== 'off'
  }
  if (args.contextManager !== undefined) {
    config.contextManager = args.contextManager === 'off' ? false : args.contextManager
  }
  // `on` keeps an object form already present (a saved `dir`, a `--set` sub-key) rather than flattening it.
  for (const key of ['session', 'memory'] as const) {
    if (args[key] === undefined) continue
    if (args[key] === 'off') {
      config[key] = false
    } else if (args[key] === 'on') {
      config[key] ||= true
    } else {
      throw new Error(`--${key} must be 'on' or 'off'.`)
    }
  }
  // `--session off` (or a disabled saved profile) wins over the id.
  if (args.sessionId !== undefined && config.session !== false) {
    const session = config.session
    config.session = { ...(typeof session === 'object' && session !== null ? session : {}), id: args.sessionId }
  }
  if (args.skills !== undefined) {
    config.skills = args.skills === 'off' ? false : commaSeparated(args.skills)
  }
  return normalizeHarnessAgentConfig(config)
}

export function projectConfigOverrides(args: ParsedArgs): Partial<HarnessAgentConfig> {
  const fields = new Set(args.configSet.map((assignment) => assignment.split('=')[0]!.split('.')[0]!))
  for (const key of [
    ...DIRECT_CONFIG_FLAGS,
    'model',
    'builtinTools',
    'builtinPlugins',
    'caching',
    'contextManager',
    'session',
    'skills',
    'memory',
  ] as const) {
    if (args[key] !== undefined) fields.add(key)
  }
  if (args.sessionId !== undefined) fields.add('session')
  const config = agentConfig(args, DEFAULT_HARNESS_AGENT_CONFIG)
  return Object.fromEntries(Object.entries(config).filter(([key]) => fields.has(key)))
}

export function shouldPersistModelChanges(args: ParsedArgs): boolean {
  const assignedFields = args.configSet.map((assignment) => assignment.slice(0, assignment.indexOf('=')))
  return (
    !args.agent &&
    args.model === undefined &&
    args.effort === undefined &&
    !assignedFields.some((field) => field === 'model' || field === 'effort')
  )
}

function applyConfigAssignment(config: Record<string, unknown>, assignment: string): void {
  const separator = assignment.indexOf('=')
  if (separator <= 0) {
    throw new Error(`--set expects field=value; received ${JSON.stringify(assignment)}.`)
  }
  const path = assignment.slice(0, separator)
  const keys = path.split('.')
  if (
    keys.some(
      (key) =>
        !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key) || key === '__proto__' || key === 'prototype' || key === 'constructor'
    )
  ) {
    throw new Error(`--set contains an invalid config field ${JSON.stringify(path)}.`)
  }
  if (!(keys[0]! in DEFAULT_HARNESS_AGENT_CONFIG)) {
    throw new Error(`--set contains an unknown agent config field ${JSON.stringify(keys[0])}.`)
  }
  let target = config
  for (const key of keys.slice(0, -1)) {
    const value = target[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      target[key] = {}
    }
    target = target[key] as Record<string, unknown>
  }
  const raw = assignment.slice(separator + 1)
  try {
    target[keys.at(-1)!] = JSON.parse(raw) as unknown
  } catch {
    target[keys.at(-1)!] = raw
  }
}

function commaSeparated(value: string): string[] {
  return value.split(',').filter(Boolean)
}

function modelSpecifier(value: string, option: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${option} requires a model ID.`)
  }
  const separator = trimmed.indexOf('/')
  if (separator === -1) {
    return trimmed
  }
  const provider = trimmed.slice(0, separator)
  const model = trimmed.slice(separator + 1)
  if (!/^[a-z][a-z0-9_-]*$/i.test(provider)) {
    return trimmed
  }
  const providers = ['bedrock', 'bedrock-mantle', 'anthropic', 'openai', 'google', 'ollama', 'litellm']
  if (!providers.includes(provider) || !model) {
    throw new Error(
      `${option} must use a supported provider/model string: ${providers.slice(0, -1).join(', ')}, or ${providers.at(-1)}.`
    )
  }
  return trimmed
}
