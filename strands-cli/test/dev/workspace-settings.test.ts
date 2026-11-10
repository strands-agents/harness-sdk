import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceReplacementForm } from '../../src/dev/settings.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const info = { root: '/workspace/strands-dev', entrypoint: '/agents/main/agent.ts', origin: 'discovered' }

describe('workspace Settings', () => {
  it('shouldShowWorkspaceActionsOnlyWhenTheSessionRunsInDev', async () => {
    const action = vi.fn()
    const dev = new ChatController(idleBackend(), { runtime: { devWorkspace: info }, workspaceAction: action })
    const normal = new ChatController(idleBackend(), { workspaceAction: action })
    try {
      await dev.submit('/settings')
      expect(dev.getSnapshot().panel?.filters).toContainEqual({
        id: 'settings:Workspace',
        label: 'Strands dev workspace',
      })
      await dev.activatePanelRow({ label: '', description: '', value: 'settings:Workspace' })
      expect(dev.getSnapshot().panel?.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Workspace folder', description: info.root }),
          expect.objectContaining({ value: 'workspace:edit' }),
          expect.objectContaining({ value: 'workspace:import' }),
          expect.objectContaining({ value: 'workspace:create' }),
        ])
      )
      await dev.activatePanelRow({ label: '', description: '', value: 'workspace:import' })
      expect(action).toHaveBeenCalledExactlyOnceWith('import')
      await normal.submit('/settings')
      expect(normal.getSnapshot().panel?.filters?.some(({ id }) => id === 'settings:Workspace')).toBe(false)
      expect(await normal.activatePanelRow({ label: '', description: '', value: 'settings:Workspace' })).toBe(false)
    } finally {
      await dev.dispose()
      await normal.dispose()
    }
  })

  it.each(['import', 'create'] as const)('shouldRequireTypedDeleteBefore%sCanReplaceTheWorkspace', async (action) => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frame = captureFrame(output)
    const submit = vi.fn(async () => undefined)
    const cancel = vi.fn()
    render(
      createElement(WorkspaceReplacementForm, { directory: info.root, action, onSubmit: submit, onCancel: cancel }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() =>
      expect(frame().join('\n')).toContain(action === 'create' ? 'Create a new agent' : 'Import a different agent')
    )
    if (action === 'import') {
      input.write('/agents/new/agent.ts')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('/agents/new/agent.ts'))
    }
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('This is a DELETE operation.'))
    expect(frame().join('\n')).toContain(info.root)
    expect(frame().join('\n')).toContain('All files in this folder will be replaced')
    expect(frame().join('\n')).toContain('outside this folder will not be deleted')
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Type DELETE exactly'))
    expect(submit).not.toHaveBeenCalled()
    input.write('DELETE')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('confirm: DELETE'))
    input.write('\r')
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
    expect(submit).toHaveBeenCalledWith(
      action === 'import'
        ? { kind: 'import', path: '/agents/new/agent.ts' }
        : { kind: 'create', language: 'typescript', name: 'new-agent' }
    )
    expect(cancel).not.toHaveBeenCalled()
  })

  it('shouldCancelWithoutReplacingAnythingWhenEscapeIsPressed', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frame = captureFrame(output)
    const submit = vi.fn(async () => undefined)
    const cancel = vi.fn()
    render(
      createElement(WorkspaceReplacementForm, {
        directory: info.root,
        action: 'create',
        onSubmit: submit,
        onCancel: cancel,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Create a new agent'))
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('DELETE workspace and replace?'))
    input.write('\u001b')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(submit).not.toHaveBeenCalled()
  })
})
