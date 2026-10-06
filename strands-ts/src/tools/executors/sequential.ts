import { ToolResultEvent } from '../../hooks/events.js'
import { InterruptError } from '../../interrupt.js'
import { TextBlock, ToolResultBlock } from '../../types/messages.js'
import { ToolExecutor } from './executor.js'

import type { AgentStreamEvent } from '../../types/agent.js'
import type { ToolExecutionInput, ToolExecutorOptions } from './executor.js'

/**
 * Executes tool calls one at a time.
 *
 * @example
 * ```typescript
 * import { Agent, SequentialToolExecutor } from '@strands-agents/sdk'
 *
 * // The string shorthand keeps imports minimal.
 * const agent = new Agent({ toolExecutor: 'sequential' })
 *
 * // Passing an instance is equivalent if you prefer to be explicit.
 * const explicitAgent = new Agent({ toolExecutor: new SequentialToolExecutor() })
 * ```
 */
export class SequentialToolExecutor extends ToolExecutor {
  /**
   * Executes tool calls in source order, honoring the execution cancellation signal between
   * calls to short-circuit tools that have not started.
   *
   * @param options - Agent dependencies used to execute tools
   * @param input - Tool calls and invocation state
   * @returns Stream of tool lifecycle events
   * @internal
   */
  override async *execute(
    options: ToolExecutorOptions,
    input: ToolExecutionInput
  ): AsyncGenerator<AgentStreamEvent, void, undefined> {
    const { toolUseBlocks, toolResultBlocks, invocationState, assistantMessage, completedToolResults } = input

    // Keyed by the model-issued toolUseId so interrupt state matches the
    // model's tool-use blocks.
    const resultsByToolUseId = new Map<string, ToolResultBlock>(completedToolResults)

    for (const toolUseBlock of toolUseBlocks) {
      const completedResult = completedToolResults?.get(toolUseBlock.toolUseId)
      if (completedResult) {
        // Resume results belong in the final message without replaying lifecycle events.
        toolResultBlocks.push(completedResult)
        continue
      }

      if (options.cancelSignal.aborted) {
        const cancelBlock = new ToolResultBlock({
          toolUseId: toolUseBlock.toolUseId,
          status: 'error',
          content: [new TextBlock('Tool execution cancelled')],
        })
        toolResultBlocks.push(cancelBlock)
        resultsByToolUseId.set(toolUseBlock.toolUseId, cancelBlock)
        yield new ToolResultEvent({
          agent: options.agent,
          invocation: options.invocation,
          result: cancelBlock,
          invocationState,
        })
        continue
      }

      try {
        const toolResultBlock = yield* this.executeTool(options, toolUseBlock, invocationState)
        toolResultBlocks.push(toolResultBlock)
        resultsByToolUseId.set(toolUseBlock.toolUseId, toolResultBlock)
        yield new ToolResultEvent({
          agent: options.agent,
          invocation: options.invocation,
          result: toolResultBlock,
          invocationState,
        })
      } catch (error) {
        if (error instanceof InterruptError) {
          this._storePendingToolExecution(options, assistantMessage, resultsByToolUseId)
        }
        throw error
      }
    }
  }
}
