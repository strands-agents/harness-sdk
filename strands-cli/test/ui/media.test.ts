import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'ink'
import {
  DocumentBlock,
  ImageBlock,
  JsonBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  VideoBlock,
} from '@strands-agents/sdk'

import { projectMessages, TurnProjector } from '../../src/ui/chat/projector.js'
import { projectMediaContent, projectToolResultContent } from '../../src/agent/events.js'
import { MediaView } from '../../src/ui/media.js'

describe('SDK media projection', () => {
  const bytes = new Uint8Array([1, 2, 3])
  const s3Location = { type: 's3' as const, uri: 's3://bucket/file\u0007', bucketOwner: '' }
  const s3 = { type: 's3', location: { type: 's3', uri: 's3://bucket/file', bucketOwner: '' } }

  it.each([
    [new ImageBlock({ format: 'png', source: { bytes } }), { type: 'bytes', bytes }],
    [
      new ImageBlock({ format: 'png', source: { url: 'https://example.com/image\u0007' } }),
      { type: 'url', url: 'https://example.com/image' },
    ],
    [new ImageBlock({ format: 'png', source: { location: s3Location } }), s3],
    [new VideoBlock({ format: 'mp4', source: { bytes } }), { type: 'bytes', bytes }],
    [new VideoBlock({ format: 'mp4', source: { location: s3Location } }), s3],
    [new DocumentBlock({ name: 'notes\u0007', format: 'txt', source: { bytes } }), { type: 'bytes', bytes }],
    [
      new DocumentBlock({
        name: 'notes',
        format: 'txt',
        source: { text: 'text\u0007' },
        context: '',
        citations: { enabled: true },
      }),
      { type: 'text', text: 'text' },
    ],
    [
      new DocumentBlock({
        name: 'notes',
        format: 'txt',
        source: { content: [{ text: 'one\u0007' }, { text: 'two' }] },
      }),
      { type: 'content', content: ['one', 'two'] },
    ],
    [new DocumentBlock({ name: 'notes', format: 'txt', source: { location: s3Location } }), s3],
  ])('preserves live/restored %s sources and ownership', (block, source) => {
    const content = projectMediaContent(block)!
    const toolUse = new ToolUseBlock({ toolUseId: 'read-1', name: 'read', input: { path: 'file' } })
    const result = new ToolResultBlock({
      toolUseId: toolUse.toolUseId,
      status: 'success',
      content: [new TextBlock('read\u0007'), new JsonBlock({ json: { key: 'value\u0007' } }), block],
    })
    const restored = projectMessages([
      new Message({ role: 'user', content: [new TextBlock('inspect')] }),
      new Message({ role: 'assistant', content: [toolUse, block] }),
      new Message({ role: 'user', content: [result] }),
    ])[0]!
    const projector = new TurnProjector(restored.id, 'inspect')
    projector.handle({ type: 'toolStart', toolUseId: toolUse.toolUseId, name: toolUse.name, input: toolUse.input })
    projector.handle({ type: 'media', content })
    projector.handle({
      type: 'toolResult',
      toolUseId: result.toolUseId,
      status: result.status,
      content: result.content.map(projectToolResultContent),
    })
    const snapshot = projector.snapshot()

    expect(snapshot.entries).toEqual(restored.entries)
    expect(content.source).toEqual(source)
    expect(snapshot.entries[0]).toMatchObject({
      result: [{ type: 'text', text: 'read' }, { type: 'json', value: { key: 'value' } }, { source }],
    })
    if (block.type === 'documentBlock') {
      expect(content).toMatchObject({
        name: 'notes',
        ...(block.context !== undefined ? { context: block.context } : {}),
        ...(block.citations ? { citations: block.citations } : {}),
      })
    }
    const live = snapshot.entries[1]
    const restoredMedia = restored.entries[1]
    const repeated = projector.snapshot().entries[1]
    if (content.source.type === 'bytes') {
      expect(content.source.bytes).not.toBe(bytes)
      if (
        live?.type !== 'media' ||
        restoredMedia?.type !== 'media' ||
        repeated?.type !== 'media' ||
        live.content.source.type !== 'bytes' ||
        restoredMedia.content.source.type !== 'bytes' ||
        repeated.content.source.type !== 'bytes'
      ) {
        throw new Error('Expected byte media in both transcripts.')
      }
      expect(restoredMedia.content.source.bytes).not.toBe(bytes)
      expect(live.content.source.bytes).not.toBe(content.source.bytes)
      expect(repeated.content.source.bytes).toBe(live.content.source.bytes)
      content.source.bytes[0] = 9
      expect(live.content.source.bytes).toEqual(bytes)
      expect(restoredMedia.content.source.bytes).toEqual(bytes)
    }
  })
})

describe('terminal media', () => {
  it('expands document preview tabs before terminal layout without changing the document', () => {
    const content = {
      type: 'document' as const,
      name: 'table',
      format: 'txt' as const,
      source: { type: 'text' as const, text: 'item\tvalue' },
    }
    const rendered = renderToString(createElement(MediaView, { content }), { columns: 40 })
    expect(rendered).toContain('item    value')
    expect(rendered).not.toContain('\t')
    expect(content.source.text).toBe('item\tvalue')
  })
})
