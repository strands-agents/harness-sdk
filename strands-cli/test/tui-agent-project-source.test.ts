import { describe, expect, it } from 'vitest'
import { defineHarnessAgentConfig, type HarnessAgentConfig } from '@strands-agents/harness'

import { agentProjectSource } from '../src/tui/project/source.js'

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

  it('emits explicit skill paths', () => {
    expect(source({ skills: ['./skills'] })).toContain("skills: [projectPath('./skills')],")
  })
})
