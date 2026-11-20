import { describe, expect, it } from 'vitest'

import type { TemporaryAgentFacts } from '../../../src/dev/temporary-evals-fork/agent-context.js'
import { temporaryRunAgent } from '../../../src/dev/temporary-evals-fork/host.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'

const workspace: DevWorkspace = {
  directory: '/w/project/strands-dev',
  root: '/w/project',
  entrypoint: '/w/project/agent.py',
  config: { version: 1, name: 'desk', language: 'python', entrypoint: 'agent.py', origin: { kind: 'discovered' } },
}

const tool = (name: string): { name: string; description: string } => ({ name, description: `${name} tool` })

describe('TEMPORARY run agent', () => {
  it.each<[string, TemporaryAgentFacts, ReturnType<typeof temporaryRunAgent>]>([
    [
      'ShellWriteAndEditTools',
      {
        model: 'us.anthropic.claude-sonnet-4-6',
        tools: ['shell', 'read', 'write', 'edit', 'strands_dev_test'].map(tool),
      },
      { model: 'us.anthropic.claude-sonnet-4-6', folder: '/w/project', fileTools: ['shell', 'write', 'edit'] },
    ],
    ['OnlyReadTools', { tools: ['read', 'web_search'].map(tool) }, { folder: '/w/project', fileTools: [] }],
    ['NoFacts', {}, { folder: '/w/project', fileTools: [] }],
  ])('shouldGiveTheModelTheProjectFolderAndTheFileToolsWhenTheAgentHas%s', (_case, facts, agent) => {
    expect(temporaryRunAgent({ workspace, agent: () => facts })).toEqual(agent)
  })
})
