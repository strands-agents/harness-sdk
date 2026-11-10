import { DEFAULT_HARNESS_AGENT_CONFIG, type HarnessAgentConfig } from '@strands-agents/harness'

import { webFetchModelModule } from '../agent/tools.js'
import { isRecord } from '../values.js'
import type { AgentProjectLanguage } from './import.js'

export type AgentEntrypointPlacement = 'agent-folder' | 'project-root'

const PROJECT_ROOT_EXPRESSIONS: Record<AgentEntrypointPlacement, { python: string; typescript: string }> = {
  'agent-folder': { python: 'Path(__file__).parent.parent', typescript: "new URL('..', import.meta.url)" },
  'project-root': { python: 'Path(__file__).parent', typescript: "new URL('.', import.meta.url)" },
}

export function agentProjectSource(
  config: HarnessAgentConfig,
  language: AgentProjectLanguage,
  placement: AgentEntrypointPlacement = 'agent-folder'
): string {
  const python = language === 'python'
  const projectRoot = PROJECT_ROOT_EXPRESSIONS[placement]
  const literal = (value: unknown): string => sourceLiteral(value, python)
  let usesProjectPath = false
  const projectPath = (value: string): string => {
    usesProjectPath = true
    return `${python ? 'project_path' : 'projectPath'}(${value})`
  }
  const optionName = (key: string): string =>
    python ? key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`) : key
  const options = new Map<string, string>()
  const backgroundKeys: Record<string, string> = {
    waitForCompletion: 'wait_for_completion',
    maxConcurrency: 'max_concurrency',
  }
  for (const [key, value] of Object.entries(config.agentConfig)) {
    if (python && key === 'printer' && typeof value === 'boolean') {
      if (!value) {
        options.set('callback_handler', 'None')
      }
      continue
    }
    const configured =
      python && key === 'backgroundTasks' && isRecord(value)
        ? Object.fromEntries(Object.entries(value).map(([key, value]) => [backgroundKeys[key] ?? key, value]))
        : value
    options.set(python ? pythonAgentOptionName(key) : key, literal(configured))
  }
  const set = (key: string, value: unknown): void => {
    options.set(optionName(key), literal(value))
  }
  const expression = (key: string, value: string): void => {
    options.set(optionName(key), value)
  }
  const modules: Record<string, unknown> = {}
  const loadedOptions = new Set<string>()
  const load = (key: keyof HarnessAgentConfig, option: string): void => {
    const value = config[key]
    if (value === null || (Array.isArray(value) && value.length === 0)) {
      return
    }
    modules[key] = value
    loadedOptions.add(optionName(option))
  }
  load('modelModule', 'model')
  load('tools', 'tools')
  load('subagents', 'tools')
  load('plugins', 'plugins')
  // Stores only matter when memory is on; `memory: false` is emitted inline below instead.
  if (config.memory !== false) {
    load('memoryStores', 'memory')
    // The loader resolves `memory` from the stores plus the memory config, so a custom `dir` rides along.
    if (loadedOptions.has(optionName('memory')) && !sameJson(config.memory, DEFAULT_HARNESS_AGENT_CONFIG.memory)) {
      modules.memory = config.memory
    }
  }
  load('sandbox', 'sandbox')
  load('interventionModules', 'interventions')
  if (config.modelModule) {
    modules.model = config.model
  }
  const webFetchModule = webFetchModelModule(config.builtinTools)
  if (webFetchModule) {
    modules.builtinTools = config.builtinTools
    loadedOptions.add(optionName('builtinTools'))
  }
  if (config.interventionModules.length > 0) {
    modules.interventions = config.interventions
  }
  if (Object.keys(config.agentConfigModules).length > 0) {
    modules.agentConfigModules = config.agentConfigModules
    for (const key of Object.keys(config.agentConfigModules)) {
      options.set(python ? pythonAgentOptionName(key) : key, `extensions[${literal(key)}]`)
    }
  }

  set('name', config.name)
  if (config.description) {
    set('description', config.description)
  }
  set('model', config.model)
  if (config.instructions) {
    set('instructions', config.instructions)
  }
  if (config.effort !== DEFAULT_HARNESS_AGENT_CONFIG.effort) {
    set('effort', config.effort)
  } else {
    options.delete(optionName('effort'))
  }
  if (Object.keys(config.mcpServers).length > 0) {
    expression(
      'mcpServers',
      sourceLiteral(mcpServersForSource(config.mcpServers, python), python, 0, true, projectPath)
    )
  }
  for (const key of ['builtinTools', 'builtinPlugins', 'caching'] as const) {
    // Passing the default tools explicitly changes unsupported-provider handling in the factory.
    if (key === 'builtinTools' && webFetchModule) {
      continue
    }
    if (!sameJson(config[key], DEFAULT_HARNESS_AGENT_CONFIG[key])) {
      set(key, config[key])
    }
  }
  if (!sameJson(config.contextManager, DEFAULT_HARNESS_AGENT_CONFIG.contextManager)) {
    set('contextManager', config.contextManager)
  } else {
    options.delete(optionName('contextManager'))
  }
  if (!sameJson(config.skills, DEFAULT_HARNESS_AGENT_CONFIG.skills)) {
    const skill = (value: string): string =>
      value.startsWith('https://') ? literal(value) : projectPath(literal(value))
    expression(
      'skills',
      typeof config.skills === 'string'
        ? skill(config.skills)
        : Array.isArray(config.skills)
          ? `[${config.skills.map(skill).join(', ')}]`
          : literal(config.skills)
    )
  } else {
    options.delete('skills')
  }
  if (!sameJson(config.session, DEFAULT_HARNESS_AGENT_CONFIG.session)) {
    set('session', config.session)
  } else {
    options.delete('session')
  }
  if (!loadedOptions.has(optionName('memory'))) {
    if (!sameJson(config.memory, DEFAULT_HARNESS_AGENT_CONFIG.memory)) {
      set('memory', config.memory)
    } else {
      options.delete('memory')
    }
  }
  if (config.interventions !== null) {
    const policy = (value: string): string =>
      value.trim().endsWith('.cedar') ? projectPath(literal(value.trim())) : literal(value)
    expression(
      'interventions',
      typeof config.interventions === 'string'
        ? policy(config.interventions)
        : `[${config.interventions.map(policy).join(', ')}]`
    )
  }
  for (const key of loadedOptions) {
    options.set(key, python ? `extensions.get(${literal(key)})` : `extensions[${literal(key)}]`)
  }

  const hasModules = Object.keys(modules).length > 0
  const hasEnvironment = /\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}/u.test(JSON.stringify(config.mcpServers))
  const usesPythonInterpreter =
    python &&
    Object.values(config.mcpServers).some(
      (server) =>
        server &&
        typeof server === 'object' &&
        !Array.isArray(server) &&
        'command' in server &&
        typeof server.command === 'string' &&
        /^python(?:3)?(?:\.exe)?$/iu.test(server.command)
    )
  const lines = python
    ? [
        ...(hasEnvironment ? ['import os'] : []),
        ...(usesPythonInterpreter ? ['import sys'] : []),
        ...(hasModules || usesProjectPath ? ['from pathlib import Path'] : []),
        ...(hasEnvironment || usesPythonInterpreter || hasModules || usesProjectPath ? [''] : []),
        hasModules
          ? 'from strands_harness import create_harness, harness_agent_kwargs_from_config'
          : 'from strands_harness import create_harness',
      ]
    : [
        ...(hasModules || usesProjectPath ? ["import { fileURLToPath } from 'node:url'"] : []),
        ...(usesProjectPath ? ["import { resolve } from 'node:path'"] : []),
        hasModules
          ? "import { createHarness, defineHarnessAgentConfig, harnessAgentOptionsFromConfig } from '@strands-agents/harness'"
          : "import { createHarness } from '@strands-agents/harness'",
      ]
  if (usesProjectPath) {
    lines.push(
      '',
      ...(python
        ? [
            `project_root = ${projectRoot.python}`,
            '',
            'def project_path(path: str) -> str:',
            '    return str(project_root / path)',
          ]
        : [
            `const projectRoot = fileURLToPath(${projectRoot.typescript})`,
            '',
            'function projectPath(path: string): string {',
            '  return resolve(projectRoot, path)',
            '}',
          ])
    )
  }
  if (hasEnvironment && !python) {
    lines.push(
      '',
      'function env(name: string): string {',
      '  const value = process.env[name]',
      '  if (value === undefined) throw new Error(`Environment variable "${name}" is not set.`)',
      '  return value',
      '}'
    )
  }
  if (hasModules) {
    lines.push(
      '',
      python
        ? `extensions = harness_agent_kwargs_from_config(${literal(modules)}, ${projectRoot.python})`
        : `const extensions = await harnessAgentOptionsFromConfig(defineHarnessAgentConfig(${literal(modules)}), fileURLToPath(${projectRoot.typescript}))`
    )
  }
  lines.push('', python ? 'agent = create_harness(' : 'export const agent = await createHarness({')
  for (const [key, value] of options) {
    const assignment = python ? `${key}=${value},` : `${/^[a-z_$][\w$]*$/iu.test(key) ? key : literal(key)}: ${value},`
    lines.push(...assignment.split('\n').map((line) => `${python ? '    ' : '  '}${line}`))
  }
  lines.push(python ? ')' : '})', '')
  return lines.join('\n')
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function pythonAgentOptionName(key: string): string {
  const aliases: Record<string, string | null> = {
    appState: 'state',
    id: 'agent_id',
    systemPrompt: 'system_prompt',
    traceAttributes: 'trace_attributes',
    conversationManager: 'conversation_manager',
    contextManager: 'context_manager',
    sessionManager: 'session_manager',
    memoryManager: 'memory_manager',
    retryStrategy: 'retry_strategy',
    toolExecutor: 'tool_executor',
    structuredOutputSchema: 'structured_output_model',
    modelState: null,
    backgroundTasks: 'background_tasks',
    printer: null,
  }
  const name = Object.hasOwn(aliases, key) ? aliases[key] : key
  if (name === null || name === undefined || /[A-Z]/u.test(name)) {
    throw new Error(`Cannot export agent option ${JSON.stringify(key)} to Python: no supported Python equivalent.`)
  }
  return name
}

function sourceLiteral(
  value: unknown,
  python: boolean,
  depth = 0,
  mcp = false,
  projectPath?: (value: string) => string
): string {
  const indent = python ? '    ' : '  '
  if (value === null) {
    return python ? 'None' : 'null'
  }
  if (typeof value === 'boolean') {
    return python ? (value ? 'True' : 'False') : String(value)
  }
  if (typeof value === 'string' && mcp) {
    const parts: string[] = []
    let offset = 0
    for (const match of value.matchAll(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/gu)) {
      if (match.index > offset) {
        parts.push(sourceString(value.slice(offset, match.index), python))
      }
      parts.push(python ? `os.environ[${sourceString(match[1]!, true)}]` : `env(${sourceString(match[1]!, false)})`)
      offset = match.index + match[0].length
    }
    if (parts.length > 0) {
      if (offset < value.length) {
        parts.push(sourceString(value.slice(offset), python))
      }
      return parts.join(' + ')
    }
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => sourceLiteral(item, python, depth + 1, mcp, projectPath))
    const inline = `[${items.join(', ')}]`
    return inline.length <= 100 && !inline.includes('\n')
      ? inline
      : `[\n${items.map((item) => `${indent.repeat(depth + 1)}${item},`).join('\n')}\n${indent.repeat(depth)}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) {
      return '{}'
    }
    return `{\n${entries
      .map(([key, item]) => {
        const property = python
          ? sourceString(key, true)
          : key === '__proto__'
            ? `[${sourceString(key, false)}]`
            : /^[a-z_$][\w$]*$/iu.test(key)
              ? key
              : sourceString(key, false)
        let rendered = sourceLiteral(item, python, depth + 1, mcp, projectPath)
        if (mcp && depth === 1 && key === 'cwd' && typeof item === 'string') {
          rendered = projectPath?.(rendered) ?? rendered
        }
        if (
          python &&
          mcp &&
          depth === 1 &&
          key === 'command' &&
          typeof item === 'string' &&
          /^python(?:3)?(?:\.exe)?$/iu.test(item)
        ) {
          rendered = 'sys.executable'
        }
        return `${indent.repeat(depth + 1)}${property}: ${rendered},`
      })
      .join('\n')}\n${indent.repeat(depth)}}`
  }
  return typeof value === 'string' ? sourceString(value, python) : JSON.stringify(value)
}

function mcpServersForSource(
  servers: HarnessAgentConfig['mcpServers'],
  python: boolean
): HarnessAgentConfig['mcpServers'] {
  if (typeof servers === 'string') return servers
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if (!isRecord(server)) return [name, server]
      const localRunner =
        typeof server.command === 'string' &&
        /^(?:node|python(?:\d+(?:\.\d+)*)?|(?:ba|da|z)?sh)(?:\.exe)?$/iu.test(server.command)
      const configured = localRunner && server.cwd === undefined ? { ...server, cwd: '.' } : server
      if (!python) return [name, configured]
      return [
        name,
        Object.fromEntries(
          Object.entries(configured).map(([key, value]) => {
            if (key === 'continueOnError') return ['continue_on_error', value]
            if (key === 'toolFilters') return ['tool_filters', value]
            if (key !== 'auth' || !isRecord(value)) return [key, value]
            return [
              key,
              Object.fromEntries(
                Object.entries(value).map(([key, value]) => [
                  key === 'clientId' ? 'client_id' : key === 'clientSecret' ? 'client_secret' : key,
                  value,
                ])
              ),
            ]
          })
        ),
      ]
    })
  )
}

function sourceString(value: string, python: boolean): string {
  const json = JSON.stringify(value)
  return python ? json : `'${json.slice(1, -1).replace(/\\"/gu, '"').replace(/'/gu, "\\'")}'`
}
