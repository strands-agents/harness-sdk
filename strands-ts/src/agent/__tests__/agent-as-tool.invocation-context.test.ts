import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import { unwrapInvocationContext } from '../invocation-context.js'
import { AfterToolCallEvent, BeforeModelCallEvent } from '../../hooks/events.js'
import { limitStopMessage, TextBlock, ToolResultBlock } from '../../types/messages.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'

describe('AgentAsTool request-wide invocation context', () => {
  it('folds the inner agent model usage into the parent request total', async () => {
    const innerModel = new MockMessageModel().addTurn(
      { type: 'textBlock', text: 'inner-done' },
      { usage: { inputTokens: 0, outputTokens: 60, totalTokens: 60 } }
    )
    const inner = new Agent({ model: innerModel, name: 'inner', description: 'inner agent' })

    let innerSawInvocationContext = false
    let innerSeenOutputTokens: number | undefined
    inner.addHook(BeforeModelCallEvent, (event) => {
      const invocationContext = unwrapInvocationContext(event.invocationContext)
      innerSawInvocationContext = invocationContext !== undefined
      innerSeenOutputTokens = invocationContext?.usage.outputTokens
    })

    const outerModel = new MockMessageModel()
      .addTurn([{ type: 'toolUseBlock', name: 'inner', toolUseId: 'tu-1', input: { input: 'hi' } }], {
        usage: { inputTokens: 0, outputTokens: 60, totalTokens: 60 },
      })
      .addTurn(
        { type: 'textBlock', text: 'outer-done' },
        { usage: { inputTokens: 0, outputTokens: 10, totalTokens: 10 } }
      )
    const outer = new Agent({ model: outerModel, tools: [inner.asTool()] })

    await outer.invoke('run inner')

    expect(innerSawInvocationContext).toBe(true)
    expect(innerSeenOutputTokens).toBe(60)
  })

  it('trips a limit that only the parent-plus-child total exceeds', async () => {
    const innerModel = new MockMessageModel().addTurn(
      { type: 'textBlock', text: 'inner-done' },
      { usage: { inputTokens: 0, outputTokens: 60, totalTokens: 60 } }
    )
    const inner = new Agent({ model: innerModel, name: 'inner', description: 'inner agent' })

    const outerModel = new MockMessageModel()
      .addTurn([{ type: 'toolUseBlock', name: 'inner', toolUseId: 'tu-1', input: { input: 'hi' } }], {
        usage: { inputTokens: 0, outputTokens: 60, totalTokens: 60 },
      })
      .addTurn(
        { type: 'textBlock', text: 'outer-done' },
        { usage: { inputTokens: 0, outputTokens: 60, totalTokens: 60 } }
      )
    const outer = new Agent({ model: outerModel, tools: [inner.asTool()] })

    const result = await outer.invoke('run inner', { limits: { outputTokens: 100 } })

    expect(result.stopReason).toBe('limitOutputTokens')
  })

  it('returns an error result when the child stops on the shared limit', async () => {
    const inner = new Agent({
      model: new MockMessageModel().addTurn({ type: 'textBlock', text: 'never reached' }),
      name: 'inner',
      description: 'inner agent',
      printer: false,
    })
    const outer = new Agent({
      model: new MockMessageModel().addTurn(
        [{ type: 'toolUseBlock', name: 'inner', toolUseId: 'tu-1', input: { input: 'hi' } }],
        { usage: { inputTokens: 0, outputTokens: 60, totalTokens: 60 } }
      ),
      tools: [inner.asTool()],
      printer: false,
    })
    let toolResult: ToolResultBlock | undefined
    outer.addHook(AfterToolCallEvent, (event) => {
      toolResult = event.result
    })

    const result = await outer.invoke('run inner', { limits: { outputTokens: 50 } })

    expect(result.stopReason).toBe('limitOutputTokens')
    expect(toolResult).toEqual(
      new ToolResultBlock({
        toolUseId: 'tu-1',
        status: 'error',
        content: [new TextBlock(`Error: ${limitStopMessage('inner', 'limitOutputTokens')}`)],
        error: expect.any(Error),
      })
    )
  })
})
