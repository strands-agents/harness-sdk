import type { BeforeToolCallEvent, JSONValue } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import { buildFileChangePreview, createDiffPreview } from '../src/tui/permissions/file-change-preview.js'

describe('file change previews', () => {
  it('renders a focused red/green hunk for a replacement', () => {
    const preview = createDiffPreview('/workspace/example.ts', 'one\ntwo\nthree', 'one\nTWO\nthree')

    expect(preview).toMatchObject({
      path: '/workspace/example.ts',
      lines: [
        { kind: 'header' },
        { kind: 'context', text: 'one', oldLine: 1, newLine: 1 },
        { kind: 'remove', text: 'two', oldLine: 2 },
        { kind: 'add', text: 'TWO', newLine: 2 },
        { kind: 'context', text: 'three', oldLine: 3, newLine: 3 },
      ],
    })
  })

  it('uses the active agent sandbox to preview write and edit calls', async () => {
    const readText = vi.fn(async () => 'alpha\nbeta\n')
    const writePreview = await buildFileChangePreview(
      toolEvent('write', { path: '/workspace/file.txt', content: 'alpha\nBETA\n' }, readText)
    )
    const editPreview = await buildFileChangePreview(
      toolEvent('edit', { path: '/workspace/file.txt', old_str: 'beta', new_str: 'BETA' }, readText)
    )

    expect(readText).toHaveBeenCalledWith('/workspace/file.txt')
    expect(writePreview?.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'add', text: 'BETA' })])
    )
    expect(editPreview?.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'remove', text: 'beta' })])
    )
  })

  it('omits an edit preview when the replacement is not uniquely applicable', async () => {
    const preview = await buildFileChangePreview(
      toolEvent(
        'edit',
        { path: '/workspace/file.txt', old_str: 'same', new_str: 'changed' },
        vi.fn(async () => 'same\nsame\n')
      )
    )

    expect(preview).toBeUndefined()
  })
})

function toolEvent(name: string, input: JSONValue, readText: (path: string) => Promise<string>): BeforeToolCallEvent {
  return {
    toolUse: { name, input, toolUseId: `${name}-1` },
    agent: {
      sandbox: { readText },
    },
  } as unknown as BeforeToolCallEvent
}
