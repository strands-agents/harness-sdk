import { describe, expect, it, vi } from 'vitest'

import { devChatExtension, type DevChatPart } from '../../src/dev/chat-extension.js'
import type { DevWorkspace } from '../../src/dev/workspace.js'

const workspace: DevWorkspace = {
  directory: '/work/desk/strands-dev',
  root: '/work/desk',
  entrypoint: '/work/desk/agent.py',
  config: { version: 1, name: 'desk', language: 'python', entrypoint: 'agent.py', origin: { kind: 'discovered' } },
}
const project = { root: '/work/desk', entrypoint: '/work/desk/agent.py', language: 'python' as const }

const part = (run = vi.fn(async () => 'status text')): DevChatPart => ({
  instructions: 'Experiments live in tmp/experiments.',
  skills: [{ name: 'create-experiment', description: 'Create one', instructions: 'Ask first.' }],
  tools: [{ name: 'strands_dev_status', description: 'Status', inputSchema: { type: 'object' }, readOnly: true, run }],
})

describe('devChatExtension', () => {
  it('shouldDescribeTheWorkspaceAndEachPartWhenItBuildsTheInstructions', () => {
    const { extension } = devChatExtension(workspace, project, [part()])

    expect(extension.instructions).toMatch(/^<strands_dev>\n[\s\S]*\n<\/strands_dev>$/u)
    expect(extension.instructions).toContain('Agent: desk (python)')
    expect(extension.instructions).toContain('Agent source: /work/desk/agent.py')
    expect(extension.instructions).toContain('Workspace folder: /work/desk/strands-dev')
    expect(extension.instructions).toContain('.strands/state/')
    expect(extension.instructions).toContain('runtime-only overlay')
    expect(extension.instructions).toContain('Do not copy its instructions, skills, or strands_dev_* tools')
    expect(extension.instructions).toContain('Experiments live in tmp/experiments.')
    expect(extension.skills.map(({ name }) => name)).toEqual(['create-experiment'])
    expect(extension.tools).toEqual([
      { name: 'strands_dev_status', description: 'Status', inputSchema: { type: 'object' }, readOnly: true },
    ])
  })

  it('shouldDescribeOnlyTheWorkspaceWhenThereAreNoParts', () => {
    const { extension } = devChatExtension(workspace, project, [])

    expect(extension.instructions).toContain('Workspace folder: /work/desk/strands-dev')
    expect(extension.skills).toEqual([])
    expect(extension.tools).toEqual([])
  })

  it.each([
    ['an object', { verbose: true }, { verbose: true }],
    ['no object', 'text', {}],
  ])('shouldRunTheNamedToolWhenTheAgentSends%s', async (_case, input, expected) => {
    const run = vi.fn(async () => 'status text')
    const { call } = devChatExtension(workspace, project, [part(run)])

    const result = await call('strands_dev_status', input)

    expect(result).toBe('status text')
    expect(run).toHaveBeenCalledWith(expected)
  })

  it('shouldRejectAToolThatNoPartOffersWhenTheAgentCallsIt', async () => {
    const { call } = devChatExtension(workspace, project, [part()])

    await expect(call('strands_dev_missing', {})).rejects.toThrow('strands dev has no tool named strands_dev_missing.')
  })
})
