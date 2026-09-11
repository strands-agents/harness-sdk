import { describe, it, expect, vi } from 'vitest'
import { ContextOffloader } from '../plugin.js'
import { InMemoryStorage } from '../storage.js'
import { AfterToolCallEvent, BeforeModelCallEvent } from '../../../hooks/events.js'
import { TextBlock, JsonBlock, ToolResultBlock } from '../../../types/messages.js'
import type { JSONValue } from '../../../types/json.js'
import { ImageBlock, VideoBlock, DocumentBlock } from '../../../types/media.js'
import { createMockAgent, invokeTrackedHook } from '../../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { AgentMetrics } from '../../../telemetry/meter.js'

const mockModel = new MockMessageModel()

function makeMockAgent() {
  return createMockAgent({ extra: { model: mockModel } as never })
}

function makeEvent(
  content: InstanceType<
    typeof TextBlock | typeof JsonBlock | typeof ImageBlock | typeof VideoBlock | typeof DocumentBlock
  >[],
  overrides?: { status?: 'success' | 'error'; toolName?: string; structuredContent?: JSONValue }
) {
  const agent = makeMockAgent()
  const result = new ToolResultBlock({
    toolUseId: 'tool-123',
    status: overrides?.status ?? 'success',
    content,
    ...(overrides !== undefined && 'structuredContent' in overrides
      ? { structuredContent: overrides.structuredContent }
      : {}),
  })
  return new AfterToolCallEvent({
    agent,
    toolUse: { name: overrides?.toolName ?? 'some_tool', toolUseId: 'tool-123', input: {} },
    tool: undefined,
    result,
    invocationState: {},
  })
}

describe('ContextOffloader', () => {
  describe('constructor validation', () => {
    it('throws if maxResultTokens is not positive', () => {
      expect(() => new ContextOffloader({ storage: new InMemoryStorage(), maxResultTokens: 0 })).toThrow(
        'maxResultTokens must be positive'
      )
    })

    it('throws if previewTokens is negative', () => {
      expect(() => new ContextOffloader({ storage: new InMemoryStorage(), previewTokens: -1 })).toThrow(
        'previewTokens must be non-negative'
      )
    })

    it('throws if previewTokens >= maxResultTokens', () => {
      expect(
        () => new ContextOffloader({ storage: new InMemoryStorage(), maxResultTokens: 100, previewTokens: 100 })
      ).toThrow('previewTokens must be less than maxResultTokens')
    })
  })

  describe('plugin interface', () => {
    it('has correct name', () => {
      const plugin = new ContextOffloader({ storage: new InMemoryStorage() })
      expect(plugin.name).toBe('strands:context-offloader')
    })

    it('registers hooks', () => {
      const plugin = new ContextOffloader({ storage: new InMemoryStorage() })
      const agent = createMockAgent()
      plugin.initAgent(agent)
      expect(agent.trackedHooks).toHaveLength(2)
      const eventTypes = agent.trackedHooks.map((h) => h.eventType)
      expect(eventTypes).toContain(AfterToolCallEvent)
      expect(eventTypes).toContain(BeforeModelCallEvent)
    })

    it('returns retrieval tool by default', () => {
      const plugin = new ContextOffloader({ storage: new InMemoryStorage() })
      const tools = plugin.getTools()
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('retrieve_offloaded_content')
    })

    it('returns empty tools when includeRetrievalTool is false', () => {
      const plugin = new ContextOffloader({ storage: new InMemoryStorage(), includeRetrievalTool: false })
      expect(plugin.getTools()).toHaveLength(0)
    })
  })

  describe('hook behavior', () => {
    it('does not offload results below threshold', async () => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({ storage, maxResultTokens: 2500 })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const event = makeEvent([new TextBlock('short text')])
      await invokeTrackedHook(agent, event)

      expect(event.result.content).toHaveLength(1)
      expect(event.result.content[0]).toBeInstanceOf(TextBlock)
      expect((event.result.content[0] as TextBlock).text).toBe('short text')
    })

    it('does not offload error results', async () => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({ storage, maxResultTokens: 10, previewTokens: 5 })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const event = makeEvent([new TextBlock('x'.repeat(1000))], { status: 'error' })
      await invokeTrackedHook(agent, event)

      expect((event.result.content[0] as TextBlock).text).toBe('x'.repeat(1000))
    })

    it('does not offload retrieval tool results', async () => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({
        storage,
        maxResultTokens: 10,
        previewTokens: 5,
        includeRetrievalTool: true,
      })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const event = makeEvent([new TextBlock('x'.repeat(1000))], { toolName: 'retrieve_offloaded_content' })
      await invokeTrackedHook(agent, event)

      expect((event.result.content[0] as TextBlock).text).toBe('x'.repeat(1000))
    })

    it('offloads large text results', async () => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({ storage, maxResultTokens: 100, previewTokens: 10 })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const largeText = 'a'.repeat(2000)
      const event = makeEvent([new TextBlock(largeText)])
      await invokeTrackedHook(agent, event)

      expect(event.result.content).toHaveLength(1)
      const preview = (event.result.content[0] as TextBlock).text
      expect(preview).toContain('[Offloaded:')
      expect(preview).toContain('Tool result was offloaded')
      expect(preview).toContain('[Stored references:]')
      expect(preview).not.toContain(largeText)
    })

    it.each([
      ['object', { temperature: 72 }],
      ['zero', 0],
      ['empty string', ''],
      ['false', false],
      ['null', null],
    ])('preserves %s structuredContent when offloading', async (_label, structuredContent) => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({ storage, maxResultTokens: 100, previewTokens: 10 })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const event = makeEvent([new TextBlock('a'.repeat(2000))], { structuredContent })
      await invokeTrackedHook(agent, event)

      expect((event.result.content[0] as TextBlock).text).toContain('[Offloaded:')
      expect(event.result.structuredContent).toEqual(structuredContent)
    })

    it('offloads large JSON results', async () => {
      const storage = new InMemoryStorage()
      // JSON uses chars/2 heuristic, so 1000 chars of JSON ≈ 500 tokens
      const plugin = new ContextOffloader({ storage, maxResultTokens: 10, previewTokens: 5 })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const largeJson = { data: 'x'.repeat(1000) }
      const event = makeEvent([new JsonBlock({ json: largeJson })])
      await invokeTrackedHook(agent, event)

      const preview = (event.result.content[0] as TextBlock).text
      expect(preview).toContain('[Offloaded:')
      expect(preview).toContain('json,')
    })

    it('offloads image blocks with placeholder', async () => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({ storage, maxResultTokens: 10, previewTokens: 5 })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const imgBytes = new Uint8Array(10000)
      const event = makeEvent([
        new TextBlock('x'.repeat(1000)),
        new ImageBlock({ format: 'png', source: { bytes: imgBytes } }),
      ])
      await invokeTrackedHook(agent, event)

      const imageBlock = event.result.content.find((b) => b instanceof TextBlock && b.text.includes('[image:'))
      expect(imageBlock).toBeDefined()
      expect((imageBlock as TextBlock).text).toContain('[image: png,')
      expect((imageBlock as TextBlock).text).toContain('ref:')
    })

    it('offloads document blocks with placeholder', async () => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({ storage, maxResultTokens: 10, previewTokens: 5 })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const docBytes = new Uint8Array(10000)
      const event = makeEvent([
        new TextBlock('x'.repeat(1000)),
        new DocumentBlock({ format: 'pdf', name: 'report.pdf', source: { bytes: docBytes } }),
      ])
      await invokeTrackedHook(agent, event)

      const docBlock = event.result.content.find((b) => b instanceof TextBlock && b.text.includes('[document:'))
      expect(docBlock).toBeDefined()
      expect((docBlock as TextBlock).text).toContain('[document: pdf, report.pdf,')
      expect((docBlock as TextBlock).text).toContain('ref:')
    })

    it('preserves original result on storage failure', async () => {
      const failingStorage: InMemoryStorage = new InMemoryStorage()
      vi.spyOn(failingStorage, 'store').mockImplementation(() => {
        throw new Error('storage down')
      })

      const plugin = new ContextOffloader({ storage: failingStorage, maxResultTokens: 10, previewTokens: 5 })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const event = makeEvent([new TextBlock('x'.repeat(1000))])
      const originalResult = event.result
      await invokeTrackedHook(agent, event)

      expect(event.result).toBe(originalResult)
    })

    it('includes retrieval tool guidance when enabled', async () => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({
        storage,
        maxResultTokens: 10,
        previewTokens: 5,
        includeRetrievalTool: true,
      })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const event = makeEvent([new TextBlock('x'.repeat(1000))])
      await invokeTrackedHook(agent, event)

      const preview = (event.result.content[0] as TextBlock).text
      expect(preview).toContain('retrieve_offloaded_content')
      expect(preview).toContain('pattern')
      expect(preview).toContain('line_range')
    })

    it('respects custom previewTokens', async () => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({ storage, maxResultTokens: 10, previewTokens: 2 })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const event = makeEvent([new TextBlock('a'.repeat(1000))])
      await invokeTrackedHook(agent, event)

      const preview = (event.result.content[0] as TextBlock).text
      const previewSection = preview.split('[Stored references:]')[0]
      // previewTokens=2 → 2*4=8 chars of 'a' in preview
      expect(previewSection).toContain('a'.repeat(8))
      expect(previewSection).not.toContain('a'.repeat(100))
    })

    it('stores and retrieves content round-trip', async () => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({
        storage,
        maxResultTokens: 10,
        previewTokens: 5,
        includeRetrievalTool: true,
      })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const event = makeEvent([new TextBlock('hello world '.repeat(100))])
      await invokeTrackedHook(agent, event)

      const preview = (event.result.content[0] as TextBlock).text
      const refMatch = preview.match(/mem_\d+_tool-123_0/)
      expect(refMatch).not.toBeNull()

      const retrieved = await storage.retrieve(refMatch![0])
      expect(new TextDecoder().decode(retrieved.content)).toBe('hello world '.repeat(100))
    })
  })

  describe('retrieval tool', () => {
    it('retrieves text content as string', async () => {
      const storage = new InMemoryStorage()
      const ref = await storage.store('k1', new TextEncoder().encode('hello'), 'text/plain')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const tools = plugin.getTools()
      const retrievalTool = tools[0]!
      const result = await (retrievalTool as unknown as { invoke(input: unknown): Promise<unknown> }).invoke({
        reference: ref,
      })
      expect(result).toBe('hello')
    })

    it('retrieves JSON content as parsed object', async () => {
      const storage = new InMemoryStorage()
      const ref = await storage.store('k1', new TextEncoder().encode('{"foo":"bar"}'), 'application/json')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const tools = plugin.getTools()
      const retrievalTool = tools[0]!
      const result = await (retrievalTool as unknown as { invoke(input: unknown): Promise<unknown> }).invoke({
        reference: ref,
      })
      expect(result).toEqual({ foo: 'bar' })
    })

    it('retrieves image content as ImageBlock', async () => {
      const storage = new InMemoryStorage()
      const imgBytes = new Uint8Array([137, 80, 78, 71])
      const ref = await storage.store('k1', imgBytes, 'image/png')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const tools = plugin.getTools()
      const retrievalTool = tools[0]!
      const result = await (retrievalTool as unknown as { invoke(input: unknown): Promise<unknown> }).invoke({
        reference: ref,
      })
      expect(result).toBeInstanceOf(ImageBlock)
      expect((result as ImageBlock).format).toBe('png')
    })

    it('retrieves video content as VideoBlock', async () => {
      const storage = new InMemoryStorage()
      const vidBytes = new Uint8Array([0x00, 0x00, 0x00, 0x1c])
      const ref = await storage.store('k1', vidBytes, 'video/mp4')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const tools = plugin.getTools()
      const retrievalTool = tools[0]!
      const result = await (retrievalTool as unknown as { invoke(input: unknown): Promise<unknown> }).invoke({
        reference: ref,
      })
      expect(result).toBeInstanceOf(VideoBlock)
      expect((result as VideoBlock).format).toBe('mp4')
    })

    it('retrieves document content as DocumentBlock', async () => {
      const storage = new InMemoryStorage()
      const docBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
      const ref = await storage.store('k1', docBytes, 'application/pdf')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const tools = plugin.getTools()
      const retrievalTool = tools[0]!
      const result = await (retrievalTool as unknown as { invoke(input: unknown): Promise<unknown> }).invoke({
        reference: ref,
      })
      expect(result).toBeInstanceOf(DocumentBlock)
      expect((result as DocumentBlock).format).toBe('pdf')
    })

    it('returns error string for missing reference', async () => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const tools = plugin.getTools()
      const retrievalTool = tools[0]!
      const result = await (retrievalTool as unknown as { invoke(input: unknown): Promise<unknown> }).invoke({
        reference: 'nonexistent',
      })
      expect(result).toContain('Error: reference not found')
    })
  })

  describe('search via retrieval tool', () => {
    function getRetrievalTool(plugin: ContextOffloader) {
      const tools = plugin.getTools()
      return tools[0]! as unknown as { invoke(input: unknown): Promise<unknown> }
    }

    it('finds matching lines with context', async () => {
      const storage = new InMemoryStorage()
      const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
      const ref = await storage.store('k1', new TextEncoder().encode(content), 'text/plain')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        pattern: 'line 10',
        context_lines: 2,
      })) as string

      expect(result).toContain('1 match for /line 10/')
      expect(result).toContain('> 10| line 10')
      expect(result).toContain('   8| line 8')
      expect(result).toContain('  12| line 12')
    })

    it('returns line range without pattern', async () => {
      const storage = new InMemoryStorage()
      const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
      const ref = await storage.store('k1', new TextEncoder().encode(content), 'text/plain')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        line_range: { start: 5, end: 10 },
      })) as string

      expect(result).toContain('[Lines 5-10 of 50]')
      expect(result).toContain('  5| line 5')
      expect(result).toContain(' 10| line 10')
      expect(result).not.toContain('line 4')
      expect(result).not.toContain('line 11')
    })

    it('searches within line range when both provided', async () => {
      const storage = new InMemoryStorage()
      const content = Array.from({ length: 30 }, (_, i) => `item ${i + 1}`).join('\n')
      const ref = await storage.store('k1', new TextEncoder().encode(content), 'text/plain')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        pattern: 'item 1',
        line_range: { start: 10, end: 20 },
        context_lines: 0,
      })) as string

      expect(result).toContain('in lines 10-20')
      expect(result).toContain('> 10| item 10')
      expect(result).toContain('> 11| item 11')
      expect(result).not.toContain('> 1|')
    })

    it('respects custom context_lines', async () => {
      const storage = new InMemoryStorage()
      const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
      const ref = await storage.store('k1', new TextEncoder().encode(content), 'text/plain')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        pattern: 'line 10',
        context_lines: 0,
      })) as string

      expect(result).toContain('> 10| line 10')
      expect(result).not.toContain('line 9')
      expect(result).not.toContain('line 11')
    })

    it('returns error for binary content', async () => {
      const storage = new InMemoryStorage()
      const ref = await storage.store('k1', new Uint8Array([137, 80, 78, 71]), 'image/png')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        pattern: 'test',
      })) as string

      expect(result).toContain('Error: cannot search binary content (image/png)')
    })

    it('falls back to literal match on invalid regex', async () => {
      const storage = new InMemoryStorage()
      const content = 'foo (bar\nbaz\nfoo (bar again'
      const ref = await storage.store('k1', new TextEncoder().encode(content), 'text/plain')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        pattern: 'foo (bar',
        context_lines: 0,
      })) as string

      expect(result).toContain('2 matches')
      expect(result).toContain('> 1| foo (bar')
      expect(result).toContain('> 3| foo (bar again')
    })

    it('returns error for missing reference', async () => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: 'nonexistent',
        pattern: 'test',
      })) as string

      expect(result).toContain('Error: reference not found')
    })

    it('searches JSON content', async () => {
      const storage = new InMemoryStorage()
      const json = JSON.stringify({ name: 'test', items: [1, 2, 3] }, null, 2)
      const ref = await storage.store('k1', new TextEncoder().encode(json), 'application/json')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        pattern: 'items',
        context_lines: 1,
      })) as string

      expect(result).toContain('1 match for /items/')
      expect(result).toContain('items')
    })

    it('reports no matches', async () => {
      const storage = new InMemoryStorage()
      const content = 'hello\nworld\n'
      const ref = await storage.store('k1', new TextEncoder().encode(content), 'text/plain')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        pattern: 'nonexistent',
      })) as string

      expect(result).toContain("No matches found for pattern 'nonexistent'")
    })

    it('truncates output when too many matches', async () => {
      const storage = new InMemoryStorage()
      const content = Array.from({ length: 500 }, (_, i) => `match line ${i + 1}`).join('\n')
      const ref = await storage.store('k1', new TextEncoder().encode(content), 'text/plain')

      const plugin = new ContextOffloader({
        storage,
        maxResultTokens: 50,
        previewTokens: 10,
        includeRetrievalTool: true,
      })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        pattern: 'match',
        context_lines: 0,
      })) as string

      expect(result).toContain('output truncated, narrow your search')
      expect(result.length).toBeLessThan(content.length)
    })

    it('merges overlapping context into single group', async () => {
      const storage = new InMemoryStorage()
      const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
      const ref = await storage.store('k1', new TextEncoder().encode(content), 'text/plain')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        pattern: 'line [45]',
        context_lines: 2,
      })) as string

      expect(result).toContain('2 matches')
      // Lines 4 and 5 are adjacent — with context_lines=2 they should merge into one group
      expect(result).not.toContain('---')
    })

    it('returns error when line_range.start > totalLines', async () => {
      const storage = new InMemoryStorage()
      const content = 'line 1\nline 2\nline 3'
      const ref = await storage.store('k1', new TextEncoder().encode(content), 'text/plain')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        line_range: { start: 100, end: 200 },
      })) as string

      expect(result).toContain('beyond content length (3 lines)')
    })

    it('clamps line_range.end to actual content length', async () => {
      const storage = new InMemoryStorage()
      const content = 'line 1\nline 2\nline 3'
      const ref = await storage.store('k1', new TextEncoder().encode(content), 'text/plain')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        line_range: { start: 2, end: 100 },
      })) as string

      expect(result).toContain('[Lines 2-3 of 3]')
      expect(result).toContain('line 2')
      expect(result).toContain('line 3')
    })

    it('returns first N lines when only context_lines is provided', async () => {
      const storage = new InMemoryStorage()
      const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
      const ref = await storage.store('k1', new TextEncoder().encode(content), 'text/plain')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        context_lines: 10,
      })) as string

      expect(result).toContain('[Lines 1-10 of 20]')
      expect(result).toContain('line 1')
      expect(result).toContain('line 10')
      expect(result).not.toContain('line 11')
    })

    it('returns first line when context_lines is 0', async () => {
      const storage = new InMemoryStorage()
      const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
      const ref = await storage.store('k1', new TextEncoder().encode(content), 'text/plain')

      const plugin = new ContextOffloader({ storage, includeRetrievalTool: true })
      const result = (await getRetrievalTool(plugin).invoke({
        reference: ref,
        context_lines: 0,
      })) as string

      expect(result).toContain('[Lines 1-1 of 10]')
      expect(result).toContain('line 1')
      expect(result).not.toContain('line 2')
    })
  })

  describe('eviction via BeforeModelCallEvent', () => {
    it('calls _evict on storage with incrementing cycle count', () => {
      const storage = new InMemoryStorage(5)
      let cycleCount = 0
      const plugin = new ContextOffloader({ storage, maxResultTokens: 10, previewTokens: 5 })
      const agent = createMockAgent()
      Object.defineProperty(agent, 'metrics', { get: () => new AgentMetrics({ cycleCount: ++cycleCount }) })
      plugin.initAgent(agent)

      const hook = agent.trackedHooks.find((h) => h.eventType === BeforeModelCallEvent)!
      const event = new BeforeModelCallEvent({ agent, model: mockModel, invocationState: {} })

      hook.callback(event)
      expect((storage as unknown as { _currentCycle: number })._currentCycle).toBe(1)

      hook.callback(event)
      expect((storage as unknown as { _currentCycle: number })._currentCycle).toBe(2)
    })

    it('evicts stale entries on BeforeModelCallEvent', async () => {
      const storage = new InMemoryStorage(2)
      let cycleCount = 0
      const plugin = new ContextOffloader({ storage, maxResultTokens: 10, previewTokens: 5 })
      const agent = createMockAgent()
      Object.defineProperty(agent, 'metrics', { get: () => new AgentMetrics({ cycleCount: ++cycleCount }) })
      plugin.initAgent(agent)

      const ref = await storage.store('key1', new TextEncoder().encode('test'))

      const hook = agent.trackedHooks.find((h) => h.eventType === BeforeModelCallEvent)!
      const event = new BeforeModelCallEvent({ agent, model: mockModel, invocationState: {} })

      // Advance 3 cycles: threshold = 3 - 2 = 1, stored at 0, 0 < 1 → evicted
      hook.callback(event)
      hook.callback(event)
      hook.callback(event)

      await expect(storage.retrieve(ref)).rejects.toThrow('Reference not found')
    })

    it('does not crash when storage lacks _evict', () => {
      const storage = { store: vi.fn(), retrieve: vi.fn() }
      const plugin = new ContextOffloader({ storage, maxResultTokens: 10, previewTokens: 5 })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const hook = agent.trackedHooks.find((h) => h.eventType === BeforeModelCallEvent)!
      const event = new BeforeModelCallEvent({ agent, model: mockModel, invocationState: {} })

      expect(() => hook.callback(event)).not.toThrow()
    })
  })

  describe('unified Storage eviction', () => {
    it('evicts entries stored more than evictAfterCycles ago', async () => {
      const { InMemoryStorage: UnifiedInMemoryStorage } = await import('../../../storage/in-memory-storage.js')
      const unifiedStorage = new UnifiedInMemoryStorage()

      let cycleCount = 0
      const plugin = new ContextOffloader({
        storage: unifiedStorage,
        maxResultTokens: 10,
        previewTokens: 5,
        evictAfterCycles: 3,
      })
      const agent = createMockAgent({ extra: { model: mockModel } as never })
      Object.defineProperty(agent, 'metrics', { get: () => new AgentMetrics({ cycleCount }) })
      plugin.initAgent(agent)

      // Store content at cycle 0
      const event = makeEvent([new TextBlock('x'.repeat(1000))])
      Object.defineProperty(event, 'agent', { value: agent })
      await invokeTrackedHook(agent, event)

      // Verify stored
      const keys = await unifiedStorage.list('')
      expect(keys.length).toBe(1)

      // Advance to cycle 3 — threshold = 3 - 3 = 0, stored at 0, 0 < 0 is false → not evicted
      cycleCount = 3
      const hook = agent.trackedHooks.find((h) => h.eventType === BeforeModelCallEvent)!
      const modelEvent = new BeforeModelCallEvent({ agent, model: mockModel, invocationState: {} })
      await hook.callback(modelEvent)

      const keysAfter3 = await unifiedStorage.list('')
      expect(keysAfter3.length).toBe(1)

      // Advance to cycle 4 — threshold = 4 - 3 = 1, stored at 0, 0 < 1 → evicted
      cycleCount = 4
      await hook.callback(modelEvent)

      const keysAfter4 = await unifiedStorage.list('')
      expect(keysAfter4.length).toBe(0)
    })

    it('does not evict when evictAfterCycles is null', async () => {
      const { InMemoryStorage: UnifiedInMemoryStorage } = await import('../../../storage/in-memory-storage.js')
      const unifiedStorage = new UnifiedInMemoryStorage()

      let cycleCount = 0
      const plugin = new ContextOffloader({
        storage: unifiedStorage,
        maxResultTokens: 10,
        previewTokens: 5,
        evictAfterCycles: null,
      })
      const agent = createMockAgent({ extra: { model: mockModel } as never })
      Object.defineProperty(agent, 'metrics', { get: () => new AgentMetrics({ cycleCount }) })
      plugin.initAgent(agent)

      // Store content at cycle 0
      const event = makeEvent([new TextBlock('x'.repeat(1000))])
      Object.defineProperty(event, 'agent', { value: agent })
      await invokeTrackedHook(agent, event)

      // Advance far beyond any reasonable eviction window
      cycleCount = 100
      const hook = agent.trackedHooks.find((h) => h.eventType === BeforeModelCallEvent)!
      const modelEvent = new BeforeModelCallEvent({ agent, model: mockModel, invocationState: {} })
      await hook.callback(modelEvent)

      const keys = await unifiedStorage.list('')
      expect(keys.length).toBe(1)
    })
  })

  describe('unified Storage content-type round-trip', () => {
    it('stores content and content-type in a single framed key', async () => {
      const { InMemoryStorage: UnifiedInMemoryStorage } = await import('../../../storage/in-memory-storage.js')
      const unifiedStorage = new UnifiedInMemoryStorage()

      const plugin = new ContextOffloader({
        storage: unifiedStorage,
        maxResultTokens: 10,
        previewTokens: 5,
        includeRetrievalTool: true,
      })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const event = makeEvent([new TextBlock('hello world '.repeat(100))])
      await invokeTrackedHook(agent, event)

      const preview = (event.result.content[0] as TextBlock).text
      const refMatch = preview.match(/tool-123_0/)
      expect(refMatch).not.toBeNull()

      // Only one key per block — no sidecar .contenttype key
      const keys = await unifiedStorage.list('')
      expect(keys).toEqual(['offloader/tool-123_0'])

      const tools = plugin.getTools()
      const retrievalTool = tools[0]!
      const result = await (retrievalTool as unknown as { invoke(input: unknown): Promise<unknown> }).invoke({
        reference: 'tool-123_0',
      })
      expect(result).toBe('hello world '.repeat(100))
    })
  })

  describe('auto-namespacing', () => {
    it('auto-scopes a raw unified Storage under offloader/', async () => {
      const { InMemoryStorage: UnifiedInMemoryStorage } = await import('../../../storage/in-memory-storage.js')
      const unifiedStorage = new UnifiedInMemoryStorage()

      const plugin = new ContextOffloader({
        storage: unifiedStorage,
        maxResultTokens: 10,
        previewTokens: 5,
      })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const event = makeEvent([new TextBlock('x'.repeat(1000))])
      await invokeTrackedHook(agent, event)

      const keys = await unifiedStorage.list('')
      expect(keys).toEqual(['offloader/tool-123_0'])
    })

    it('does not double-namespace an already-namespaced Storage', async () => {
      const { InMemoryStorage: UnifiedInMemoryStorage } = await import('../../../storage/in-memory-storage.js')
      const { namespace } = await import('../../../storage/storage.js')
      const unifiedStorage = new UnifiedInMemoryStorage()
      const customScoped = namespace(unifiedStorage, 'custom')

      const plugin = new ContextOffloader({
        storage: customScoped,
        maxResultTokens: 10,
        previewTokens: 5,
      })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const event = makeEvent([new TextBlock('x'.repeat(1000))])
      await invokeTrackedHook(agent, event)

      const keys = await unifiedStorage.list('')
      expect(keys).toEqual(['custom/tool-123_0'])
    })

    it('does not namespace legacy OffloaderStorage', async () => {
      const storage = new InMemoryStorage()
      const plugin = new ContextOffloader({
        storage,
        maxResultTokens: 10,
        previewTokens: 5,
      })
      const agent = createMockAgent()
      plugin.initAgent(agent)

      const event = makeEvent([new TextBlock('x'.repeat(1000))])
      await invokeTrackedHook(agent, event)

      const preview = (event.result.content[0] as TextBlock).text
      expect(preview).not.toContain('offloader/')
    })
  })

  describe('LocalFileStorage sandbox routing', () => {
    it('auto-routes LocalFileStorage through sandbox and namespaces under offloader/', async () => {
      const { LocalFileStorage } = await import('../../../storage/local-file-storage.js')
      const written: Array<{ path: string; data: Uint8Array }> = []
      const mockSandbox = {
        writeFile: vi.fn(async (path: string, data: Uint8Array) => {
          written.push({ path, data })
        }),
        readFile: vi.fn(async (path: string) => {
          const entry = written.find((entry) => entry.path === path)
          if (!entry) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
          return entry.data
        }),
        removeFile: vi.fn(),
        listFiles: vi.fn(async () => []),
        executeStreaming: vi.fn(),
        executeCodeStreaming: vi.fn(),
        getTools: vi.fn(() => []),
      }

      const storage = new LocalFileStorage('./artifacts')
      const plugin = new ContextOffloader({
        storage,
        maxResultTokens: 10,
        previewTokens: 5,
      })
      const agent = createMockAgent({ extra: { model: mockModel, sandbox: mockSandbox } as never })
      plugin.initAgent(agent)

      const result = new ToolResultBlock({
        toolUseId: 'tool-123',
        status: 'success',
        content: [new TextBlock('large content '.repeat(100))],
      })
      const event = new AfterToolCallEvent({
        agent,
        toolUse: { name: 'some_tool', toolUseId: 'tool-123', input: {} },
        tool: undefined,
        result,
        invocationState: {},
      })
      await invokeTrackedHook(agent, event)

      expect(mockSandbox.writeFile).toHaveBeenCalled()
      const writtenPath = mockSandbox.writeFile.mock.calls[0]![0] as string
      expect(writtenPath).toContain('offloader/')
    })

    it('routes pre-namespaced LocalFileStorage through sandbox with user prefix', async () => {
      const { LocalFileStorage } = await import('../../../storage/local-file-storage.js')
      const written: Array<{ path: string; data: Uint8Array }> = []
      const mockSandbox = {
        writeFile: vi.fn(async (path: string, data: Uint8Array) => {
          written.push({ path, data })
        }),
        readFile: vi.fn(async (path: string) => {
          const entry = written.find((entry) => entry.path === path)
          if (!entry) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
          return entry.data
        }),
        removeFile: vi.fn(),
        listFiles: vi.fn(async () => []),
        executeStreaming: vi.fn(),
        executeCodeStreaming: vi.fn(),
        getTools: vi.fn(() => []),
      }

      const storage = new LocalFileStorage('./artifacts').namespace('custom')
      const plugin = new ContextOffloader({
        storage,
        maxResultTokens: 10,
        previewTokens: 5,
      })
      const agent = createMockAgent({ extra: { model: mockModel, sandbox: mockSandbox } as never })
      plugin.initAgent(agent)

      const result = new ToolResultBlock({
        toolUseId: 'tool-123',
        status: 'success',
        content: [new TextBlock('large content '.repeat(100))],
      })
      const event = new AfterToolCallEvent({
        agent,
        toolUse: { name: 'some_tool', toolUseId: 'tool-123', input: {} },
        tool: undefined,
        result,
        invocationState: {},
      })
      await invokeTrackedHook(agent, event)

      expect(mockSandbox.writeFile).toHaveBeenCalled()
      const writtenPath = mockSandbox.writeFile.mock.calls[0]![0] as string
      expect(writtenPath).toContain('custom/')
      expect(writtenPath).not.toContain('offloader/')
    })
  })
})
