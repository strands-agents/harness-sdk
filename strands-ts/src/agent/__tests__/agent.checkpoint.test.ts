import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { Checkpoint } from '../../experimental/checkpoint.js'
import { CheckpointError } from '../../errors.js'
import type { InvokeArgs } from '../../types/agent.js'
import { AfterModelCallEvent, AfterToolsEvent, BeforeInvocationEvent, BeforeToolCallEvent } from '../../hooks/events.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'

/** A model that always returns a single tool-use turn (reused across calls). */
function toolUseModel(): MockMessageModel {
  return new MockMessageModel().addTurn({ type: 'toolUseBlock', name: 'noop', toolUseId: 'tool-1', input: {} })
}

describe('Agent checkpointing', () => {
  describe('constructor flag', () => {
    it('does not checkpoint by default (checkpointing defaults to false)', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'done' })
      const agent = new Agent({ model, printer: false })

      const result = await agent.invoke('hi')

      expect(result.stopReason).toBe('endTurn')
      expect(result.checkpoint).toBeUndefined()
    })

    it('pauses at a cycle boundary when checkpointing is true', async () => {
      const agent = new Agent({
        model: toolUseModel(),
        tools: [createMockTool('noop', () => 'ok')],
        checkpointing: true,
        printer: false,
      })

      const result = await agent.invoke('hi')

      expect(result.stopReason).toBe('checkpoint')
      expect(result.checkpoint).toBeDefined()
    })
  })

  describe('resume validation', () => {
    it('throws CheckpointError when a checkpointResume block is passed but checkpointing is false', async () => {
      const agent = new Agent({ model: toolUseModel(), printer: false })
      const args = { checkpointResume: { checkpoint: {} } } as unknown as InvokeArgs

      await expect(agent.invoke(args)).rejects.toThrow(CheckpointError)
    })

    it('throws CheckpointError when the checkpointResume block is missing its checkpoint key', async () => {
      const agent = new Agent({ model: toolUseModel(), checkpointing: true, printer: false })
      const args = { checkpointResume: {} } as unknown as InvokeArgs

      await expect(agent.invoke(args)).rejects.toThrow(CheckpointError)
    })

    it('throws CheckpointError when the checkpoint schema version is incompatible', async () => {
      const agent = new Agent({ model: toolUseModel(), checkpointing: true, printer: false })
      const args = { checkpointResume: { checkpoint: { position: 'afterModel', schemaVersion: '0.1' } } } as InvokeArgs

      await expect(agent.invoke(args)).rejects.toThrow(CheckpointError)
    })
  })

  describe('cycle boundaries', () => {
    it('emits an afterModel checkpoint (cycle 0) before running tools', async () => {
      let toolRan = false
      const agent = new Agent({
        model: toolUseModel(),
        tools: [createMockTool('noop', () => ((toolRan = true), 'ok'))],
        checkpointing: true,
        printer: false,
      })

      const result = await agent.invoke('hi')

      expect(result.stopReason).toBe('checkpoint')
      expect(result.checkpoint?.position).toBe('afterModel')
      expect(result.checkpoint?.cycleIndex).toBe(0)
      expect(toolRan).toBe(false)
      // Deferred-append invariant: the assistant tool_use message is NOT appended
      // at afterModel, so the conversation stays reinvokable (no dangling tool_use).
      const dangling = agent.messages.filter((m) => m.content.some((b) => b.type === 'toolUseBlock'))
      expect(dangling).toHaveLength(0)
    })

    it('resuming from afterModel runs tools then emits an afterTools checkpoint (cycle 0)', async () => {
      let toolRan = false
      const agent = new Agent({
        model: toolUseModel(),
        tools: [createMockTool('noop', () => ((toolRan = true), 'ok'))],
        checkpointing: true,
        printer: false,
      })

      const resume = {
        checkpointResume: { checkpoint: new Checkpoint({ position: 'afterModel', cycleIndex: 0 }).toJSON() },
      }
      const result = await agent.invoke(resume)

      expect(result.stopReason).toBe('checkpoint')
      expect(result.checkpoint?.position).toBe('afterTools')
      expect(result.checkpoint?.cycleIndex).toBe(0)
      expect(toolRan).toBe(true)
    })

    it('does not append hook messages when resuming from an afterModel checkpoint', async () => {
      const agent = new Agent({
        model: toolUseModel(),
        tools: [createMockTool('noop', () => 'ok')],
        checkpointing: true,
        printer: false,
      })
      const contextMessage = new Message({ role: 'user', content: [new TextBlock('context')] })
      agent.addHook(BeforeInvocationEvent, (event) => {
        event.messages.push(contextMessage)
      })

      const checkpointResult = await agent.invoke('hi')
      const result = await agent.invoke({
        checkpointResume: { checkpoint: checkpointResult.checkpoint!.toJSON() },
      })

      expect(result.stopReason).toBe('checkpoint')
      expect(result.checkpoint?.position).toBe('afterTools')
      expect(agent.messages).toEqual([
        new Message({ role: 'user', content: [new TextBlock('hi')], trackingId: anyTrackingId }),
        contextMessage,
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'noop', toolUseId: 'tool-1', input: {} })],
          trackingId: anyTrackingId,
        }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [new TextBlock('ok')],
            }),
          ],
          trackingId: anyTrackingId,
        }),
      ])
    })

    it('resuming from afterTools increments the cycle index for the next afterModel checkpoint', async () => {
      const agent = new Agent({
        model: toolUseModel(),
        tools: [createMockTool('noop', () => 'ok')],
        checkpointing: true,
        printer: false,
      })

      const resume = {
        checkpointResume: { checkpoint: new Checkpoint({ position: 'afterTools', cycleIndex: 2 }).toJSON() },
      }
      const result = await agent.invoke(resume)

      expect(result.stopReason).toBe('checkpoint')
      expect(result.checkpoint?.position).toBe('afterModel')
      expect(result.checkpoint?.cycleIndex).toBe(3)
    })

    it('does not checkpoint a plain end-turn cycle (no tool use)', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'done' })
      const agent = new Agent({ model, checkpointing: true, printer: false })

      const result = await agent.invoke('hi')

      expect(result.stopReason).toBe('endTurn')
      expect(result.checkpoint).toBeUndefined()
    })

    it('starts a fresh invocation at cycle 0 (no cycle-index leak between invocations)', async () => {
      const agent = new Agent({
        model: toolUseModel(),
        tools: [createMockTool('noop', () => 'ok')],
        checkpointing: true,
        printer: false,
      })

      // Prior invocation advances an internal position via resume.
      await agent.invoke({
        checkpointResume: { checkpoint: new Checkpoint({ position: 'afterTools', cycleIndex: 5 }).toJSON() },
      })

      // A fresh, non-resume invocation must start over at cycle 0.
      const fresh = await agent.invoke('hi')
      expect(fresh.checkpoint?.position).toBe('afterModel')
      expect(fresh.checkpoint?.cycleIndex).toBe(0)
    })
  })

  describe('cancel precedence', () => {
    it('cancel beats the afterModel checkpoint', async () => {
      // Cancel arrives *during* the model call (via an AfterModelCallEvent hook),
      // after the top-of-loop cancellation check has already passed. This forces
      // control through the afterModel boundary, where the cancel path must win
      // over the checkpoint emission. (A pre-aborted signal would instead throw at
      // the top of the loop and never reach the boundary.)
      const controller = new AbortController()
      const agent = new Agent({
        model: toolUseModel(),
        tools: [createMockTool('noop', () => 'ok')],
        checkpointing: true,
        printer: false,
      })
      agent.addHook(AfterModelCallEvent, () => controller.abort())

      const result = await agent.invoke('hi', { cancelSignal: controller.signal })

      expect(result.stopReason).toBe('cancelled')
      expect(result.checkpoint).toBeUndefined()
    })

    it('cancel beats the afterTools checkpoint', async () => {
      const controller = new AbortController()
      const agent = new Agent({
        model: toolUseModel(),
        // Tool aborts mid-execution; the afterTools checkpoint must yield to cancel.
        tools: [createMockTool('noop', () => (controller.abort(), 'ok'))],
        checkpointing: true,
        printer: false,
      })

      // Resume from afterModel so tools execute this invocation.
      const resume = {
        checkpointResume: { checkpoint: new Checkpoint({ position: 'afterModel', cycleIndex: 0 }).toJSON() },
      }
      const result = await agent.invoke(resume, { cancelSignal: controller.signal })

      expect(result.stopReason).toBe('cancelled')
      expect(result.checkpoint).toBeUndefined()
    })
  })

  describe('interrupt precedence', () => {
    it('interrupt beats the afterTools checkpoint', async () => {
      const agent = new Agent({
        model: toolUseModel(),
        tools: [createMockTool('noop', () => 'ok')],
        checkpointing: true,
        printer: false,
      })
      // A hook interrupts before the tool runs. Resume from afterModel so the
      // cycle reaches tool execution; the interrupt must win over the afterTools
      // checkpoint that would otherwise fire.
      agent.addHook(BeforeToolCallEvent, (event) => {
        event.interrupt({ name: 'confirm', reason: 'ok?' })
      })

      const resume = {
        checkpointResume: { checkpoint: new Checkpoint({ position: 'afterModel', cycleIndex: 0 }).toJSON() },
      }
      const result = await agent.invoke(resume)

      expect(result.stopReason).toBe('interrupt')
      expect(result.checkpoint).toBeUndefined()
    })
  })

  describe('afterTools suppression', () => {
    it('a hook-requested endTurn wins over the afterTools checkpoint', async () => {
      const agent = new Agent({
        model: toolUseModel(),
        tools: [createMockTool('noop', () => 'ok')],
        checkpointing: true,
        printer: false,
      })
      agent.addHook(AfterToolsEvent, (event) => {
        event.endTurn = true
      })

      // Resume from afterModel so tools run and the afterTools boundary is reached.
      const resume = {
        checkpointResume: { checkpoint: new Checkpoint({ position: 'afterModel', cycleIndex: 0 }).toJSON() },
      }
      const result = await agent.invoke(resume)

      expect(result.stopReason).toBe('endTurn')
      expect(result.checkpoint).toBeUndefined()
    })
  })
})
