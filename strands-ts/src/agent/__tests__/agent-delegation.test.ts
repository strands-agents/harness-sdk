/**
 * Integration tests for AgentDelegation — verifies the full agent invoke flow
 * with delegation tools using a mock model.
 *
 * Tests exercise the complete path: Agent constructor auto-registration,
 * BeforeToolsEvent enforcement, AfterToolsEvent early exit with content blocks,
 * and event streaming unwrapping.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { Agent } from '../agent.js'
import {
  AfterToolCallEvent,
  AfterToolsEvent,
  BeforeToolCallEvent,
  MessageAddedEvent,
  StreamEvent,
} from '../../hooks/events.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { AgentAsTool } from '../agent-as-tool.js'
import { Message, ToolResultBlock, TextBlock } from '../../types/messages.js'

describe('AgentDelegation integration', () => {
  describe('basic routing', () => {
    it('routes to the correct specialist and returns stopReason endTurn', async () => {
      // Sub-agent models: each returns a distinct response
      const billingModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Your balance is $42.' })
      const techModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Try rebooting your router.' })

      const billingAgent = new Agent({ model: billingModel, name: 'Billing', printer: false })
      const techAgent = new Agent({ model: techModel, name: 'TechSupport', printer: false })

      // Orchestrator model: calls the TechSupport delegation tool
      const orchestratorModel = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'TechSupport',
        toolUseId: 'call-1',
        input: { input: 'My wifi does not work', _background_execution: true },
      })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [billingAgent.asTool({ delegate: true }), techAgent.asTool({ delegate: true })],
        backgroundTasks: {},
        printer: false,
      })

      const result = await orchestrator.invoke('My wifi does not work')

      expect(result.stopReason).toBe('endTurn')
      // The lastMessage should contain the sub-agent's response text
      const textBlocks = result.lastMessage.content.filter((b) => b.type === 'textBlock')
      expect(textBlocks).toHaveLength(1)
      expect((textBlocks[0] as { text: string }).text).toBe('Try rebooting your router.')
    })
  })

  describe('mixed tools', () => {
    it('regular tools work normally when called alone', async () => {
      const techModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Specialist response' })
      const techAgent = new Agent({ model: techModel, name: 'TechSupport', printer: false })

      const calculator = createMockTool('calculator', () => 'Result: 42')

      // Turn 1: model calls the regular calculator tool
      // Turn 2: model produces final text after seeing tool result
      const orchestratorModel = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'calculator',
          toolUseId: 'calc-1',
          input: {},
        })
        .addTurn({ type: 'textBlock', text: 'The answer is 42.' })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [calculator, techAgent.asTool({ delegate: true })],
        printer: false,
      })

      const result = await orchestrator.invoke('What is 6 * 7?')

      // Regular tool call does NOT trigger delegation
      expect(result.stopReason).toBe('endTurn')
      const textBlocks = result.lastMessage.content.filter((b) => b.type === 'textBlock')
      expect(textBlocks).toHaveLength(1)
      expect((textBlocks[0] as { text: string }).text).toBe('The answer is 42.')
    })
  })

  describe('single-call enforcement', () => {
    it('cancels all tools when delegation tool is called alongside other tools, then retries', async () => {
      const techModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Specialist answer' })
      const techAgent = new Agent({ model: techModel, name: 'TechSupport', printer: false })

      const calculator = createMockTool('calculator', () => 'Result: 42')

      // Turn 1: model calls BOTH calculator and delegation tool (invalid)
      // Turn 2: model retries with just the delegation tool (valid)
      const orchestratorModel = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'calculator', toolUseId: 'calc-1', input: {} },
          { type: 'toolUseBlock', name: 'TechSupport', toolUseId: 'tech-1', input: { input: 'help' } },
        ])
        .addTurn({
          type: 'toolUseBlock',
          name: 'TechSupport',
          toolUseId: 'tech-2',
          input: { input: 'help' },
        })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [calculator, techAgent.asTool({ delegate: true })],
        printer: false,
      })

      const result = await orchestrator.invoke('Do both things')

      // After the retry, the delegation succeeds
      expect(result.stopReason).toBe('endTurn')
      const textBlocks = result.lastMessage.content.filter((b) => b.type === 'textBlock')
      expect((textBlocks[0] as { text: string }).text).toBe('Specialist answer')
    })

    it('cancels all tools when two delegation tools are called simultaneously, then retries', async () => {
      const billingModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Billing response' })
      const techModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Tech response' })

      const billingAgent = new Agent({ model: billingModel, name: 'Billing', printer: false })
      const techAgent = new Agent({ model: techModel, name: 'TechSupport', printer: false })

      // Turn 1: model calls BOTH delegation tools simultaneously (invalid)
      // Turn 2: model retries with just one delegation tool (valid)
      const orchestratorModel = new MockMessageModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'Billing', toolUseId: 'bill-1', input: { input: 'refund' } },
          { type: 'toolUseBlock', name: 'TechSupport', toolUseId: 'tech-1', input: { input: 'wifi' } },
        ])
        .addTurn({
          type: 'toolUseBlock',
          name: 'TechSupport',
          toolUseId: 'tech-2',
          input: { input: 'wifi' },
        })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [billingAgent.asTool({ delegate: true }), techAgent.asTool({ delegate: true })],
        printer: false,
      })

      const result = await orchestrator.invoke('Handle both billing and tech')

      // After the retry, the delegation succeeds with the single tool
      expect(result.stopReason).toBe('endTurn')
      const textBlocks = result.lastMessage.content.filter((b) => b.type === 'textBlock')
      expect((textBlocks[0] as { text: string }).text).toBe('Tech response')
    })
  })

  describe('error resilience', () => {
    it('does not trigger delegation when sub-agent fails, loop continues', async () => {
      // Sub-agent model throws an error
      const failingModel = new MockMessageModel().addTurn(new Error('Sub-agent crashed'))
      const failingAgent = new Agent({ model: failingModel, name: 'FailAgent', printer: false })

      // Turn 1: model calls the delegation tool (which will error)
      // Turn 2: model produces a fallback text response after seeing the error
      const orchestratorModel = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'FailAgent',
          toolUseId: 'fail-1',
          input: { input: 'do something' },
        })
        .addTurn({ type: 'textBlock', text: 'Sorry, the specialist is unavailable.' })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [failingAgent.asTool({ delegate: true })],
        printer: false,
      })

      const result = await orchestrator.invoke('Help me')

      // Delegation did NOT trigger because the tool errored — model recovers
      expect(result.stopReason).toBe('endTurn')
      const textBlocks = result.lastMessage.content.filter((b) => b.type === 'textBlock')
      expect((textBlocks[0] as { text: string }).text).toBe('Sorry, the specialist is unavailable.')
    })
  })

  describe('cross-request state isolation', () => {
    it('does not leak delegation state when a later AfterTools hook throws', async () => {
      // Repro: first request — delegation tool succeeds (state committed), but
      // a later AfterToolsEvent hook throws. Second request should NOT see
      // stale stopReason: 'toolUse' from the first request.
      const subModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'STALE_FIRST_RESULT' })
      const subAgent = new Agent({ model: subModel, name: 'Sub', printer: false })

      // First request: model calls the delegation tool
      // Second request: model produces a fresh text response
      const orchestratorModel = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'Sub',
          toolUseId: 'del-1',
          input: { input: 'first request' },
        })
        .addTurn({ type: 'textBlock', text: 'FRESH_SECOND_RESULT' })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [subAgent.asTool({ delegate: true })],
        printer: false,
      })

      // Register a hook AFTER the plugin's hook so it fires after _onAfterTools
      // commits delegation state.
      let throwOnNext = true
      orchestrator.addHook(AfterToolsEvent, () => {
        if (throwOnNext) {
          throw new Error('AFTER_TOOLS_BOOM')
        }
      })

      // First invocation should throw because of the later hook
      await expect(orchestrator.invoke('first')).rejects.toThrow('AFTER_TOOLS_BOOM')

      // Disable the throwing hook for the second invocation
      throwOnNext = false

      // Second invocation must NOT produce stale delegation result
      const result = await orchestrator.invoke('second')
      expect(result.stopReason).toBe('endTurn')
      const textBlocks = result.lastMessage.content.filter((b) => b.type === 'textBlock')
      expect((textBlocks[0] as { text: string }).text).toBe('FRESH_SECOND_RESULT')
    })
  })

  describe('blank content skips delegation', () => {
    it('skips delegation when sub-agent returns empty text and loop continues', async () => {
      const emptyTextModel = new MockMessageModel().addTurn({ type: 'textBlock', text: '' })
      const emptyAgent = new Agent({ model: emptyTextModel, name: 'EmptyAgent', printer: false })

      // Turn 1: delegation tool call (sub-agent returns empty text → delegation skipped)
      // Turn 2: model produces a follow-up response since the loop continues
      const orchestratorModel = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'EmptyAgent',
          toolUseId: 'empty-1',
          input: { input: 'go' },
        })
        .addTurn({ type: 'textBlock', text: 'I continued.' })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [emptyAgent.asTool({ delegate: true })],
        printer: false,
      })

      const result = await orchestrator.invoke('go')

      // Delegation skipped — loop continued to the model's second turn
      expect(result.stopReason).toBe('endTurn')
      const textBlocks = result.lastMessage.content.filter((b) => b.type === 'textBlock')
      expect((textBlocks[0] as { text: string }).text).toBe('I continued.')
    })
  })

  describe('stateful model bypass', () => {
    it('skips delegation logic for delegation tools added after init — tool runs normally', async () => {
      class StatefulModel extends MockMessageModel {
        override get stateful(): boolean {
          return true
        }
      }

      const subModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Sub response' })
      const subAgent = new Agent({ model: subModel, name: 'Sub', printer: false })

      // Turn 1: model calls the delegation tool (which won't trigger delegation)
      // Turn 2: model produces final text after seeing tool result
      const statefulModel = new StatefulModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'Sub',
          toolUseId: 'del-1',
          input: { input: 'do something' },
        })
        .addTurn({ type: 'textBlock', text: 'Got the sub-agent response, done.' })

      // Create agent WITHOUT delegation tools so init-time check passes
      const orchestrator = new Agent({
        model: statefulModel,
        name: 'Orchestrator',
        tools: [],
        printer: false,
      })

      // Add delegation tool after initialization to bypass init-time check
      // (exercises the runtime guard path)
      await orchestrator.initialize()
      orchestrator.toolRegistry.add(subAgent.asTool({ delegate: true }))

      const result = await orchestrator.invoke('Do something')

      // Delegation did NOT trigger — model consumed the tool result normally
      expect(result.stopReason).toBe('endTurn')
      const textBlocks = result.lastMessage.content.filter((b) => b.type === 'textBlock')
      expect((textBlocks[0] as { text: string }).text).toBe('Got the sub-agent response, done.')
    })

    it('does not enforce single-call constraint for stateful models with runtime-added tools', async () => {
      class StatefulModel extends MockMessageModel {
        override get stateful(): boolean {
          return true
        }
      }

      const subModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Sub response' })
      const subAgent = new Agent({ model: subModel, name: 'Sub', printer: false })

      const calculator = createMockTool('calculator', () => 'Result: 42')

      // Model calls BOTH calculator and delegation tool simultaneously.
      // With a stateful model, this should NOT be cancelled.
      const statefulModel = new StatefulModel()
        .addTurn([
          { type: 'toolUseBlock', name: 'calculator', toolUseId: 'calc-1', input: {} },
          { type: 'toolUseBlock', name: 'Sub', toolUseId: 'del-1', input: { input: 'help' } },
        ])
        .addTurn({ type: 'textBlock', text: 'Both tools ran successfully.' })

      // Create agent with only the regular tool so init-time check passes
      const orchestrator = new Agent({
        model: statefulModel,
        name: 'Orchestrator',
        tools: [calculator],
        printer: false,
      })

      // Add delegation tool after initialization
      await orchestrator.initialize()
      orchestrator.toolRegistry.add(subAgent.asTool({ delegate: true }))

      const result = await orchestrator.invoke('Do both')

      // Both tools ran normally — no cancellation, no delegation
      expect(result.stopReason).toBe('endTurn')
      const textBlocks = result.lastMessage.content.filter((b) => b.type === 'textBlock')
      expect((textBlocks[0] as { text: string }).text).toBe('Both tools ran successfully.')
    })
  })

  describe('toContentBlocks conversion', () => {
    it('converts JsonBlock to TextBlock with JSON-stringified content', async () => {
      // Create a delegation tool that returns a JsonBlock directly.
      // This exercises the toContentBlocks helper's JsonBlock → TextBlock path
      // without involving the full structured output machinery.
      const jsonPayload = { items: ['a', 'b'], count: 2 }

      const jsonTool = new AgentAsTool({
        agent: (() => {
          // Sub-agent returns structured output via the schema tool
          const subModel = new MockMessageModel()
            .addTurn({
              type: 'toolUseBlock',
              name: 'strands_structured_output',
              toolUseId: 'so-1',
              input: jsonPayload,
            })
            .addTurn({ type: 'textBlock', text: '' })

          return new Agent({
            model: subModel,
            name: 'JsonAgent',
            structuredOutputSchema: z.object({ items: z.array(z.string()), count: z.number() }),
            printer: false,
          })
        })(),
        name: 'JsonAgent',
        delegate: true,
      })

      const orchestratorModel = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'JsonAgent',
        toolUseId: 'json-1',
        input: { input: 'get data' },
      })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [jsonTool],
        printer: false,
      })

      const result = await orchestrator.invoke('get data')

      expect(result.stopReason).toBe('endTurn')
      // The JsonBlock must be converted to a TextBlock containing stringified JSON
      expect(result.lastMessage.content).toHaveLength(1)
      const textBlocks = result.lastMessage.content.filter((b) => b.type === 'textBlock')
      expect(textBlocks).toHaveLength(1)
      expect(JSON.parse((textBlocks[0] as { text: string }).text)).toEqual(jsonPayload)
    })
  })

  describe('init-time validation', () => {
    it('throws when delegation tools are present on a stateful model', async () => {
      class StatefulModel extends MockMessageModel {
        override get stateful(): boolean {
          return true
        }
      }

      const subModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hi' })
      const subAgent = new Agent({ model: subModel, name: 'Sub', printer: false })

      const statefulModel = new StatefulModel().addTurn({ type: 'textBlock', text: 'Hi' })

      const orchestrator = new Agent({
        model: statefulModel,
        name: 'Orchestrator',
        tools: [subAgent.asTool({ delegate: true })],
        printer: false,
      })

      await expect(orchestrator.initialize()).rejects.toThrow(/not supported with stateful models/)
    })
  })

  describe('event streaming', () => {
    it('unwraps inner agent stream events as native events in the parent stream', async () => {
      const subModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Delegated response' })
      const subAgent = new Agent({ model: subModel, name: 'Sub', printer: false })

      const orchestratorModel = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'Sub',
        toolUseId: 'del-1',
        input: { input: 'handle this' },
      })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [subAgent.asTool({ delegate: true })],
        printer: false,
      })

      const events: StreamEvent[] = []
      const stream = orchestrator.stream('handle this')
      let next = await stream.next()
      while (!next.done) {
        events.push(next.value)
        next = await stream.next()
      }

      // All events should be native StreamEvent instances (not raw ToolStreamEvent wrappers)
      expect(events.length).toBeGreaterThan(0)
      for (const event of events) {
        expect(event).toBeInstanceOf(StreamEvent)
      }

      // Inner agent's model streaming and content blocks should surface natively
      const eventTypes = events.map((e) => (e as { type: string }).type)
      expect(eventTypes).toContain('modelStreamUpdateEvent')
      expect(eventTypes).toContain('contentBlockEvent')
    })
  })

  describe('late-error-flip', () => {
    it('does not stop the loop when a later AfterToolsEvent hook changes the result to error', async () => {
      const subModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'SECRET_RAW' })
      const subAgent = new Agent({ model: subModel, name: 'Sub', printer: false })

      // Turn 1: model calls the delegation tool (which a later hook will flip to error)
      // Turn 2: model produces a recovery response
      const orchestratorModel = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'Sub',
          toolUseId: 'del-1',
          input: { input: 'do something' },
        })
        .addTurn({ type: 'textBlock', text: 'RECOVERED_AFTER_ERROR' })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [subAgent.asTool({ delegate: true })],
        printer: false,
      })

      // Register an AfterToolsEvent hook at DEFAULT priority (fires before the
      // delegation plugin's SDK_LAST hook) that flips the result to error.
      orchestrator.addHook(AfterToolsEvent, (event) => {
        for (const block of event.message.content) {
          if (block instanceof ToolResultBlock && block.toolUseId === 'del-1') {
            ;(block as { status: string }).status = 'error'
            block.content.splice(0, block.content.length, new TextBlock('REDACTED'))
          }
        }
      })

      const result = await orchestrator.invoke('do something')

      // Delegation must NOT trigger — model should recover with a second turn
      expect(result.stopReason).toBe('endTurn')
      const textBlocks = result.lastMessage.content.filter((b) => b.type === 'textBlock')
      expect((textBlocks[0] as { text: string }).text).toBe('RECOVERED_AFTER_ERROR')
    })
  })

  describe('nested-delegation', () => {
    it('child delegation does not leak to the parent agent', async () => {
      // Middle delegates to Leaf (endTurn). Parent calls Middle as a
      // non-delegation tool. Parent should continue to its second model call.
      const leafModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Leaf response' })
      const leafAgent = new Agent({ model: leafModel, name: 'Leaf', printer: false })

      const middleModel = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'Leaf',
        toolUseId: 'leaf-1',
        input: { input: 'go' },
      })
      const middleAgent = new Agent({
        model: middleModel,
        name: 'Middle',
        tools: [leafAgent.asTool({ delegate: true })],
        printer: false,
      })

      const parentModel = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'Middle', toolUseId: 'mid-1', input: { input: 'go' } })
        .addTurn({ type: 'textBlock', text: 'PARENT_FINAL' })

      const parent = new Agent({ model: parentModel, name: 'Parent', tools: [middleAgent.asTool()], printer: false })
      const result = await parent.invoke('go')

      expect(result.stopReason).toBe('endTurn')
      expect((result.lastMessage.content[0] as { text: string }).text).toBe('PARENT_FINAL')
    })
  })

  describe('delegate-success then retry as regular tool', () => {
    it('does not promote the regular tool result as delegated when retry swaps to a non-delegation tool', async () => {
      const subModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'DELEGATED_ANSWER' })
      const subAgent = new Agent({ model: subModel, name: 'Sub', printer: false })

      const regularTool = createMockTool('regular', () => 'REGULAR_RESULT')

      // Turn 1: model calls the delegation tool
      // Turn 2: model produces final text after seeing the regular result
      const orchestratorModel = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'Sub',
          toolUseId: 'tool-1',
          input: { input: 'do something' },
        })
        .addTurn({ type: 'textBlock', text: 'PARENT_FOLLOW_UP' })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [subAgent.asTool({ delegate: true }), regularTool],
        printer: false,
      })

      let attemptCount = 0
      // After the first successful delegation call, request a retry
      orchestrator.addHook(AfterToolCallEvent, (event) => {
        if (event.toolUse.toolUseId === 'tool-1') {
          attemptCount++
          if (attemptCount === 1) {
            event.retry = true
          }
        }
      })

      // On the retry's BeforeToolCallEvent, swap to the regular tool
      orchestrator.addHook(BeforeToolCallEvent, (event) => {
        if (event.toolUse.toolUseId === 'tool-1' && attemptCount === 1) {
          event.selectedTool = regularTool
        }
      })

      const result = await orchestrator.invoke('do something')

      // Delegation must NOT trigger — model should produce a follow-up response
      expect(result.stopReason).toBe('endTurn')
      const textBlocks = result.lastMessage.content.filter((b) => b.type === 'textBlock')
      expect((textBlocks[0] as { text: string }).text).toBe('PARENT_FOLLOW_UP')
    })
  })

  describe('structured output suppresses delegation', () => {
    it('does not trigger delegation when parent has a structured output schema', async () => {
      const subModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Sub answer' })
      const subAgent = new Agent({ model: subModel, name: 'Sub', printer: false })

      // Turn 1: calls delegation tool (delegation skipped because structured output schema is set)
      // Turn 2: calls the structured output tool as forced
      const orchestratorModel = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'Sub',
          toolUseId: 'del-1',
          input: { input: 'go' },
        })
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'so-1',
          input: { answer: 'Sub answer' },
        })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [subAgent.asTool({ delegate: true })],
        structuredOutputSchema: z.object({ answer: z.string() }),
        printer: false,
      })

      const result = await orchestrator.invoke('go')

      // Delegation suppressed — structured output takes over
      expect(result.stopReason).toBe('toolUse')
      expect(result.structuredOutput).toEqual({ answer: 'Sub answer' })
    })
  })

  describe('delegation emits correct MessageAddedEvents', () => {
    it('emits exactly one assistant MessageAddedEvent with delegated content (no placeholder)', async () => {
      const subModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Balance: $42' })
      const subAgent = new Agent({ model: subModel, name: 'billing', printer: false })

      const orchestratorModel = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'billing',
        toolUseId: 'c1',
        input: { input: 'check' },
      })

      const orchestrator = new Agent({
        model: orchestratorModel,
        name: 'Orchestrator',
        tools: [subAgent.asTool({ delegate: true })],
        printer: false,
      })

      const assistantMessages: Message[] = []
      orchestrator.addHook(MessageAddedEvent, (event) => {
        if (event.agent === orchestrator && event.message.role === 'assistant') {
          assistantMessages.push(event.message)
        }
      })

      await orchestrator.invoke('Check balance')

      // Two assistant MessageAddedEvents: toolUse turn, then the delegated content
      expect(assistantMessages).toHaveLength(2)
      expect(assistantMessages[1]!.content).toEqual([new TextBlock('Balance: $42')])

      // History ends with the delegated content, no placeholder
      expect(orchestrator.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    })
  })
})
