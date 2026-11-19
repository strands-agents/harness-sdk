import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import { AfterToolCallEvent, BeforeToolCallEvent } from '../../hooks/index.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { ExecuteToolStage } from '../../middleware/stages.js'
import type { MiddlewareHandlerOf } from '../../middleware/types.js'
import type { ToolContext } from '../../tools/tool.js'
import type { InterruptParams } from '../../types/interrupt.js'
import { TextBlock, ToolResultBlock } from '../../types/messages.js'

const toolUse = { name: 'echo', toolUseId: 'direct-1', input: { text: 'hi' } }

function refuse(params: InterruptParams): never {
  throw new Error(`refused: ${params.name}`)
}

function callContext(interrupt: ToolContext['interrupt'] = refuse): Parameters<Agent['_executeToolCall']>[1] {
  return { invocationState: { principal: 'alice' }, cancelSignal: new AbortController().signal, interrupt }
}

function echoAgent(calls: unknown[] = []): Agent {
  const echo = createMockTool('echo', (context) => {
    calls.push(context.toolUse.input)
    return 'echoed'
  })
  return new Agent({ model: new MockMessageModel(), tools: [echo], printer: false })
}

describe('Agent._executeToolCall', () => {
  it('runs hooks and tool middleware around the tool and returns its result', async () => {
    const order: string[] = []
    const agent = echoAgent()
    agent.addHook(BeforeToolCallEvent, (event) => void order.push(`before:${event.invocationState.principal}`))
    agent.addHook(AfterToolCallEvent, (event) => void order.push(`after:${event.result.status}`))
    const middleware: MiddlewareHandlerOf<typeof ExecuteToolStage> = async function* (context, next) {
      order.push('middleware')
      return yield* next(context)
    }
    agent.addMiddleware(ExecuteToolStage, middleware)

    const result = await agent._executeToolCall(toolUse, callContext())

    expect(result).toEqual(
      new ToolResultBlock({ toolUseId: 'direct-1', status: 'success', content: [new TextBlock('echoed')] })
    )
    expect(order).toEqual(['before:alice', 'middleware', 'after:success'])
  })

  it('refuses the call with the interrupt error when a hook interrupts', async () => {
    const calls: unknown[] = []
    const agent = echoAgent(calls)
    agent.addHook(BeforeToolCallEvent, (event) => void event.interrupt({ name: 'approve' }))

    const result = await agent._executeToolCall(toolUse, callContext())

    expect(result).toEqual(
      new ToolResultBlock({ toolUseId: 'direct-1', status: 'error', content: [new TextBlock('refused: approve')] })
    )
    expect(calls).toEqual([])
    expect(agent._interruptState.interrupts).toEqual({})
  })

  it('refuses the call even when the hook swallows the interrupt error', async () => {
    const calls: unknown[] = []
    const agent = echoAgent(calls)
    agent.addHook(BeforeToolCallEvent, (event) => {
      try {
        event.interrupt({ name: 'approve' })
      } catch {
        // a handler that proceeds on error
      }
    })

    const result = await agent._executeToolCall(toolUse, callContext())

    expect(result.status).toBe('error')
    expect(calls).toEqual([])
  })

  it('hands the interrupt response to the hook and runs the tool', async () => {
    const calls: unknown[] = []
    const answers: unknown[] = []
    const agent = echoAgent(calls)
    agent.addHook(BeforeToolCallEvent, (event) => void answers.push(event.interrupt({ name: 'approve' })))

    const result = await agent._executeToolCall(
      toolUse,
      callContext(<T>(): T => 'yes' as T)
    )

    expect(result.status).toBe('success')
    expect(answers).toEqual(['yes'])
    expect(calls).toEqual([{ text: 'hi' }])
  })

  it('does not carry a refused tool interrupt into a retry', async () => {
    let attempts = 0
    const flaky = createMockTool('echo', (context) => {
      attempts++
      if (attempts === 1) {
        context.interrupt({ name: 'approve' })
      }
      return 'echoed'
    })
    const agent = new Agent({ model: new MockMessageModel(), tools: [flaky], printer: false })
    agent.addHook(AfterToolCallEvent, (event) => void (event.retry = event.result.status === 'error'))

    const result = await agent._executeToolCall(toolUse, callContext())

    expect(result.status).toBe('success')
    expect(attempts).toBe(2)
  })

  it('retries when an afterToolCall hook asks for it', async () => {
    const calls: unknown[] = []
    const agent = echoAgent(calls)
    agent.addHook(AfterToolCallEvent, (event) => void (event.retry = calls.length < 2))

    await agent._executeToolCall(toolUse, callContext())

    expect(calls).toHaveLength(2)
  })
})
