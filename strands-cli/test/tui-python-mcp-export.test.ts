import { defineHarnessAgentConfig } from '@strands-agents/harness'
import { expect, it } from 'vitest'

import { agentProjectSource } from '../src/tui/project/source.js'

it.each(['python', 'python3', 'python.exe', 'python3.exe'])(
  'uses the exported agent interpreter for an unqualified %s MCP command',
  (command) => {
    const config = defineHarnessAgentConfig({ mcpServers: { local: { command, args: ['-m', 'server'] } } })
    expect(agentProjectSource(config, 'python')).toContain('"command": sys.executable')
    expect(agentProjectSource(config, 'typescript')).toContain(`command: '${command}'`)
  }
)

it.each(['/opt/python/bin/python3', 'python3.11', '${env:MCP_PYTHON}', 'uvx'])(
  'preserves an explicitly selected interpreter or runner: %s',
  (command) => {
    const source = agentProjectSource(defineHarnessAgentConfig({ mcpServers: { local: { command } } }), 'python')
    expect(source).not.toContain('sys.executable')
  }
)
