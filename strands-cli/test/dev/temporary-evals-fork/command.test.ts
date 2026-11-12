import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { temporaryDevCommands } from '../../../src/dev/temporary-evals-fork/command.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import type { ImportedAgentProject } from '../../../src/project/import.js'
import type { DevChatCommandContext } from '../../../src/ui/chat/types.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const fixture = async (): Promise<{ workspace: DevWorkspace; project: ImportedAgentProject }> => {
  const root = await temporaryDirectory()
  return {
    workspace: {
      directory: join(root, 'strands-dev'),
      root,
      entrypoint: join(root, 'agent.py'),
      config: { version: 1, name: 'desk', language: 'python', entrypoint: 'agent.py', origin: { kind: 'discovered' } },
    },
    project: { root, entrypoint: join(root, 'agent.py'), language: 'python' } as ImportedAgentProject,
  }
}

const context: DevChatCommandContext = {
  signal: new AbortController().signal,
  report: () => ({ update: vi.fn() }),
  fail: vi.fn(),
}

describe('TEMPORARY dev commands', () => {
  it('shouldOfferExperimentTestAndOptimizeWithoutArgumentsWhenTheChatStarts', async () => {
    const { workspace, project } = await fixture()

    const commands = temporaryDevCommands(workspace, project)

    expect(commands.map(({ spec }) => spec.usage)).toEqual(['/experiment', '/test', '/optimize'])
    expect(commands.every(({ spec }) => spec.replacement === undefined)).toBe(true)
    expect(commands.every(({ spec }) => spec.description.startsWith('TEMPORARY: '))).toBe(true)
  })

  it.each([0, 1, 2])('shouldOpenAPanelViewWhenCommand%iRuns', async (index) => {
    const { workspace, project } = await fixture()

    const view = temporaryDevCommands(workspace, project)[index]!.open(context)

    expect(view).toBeTypeOf('function')
  })
})
