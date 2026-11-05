import { describe, expect, it } from 'vitest'

import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { AfterToolCallEvent } from '../../../hooks/events.js'
import { ExecuteToolStage } from '../../../middleware/stages.js'
import { MiddlewareRegistry } from '../../../middleware/registry.js'
import { Meter } from '../../../telemetry/meter.js'
import { Tracer } from '../../../telemetry/tracer.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { SequentialToolExecutor } from '../sequential.js'

import type { ToolExecutorOptions } from '../executor.js'
import type { AgentStreamEvent } from '../../../types/agent.js'

function createOptions(
  agent: Agent,
  cancelSignal: AbortSignal,
  middlewareRegistry = new MiddlewareRegistry()
): ToolExecutorOptions {
  return {
    agent,
    middlewareRegistry,
    tracer: new Tracer(),
    meter: new Meter(),
    cancelSignal,
  }
}

async function runExecutor(
  executor: SequentialToolExecutor,
  options: ToolExecutorOptions,
  toolUseBlocks: ToolUseBlock[],
  onEvent?: (event: AgentStreamEvent) => void
): Promise<ToolResultBlock[]> {
  const toolResultBlocks: ToolResultBlock[] = []
  const assistantMessage = new Message({ role: 'assistant', content: toolUseBlocks })
  const generator = executor.execute(options, {
    toolUseBlocks,
    toolResultBlocks,
    invocationState: {},
    assistantMessage,
  })

  let next = await generator.next()
  while (!next.done) {
    onEvent?.(next.value)
    next = await generator.next()
  }

  return toolResultBlocks
}

describe('ToolExecutor cancellation signal', () => {
  it('keeps middleware and tools on the supplied execution signal', async () => {
    const executionController = new AbortController()
    const replacementSignal = new AbortController().signal
    let middlewareSignal: AbortSignal | undefined
    let toolSignal: AbortSignal | undefined
    const tool = createMockTool('probe', (context) => {
      toolSignal = context.cancelSignal
      return 'ok'
    })
    const agent = new Agent({ model: new MockMessageModel(), tools: [tool], printer: false })
    const middlewareRegistry = new MiddlewareRegistry()
    middlewareRegistry.add(ExecuteToolStage, async function* (context, next) {
      middlewareSignal = context.cancelSignal
      return yield* next({ ...context, cancelSignal: replacementSignal })
    })

    const results = await runExecutor(
      new SequentialToolExecutor(),
      createOptions(agent, executionController.signal, middlewareRegistry),
      [new ToolUseBlock({ name: 'probe', toolUseId: 'probe-1', input: {} })]
    )

    expect(executionController.signal).not.toBe(agent.cancelSignal)
    expect({
      middlewareSignal,
      toolSignal,
      resultStatus: results[0]?.status,
    }).toEqual({
      middlewareSignal: executionController.signal,
      toolSignal: executionController.signal,
      resultStatus: 'success',
    })
  })

  it('uses the supplied signal between sequential tool executions', async () => {
    const executionController = new AbortController()
    const executedTools: string[] = []
    const firstTool = createMockTool('first', () => {
      executedTools.push('first')
      executionController.abort()
      return 'done'
    })
    const secondTool = createMockTool('second', () => {
      executedTools.push('second')
      return 'unexpected'
    })
    const agent = new Agent({
      model: new MockMessageModel(),
      tools: [firstTool, secondTool],
      printer: false,
    })

    const results = await runExecutor(new SequentialToolExecutor(), createOptions(agent, executionController.signal), [
      new ToolUseBlock({ name: 'first', toolUseId: 'first-1', input: {} }),
      new ToolUseBlock({ name: 'second', toolUseId: 'second-1', input: {} }),
    ])

    expect(agent.cancelSignal.aborted).toBe(false)
    expect(executedTools).toEqual(['first'])
    expect(results).toEqual([
      new ToolResultBlock({
        toolUseId: 'first-1',
        status: 'success',
        content: [new TextBlock('done')],
      }),
      new ToolResultBlock({
        toolUseId: 'second-1',
        status: 'error',
        content: [new TextBlock('Tool execution cancelled')],
      }),
    ])
  })

  it('does not retry after the supplied signal is aborted', async () => {
    const executionController = new AbortController()
    let toolCallCount = 0
    const tool = createMockTool('retryable', () => {
      toolCallCount += 1
      return 'done'
    })
    const agent = new Agent({ model: new MockMessageModel(), tools: [tool], printer: false })
    let afterToolCallCount = 0

    await runExecutor(
      new SequentialToolExecutor(),
      createOptions(agent, executionController.signal),
      [new ToolUseBlock({ name: 'retryable', toolUseId: 'retry-1', input: {} })],
      (event) => {
        if (event instanceof AfterToolCallEvent && afterToolCallCount === 0) {
          afterToolCallCount += 1
          executionController.abort()
          event.retry = true
        }
      }
    )

    expect(agent.cancelSignal.aborted).toBe(false)
    expect(toolCallCount).toBe(1)
    expect(afterToolCallCount).toBe(1)
  })
})
