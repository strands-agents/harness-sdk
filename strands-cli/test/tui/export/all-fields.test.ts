import type { HarnessAgentConfig } from '@strands-agents/harness'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  applyCompleteProfileInChat,
  createCompleteProfileFixture,
  exportCompleteProfile,
  type CompleteProfileFixture,
  type ExportedProfile,
} from './complete-profile.js'

type Evidence = (exported: ExportedProfile, fixture: CompleteProfileFixture) => void

const evidence = {
  name: ({ source }) => expect(source).toContain("name: 'Chat configured agent'"),
  description: ({ source }) => expect(source).toContain("description: 'Created during chat'"),
  instructions: ({ source }) => expect(source).toContain("instructions: 'Review every field.'"),
  model: ({ source }) => expect(source).toContain("model: 'bedrock/chat-base-model'"),
  modelModule: ({ source }) => expect(source).toContain('modelModule:'),
  effort: ({ source }) => expect(source).toContain("effort: 'high'"),
  tools: ({ source }) => expect(source).toContain('tools:'),
  subagents: ({ source }) => expect(source).toContain('subagents:'),
  mcpServers: ({ source }) => expect(source).toContain("url: 'https://example.com/mcp'"),
  builtinTools: ({ source }) => expect(source).toContain('builtinTools: []'),
  caching: ({ source }) => expect(source).toContain('caching: false'),
  contextManager: ({ source }) => expect(source).toContain("contextManager: 'agentic'"),
  session: ({ source }) => expect(source).toContain("dir: './state/sessions'"),
  skills: ({ entries, source }, { skillUrl }) => {
    expect(source).toContain(skillUrl)
    expect(entries).toHaveProperty('agent/skills/review/SKILL.md')
  },
  memory: ({ source }) => expect(source).toContain("dir: './state/memory'"),
  memoryStores: ({ source }) => expect(source).toContain('memoryStores:'),
  plugins: ({ source }) => expect(source).toContain('plugins:'),
  builtinPlugins: ({ source }) => expect(source).toContain('builtinPlugins: []'),
  interventions: ({ entries }) =>
    expect(Object.keys(entries).some((path) => path.endsWith('/approval.cedar'))).toBe(true),
  interventionModules: ({ source }) => expect(source).toContain('interventionModules:'),
  sandbox: ({ source }) => expect(source).toContain('sandbox:'),
  agentConfigModules: ({ source }) => expect(source).toContain('agentConfigModules:'),
  dependencies: ({ manifest }) => expect(manifest.dependencies['@strands-agents/sdk']).toBe('>=1.19.0 <2.0.0'),
  agentConfig: ({ source }) => expect(source).toContain('checkpointing: true'),
} satisfies Record<keyof HarnessAgentConfig, Evidence>

describe('chat-configured export fields', () => {
  let root: string
  let fixture: CompleteProfileFixture
  let applied: HarnessAgentConfig
  let exported: ExportedProfile

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'strands-chat-export-fields-'))
    vi.stubEnv('AWS_REGION', 'us-east-1')
    fixture = await createCompleteProfileFixture(root)
    applied = await applyCompleteProfileInChat(fixture)
    exported = await exportCompleteProfile(fixture, applied)
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it('applies the exact profile assembled during chat', () => {
    expect(applied).toEqual(fixture.expected)
  })

  it('requires explicit export evidence for every profile field', () => {
    expect(Object.keys(evidence).sort()).toEqual(Object.keys(applied).sort())
  })

  it.each(Object.entries(evidence))('preserves %s', (_field, check) => {
    check(exported, fixture)
  })
})
