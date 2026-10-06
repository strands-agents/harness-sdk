import { normalizeError } from '../../errors.js'
import { ToolResultEvent } from '../../hooks/events.js'
import { InterruptError } from '../../interrupt.js'
import { TextBlock, ToolResultBlock } from '../../types/messages.js'
import { ToolExecutor } from './executor.js'

import type { AgentStreamEvent } from '../../types/agent.js'
import type { ToolExecutionInput, ToolExecutorOptions } from './executor.js'

type ExecutionStep =
  | { index: number; kind: 'next'; result: IteratorResult<AgentStreamEvent, ToolResultBlock> }
  | { index: number; kind: 'throw'; error: unknown }

/**
 * Executes tool calls concurrently.
 *
 * @example
 * ```typescript
 * import { Agent, ConcurrentToolExecutor } from '@strands-agents/sdk'
 *
 * // The string shorthand keeps imports minimal (concurrent is also the default).
 * const agent = new Agent({ toolExecutor: 'concurrent' })
 *
 * // Passing an instance is equivalent if you prefer to be explicit.
 * const explicitAgent = new Agent({ toolExecutor: new ConcurrentToolExecutor() })
 * ```
 */
export class ConcurrentToolExecutor extends ToolExecutor {
  /**
   * Executes tool calls concurrently by racing per-tool generators. Each
   * generator advances serially, preserving its event order while allowing
   * events from different tools to interleave. Retries remain isolated within
   * the affected tool's generator.
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

    // Restored results are included in the final message without replaying their events.
    const executions = toolUseBlocks.map((toolUseBlock) => ({
      toolUseBlock,
      generator: completedToolResults?.has(toolUseBlock.toolUseId)
        ? undefined
        : this.executeTool(options, toolUseBlock, invocationState),
    }))

    // Convert generator rejections into tagged steps so one tool cannot reject
    // the whole race before its failure is isolated and siblings can continue.
    const takeNextStep = (index: number): Promise<ExecutionStep> =>
      executions[index]!.generator!.next().then(
        (result): ExecutionStep => ({ index, kind: 'next', result }),
        (error: unknown): ExecutionStep => ({ index, kind: 'throw', error })
      )

    const resultsByToolUseId = new Map<string, ToolResultBlock>()
    if (completedToolResults) {
      for (const [toolUseId, result] of completedToolResults) {
        resultsByToolUseId.set(toolUseId, result)
      }
    }

    const pendingSteps = new Map<number, Promise<ExecutionStep>>()
    for (let index = 0; index < executions.length; index++) {
      if (executions[index]!.generator) {
        pendingSteps.set(index, takeNextStep(index))
      }
    }

    // Defer interrupts until all sibling tools have finished.
    let interruptError: InterruptError | undefined

    try {
      while (pendingSteps.size > 0) {
        const winner = await Promise.race(pendingSteps.values())
        const { index } = winner
        const toolUseBlock = executions[index]!.toolUseBlock

        if (winner.kind === 'throw') {
          pendingSteps.delete(index)

          if (winner.error instanceof InterruptError) {
            interruptError = winner.error
            continue
          }

          // Generator-level failures belong to one tool call and must not stop its siblings.
          const error = normalizeError(winner.error)
          const result = new ToolResultBlock({
            toolUseId: toolUseBlock.toolUseId,
            status: 'error',
            content: [new TextBlock(error.message)],
            error,
          })
          resultsByToolUseId.set(toolUseBlock.toolUseId, result)
          yield new ToolResultEvent({ agent: options.agent, invocation: options.invocation, result, invocationState })
          continue
        }

        if (winner.result.done) {
          pendingSteps.delete(index)
          resultsByToolUseId.set(toolUseBlock.toolUseId, winner.result.value)
          yield new ToolResultEvent({
            agent: options.agent,
            invocation: options.invocation,
            result: winner.result.value,
            invocationState,
          })
        } else {
          try {
            yield winner.result.value
          } catch (error) {
            // Stream consumers can inject an interrupt at a yielded lifecycle event.
            if (error instanceof InterruptError) {
              interruptError = error
              pendingSteps.delete(index)
              continue
            }
            throw error
          }
          pendingSteps.set(index, takeNextStep(index))
        }
      }

      if (interruptError) {
        this._storePendingToolExecution(options, assistantMessage, resultsByToolUseId)
        throw interruptError
      }
    } finally {
      // Close generators that are still in flight when the stream consumer exits early.
      await Promise.allSettled(
        Array.from(pendingSteps.keys(), (index) =>
          executions[index]!.generator!.return(undefined as unknown as ToolResultBlock)
        )
      )

      // Preserve source order and account for every requested tool, including
      // tools that did not finish before an interrupt or early stream exit.
      for (const toolUseBlock of toolUseBlocks) {
        const result = resultsByToolUseId.get(toolUseBlock.toolUseId)
        if (result) {
          toolResultBlocks.push(result)
        } else {
          toolResultBlocks.push(
            new ToolResultBlock({
              toolUseId: toolUseBlock.toolUseId,
              status: 'error',
              content: [new TextBlock('Tool execution interrupted')],
            })
          )
        }
      }
    }
  }
}
