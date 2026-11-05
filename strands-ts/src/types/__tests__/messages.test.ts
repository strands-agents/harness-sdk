import { describe, expect, test, it } from 'vitest'
import {
  Message,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ReasoningBlock,
  CachePointBlock,
  GuardContentBlock,
  JsonBlock,
  generateTrackingId,
  type MessageData,
  type SystemPromptData,
  systemPromptFromData,
  systemPromptToData,
} from '../messages.js'
import { AudioBlock, ImageBlock, VideoBlock, DocumentBlock, encodeBase64 } from '../media.js'
import { CitationsBlock } from '../citations.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'

describe('Message', () => {
  test('creates message with role and content', () => {
    const content = [new TextBlock('test')]
    const message = new Message({ role: 'user', content })

    expect(message).toEqual({
      type: 'message',
      role: 'user',
      content,
      trackingId: anyTrackingId,
    })
  })
})

describe('Message metadata', () => {
  test('creates message without metadata', () => {
    const message = new Message({ role: 'user', content: [new TextBlock('test')] })
    expect(message.metadata).toBeUndefined()
  })

  test('creates message with metadata', () => {
    const metadata = {
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      metrics: { latencyMs: 100 },
    }
    const message = new Message({ role: 'assistant', content: [new TextBlock('hello')], metadata })
    expect(message.metadata).toStrictEqual(metadata)
  })

  test('creates message with custom metadata', () => {
    const metadata = {
      custom: { source: 'summarization', originalTurns: [5, 6, 7] },
    }
    const message = new Message({ role: 'assistant', content: [new TextBlock('summary')], metadata })
    expect(message.metadata).toStrictEqual(metadata)
  })

  test('toJSON includes metadata when present', () => {
    const metadata = {
      usage: { inputTokens: 42, outputTokens: 10, totalTokens: 52 },
      metrics: { latencyMs: 200 },
    }
    const message = new Message({ role: 'assistant', content: [new TextBlock('test')], metadata })
    const json = message.toJSON()
    expect(json.metadata).toStrictEqual(metadata)
  })

  test('toJSON omits metadata when not present', () => {
    const message = new Message({ role: 'user', content: [new TextBlock('test')] })
    const json = message.toJSON()
    expect('metadata' in json).toBe(false)
  })

  test('fromMessageData preserves metadata', () => {
    const data: MessageData = {
      role: 'assistant',
      content: [{ text: 'hello' }],
      metadata: {
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        metrics: { latencyMs: 100 },
      },
    }
    const message = Message.fromMessageData(data)
    expect(message.metadata).toStrictEqual(data.metadata)
  })

  test('fromMessageData works without metadata', () => {
    const data: MessageData = {
      role: 'user',
      content: [{ text: 'hello' }],
    }
    const message = Message.fromMessageData(data)
    expect(message.metadata).toBeUndefined()
  })

  test('round-trips metadata through toJSON/fromJSON', () => {
    const metadata = {
      usage: { inputTokens: 42, outputTokens: 10, totalTokens: 52 },
      metrics: { latencyMs: 200 },
      custom: { source: 'test' },
    }
    const original = new Message({ role: 'assistant', content: [new TextBlock('test')], metadata })
    const restored = Message.fromJSON(original.toJSON())
    expect(restored.metadata).toStrictEqual(metadata)
  })

  test('round-trips metadata through JSON.stringify/parse', () => {
    const metadata = {
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }
    const original = new Message({ role: 'assistant', content: [new TextBlock('test')], metadata })
    const jsonString = JSON.stringify(original)
    const restored = Message.fromJSON(JSON.parse(jsonString))
    expect(restored.metadata).toStrictEqual(metadata)
  })
})

describe('Message id', () => {
  test('constructor mints a UUID tracking id by default', () => {
    const message = new Message({ role: 'user', content: [new TextBlock('test')] })
    expect(message.trackingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('two messages get distinct tracking ids', () => {
    const a = new Message({ role: 'user', content: [new TextBlock('test')] })
    const b = new Message({ role: 'user', content: [new TextBlock('test')] })
    expect(a.trackingId).not.toBe(b.trackingId)
  })

  test('constructor preserves an explicit id', () => {
    const message = new Message({ role: 'user', content: [new TextBlock('test')], trackingId: 'abc123' })
    expect(message.trackingId).toBe('abc123')
  })

  test('constructor mints when given an empty-string id', () => {
    // An empty id cannot serve as a durable key, so it is treated as absent and replaced.
    const message = new Message({ role: 'user', content: [new TextBlock('test')], trackingId: '' })
    expect(message.trackingId).toBeTruthy()
  })

  test('generateTrackingId produces unique strings', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateTrackingId()))
    expect(ids.size).toBe(1000)
  })

  test('toJSON includes the tracking id', () => {
    const message = new Message({ role: 'assistant', content: [new TextBlock('test')], trackingId: 'abc123' })
    expect(message.toJSON().trackingId).toBe('abc123')
  })

  test('fromMessageData preserves id', () => {
    const data: MessageData = { role: 'assistant', content: [{ text: 'hello' }], trackingId: 'abc123' }
    expect(Message.fromMessageData(data).trackingId).toBe('abc123')
  })

  test('fromMessageData backfills a tracking id when serialized data omits it', () => {
    const data: MessageData = { role: 'assistant', content: [{ text: 'hello' }] }
    expect(Message.fromMessageData(data).trackingId).toBeTruthy()
  })

  test('round-trips id through toJSON/fromJSON', () => {
    const original = new Message({ role: 'assistant', content: [new TextBlock('test')], trackingId: 'durable-1' })
    expect(Message.fromJSON(original.toJSON()).trackingId).toBe('durable-1')
  })

  test('clone preserves id', () => {
    const original = new Message({ role: 'assistant', content: [new TextBlock('test')], trackingId: 'durable-1' })
    expect(original.clone().trackingId).toBe('durable-1')
  })
})

describe('TextBlock', () => {
  test('creates text block with text', () => {
    const block = new TextBlock('hello')

    expect(block).toEqual({
      type: 'textBlock',
      text: 'hello',
    })
  })
})

describe('ToolUseBlock', () => {
  test('creates tool use block', () => {
    const block = new ToolUseBlock({
      name: 'test-tool',
      toolUseId: '123',
      input: { param: 'value' },
    })

    expect(block).toEqual({
      type: 'toolUseBlock',
      name: 'test-tool',
      toolUseId: '123',
      input: { param: 'value' },
    })
  })
})

describe('ToolResultBlock', () => {
  test('creates tool result block', () => {
    const block = new ToolResultBlock({
      toolUseId: '123',
      status: 'success',
      content: [new TextBlock('result')],
    })

    expect(block).toEqual({
      type: 'toolResultBlock',
      toolUseId: '123',
      status: 'success',
      content: [new TextBlock('result')],
    })
  })
})

describe('ReasoningBlock', () => {
  test('creates reasoning block with text', () => {
    const block = new ReasoningBlock({ text: 'thinking...' })

    expect(block).toEqual({
      type: 'reasoningBlock',
      text: 'thinking...',
    })
  })
})

describe('CachePointBlock', () => {
  test('creates cache point block', () => {
    const block = new CachePointBlock({ cacheType: 'default' })

    expect(block).toEqual({
      type: 'cachePointBlock',
      cacheType: 'default',
    })
  })

  test('creates cache point block with ttl', () => {
    const block = new CachePointBlock({ cacheType: 'default', ttl: '1h' })

    expect(block).toEqual({
      type: 'cachePointBlock',
      cacheType: 'default',
      ttl: '1h',
    })
  })

  test('serializes ttl in toJSON', () => {
    const block = new CachePointBlock({ cacheType: 'default', ttl: '5m' })

    expect(block.toJSON()).toEqual({
      cachePoint: { cacheType: 'default', ttl: '5m' },
    })
  })

  test('omits ttl in toJSON when not set', () => {
    const block = new CachePointBlock({ cacheType: 'default' })

    expect(block.toJSON()).toEqual({
      cachePoint: { cacheType: 'default' },
    })
  })

  test('roundtrips ttl via fromJSON', () => {
    const block = CachePointBlock.fromJSON({ cachePoint: { cacheType: 'default', ttl: '1h' } })

    expect(block).toEqual({
      type: 'cachePointBlock',
      cacheType: 'default',
      ttl: '1h',
    })
  })
})

describe('JsonBlock', () => {
  test('creates json block', () => {
    const block = new JsonBlock({ json: { key: 'value' } })

    expect(block).toEqual({
      type: 'jsonBlock',
      json: { key: 'value' },
    })
  })
})

describe('Message.fromMessageData', () => {
  it('converts text block data to TextBlock', () => {
    const messageData: MessageData = {
      role: 'user',
      content: [{ text: 'hello world' }],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toHaveLength(1)
    expect(message.content[0]).toEqual(new TextBlock('hello world'))
  })

  it('converts tool use block data to ToolUseBlock', () => {
    const messageData: MessageData = {
      role: 'assistant',
      content: [
        {
          toolUse: {
            toolUseId: 'tool-123',
            name: 'test-tool',
            input: { key: 'value' },
          },
        },
      ],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toHaveLength(1)
    expect(message.content[0]).toBeInstanceOf(ToolUseBlock)
    expect(message.content[0]!.type).toBe('toolUseBlock')
  })

  it('converts tool result block data to ToolResultBlock with text content', () => {
    const messageData: MessageData = {
      role: 'user',
      content: [
        {
          toolResult: {
            toolUseId: 'tool-123',
            status: 'success',
            content: [{ text: 'result text' }],
          },
        },
      ],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toHaveLength(1)
    expect(message.content[0]).toBeInstanceOf(ToolResultBlock)
    const toolResultBlock = message.content[0] as ToolResultBlock
    expect(toolResultBlock.content).toHaveLength(1)
    expect(toolResultBlock.content[0]).toBeInstanceOf(TextBlock)
  })

  it('converts tool result block data to ToolResultBlock with json content', () => {
    const messageData: MessageData = {
      role: 'user',
      content: [
        {
          toolResult: {
            toolUseId: 'tool-123',
            status: 'success',
            content: [{ json: { result: 'value' } }],
          },
        },
      ],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toHaveLength(1)
    const toolResultBlock = message.content[0] as ToolResultBlock
    expect(toolResultBlock.content).toHaveLength(1)
    expect(toolResultBlock.content[0]).toBeInstanceOf(JsonBlock)
  })

  it('converts reasoning block data to ReasoningBlock', () => {
    const messageData: MessageData = {
      role: 'assistant',
      content: [
        {
          reasoning: { text: 'thinking about it...' },
        },
      ],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toHaveLength(1)
    expect(message.content[0]).toBeInstanceOf(ReasoningBlock)
    expect(message.content[0]!.type).toBe('reasoningBlock')
  })

  it('converts cache point block data to CachePointBlock', () => {
    const messageData: MessageData = {
      role: 'user',
      content: [
        {
          cachePoint: { cacheType: 'default' },
        },
      ],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toHaveLength(1)
    expect(message.content[0]).toBeInstanceOf(CachePointBlock)
    expect(message.content[0]!.type).toBe('cachePointBlock')
  })

  it('converts guard content block data to GuardContentBlock', () => {
    const messageData: MessageData = {
      role: 'user',
      content: [
        {
          guardContent: {
            text: {
              text: 'guard this content',
              qualifiers: ['guard_content'],
            },
          },
        },
      ],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toHaveLength(1)
    expect(message.content[0]!.type).toBe('guardContentBlock')
  })

  it('converts audio block data to AudioBlock', () => {
    const messageData: MessageData = {
      role: 'user',
      content: [
        {
          audio: {
            format: 'mp3',
            source: { bytes: new Uint8Array([1, 2, 3]) },
          },
        },
      ],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toEqual([
      new AudioBlock({
        format: 'mp3',
        source: { bytes: new Uint8Array([1, 2, 3]) },
      }),
    ])
  })

  it('converts image block data to ImageBlock', () => {
    const messageData: MessageData = {
      role: 'user',
      content: [
        {
          image: {
            format: 'jpeg',
            source: { bytes: new Uint8Array([1, 2, 3]) },
          },
        },
      ],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toHaveLength(1)
    expect(message.content[0]).toBeInstanceOf(ImageBlock)
    expect(message.content[0]!.type).toBe('imageBlock')
  })

  it('converts video block data to VideoBlock', () => {
    const messageData: MessageData = {
      role: 'user',
      content: [
        {
          video: {
            format: 'mp4',
            source: { bytes: new Uint8Array([1, 2, 3]) },
          },
        },
      ],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toHaveLength(1)
    expect(message.content[0]).toBeInstanceOf(VideoBlock)
    expect(message.content[0]!.type).toBe('videoBlock')
  })

  it('converts document block data to DocumentBlock', () => {
    const messageData: MessageData = {
      role: 'user',
      content: [
        {
          document: {
            name: 'test.pdf',
            format: 'pdf',
            source: { bytes: new Uint8Array([1, 2, 3]) },
          },
        },
      ],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toHaveLength(1)
    expect(message.content[0]).toBeInstanceOf(DocumentBlock)
    expect(message.content[0]!.type).toBe('documentBlock')
  })

  it('converts citations content block data to CitationsBlock', () => {
    const messageData: MessageData = {
      role: 'assistant',
      content: [
        {
          citations: {
            citations: [
              {
                location: { type: 'documentChar', documentIndex: 0, start: 10, end: 50 },
                source: 'doc-0',
                sourceContent: [{ text: 'source text' }],
                title: 'Test Doc',
              },
            ],
            content: [{ text: 'generated text' }],
          },
        },
      ],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toHaveLength(1)
    expect(message.content[0]).toBeInstanceOf(CitationsBlock)
    expect(message.content[0]!.type).toBe('citationsBlock')
  })

  it('converts multiple content blocks', () => {
    const messageData: MessageData = {
      role: 'user',
      content: [
        { text: 'first block' },
        { image: { format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } } },
        { text: 'second block' },
      ],
    }
    const message = Message.fromMessageData(messageData)
    expect(message.content).toHaveLength(3)
    expect(message.content[0]).toBeInstanceOf(TextBlock)
    expect(message.content[1]).toBeInstanceOf(ImageBlock)
    expect(message.content[2]).toBeInstanceOf(TextBlock)
  })

  it('throws error for unknown content block type', () => {
    const messageData = {
      role: 'user',
      content: [{ unknownType: { data: 'value' } }],
    } as unknown as MessageData
    expect(() => Message.fromMessageData(messageData)).toThrow('Unknown ContentBlockData type')
  })
})

describe('systemPromptFromData', () => {
  describe('when called with string', () => {
    it('returns the string unchanged', () => {
      const data: SystemPromptData = 'You are a helpful assistant'
      const result = systemPromptFromData(data)
      expect(result).toBe('You are a helpful assistant')
    })
  })

  describe('when called with TextBlockData', () => {
    it('converts to TextBlock', () => {
      const data: SystemPromptData = [{ text: 'System prompt text' }]
      const result = systemPromptFromData(data)
      expect(result).toEqual([new TextBlock('System prompt text')])
    })
  })

  describe('when called with CachePointBlockData', () => {
    it('converts to CachePointBlock', () => {
      const data: SystemPromptData = [{ text: 'prompt' }, { cachePoint: { cacheType: 'default' } }]
      const result = systemPromptFromData(data)
      expect(result).toEqual([new TextBlock('prompt'), new CachePointBlock({ cacheType: 'default' })])
    })
  })

  describe('when called with GuardContentBlockData', () => {
    it('converts to GuardContentBlock', () => {
      const data: SystemPromptData = [
        {
          guardContent: {
            text: {
              text: 'guard this content',
              qualifiers: ['guard_content'],
            },
          },
        },
      ]
      const result = systemPromptFromData(data)
      expect(result).toEqual([
        new GuardContentBlock({
          text: {
            text: 'guard this content',
            qualifiers: ['guard_content'],
          },
        }),
      ])
    })
  })

  describe('when called with mixed content blocks', () => {
    it('converts all block types correctly', () => {
      const data: SystemPromptData = [
        { text: 'First text block' },
        { cachePoint: { cacheType: 'default' } },
        { text: 'Second text block' },
        {
          guardContent: {
            text: {
              text: 'guard content',
              qualifiers: ['guard_content'],
            },
          },
        },
      ]
      const result = systemPromptFromData(data)
      expect(result).toEqual([
        new TextBlock('First text block'),
        new CachePointBlock({ cacheType: 'default' }),
        new TextBlock('Second text block'),
        new GuardContentBlock({
          text: {
            text: 'guard content',
            qualifiers: ['guard_content'],
          },
        }),
      ])
    })
  })

  describe('when called with empty array', () => {
    it('returns empty array', () => {
      const data: SystemPromptData = []
      const result = systemPromptFromData(data)
      expect(result).toEqual([])
    })
  })

  describe('when called with unknown block type', () => {
    it('throws error', () => {
      const data = [{ unknownType: { data: 'value' } }] as unknown as SystemPromptData
      expect(() => systemPromptFromData(data)).toThrow('Unknown SystemContentBlockData type')
    })
  })

  describe('when called with class instances', () => {
    it('returns them unchanged', () => {
      const systemPrompt = [new TextBlock('prompt'), new CachePointBlock({ cacheType: 'default' })]
      const result = systemPromptFromData(systemPrompt)
      expect(result).toEqual(systemPrompt)
    })
  })
})

describe('systemPromptToData', () => {
  describe('when called with string', () => {
    it('returns the string unchanged', () => {
      const prompt = 'You are a helpful assistant'
      const result = systemPromptToData(prompt)
      expect(result).toBe('You are a helpful assistant')
    })
  })

  describe('when called with TextBlock array', () => {
    it('converts to TextBlockData array', () => {
      const prompt = [new TextBlock('System prompt text')]
      const result = systemPromptToData(prompt)
      expect(result).toEqual([{ text: 'System prompt text' }])
    })
  })

  describe('when called with CachePointBlock array', () => {
    it('converts to CachePointBlockData array', () => {
      const prompt = [new TextBlock('prompt'), new CachePointBlock({ cacheType: 'default' })]
      const result = systemPromptToData(prompt)
      expect(result).toEqual([{ text: 'prompt' }, { cachePoint: { cacheType: 'default' } }])
    })
  })

  describe('when called with GuardContentBlock array', () => {
    it('converts to GuardContentBlockData array', () => {
      const prompt = [
        new GuardContentBlock({
          text: {
            text: 'guard this content',
            qualifiers: ['guard_content'],
          },
        }),
      ]
      const result = systemPromptToData(prompt)
      expect(result).toEqual([
        {
          guardContent: {
            text: {
              text: 'guard this content',
              qualifiers: ['guard_content'],
            },
          },
        },
      ])
    })
  })

  describe('when called with mixed content blocks', () => {
    it('converts all block types correctly', () => {
      const prompt = [
        new TextBlock('First text block'),
        new CachePointBlock({ cacheType: 'default' }),
        new TextBlock('Second text block'),
        new GuardContentBlock({
          text: {
            text: 'guard content',
            qualifiers: ['guard_content'],
          },
        }),
      ]
      const result = systemPromptToData(prompt)
      expect(result).toEqual([
        { text: 'First text block' },
        { cachePoint: { cacheType: 'default' } },
        { text: 'Second text block' },
        {
          guardContent: {
            text: {
              text: 'guard content',
              qualifiers: ['guard_content'],
            },
          },
        },
      ])
    })
  })

  describe('when called with empty array', () => {
    it('returns empty array', () => {
      const prompt: (TextBlock | CachePointBlock | GuardContentBlock)[] = []
      const result = systemPromptToData(prompt)
      expect(result).toEqual([])
    })
  })

  describe('round-trip conversion', () => {
    it('preserves data through toData/fromData cycle', () => {
      const original = [new TextBlock('prompt text'), new CachePointBlock({ cacheType: 'default' })]
      const data = systemPromptToData(original)
      const restored = systemPromptFromData(data)
      expect(restored).toEqual(original)
    })

    it('preserves string through toData/fromData cycle', () => {
      const original = 'Simple string prompt'
      const data = systemPromptToData(original)
      const restored = systemPromptFromData(data)
      expect(restored).toBe(original)
    })
  })
})

describe('toJSON/fromJSON round-trips', () => {
  // prettier-ignore
  const roundTripCases = [
    ['TextBlock',                              () => new TextBlock('Hello world')],
    ['ToolUseBlock without reasoningSignature',() => new ToolUseBlock({ name: 'test-tool', toolUseId: '123', input: { param: 'value' } })],
    ['ToolUseBlock with reasoningSignature',   () => new ToolUseBlock({ name: 'test-tool', toolUseId: '123', input: { param: 'value' }, reasoningSignature: 'sig123' })],
    ['ToolResultBlock with text content',      () => new ToolResultBlock({ toolUseId: '123', status: 'success', content: [new TextBlock('Result text')] })],
    ['ToolResultBlock with json content',      () => new ToolResultBlock({ toolUseId: '456', status: 'success', content: [new JsonBlock({ json: { result: 'data' } })] })],
    ['ToolResultBlock with error status',      () => new ToolResultBlock({ toolUseId: '789', status: 'error', content: [new TextBlock('Error message')] })],
    ['ReasoningBlock with text only',          () => new ReasoningBlock({ text: 'Thinking...' })],
    ['ReasoningBlock with signature',          () => new ReasoningBlock({ text: 'Thinking...', signature: 'sig123' })],
    ['ReasoningBlock with redactedContent',    () => new ReasoningBlock({ redactedContent: new Uint8Array([1, 2, 3]) })],
    ['CachePointBlock',                        () => new CachePointBlock({ cacheType: 'default' })],
    ['JsonBlock',                              () => new JsonBlock({ json: { key: 'value', nested: { a: 1 } } })],
    ['GuardContentBlock with text',            () => new GuardContentBlock({ text: { text: 'Guard this', qualifiers: ['guard_content'] } })],
    ['GuardContentBlock with image',           () => new GuardContentBlock({ image: { format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } } })],
    ['AudioBlock',                             () => new AudioBlock({ format: 'mp3', source: { bytes: new Uint8Array([1, 2, 3]) } })],
    ['Message with text content',              () => new Message({ role: 'user', content: [new TextBlock('Hello')] })],
    ['Message with multiple content blocks',   () => new Message({ role: 'assistant', content: [new TextBlock('Here is the result'), new ToolUseBlock({ name: 'test-tool', toolUseId: '123', input: { key: 'value' } })] })],
    ['Message with image content',             () => new Message({ role: 'user', content: [new TextBlock('Check this image'), new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } })] })],
    ['CitationsBlock',                         () => new CitationsBlock({ citations: [{ location: { type: 'documentChar', documentIndex: 0, start: 0, end: 10 }, source: 'doc-0', sourceContent: [{ text: 'source' }], title: 'Test' }], content: [{ text: 'generated' }] })],
  ] as const

  it.each(roundTripCases)('%s', (_name, createBlock) => {
    const original = createBlock()
    // Use duck-typing here
    const BlockClass = original.constructor as unknown as { fromJSON(json: unknown): unknown }
    const restored = BlockClass.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('Message works with JSON.stringify', () => {
    const original = new Message({ role: 'user', content: [new TextBlock('Test')] })
    const jsonString = JSON.stringify(original)
    const restored = Message.fromJSON(JSON.parse(jsonString))
    expect(restored).toEqual(original)
  })
})

describe('fromJSON with serialized (base64 string) input', () => {
  it('ReasoningBlock.fromJSON accepts base64 string for redactedContent', () => {
    const originalBytes = new Uint8Array([1, 2, 3, 4, 5])
    const base64String = encodeBase64(originalBytes)
    const block = ReasoningBlock.fromJSON({
      reasoning: { redactedContent: base64String },
    })
    expect(block.redactedContent).toEqual(originalBytes)
  })

  it('GuardContentBlock.fromJSON accepts base64 string for image bytes', () => {
    const originalBytes = new Uint8Array([10, 20, 30])
    const base64String = encodeBase64(originalBytes)
    const block = GuardContentBlock.fromJSON({
      guardContent: {
        image: { format: 'png', source: { bytes: base64String } },
      },
    })
    expect(block.image?.source.bytes).toEqual(originalBytes)
  })
})

describe('toJSON format', () => {
  it('TextBlock returns unwrapped format', () => {
    const block = new TextBlock('Test')
    expect(block.toJSON()).toStrictEqual({ text: 'Test' })
  })

  it('JsonBlock returns unwrapped format', () => {
    const block = new JsonBlock({ json: { test: true } })
    expect(block.toJSON()).toStrictEqual({ json: { test: true } })
  })

  it('ToolUseBlock omits undefined reasoningSignature', () => {
    const block = new ToolUseBlock({ name: 'test-tool', toolUseId: '123', input: {} })
    expect('reasoningSignature' in block.toJSON().toolUse).toBe(false)
  })

  it('ToolResultBlock does not serialize error field', () => {
    const block = new ToolResultBlock({
      toolUseId: '123',
      status: 'error',
      content: [new TextBlock('Error')],
      error: new Error('Test error'),
    })
    expect('error' in block.toJSON().toolResult).toBe(false)
  })

  it('ReasoningBlock encodes redactedContent as base64', () => {
    const block = new ReasoningBlock({ redactedContent: new Uint8Array([1, 2, 3]) })
    expect(typeof block.toJSON().reasoning.redactedContent).toBe('string')
  })

  it('ReasoningBlock omits undefined fields', () => {
    const block = new ReasoningBlock({ text: 'Test' })
    const json = block.toJSON()
    expect('signature' in json.reasoning).toBe(false)
    expect('redactedContent' in json.reasoning).toBe(false)
  })

  it('GuardContentBlock encodes image bytes as base64', () => {
    const block = new GuardContentBlock({
      image: { format: 'jpeg', source: { bytes: new Uint8Array([1, 2, 3]) } },
    })
    expect(typeof block.toJSON().guardContent.image?.source.bytes).toBe('string')
  })
})
