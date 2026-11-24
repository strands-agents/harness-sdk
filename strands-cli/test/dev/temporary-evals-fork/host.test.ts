import { describe, expect, it } from 'vitest'

import type { TemporaryAgentFacts } from '../../../src/dev/temporary-evals-fork/agent-context.js'
import { temporaryFileChangeWarning, type TemporarySessionHost } from '../../../src/dev/temporary-evals-fork/host.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'

const host = (tools: readonly string[]): TemporarySessionHost => ({
  workspace: { root: '/w/project' } as DevWorkspace,
  agent: (): TemporaryAgentFacts => ({ tools: tools.map((name) => ({ name, description: '' })) }),
})

describe('temporaryFileChangeWarning', () => {
  it.each([
    [
      ['shell', 'read', 'write', 'edit', 'strands_dev_status'],
      'its shell, write, and edit tools can change files there.',
    ],
    [['edit', 'edit'], 'its edit tool can change files there.'],
  ])('shouldNameTheToolsThatCanChangeFilesWhenTheAgentHas %j', (tools, ending) => {
    expect(temporaryFileChangeWarning(host(tools))).toBe(
      `Evaluations and optimizations run this agent in /w/project, and ${ending}`
    )
  })

  it.each([[[]], [['read', 'web_search', 'web_fetch']]])('shouldGiveNoWarningWhenTheAgentHas %j', (tools) => {
    expect(temporaryFileChangeWarning(host(tools))).toBeUndefined()
  })
})
