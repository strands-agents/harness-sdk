import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { temporaryAgentContext } from '../../../src/dev/temporary-evals-fork/agent-context.js'
import type { DevWorkspace } from '../../../src/dev/workspace.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const workspaceAt = async (files: Record<string, string>): Promise<DevWorkspace> => {
  const root = await temporaryDirectory()
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), text)
  }
  return {
    directory: join(root, 'strands-dev'),
    root,
    entrypoint: join(root, 'agent.py'),
    config: { version: 1, name: 'desk', language: 'python', entrypoint: 'agent.py', origin: { kind: 'discovered' } },
  }
}

describe('temporaryAgentContext', () => {
  it('shouldDescribeTheSourceToolsAndNotesWhenTheAgentHasThem', async () => {
    const workspace = await workspaceAt({
      'agent.py': 'agent = make()\n',
      'instructions.md': 'Refund within 30 days.\n',
    })

    const context = await temporaryAgentContext(workspace, {
      description: 'Answers refund questions',
      tools: [{ name: 'lookup_order', description: 'Find an order' }],
    })

    expect(context.summary).toBe('agent.py · 1 tool · instructions.md')
    expect(context.text).toContain('This is an AI agent named desk.')
    expect(context.text).toContain('Its description: Answers refund questions')
    expect(context.text).toContain('- lookup_order: Find an order')
    expect(context.text).toContain('Its source file agent.py:\nagent = make()')
    expect(context.text).toContain('The file instructions.md:\nRefund within 30 days.')
  })

  it('shouldNameOnlyTheSourceFileWhenTheAgentHasNoToolsOrNotes', async () => {
    const workspace = await workspaceAt({ 'agent.py': 'agent = make()\n' })

    const context = await temporaryAgentContext(workspace, {})

    expect(context.summary).toBe('agent.py')
  })
})
