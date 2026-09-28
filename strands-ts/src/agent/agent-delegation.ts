/**
 * AgentDelegation — enforces delegation semantics for tool routing.
 *
 * When a tool is configured with `delegate: true`, this plugin ensures:
 * 1. The delegation tool is the only tool called in the turn (single-call constraint)
 * 2. The agent loop exits immediately after a successful delegation (via endTurn)
 * 3. The delegation tool's content blocks become the final assistant message
 * 4. Streaming events from the delegate agent are surfaced natively in the parent stream
 */

import type { Plugin } from '../plugins/plugin.js'
import type { LocalAgent, AgentStreamEvent } from '../types/agent.js'
import type { ContentBlock } from '../types/messages.js'
import {
  AfterToolCallEvent,
  AfterToolsEvent,
  BeforeModelCallEvent,
  BeforeToolsEvent,
  StreamEvent,
  ToolStreamUpdateEvent,
} from '../hooks/events.js'
import { HookOrder } from '../hooks/types.js'
import { ExecuteToolStage } from '../middleware/index.js'
import type { ExecuteToolContext, ExecuteToolResult, MiddlewareNext } from '../middleware/index.js'
import { TextBlock, ToolResultBlock, ToolUseBlock } from '../types/messages.js'
import { AgentAsTool } from './agent-as-tool.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../tools/structured-output-tool.js'
import { logger } from '../logging/logger.js'

/**
 * Checks whether a tool registered on the agent is a delegation AgentAsTool.
 */
function isDelegationTool(agent: LocalAgent, toolName: string): boolean {
  const tool = agent.toolRegistry.get(toolName)
  return tool instanceof AgentAsTool && tool.delegate
}

/**
 * Converts ToolResultContent blocks into valid ContentBlocks for an assistant message.
 *
 * AgentAsTool only produces TextBlock or JsonBlock results. JsonBlock is not part
 * of the ContentBlock union, so it is serialized to a TextBlock.
 */
function toContentBlocks(block: ToolResultBlock): ContentBlock[] {
  return block.content.map((contentBlock): ContentBlock => {
    if (contentBlock.type === 'jsonBlock') {
      return new TextBlock(JSON.stringify(contentBlock.json))
    }
    return contentBlock as ContentBlock
  })
}

/** Per-agent state tracked across the delegation lifecycle within a single invocation. */
interface DelegationState {
  /** Number of tool use blocks in the current batch (from BeforeToolsEvent). */
  toolUseCount: number
  /** Tool use ID of the delegation tool that succeeded (set by AfterToolCallEvent). */
  toolUseId?: string
}

/**
 * Plugin that enforces delegation semantics for tool routing.
 *
 * Automatically registered on every agent. Acts as a no-op when no delegation tools fire.
 * Implements single-call constraint, early loop exit, and result transformation.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 *
 * const specialist = new Agent({ name: 'Specialist' })
 * const orchestrator = new Agent({
 *   tools: [specialist.asTool({ delegate: true })],
 *   // AgentDelegation is auto-registered — no manual setup needed
 * })
 * ```
 */
export class AgentDelegation implements Plugin {
  readonly name = 'strands:agent-delegation'

  /** Per-agent delegation state, created in _onBeforeTools and consumed in _onAfterTools. */
  private readonly _state = new WeakMap<LocalAgent, DelegationState>()

  initAgent(agent: LocalAgent): void {
    // Fail fast: delegation is incompatible with stateful models.
    // Stateful models manage conversation state server-side. Delegation's early
    // exit would leave an unclosed function call on the server, corrupting the
    // next request.
    if (agent.model.stateful) {
      const hasDelegationTool = agent.toolRegistry.list().some((tool) => tool instanceof AgentAsTool && tool.delegate)
      if (hasDelegationTool) {
        throw new Error(
          'Delegation tools (delegate: true) are not supported with stateful models. ' +
            "Stateful models manage conversation state server-side, and delegation's early loop exit " +
            'would leave unclosed function calls on the server.'
        )
      }
    }

    agent.addHook(BeforeToolsEvent, (event) => this._onBeforeTools(event))
    agent.addHook(AfterToolCallEvent, (event) => this._onAfterToolCall(event))
    agent.addHook(AfterToolsEvent, (event) => this._onAfterTools(event), { order: HookOrder.SDK_LAST })

    // If the loop continues past a delegation batch (e.g. a later hook cleared
    // endTurn), the next model call invalidates the delegation flag.
    agent.addHook(BeforeModelCallEvent, (event) => {
      this._state.delete(event.agent)
    })

    // async function* doesn't bind lexical `this`; capture for the terminal callback.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this

    // ExecuteToolStage middleware: unwraps inner agent streaming events for delegation tools
    // so they appear as native events in the parent agent's stream.
    agent.addMiddleware(
      ExecuteToolStage,
      async function* (
        context: ExecuteToolContext,
        next: MiddlewareNext<ExecuteToolContext, ExecuteToolResult, AgentStreamEvent>
      ): AsyncGenerator<AgentStreamEvent, ExecuteToolResult, undefined> {
        return yield* self._handleToolExecution(context, next, agent)
      }
    )
  }

  /**
   * BeforeToolsEvent hook: enforces single-call constraint against registry names
   * and initializes per-batch delegation state.
   */
  private _onBeforeTools(event: BeforeToolsEvent): void {
    if (event.agent.model.stateful) return

    const toolUseBlocks = event.message.content.filter((block): block is ToolUseBlock => block.type === 'toolUseBlock')

    // Initialize state for this batch.
    this._state.set(event.agent, { toolUseCount: toolUseBlocks.length })

    // Cancel the batch if a delegation tool is present alongside other tools.
    const hasDelegation = toolUseBlocks.some((block) => isDelegationTool(event.agent, block.name))
    if (hasDelegation && toolUseBlocks.length > 1) {
      event.cancel =
        'This tool call was not executed. A delegation tool must be the only ' +
        'tool called in a turn. Retry with a single delegation tool call or ' +
        'use only non-delegation tools.'
    }
  }

  /**
   * AfterToolCallEvent hook: marks the delegation tool use ID on success.
   */
  private _onAfterToolCall(event: AfterToolCallEvent): void {
    if (event.agent.model.stateful || !(event.tool instanceof AgentAsTool) || !event.tool.delegate) {
      // Clear stale delegation mark if a retry swapped to a non-delegation tool
      const state = this._state.get(event.agent)
      if (state?.toolUseId === event.toolUse.toolUseId) {
        delete state.toolUseId
      }
      return
    }

    const state = this._state.get(event.agent)
    if (!state) return

    // Only mark if the result is successful. If error, clear any prior mark
    // (e.g. from a retried attempt that succeeded previously).
    if (event.result.status === 'error') {
      delete state.toolUseId
      return
    }

    state.toolUseId = event.toolUse.toolUseId
  }

  /**
   * AfterToolsEvent hook: sets endTurn to delegation content blocks when
   * delegation succeeded with meaningful content.
   *
   * This hook runs at `HookOrder.SDK_LAST` (100), after every SDK and vended-plugin
   * hook. A hook registered above that order still runs afterwards and could flip
   * a `ToolResultBlock` to error, but `endTurn` is already committed and the loop
   * will exit anyway — mutating a committed `ToolResultBlock`'s status is not a
   * supported pattern.
   */
  private _onAfterTools(event: AfterToolsEvent): void {
    if (event.agent.model.stateful) return

    const state = this._state.get(event.agent)
    if (!state?.toolUseId) return

    // Verify the tool result is still successful in the committed message.
    const resultBlock = event.message.content.find(
      (block): block is ToolResultBlock => block instanceof ToolResultBlock && block.toolUseId === state.toolUseId
    )
    if (!resultBlock || resultBlock.status === 'error') {
      delete state.toolUseId
      return
    }

    // Skip delegation when the parent expects structured output.
    if (event.agent.toolRegistry.get(STRUCTURED_OUTPUT_TOOL_NAME)) {
      logger.debug(`tool_use_id=<${state.toolUseId}> | parent requires structured output, skipping delegation`)
      return
    }

    // Skip delegation when the tool result has no meaningful content.
    const endTurnContent = toContentBlocks(resultBlock)
    if (endTurnContent.length === 0 || endTurnContent.every((block) => 'text' in block && block.text === '')) {
      logger.debug(`tool_use_id=<${state.toolUseId}> | delegation produced blank content, skipping delegation`)
      return
    }

    event.endTurn = endTurnContent
  }

  /**
   * ExecuteToolStage middleware: enforces single-call constraint and surfaces
   * delegate agent streaming events natively.
   *
   * For delegation tools in a multi-tool batch, returns an error result without
   * executing the tool. For valid single-tool delegation, unwraps inner agent
   * streaming events so they appear as native events in the parent stream.
   */
  private async *_handleToolExecution(
    context: ExecuteToolContext,
    next: MiddlewareNext<ExecuteToolContext, ExecuteToolResult, AgentStreamEvent>,
    agent: LocalAgent
  ): AsyncGenerator<AgentStreamEvent, ExecuteToolResult, undefined> {
    // Non-delegation tools or stateful models pass through unchanged.
    if (!(context.tool instanceof AgentAsTool) || !context.tool.delegate || agent.model.stateful) {
      return yield* next(context)
    }

    // Enforce single-call constraint: delegation tool must be the only tool in the batch.
    const state = this._state.get(agent)
    if (state && state.toolUseCount > 1) {
      return {
        result: new ToolResultBlock({
          toolUseId: context.toolUse.toolUseId,
          status: 'error',
          content: [
            new TextBlock(
              'Delegation failed: a delegation tool must be the only tool called in a turn. ' +
                'Retry with a single delegation tool call or use only non-delegation tools.'
            ),
          ],
        }),
      }
    }

    // Iterate the inner pipeline manually so we can transform events
    const gen = next(context)
    let result = await gen.next()
    while (!result.done) {
      const event = result.value

      // ToolStreamUpdateEvents from a delegation tool may contain wrapped inner agent events.
      // Unwrap them: if the data is a StreamEvent instance, yield it as a native event.
      if (event.type === 'toolStreamUpdateEvent') {
        const innerData = (event as ToolStreamUpdateEvent).event.data
        if (innerData instanceof StreamEvent) {
          yield innerData as AgentStreamEvent
        } else {
          // Regular tool stream events (e.g., from the inner agent's own tools) pass through
          yield event
        }
      } else {
        yield event
      }

      result = await gen.next()
    }
    return result.value
  }
}
