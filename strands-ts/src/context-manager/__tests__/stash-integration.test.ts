import { describe, it, expect } from 'vitest'
import { Offload } from '../strategies/offload/index.js'
import { offloadPlaceholder } from '../placeholder.js'
import { repairAlternation } from '../message-trimming.js'
import { Stash } from '../stash.js'
import { ContextManager } from '../context-manager.js'
import { createRetrievalTool, RETRIEVAL_TOOL_NAME } from '../retrieval-tool.js'
import { PluginRegistry } from '../../plugins/registry.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import { DocumentBlock, ImageBlock } from '../../types/media.js'
import { createMockAgent } from '../../__fixtures__/agent-helpers.js'
import { makeContext, makeToolResultMessage } from '../../__fixtures__/context-manager-helpers.js'
import type { Tool } from '../../tools/tool.js'

function invokeRetrievalTool(retrievalTool: Tool, input: unknown): Promise<unknown> {
  return (retrievalTool as unknown as { invoke(input: unknown): Promise<unknown> }).invoke(input)
}

async function stashAll(stash: Stash, messages: Message[]): Promise<void> {
  for (const message of messages) await stash.storeMessage(message)
}

describe('ContextManager tool registration', () => {
  it('registers retrieve_context after plugin initialization', async () => {
    const contextManager = new ContextManager()
    const registry = new PluginRegistry([contextManager])
    const agent = createMockAgent()

    await registry.initialize(agent)

    expect(agent.toolRegistry.get(RETRIEVAL_TOOL_NAME)).toBeDefined()
  })

  it('does not register retrieve_context when stash is disabled', async () => {
    const contextManager = new ContextManager({ stash: false })
    const registry = new PluginRegistry([contextManager])
    const agent = createMockAgent()

    await registry.initialize(agent)

    expect(agent.toolRegistry.get(RETRIEVAL_TOOL_NAME)).toBeUndefined()
  })

  it('backfills stash from pre-existing messages at init', async () => {
    const largeText = 'restored content '.repeat(500)
    const messages = [makeToolResultMessage(largeText)]
    const contextManager = new ContextManager()
    const registry = new PluginRegistry([contextManager])
    const agent = createMockAgent({ messages })

    await registry.initialize(agent)

    const stash = contextManager.stash!
    const keys = await stash.list()
    expect(keys.length).toBe(1)
    const retrieved = await stash.retrieve(keys[0]!)
    expect((retrieved!.data as { text: string }).text).toBe(largeText)
  })
})

describe('Offload strategies with stash', () => {
  describe('truncate + stash', () => {
    it('resolves the reference of a block that a history edit moved into another message', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const big = 'x'.repeat(20000)
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('q')], trackingId: 'u0' }),
        new Message({ role: 'assistant', content: [new TextBlock('short')], trackingId: 'a1' }),
        new Message({ role: 'assistant', content: [new TextBlock(big)], trackingId: 'a2' }),
      ]
      await stashAll(stash, messages)
      // Merges a2 into a1: the big block is now a1_1, while it was stored on arrival as a2_0.
      repairAlternation(messages)

      await Offload.truncate('assistantText', { previewTokens: 10 }).apply(makeContext(messages, { stash }))

      const placeholder = messages[1]!.content[1] as TextBlock
      expect((placeholder as TextBlock).metadata?.offloaded).toBeDefined()
      expect(placeholder.metadata!.offloaded!.ref).toBe('a1_1')
      const retrieve = createRetrievalTool(stash)
      expect(await invokeRetrievalTool(retrieve, { reference: 'a1_1' })).toEqual(new TextBlock(big))
    })

    it('persists original content to stash before truncating', async () => {
      const storage = new InMemoryStorage()
      const stash = new Stash(storage, 'test-session', 'test-agent')
      const largeText = 'important data '.repeat(1000)
      const messages = [makeToolResultMessage(largeText)]
      await stashAll(stash, messages)
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages, { stash })

      const acted = await strategy.apply(context)

      expect(acted).toBe(true)

      const keys = await stash.list()
      expect(keys.length).toBe(1)

      const retrieved = await stash.retrieve(keys[0]!)
      expect(retrieved).not.toBeNull()
      expect((retrieved!.data as { text: string }).text).toBe(largeText)
    })

    it('leaves an OffloadedBlock referencing the tool result in the truncated preview', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const largeText = 'x'.repeat(20000)
      const messages = [makeToolResultMessage(largeText)]
      await stashAll(stash, messages)
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages, { stash })

      await strategy.apply(context)

      const block = messages[0]!.content[0] as ToolResultBlock
      const placeholder = block.content[0] as TextBlock
      const { preview } = placeholder.metadata!.offloaded!
      expect(placeholder).toEqual(offloadPlaceholder('truncate', preview, 'tool-123'))
    })

    it('never stores a seeded placeholder under the original key when a strategy acts on it', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const seeded = new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'tool-123',
            status: 'success',
            content: [offloadPlaceholder('truncate', '[Truncated: 1 block, ~7,500 tokens] preview', 'tool-123')],
          }),
        ],
      })
      const messages = [seeded]
      await stashAll(stash, messages)

      await Offload.drop('toolResults').apply(makeContext(messages, { stash }))

      expect((messages[0]!.content[0] as ToolResultBlock).content).toEqual([
        offloadPlaceholder('drop', '[Dropped: ~15 tokens]', 'tool-123'),
      ])
      expect(await stash.list()).toStrictEqual([])
      expect(await invokeRetrievalTool(createRetrievalTool(stash), { reference: 'tool-123' })).toBe(
        'Error: reference not found: tool-123. Pass only the <id> from the placeholder\'s "[ref: <id>]".'
      )
    })

    it('lets a later strategy act on an already truncated result and keeps its reference resolvable', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const original = 'x'.repeat(20000)
      const messages = [makeToolResultMessage(original)]
      await stashAll(stash, messages)
      const context = makeContext(messages, { stash })
      await Offload.truncate('toolResults', { previewTokens: 10 }).apply(context)

      const actedAgain = await Offload.drop('toolResults').apply(context)

      expect(actedAgain).toBe(true)
      expect((messages[0]!.content[0] as ToolResultBlock).content).toEqual([
        new TextBlock('[Dropped: ~32 tokens] [ref: tool-123]', {
          metadata: { offloaded: { method: 'drop', ref: 'tool-123', preview: '[Dropped: ~32 tokens]' } },
        }),
      ])
      expect(await invokeRetrievalTool(createRetrievalTool(stash), { reference: 'tool-123' })).toEqual(
        new TextBlock(original)
      )
    })

    it('leaves a placeholder without a reference when no stash is configured', async () => {
      const largeText = 'x'.repeat(20000)
      const messages = [makeToolResultMessage(largeText)]
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages)

      await strategy.apply(context)

      const placeholder = (messages[0]!.content[0] as ToolResultBlock).content[0] as TextBlock
      expect((placeholder as TextBlock).metadata?.offloaded).toBeDefined()
      expect(placeholder.metadata!.offloaded!.ref).toBeUndefined()
      expect(placeholder.text).toBe(placeholder.metadata!.offloaded!.preview)
    })
  })

  describe('drop + stash', () => {
    it('persists original content before dropping', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const largeText = 'critical information '.repeat(500)
      const messages = [makeToolResultMessage(largeText)]
      await stashAll(stash, messages)
      const strategy = Offload.drop('toolResults')
      const context = makeContext(messages, { stash })

      const acted = await strategy.apply(context)

      expect(acted).toBe(true)

      const keys = await stash.list()
      expect(keys.length).toBe(1)

      const retrieved = await stash.retrieve(keys[0]!)
      expect((retrieved!.data as { text: string }).text).toBe(largeText)
    })

    it('leaves an OffloadedBlock referencing the tool result as the drop marker', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const largeText = 'x'.repeat(20000)
      const messages = [makeToolResultMessage(largeText)]
      await stashAll(stash, messages)
      const strategy = Offload.drop('toolResults')
      const context = makeContext(messages, { stash })

      await strategy.apply(context)

      const block = messages[0]!.content[0] as ToolResultBlock
      expect(block.content).toEqual([
        new TextBlock('[Dropped: ~5,000 tokens] [ref: tool-123]', {
          metadata: { offloaded: { method: 'drop', ref: 'tool-123', preview: '[Dropped: ~5,000 tokens]' } },
        }),
      ])
      expect((block.content[0] as TextBlock).text).toBe('[Dropped: ~5,000 tokens] [ref: tool-123]')
    })

    it('marks removed messages with an OffloadedBlock that retrieves them', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const text = (role: 'user' | 'assistant', content: string, trackingId: string): Message =>
        new Message({ role, content: [new TextBlock(content)], trackingId })
      const first = text('assistant', 'first answer', 'm1')
      const second = text('user', 'second question', 'm2')
      const messages = [text('user', 'start', 'm0'), first, second, text('assistant', 'final', 'm3')]
      await stashAll(stash, messages)
      const strategy = Offload.drop('*').when({ contextUtilization: '50%' })

      const acted = await strategy.apply(makeContext(messages, { stash, utilization: 0.9 }))

      expect(acted).toBe(true)
      const marker = new TextBlock('[Dropped: 2 messages] [ref: removed-m1]', {
        metadata: {
          offloaded: { method: 'drop', ref: 'removed-m1', preview: '[Dropped: 2 messages]', removedMessages: 2 },
        },
      })
      expect(messages.map((message) => message.content)).toEqual([
        [new TextBlock('start')],
        [new TextBlock('final'), marker],
      ])
      const retrieve = createRetrievalTool(stash)
      expect(await invokeRetrievalTool(retrieve, { reference: 'removed-m1' })).toEqual([
        first.toJSON(),
        second.toJSON(),
      ])
      expect(await invokeRetrievalTool(retrieve, { reference: 'removed-m1', pattern: 'second' })).toContain(
        'second question'
      )
    })

    it('leaves a marker without a reference when there is no stash', async () => {
      const messages = [
        makeToolResultMessage('a', 't0'),
        new Message({ role: 'assistant', content: [new TextBlock('mid')] }),
        new Message({ role: 'user', content: [new TextBlock('next')] }),
        new Message({ role: 'assistant', content: [new TextBlock('final')] }),
      ]

      await Offload.drop('*')
        .when({ contextUtilization: '50%' })
        .apply(makeContext(messages, { utilization: 0.9 }))

      expect(messages.at(-1)!.content).toEqual([
        new TextBlock('final'),
        new TextBlock('[Dropped: 2 messages]', {
          metadata: { offloaded: { method: 'drop', preview: '[Dropped: 2 messages]', removedMessages: 2 } },
        }),
      ])
    })
  })

  describe('binary content stashing', () => {
    it('stashes image content from tool results', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-img',
              status: 'success',
              content: [new ImageBlock({ format: 'png', source: { bytes: imageBytes } })],
            }),
          ],
        }),
      ]
      await stashAll(stash, messages)
      const strategy = Offload.drop('toolResults')
      const context = makeContext(messages, { stash })

      const acted = await strategy.apply(context)

      expect(acted).toBe(true)
      const keys = await stash.list()
      expect(keys.length).toBe(1)

      const retrieved = await stash.retrieve(keys[0]!)
      expect(retrieved).not.toBeNull()
      const data = retrieved!.data as { image: { format: string; source: { bytes: string } } }
      expect(data.image.format).toBe('png')
      expect(data.image.source.bytes).toBeDefined()
    })

    it('stashes each block independently when mixed content', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const imageBytes = new Uint8Array([0xff, 0xd8])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-mixed',
              status: 'success',
              content: [
                new TextBlock('description of image'),
                new ImageBlock({ format: 'jpeg', source: { bytes: imageBytes } }),
              ],
            }),
          ],
        }),
      ]
      await stashAll(stash, messages)
      const strategy = Offload.drop('toolResults')
      const context = makeContext(messages, { stash })

      await strategy.apply(context)

      const keys = await stash.list()
      expect(keys.length).toBe(2)

      const entries = await Promise.all(keys.map((key) => stash.retrieve(key)))
      const textEntry = entries.find(
        (entry) => entry && typeof entry.data === 'object' && entry.data !== null && 'text' in entry.data
      )
      const imageEntry = entries.find(
        (entry) => entry && typeof entry.data === 'object' && entry.data !== null && 'image' in entry.data
      )

      expect(textEntry).not.toBeNull()
      expect((textEntry!.data as { text: string }).text).toBe('description of image')

      expect(imageEntry).not.toBeNull()
      expect((imageEntry!.data as { image: { format: string } }).image.format).toBe('jpeg')
    })
  })

  describe('eager stashing via storeMessage', () => {
    it('persists tool result content on message arrival', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const largeText = 'important data '.repeat(500)
      const message = makeToolResultMessage(largeText, 'call-1')

      await stash.storeMessage(message)

      const keys = await stash.list()
      expect(keys.length).toBe(1)
      const retrieved = await stash.retrieve(keys[0]!)
      expect(retrieved).not.toBeNull()
      expect((retrieved!.data as { text: string }).text).toBe(largeText)
    })

    it('persists text blocks from assistant messages on arrival', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const assistantText = 'important analysis '.repeat(200)
      const message = new Message({ role: 'assistant', content: [new TextBlock(assistantText)] })

      await stash.storeMessage(message)

      const keys = await stash.list()
      expect(keys.length).toBe(1)
      const retrieved = await stash.retrieve(keys[0]!)
      expect((retrieved!.data as { text: string }).text).toBe(assistantText)
    })
  })

  describe('media restoration in retrieval', () => {
    it('restores image blocks as ImageBlock instances', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-img',
              status: 'success',
              content: [new ImageBlock({ format: 'png', source: { bytes: imageBytes } })],
            }),
          ],
        }),
      ]
      await stashAll(stash, messages)

      const retrievalTool = createRetrievalTool(stash)
      const keys = await stash.list()
      const result = await invokeRetrievalTool(retrievalTool, { reference: keys[0]! })

      expect(result).toBeInstanceOf(ImageBlock)
      expect((result as ImageBlock).format).toBe('png')
    })

    it('returns text content normally (not treated as media)', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const messages = [makeToolResultMessage('hello world')]
      await stashAll(stash, messages)

      const retrievalTool = createRetrievalTool(stash)
      const keys = await stash.list()
      const result = await invokeRetrievalTool(retrievalTool, { reference: keys[0]! })

      expect(result).toEqual(new TextBlock('hello world'))
    })

    it('restores document blocks as DocumentBlock instances', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const docData = { document: { format: 'pdf', source: { bytes: 'base64encodedcontent' } } }
      await stash.store('tool-doc', 0, new TextEncoder().encode(JSON.stringify(docData)))

      const retrievalTool = createRetrievalTool(stash)
      const keys = await stash.list()
      const result = await invokeRetrievalTool(retrievalTool, { reference: keys[0]! })

      expect(result).toBeInstanceOf(DocumentBlock)
      expect((result as DocumentBlock).format).toBe('pdf')
    })
  })

  describe('retrieval loop prevention', () => {
    it('does not offload retrieve_context tool results when stash is active', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const largeRetrievalResult = 'retrieved content '.repeat(1000)

      const messages = [
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ toolUseId: 'call-1', name: RETRIEVAL_TOOL_NAME, input: {} })],
        }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'call-1',
              status: 'success',
              content: [new TextBlock(largeRetrievalResult)],
            }),
          ],
        }),
      ]
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages, { stash })

      const acted = await strategy.apply(context)

      expect(acted).toBe(false)
      const block = messages[1]!.content[0] as ToolResultBlock
      const text = (block.content[0] as TextBlock).text
      expect(text).toBe(largeRetrievalResult)
    })

    it('offloads retrieve_context results when no stash (stash not configured)', async () => {
      const largeRetrievalResult = 'retrieved content '.repeat(1000)

      const messages = [
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ toolUseId: 'call-1', name: RETRIEVAL_TOOL_NAME, input: {} })],
        }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'call-1',
              status: 'success',
              content: [new TextBlock(largeRetrievalResult)],
            }),
          ],
        }),
      ]
      const strategy = Offload.truncate('toolResults')
      const context = makeContext(messages)

      const acted = await strategy.apply(context)

      expect(acted).toBe(true)
    })
  })
})
