import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { InvokeModelStage, ExecuteToolStage, AgentStreamStage } from '../stages.js'
import type { InvokeModelContext } from '../stages.js'
import { TextBlock, ToolResultBlock, Message } from '../../types/messages.js'
import type { JSONValue } from '../../types/json.js'

describe('InvokeModelStage copy-on-input isolation', () => {
  describe('messages', () => {
    it('middleware receives a deep copy of messages, not a reference to the agent array', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, printer: false })

      let receivedMessages: readonly Message[] | undefined

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        receivedMessages = context.messages
        return yield* next(context)
      })

      await agent.invoke('Hello')

      expect(receivedMessages).not.toBe(agent.messages)
    })

    it('mutating the context messages array does not affect agent.messages', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, printer: false })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        // Force-cast to bypass readonly for this mutation test
        ;(context.messages as Message[]).push(new Message({ role: 'user', content: [new TextBlock('injected')] }))
        return yield* next(context)
      })

      await agent.invoke('Hello')

      // Agent messages should only contain the original user message + assistant response,
      // not the injected one
      const userMessages = agent.messages.filter((m) => m.role === 'user')
      expect(userMessages).toHaveLength(1)
      expect(userMessages[0]!.content[0]).toBeInstanceOf(TextBlock)
      expect((userMessages[0]!.content[0] as TextBlock).text).toBe('Hello')
    })

    it('message content blocks are deep copied (not shared references)', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, printer: false })

      let receivedContent: unknown

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        receivedContent = context.messages[0]?.content[0]
        return yield* next(context)
      })

      await agent.invoke('Hello')

      // The content block in middleware should be a different instance
      expect(receivedContent).not.toBe(agent.messages[0]?.content[0])
    })

    it('message metadata is deep copied (not shared reference)', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, printer: false })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        const msg = context.messages[0]
        if (msg?.metadata) {
          msg.metadata.custom = { ...(msg.metadata.custom ?? {}), injected: 'value' }
        }
        return yield* next(context)
      })

      // Pre-set metadata on the agent's message so the middleware has something to mutate
      agent.messages.push(
        new Message({
          role: 'user',
          content: [new TextBlock('Hello')],
          metadata: { custom: { original: 'data' } },
        })
      )

      await agent.invoke('Hello')

      const userMsg = agent.messages.find((m) => m.role === 'user' && m.metadata?.custom?.['original'] === 'data')
      expect(userMsg?.metadata?.custom).toEqual({ original: 'data' })
      expect(userMsg?.metadata?.custom).not.toHaveProperty('injected')
    })
  })

  describe('systemPrompt', () => {
    it('string systemPrompt is passed through (immutable primitive)', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, printer: false, systemPrompt: 'Be helpful' })

      let receivedPrompt: unknown

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        receivedPrompt = context.systemPrompt
        return yield* next(context)
      })

      await agent.invoke('Hello')

      expect(receivedPrompt).toBe('Be helpful')
    })

    it('array systemPrompt is deep copied', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const systemBlocks = [new TextBlock('Be helpful')]
      const agent = new Agent({ model, printer: false, systemPrompt: systemBlocks })

      let receivedPrompt: unknown

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        receivedPrompt = context.systemPrompt
        return yield* next(context)
      })

      await agent.invoke('Hello')

      expect(receivedPrompt).not.toBe(systemBlocks)
      expect(Array.isArray(receivedPrompt)).toBe(true)
      expect((receivedPrompt as TextBlock[])[0]).not.toBe(systemBlocks[0])
    })
  })

  describe('toolSpecs', () => {
    it('toolSpecs are deep copied across invocations', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )
      const agent = new Agent({ model, tools: [tool], printer: false })

      const receivedSpecs: unknown[] = []

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        receivedSpecs.push(context.toolSpecs)
        return yield* next(context)
      })

      await agent.invoke('Hello')
      await agent.invoke('Hello again')

      // Each invocation should get a fresh copy
      expect(receivedSpecs[0]).not.toBe(receivedSpecs[1])
      expect(receivedSpecs[0]).toEqual(receivedSpecs[1])
      expect(receivedSpecs[0]).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'testTool' })]))
    })
  })

  describe('modelState', () => {
    it('modelState is not exposed on the middleware context', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, printer: false, systemPrompt: 'hi', modelState: { existing: 'value' } })

      let contextKeys: string[] = []

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        contextKeys = Object.keys(context)
        return yield* next(context)
      })

      await agent.invoke('Hello')

      expect(contextKeys.sort()).toEqual(
        ['agent', 'invocationState', 'messages', 'model', 'projectedInputTokens', 'systemPrompt', 'toolSpecs'].sort()
      )
    })

    it('model state changes are written back to agent.modelState after streaming', async () => {
      const model = new MockMessageModel()
      const originalStream = model.stream.bind(model)
      model.stream = async function* (messages, options) {
        options?.modelState?.set('responseId', 'resp_123')
        yield* originalStream(messages, options)
      }
      model.addTurn({ type: 'textBlock', text: 'Hi' })

      const agent = new Agent({ model, printer: false })
      await agent.invoke('Hello')

      expect(agent.modelState.getAll()).toEqual({ responseId: 'resp_123' })
    })

    it('model state deletions are synced back to agent.modelState', async () => {
      const model = new MockMessageModel()
      const originalStream = model.stream.bind(model)
      model.stream = async function* (messages, options) {
        options?.modelState?.delete('oldKey')
        options?.modelState?.set('newKey', 'fresh')
        yield* originalStream(messages, options)
      }
      model.addTurn({ type: 'textBlock', text: 'Hi' })

      const agent = new Agent({ model, printer: false, modelState: { oldKey: 'stale' } })
      await agent.invoke('Hello')

      expect(agent.modelState.get('oldKey')).toBeUndefined()
      expect(agent.modelState.get('newKey')).toBe('fresh')
    })

    it('middleware mutations to agent.modelState before next() do not affect the model call', async () => {
      const model = new MockMessageModel()
      const originalStream = model.stream.bind(model)
      let modelReceivedState: Record<string, unknown> | undefined
      model.stream = async function* (messages, options) {
        modelReceivedState = options?.modelState?.getAll()
        yield* originalStream(messages, options)
      }
      model.addTurn({ type: 'textBlock', text: 'Hi' })

      const agent = new Agent({ model, printer: false, modelState: { key: 'snapshotted' } })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        agent.modelState.set('key', 'mutated-before-next')
        agent.modelState.set('extra', 'injected')
        return yield* next(context)
      })

      await agent.invoke('Hello')

      expect(modelReceivedState).toEqual({ key: 'snapshotted' })
    })

    it('middleware mutations to agent.modelState after next() do not persist', async () => {
      const model = new MockMessageModel()
      const originalStream = model.stream.bind(model)
      model.stream = async function* (messages, options) {
        options?.modelState?.set('fromModel', 'model-wrote-this')
        yield* originalStream(messages, options)
      }
      model.addTurn({ type: 'textBlock', text: 'Hi' })

      const agent = new Agent({ model, printer: false, modelState: { key: 'original' } })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        const result = yield* next(context)
        agent.modelState.set('sneaky', 'should-be-gone')
        agent.modelState.set('fromModel', 'overwritten')
        return result
      })

      await agent.invoke('Hello')

      // Writeback happens after the full middleware chain, discarding any mutations
      expect(agent.modelState.get('fromModel')).toBe('model-wrote-this')
      expect(agent.modelState.get('sneaky')).toBeUndefined()
      // 'key' persists because it was in the snapshot that the model received
      expect(agent.modelState.get('key')).toBe('original')
    })
  })

  describe('invocationState', () => {
    it('invocationState is shared by reference — mutations are visible on the result', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, printer: false })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        ;(context.invocationState as Record<string, unknown>)['middlewareTouched'] = true
        return yield* next(context)
      })

      const result = await agent.invoke('Hello', { invocationState: { myKey: 'myValue' } })

      expect(result.invocationState).toEqual({ myKey: 'myValue', middlewareTouched: true })
    })
  })

  describe('toolChoice', () => {
    it('toolChoice is undefined when not explicitly configured', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, printer: false })

      let receivedChoice: unknown

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        receivedChoice = context.toolChoice
        return yield* next(context)
      })

      await agent.invoke('Hello')

      expect(receivedChoice).toBeUndefined()
    })

    it('toolChoice is deep copied when present', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'plain response' }).addTurn({
        type: 'toolUseBlock',
        name: 'strands_structured_output',
        toolUseId: 'so-1',
        input: { name: 'Alice' },
      })
      const { z } = await import('zod')
      const agent = new Agent({
        model,
        printer: false,
        structuredOutputSchema: z.object({ name: z.string() }),
      })

      const receivedChoices: unknown[] = []

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        receivedChoices.push(context.toolChoice)
        return yield* next(context)
      })

      await agent.invoke('Hello')

      // Second call should have toolChoice forced by structured output
      const definedChoice = receivedChoices.find((c) => c !== undefined)
      expect(definedChoice).toEqual({ tool: { name: 'strands_structured_output' } })
    })
  })

  describe('functional style — passing modified context to next()', () => {
    it('middleware can pass a new context with modified messages to next()', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, printer: false })

      let terminalMessages: readonly Message[] | undefined

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        const newContext: InvokeModelContext = {
          ...context,
          messages: [...context.messages, new Message({ role: 'user', content: [new TextBlock('extra context')] })],
        }
        return yield* next(newContext)
      })

      // Add a second middleware closer to terminal to capture what actually arrives
      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        terminalMessages = context.messages
        return yield* next(context)
      })

      await agent.invoke('Hello')

      expect(terminalMessages).toHaveLength(2)
      expect((terminalMessages![1]!.content[0] as TextBlock).text).toBe('extra context')
    })

    it('middleware can pass a new context with modified toolSpecs to next()', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const tool = createMockTool(
        'myTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )
      const agent = new Agent({ model, tools: [tool], printer: false })

      let terminalSpecs: unknown

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        // Filter out all tools
        const newContext: InvokeModelContext = {
          ...context,
          toolSpecs: [],
        }
        return yield* next(newContext)
      })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        terminalSpecs = context.toolSpecs
        return yield* next(context)
      })

      await agent.invoke('Hello')

      expect(terminalSpecs).toEqual([])
    })
  })
})

describe('ExecuteToolStage copy-on-input isolation', () => {
  function createToolCallingModel(): MockMessageModel {
    return new MockMessageModel()
      .addTurn({
        type: 'toolUseBlock',
        name: 'testTool',
        toolUseId: 'tool-1',
        input: { key: 'value', nested: { arr: [1, 2, 3] } },
      })
      .addTurn({ type: 'textBlock', text: 'Done' })
  }

  describe('toolUse.input', () => {
    it('toolUse.input is a deep copy of the model output', async () => {
      const model = createToolCallingModel()
      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )
      const agent = new Agent({ model, tools: [tool], printer: false })

      let receivedInput: JSONValue | undefined

      agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
        receivedInput = context.toolUse.input
        return yield* next(context)
      })

      await agent.invoke('Call the tool')

      expect(receivedInput).toEqual({ key: 'value', nested: { arr: [1, 2, 3] } })
    })

    it('mutating toolUse.input in middleware does not affect the original message', async () => {
      const model = createToolCallingModel()
      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )
      const agent = new Agent({ model, tools: [tool], printer: false })

      agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
        ;(context.toolUse.input as Record<string, unknown>)['injected'] = true
        return yield* next(context)
      })

      await agent.invoke('Call the tool')

      // The original tool use block in the assistant message should be unaffected
      const assistantMsg = agent.messages.find((m) => m.role === 'assistant')
      const toolUseBlock = assistantMsg?.content.find((b) => b.type === 'toolUseBlock')
      expect(toolUseBlock).toBeDefined()
      expect((toolUseBlock as { input: JSONValue }).input).not.toHaveProperty('injected')
    })
  })

  describe('invocationState', () => {
    it('invocationState is shared by reference (intentionally mutable)', async () => {
      const model = createToolCallingModel()
      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )
      const agent = new Agent({ model, tools: [tool], printer: false })

      agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
        ;(context.invocationState as Record<string, unknown>)['middlewareTouched'] = true
        return yield* next(context)
      })

      const result = await agent.invoke('Call the tool', { invocationState: { original: true } })

      expect(result.invocationState).toEqual({ original: true, middlewareTouched: true })
    })
  })
})

describe('AgentStreamStage shared references', () => {
  describe('args', () => {
    it('args is shared by reference with the caller', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, printer: false })

      const inputMessages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      let receivedArgs: unknown

      agent.addMiddleware(AgentStreamStage, async function* (context, next) {
        receivedArgs = context.args
        return yield* next(context)
      })

      await agent.invoke(inputMessages)

      expect(receivedArgs).toBe(inputMessages)
    })
  })
})
