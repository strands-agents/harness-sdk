import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { Message, ToolResultBlock, TextBlock, ToolUseBlock } from '../../types/messages.js'
import { ConcurrentInvocationError, ToolNotFoundError } from '../../errors.js'
import { ToolStreamEvent } from '../../tools/tool.js'
import type { ToolContext } from '../../tools/tool.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'

describe('ToolCaller', () => {
  describe('basic tool calling via .invoke()', () => {
    it('calls a tool by name and returns the result', async () => {
      const tool = createMockTool(
        'calculator',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('8')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      const result = await agent.tool.calculator!.invoke({ a: 5, b: 3 })

      expect(result).toStrictEqual(
        new ToolResultBlock({
          toolUseId: 'test-id',
          status: 'success',
          content: [new TextBlock('8')],
        })
      )
    })

    it('calls a tool with empty input when no input provided', async () => {
      const tool = createMockTool(
        'ping',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('pong')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      const result = await agent.tool.ping!.invoke()

      expect(result).toStrictEqual(
        new ToolResultBlock({
          toolUseId: 'test-id',
          status: 'success',
          content: [new TextBlock('pong')],
        })
      )
    })

    it('passes agent.cancelSignal to direct tool calls', async () => {
      let receivedSignal: AbortSignal | undefined
      const tool = createMockTool('probe', (context) => {
        receivedSignal = context.cancelSignal
        return new ToolResultBlock({
          toolUseId: context.toolUse.toolUseId,
          status: 'success',
          content: [],
        })
      })
      const agent = new Agent({
        model: new MockMessageModel().addTurn({ type: 'textBlock', text: 'unused' }),
        tools: [tool],
      })

      await agent.tool.probe!.invoke({})

      expect(receivedSignal).toBe(agent.cancelSignal)
    })

    it('throws when tool is not found', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [] })

      await expect(agent.tool.nonexistent!.invoke()).rejects.toThrow(ToolNotFoundError)
      await expect(agent.tool.nonexistent!.invoke()).rejects.toThrow("Tool 'nonexistent' not found")
    })
  })

  describe('underscore-to-hyphen normalization', () => {
    it('resolves underscore names to hyphenated tool names', async () => {
      const tool = createMockTool(
        'my-tool',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      const result = await agent.tool.my_tool!.invoke()

      expect(result.status).toBe('success')
    })

    it('prefers exact name match over normalized match', async () => {
      const exactTool = createMockTool(
        'my_tool',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('exact')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [exactTool] })

      const result = await agent.tool.my_tool!.invoke()

      expect(result).toStrictEqual(
        new ToolResultBlock({
          toolUseId: 'test-id',
          status: 'success',
          content: [new TextBlock('exact')],
        })
      )
    })
  })

  describe('case-insensitive name resolution', () => {
    it('resolves tool names case-insensitively', async () => {
      const tool = createMockTool(
        'MyTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      const result = await agent.tool.mytool!.invoke()

      expect(result.status).toBe('success')
    })

    it('prefers exact match over case-insensitive match', async () => {
      const exactTool = createMockTool(
        'myTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('exact')],
          })
      )
      const upperTool = createMockTool(
        'MYTOOL',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('upper')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [exactTool, upperTool] })

      const result = await agent.tool.myTool!.invoke()

      expect(result.content[0]).toStrictEqual(new TextBlock('exact'))
    })
  })

  describe('message history recording', () => {
    it('records tool call in message history by default', async () => {
      const tool = createMockTool(
        'calculator',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('8')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      await agent.tool.calculator!.invoke({ a: 5, b: 3 })

      // Per TESTING.md, prefer full-object assertions over per-field checks.
      // toolUseId is non-deterministic (UUID), so use expect.stringMatching.
      expect(agent.messages).toEqual([
        new Message({
          trackingId: anyTrackingId,
          role: 'assistant',
          content: [
            new ToolUseBlock({
              toolUseId: expect.stringMatching(/^tooluse_/) as unknown as string,
              name: 'calculator',
              input: { a: 5, b: 3 },
            }),
          ],
        }),
        new Message({
          trackingId: anyTrackingId,
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'test-id',
              status: 'success',
              content: [new TextBlock('8')],
            }),
          ],
        }),
        new Message({
          trackingId: anyTrackingId,
          role: 'assistant',
          content: [new TextBlock('agent.tool.calculator was called.')],
        }),
      ])
    })

    it('does not record when recordDirectToolCall is false per-call', async () => {
      const tool = createMockTool(
        'calculator',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('8')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      await agent.tool.calculator!.invoke({ a: 5, b: 3 }, { recordDirectToolCall: false })

      expect(agent.messages).toHaveLength(0)
    })

    it('records when explicitly set to true per-call', async () => {
      const tool = createMockTool(
        'calculator',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('8')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      await agent.tool.calculator!.invoke({ a: 5, b: 3 }, { recordDirectToolCall: true })

      expect(agent.messages).toHaveLength(3)
    })

    it('records full input without filtering', async () => {
      const tool = createMockTool(
        'my-tool',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )
      Object.defineProperty(tool, 'toolSpec', {
        value: {
          name: 'my-tool',
          description: 'Tool with strict schema',
          inputSchema: {
            type: 'object',
            properties: {
              allowed: { type: 'string' },
            },
          },
        },
      })
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      await agent.tool.my_tool!.invoke({ allowed: 'yes', extra: 'also-recorded' })

      // Input is recorded as-is — no filtering
      const recToolUseBlock = agent.messages[0]!.content[0] as ToolUseBlock
      expect(recToolUseBlock).toBeInstanceOf(ToolUseBlock)
      expect(recToolUseBlock.input).toStrictEqual({ allowed: 'yes', extra: 'also-recorded' })
    })
  })

  describe('concurrency protection', () => {
    it('throws ConcurrentInvocationError when agent is invoking and recording is enabled', async () => {
      const tool = createMockTool(
        'slow-tool',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('done')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      // Simulate the agent being in the middle of an invocation by mocking isInvoking
      Object.defineProperty(agent, 'isInvoking', { get: () => true })

      await expect(agent.tool.slow_tool!.invoke()).rejects.toThrow(ConcurrentInvocationError)
      await expect(agent.tool.slow_tool!.invoke()).rejects.toThrow(
        'Direct tool call cannot be made while the agent is in the middle of an invocation'
      )
    })

    it('allows direct tool call during invocation when recordDirectToolCall is false', async () => {
      const tool = createMockTool(
        'quick-tool',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      // Simulate the agent being in the middle of an invocation
      Object.defineProperty(agent, 'isInvoking', { get: () => true })

      // Should NOT throw when recording is disabled
      const result = await agent.tool.quick_tool!.invoke({}, { recordDirectToolCall: false })
      expect(result.status).toBe('success')
    })

    it('isInvoking is false on a fresh agent', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })

      expect(agent.isInvoking).toBe(false)
    })
  })

  describe('tool error handling', () => {
    it('propagates errors when tool throws', async () => {
      const throwingTool = createMockTool('thrower', () => {
        throw new Error('Boom!')
      })
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [throwingTool] })

      await expect(agent.tool.thrower!.invoke()).rejects.toThrow('Boom!')
    })
  })

  describe('agent.tool accessor', () => {
    it('is accessible as a property', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })

      expect(agent.tool).toBeDefined()
    })

    it('returns same instance on multiple accesses', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model })

      expect(agent.tool).toBe(agent.tool)
    })

    it('returns a ToolHandle with invoke and stream methods', () => {
      const tool = createMockTool(
        'calculator',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      const handle = agent.tool.calculator!
      expect(typeof handle.invoke).toBe('function')
      expect(typeof handle.stream).toBe('function')
    })
  })

  describe('tool use ID generation', () => {
    it('generates unique tool use IDs using crypto.randomUUID', async () => {
      const tool = createMockTool(
        'id-tool',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      await agent.tool.id_tool!.invoke()
      await agent.tool.id_tool!.invoke()

      // Each call records 3 messages: [0]=assistant(toolUse), [1]=user(toolResult), [2]=assistant(ack)
      // Second call: [3]=assistant(toolUse), [4]=user(toolResult), [5]=assistant(ack)
      expect(agent.messages).toHaveLength(6)

      const toolUse1 = agent.messages[0]!.content[0] as ToolUseBlock
      const toolUse2 = agent.messages[3]!.content[0] as ToolUseBlock

      // Verify both are ToolUseBlocks at the correct indices
      expect(toolUse1).toBeInstanceOf(ToolUseBlock)
      expect(toolUse2).toBeInstanceOf(ToolUseBlock)

      // Verify IDs are unique and follow the expected format
      expect(toolUse1.toolUseId).toMatch(/^tooluse_/)
      expect(toolUse2.toolUseId).toMatch(/^tooluse_/)
      expect(toolUse1.toolUseId).not.toBe(toolUse2.toolUseId)
    })
  })

  describe('streaming via .stream()', () => {
    it('yields intermediate events and returns final result', async () => {
      const yields: string[] = []
      const streamingTool = {
        name: 'streamer',
        description: 'A tool that yields progress events',
        toolSpec: {
          name: 'streamer',
          description: 'A tool that yields progress events',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        async *stream(): AsyncGenerator<ToolStreamEvent, ToolResultBlock, undefined> {
          yields.push('first')
          yield new ToolStreamEvent({ data: 'step 1' })
          yields.push('second')
          yield new ToolStreamEvent({ data: 'step 2' })
          yields.push('third')
          yield new ToolStreamEvent({ data: 'step 3' })
          return new ToolResultBlock({
            toolUseId: 'stream-id',
            status: 'success',
            content: [new TextBlock('complete')],
          })
        },
      }
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [streamingTool] })

      const events: ToolStreamEvent[] = []
      const gen = agent.tool.streamer!.stream()
      let result = await gen.next()
      while (!result.done) {
        events.push(result.value)
        result = await gen.next()
      }
      const finalResult = result.value

      expect(finalResult.status).toBe('success')
      expect(finalResult.content[0]).toStrictEqual(new TextBlock('complete'))
      // Verify all yields were consumed (generator fully iterated)
      expect(yields).toStrictEqual(['first', 'second', 'third'])
      // Verify we received all 3 stream events
      expect(events).toHaveLength(3)
    })

    it('invoke() also fully consumes multi-yield generator', async () => {
      const yields: string[] = []
      const streamingTool = {
        name: 'streamer',
        description: 'A tool that yields progress events',
        toolSpec: {
          name: 'streamer',
          description: 'A tool that yields progress events',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        async *stream(): AsyncGenerator<ToolStreamEvent, ToolResultBlock, undefined> {
          yields.push('first')
          yield new ToolStreamEvent({ data: 'step 1' })
          yields.push('second')
          yield new ToolStreamEvent({ data: 'step 2' })
          yields.push('third')
          yield new ToolStreamEvent({ data: 'step 3' })
          return new ToolResultBlock({
            toolUseId: 'stream-id',
            status: 'success',
            content: [new TextBlock('complete')],
          })
        },
      }
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [streamingTool] })

      const result = await agent.tool.streamer!.invoke()

      expect(result.status).toBe('success')
      expect(result.content[0]).toStrictEqual(new TextBlock('complete'))
      // Verify all yields were consumed even when using .invoke()
      expect(yields).toStrictEqual(['first', 'second', 'third'])
    })
  })

  describe('tool input passthrough', () => {
    it('passes ALL parameters to tool execution', async () => {
      let receivedInput: unknown = null
      const tool = createMockTool(
        'capture-tool',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('captured')],
          })
      )
      // Override stream to capture input
      const originalStream = tool.stream.bind(tool)
      tool.stream = function (context: ToolContext) {
        receivedInput = context.toolUse.input
        return originalStream(context)
      }
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [tool] })

      await agent.tool.capture_tool!.invoke({ allowed: 'yes', extra: 'should-pass-through' })

      // Tool receives ALL parameters
      expect(receivedInput).toStrictEqual({ allowed: 'yes', extra: 'should-pass-through' })
    })
  })

  describe('dynamically added tools', () => {
    it('can call a tool that was added after agent creation', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, tools: [] })

      // Add tool after creation
      const laterTool = createMockTool(
        'later-tool',
        () =>
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('dynamic')],
          })
      )
      agent.toolRegistry.add(laterTool)

      const result = await agent.tool.later_tool!.invoke()

      expect(result.status).toBe('success')
      expect(result.content[0]).toStrictEqual(new TextBlock('dynamic'))
    })
  })
})

describe('MessageAddedEvent hooks', () => {
  it('fires MessageAddedEvent for each message recorded during direct tool call', async () => {
    const { MessageAddedEvent } = await import('../../hooks/events.js')

    const tool = createMockTool(
      'calculator',
      () =>
        new ToolResultBlock({
          toolUseId: 'test-id',
          status: 'success',
          content: [new TextBlock('8')],
        })
    )
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
    const agent = new Agent({ model, tools: [tool] })

    const firedEvents: InstanceType<typeof MessageAddedEvent>[] = []
    agent.addHook(MessageAddedEvent, (event) => {
      firedEvents.push(event)
    })

    await agent.tool.calculator!.invoke({ a: 5, b: 3 })

    // Should fire 3 MessageAddedEvents (one per recorded message).
    // Use full-object assertions per TESTING.md.
    expect(firedEvents).toHaveLength(3)
    expect(firedEvents[0]!.message).toEqual(
      new Message({
        trackingId: anyTrackingId,
        role: 'assistant',
        content: [
          new ToolUseBlock({
            toolUseId: expect.stringMatching(/^tooluse_/) as unknown as string,
            name: 'calculator',
            input: { a: 5, b: 3 },
          }),
        ],
      })
    )
    expect(firedEvents[1]!.message).toEqual(
      new Message({
        trackingId: anyTrackingId,
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'test-id',
            status: 'success',
            content: [new TextBlock('8')],
          }),
        ],
      })
    )
    expect(firedEvents[2]!.message).toEqual(
      new Message({
        trackingId: anyTrackingId,
        role: 'assistant',
        content: [new TextBlock('agent.tool.calculator was called.')],
      })
    )
  })

  it('does not fire MessageAddedEvent when recordDirectToolCall is false', async () => {
    const { MessageAddedEvent } = await import('../../hooks/events.js')

    const tool = createMockTool(
      'calculator',
      () =>
        new ToolResultBlock({
          toolUseId: 'test-id',
          status: 'success',
          content: [new TextBlock('8')],
        })
    )
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
    const agent = new Agent({ model, tools: [tool] })

    const firedEvents: InstanceType<typeof MessageAddedEvent>[] = []
    agent.addHook(MessageAddedEvent, (event) => {
      firedEvents.push(event)
    })

    await agent.tool.calculator!.invoke({ a: 5, b: 3 }, { recordDirectToolCall: false })

    // No events should fire when recording is disabled
    expect(firedEvents).toHaveLength(0)
  })
})
