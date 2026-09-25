import { DEFAULT_HARNESS_AGENT_CONFIG, type HarnessAgentConfig } from '@strands-agents/harness'

import { webFetchModelModule } from '../builtin-tools.js'
import type { AgentProjectLanguage } from './import.js'

export function agentProjectSource(config: HarnessAgentConfig, language: AgentProjectLanguage): string {
  const python = language === 'python'
  const literal = (value: unknown): string => sourceLiteral(value, python)
  let usesProjectPath = false
  const projectPath = (value: string): string => {
    usesProjectPath = true
    return `${python ? 'project_path' : 'projectPath'}(${value})`
  }
  const optionName = (key: string): string =>
    python ? key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`) : key
  const options = new Map<string, string>()
  for (const [key, value] of Object.entries(config.agentConfig)) {
    if (python && key === 'printer' && typeof value === 'boolean') {
      if (!value) {
        options.set('callback_handler', 'None')
      }
      continue
    }
    options.set(python ? pythonAgentOptionName(key) : key, literal(value))
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
    expression('mcpServers', sourceLiteral(mcpServersForSource(config.mcpServers), python, 0, true, projectPath))
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
    expression(
      'skills',
      typeof config.skills === 'string'
        ? projectPath(literal(config.skills))
        : Array.isArray(config.skills)
          ? `[${config.skills.map((skill) => projectPath(literal(skill))).join(', ')}]`
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
            'project_root = Path(__file__).parent.parent',
            '',
            'def project_path(path: str) -> str:',
            '    return str(project_root / path)',
          ]
        : [
            "const projectRoot = fileURLToPath(new URL('..', import.meta.url))",
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
        ? `extensions = harness_agent_kwargs_from_config(${literal(modules)}, Path(__file__).parent.parent)`
        : `const extensions = await harnessAgentOptionsFromConfig(defineHarnessAgentConfig(${literal(modules)}), fileURLToPath(new URL('..', import.meta.url)))`
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
    const renamed: Record<string, string> = {
      continueOnError: 'continue_on_error',
      toolFilters: 'tool_filters',
      clientId: 'client_id',
      clientSecret: 'client_secret',
      waitForCompletion: 'wait_for_completion',
      maxConcurrency: 'max_concurrency',
    }
    const entries = Object.entries(value)
    if (entries.length === 0) {
      return '{}'
    }
    return `{\n${entries
      .map(([key, item]) => {
        const name = python ? (renamed[key] ?? key) : key
        const property = python
          ? sourceString(name, true)
          : name === '__proto__'
            ? `[${sourceString(name, false)}]`
            : /^[a-z_$][\w$]*$/iu.test(name)
              ? name
              : sourceString(name, false)
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

function mcpServersForSource(servers: HarnessAgentConfig['mcpServers']): HarnessAgentConfig['mcpServers'] {
  if (typeof servers === 'string') return servers
  return Object.fromEntries(
    Object.entries(servers).map(([name, raw]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [name, raw]
      const server = raw as Record<string, unknown>
      const localRunner =
        typeof server.command === 'string' &&
        /^(?:node|python(?:\d+(?:\.\d+)*)?|(?:ba|da|z)?sh)(?:\.exe)?$/iu.test(server.command)
      return [name, localRunner && server.cwd === undefined ? { ...server, cwd: '.' } : server]
    })
  )
}

function sourceString(value: string, python: boolean): string {
  const json = JSON.stringify(value)
  return python ? json : `'${json.slice(1, -1).replace(/\\"/gu, '"').replace(/'/gu, "\\'")}'`
}
