import { defineHarnessAgentConfig, type HarnessAgentConfig } from '@strands-agents/harness'
import { describe, expect, it } from 'vitest'

import { agentProjectSource } from '../../../src/tui/project/source.js'

const store = { kind: 'memory-store' as const, module: './memory/store.ts' }

function source(overrides: Partial<HarnessAgentConfig>, language: 'typescript' | 'python' = 'typescript'): string {
  return agentProjectSource(defineHarnessAgentConfig(overrides), language)
}

describe('agentProjectSource memory', () => {
  it('keeps memory: false when memory stores are configured', () => {
    const generated = source({ memory: false, memoryStores: [store] })
    expect(generated).toContain('memory: false,')
    expect(generated).not.toContain('memoryStores')
    expect(generated).not.toContain('extensions')
  })

  it('keeps a custom memory directory alongside loaded memory stores', () => {
    const generated = source({ memory: { dir: './state/memory' }, memoryStores: [store] })
    expect(generated).toContain("memory: extensions['memory'],")
    expect(generated).toMatch(/harnessAgentOptionsFromConfig\(defineHarnessAgentConfig\(\{[\s\S]*memoryStores:/u)
    expect(generated).toMatch(
      /harnessAgentOptionsFromConfig\(defineHarnessAgentConfig\(\{[\s\S]*dir: '\.\/state\/memory'/u
    )
  })

  it('does not forward default memory config to the loader', () => {
    const generated = source({ memoryStores: [store] })
    expect(generated).toContain("memory: extensions['memory'],")
    expect(generated).not.toMatch(/defineHarnessAgentConfig\(\{[\s\S]*memory:[\s\S]*\}\)\)/u)
  })

  it('emits memory=False for python when memory stores are configured', () => {
    expect(source({ memory: false, memoryStores: [store] }, 'python')).toContain('memory=False,')
  })
})

describe('agentProjectSource skills', () => {
  it('omits skills when it matches the default', () => {
    expect(source({})).not.toContain('skills')
  })

  it('emits skills: false for a disabled profile', () => {
    expect(source({ skills: false })).toContain('skills: false,')
    expect(source({ skills: false }, 'python')).toContain('skills=False,')
  })
})

describe('agentProjectSource MCP commands', () => {
  it.each(['python', 'python3', 'python.exe', 'python3.exe'])(
    'uses the exported agent interpreter for an unqualified %s MCP command',
    (command) => {
      const config = defineHarnessAgentConfig({ mcpServers: { local: { command, args: ['-m', 'server'] } } })
      expect(agentProjectSource(config, 'python')).toContain('"command": sys.executable')
      expect(agentProjectSource(config, 'typescript')).toContain(`command: '${command}'`)
    }
  )

  it.each([
    ['/opt/python/bin/python3', '"command": "/opt/python/bin/python3"'],
    ['python3.11', '"command": "python3.11"'],
    ['${env:MCP_PYTHON}', '"command": os.environ["MCP_PYTHON"]'],
    ['uvx', '"command": "uvx"'],
  ])('preserves an explicitly selected interpreter or runner: %s', (command, expected) => {
    const source = agentProjectSource(defineHarnessAgentConfig({ mcpServers: { local: { command } } }), 'python')
    expect(source).not.toContain('sys.executable')
    expect(source).toContain(expected)
  })
})

describe('agentProjectSource portability', () => {
  it('recases Python background task options without dropping them', () => {
    const source = agentProjectSource(
      defineHarnessAgentConfig({
        agentConfig: { backgroundTasks: { waitForCompletion: false, maxConcurrency: 2, timeout: 1_500 } },
      }),
      'python'
    )
    expect(source).toContain('"wait_for_completion": False')
    expect(source).toContain('"max_concurrency": 2')
    expect(source).toContain('"timeout": 1500')
  })

  it.each(['typescript', 'python'] as const)('anchors local paths to the exported project in %s source', (language) => {
    const source = agentProjectSource(
      defineHarnessAgentConfig({
        skills: ['./agent/skills'],
        interventions: './agent/policy.cedar',
        mcpServers: { local: { command: 'node', args: ['./server.mjs'] } },
      }),
      language
    )
    expect(source).toContain(
      language === 'typescript' ? "projectPath('./agent/skills')" : 'project_path("./agent/skills")'
    )
    expect(source).toContain(language === 'typescript' ? "cwd: projectPath('.')" : '"cwd": project_path(".")')
    expect(source).toContain(
      language === 'typescript' ? "projectPath('./agent/policy.cedar')" : 'project_path("./agent/policy.cedar")'
    )
  })
})
