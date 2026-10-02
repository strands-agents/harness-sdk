import { describe, expect, it } from 'vitest'

import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { MiddlewareRegistry } from '../../../middleware/registry.js'
import { Meter } from '../../../telemetry/meter.js'
import { Tracer } from '../../../telemetry/tracer.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { ToolStreamEvent } from '../../tool.js'
import { ConcurrentToolExecutor } from '../concurrent.js'
import { SequentialToolExecutor } from '../sequential.js'

import type { Tool, ToolContext, ToolStreamGenerator } from '../../tool.js'

// Guards https://github.com/strands-agents/harness-sdk/issues/4795: closing the executor's generator early
// must close the tool's generator too, so a tool's `finally` cleanup always runs.
describe.each([
  ['SequentialToolExecutor', (): SequentialToolExecutor => new SequentialToolExecutor()],
  ['ConcurrentToolExecutor', (): ConcurrentToolExecutor => new ConcurrentToolExecutor()],
])('%s early close', (_name, createExecutor) => {
  it('runs the tool generator finally when the executor generator is returned mid-stream', async () => {
    let cleanedUp = false
    const tool: Tool = {
      name: 'streaming',
      description: 'Streams two events',
      toolSpec: {
        name: 'streaming',
        description: 'Streams two events',
        inputSchema: { type: 'object', properties: {} },
      },
      async *stream(context: ToolContext): ToolStreamGenerator {
        try {
          yield new ToolStreamEvent({ data: 'first' })
          yield new ToolStreamEvent({ data: 'second' })
          return new ToolResultBlock({
            toolUseId: context.toolUse.toolUseId,
            status: 'success',
            content: [new TextBlock('ok')],
          })
        } finally {
          cleanedUp = true
        }
      },
    }
    const agent = new Agent({ model: new MockMessageModel(), tools: [tool], printer: false })
    const toolUseBlocks = [new ToolUseBlock({ name: 'streaming', toolUseId: 'streaming-1', input: {} })]
    const generator = createExecutor().execute(
      {
        agent,
        middlewareRegistry: new MiddlewareRegistry(),
        tracer: new Tracer(),
        meter: new Meter(),
        cancelSignal: new AbortController().signal,
      },
      {
        toolUseBlocks,
        toolResultBlocks: [],
        invocationState: {},
        assistantMessage: new Message({ role: 'assistant', content: toolUseBlocks }),
      }
    )

    let next = await generator.next()
    while (!next.done && next.value.type !== 'toolStreamUpdateEvent') {
      next = await generator.next()
    }
    expect(next.done).toBe(false)
    expect(cleanedUp).toBe(false)

    await generator.return(undefined as never)

    expect(cleanedUp).toBe(true)
  })
})
