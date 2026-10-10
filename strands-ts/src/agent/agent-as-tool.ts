/**
 * Agent-as-tool adapter.
 *
 * This module provides the AgentAsTool class that wraps an Agent as a tool
 * so it can be used by another agent. Agents passed directly in the tools
 * array are automatically wrapped via {@link Agent.asTool}.
 */

import type { Agent } from './agent.js'
import type { Snapshot } from '../types/snapshot.js'
import { Interrupt, InterruptError, InterruptState, type InterruptStateData } from '../interrupt.js'
import { logger } from '../logging/logger.js'
import { InterruptResponseContent } from '../types/interrupt.js'
import { deepCopy, type JSONValue } from '../types/json.js'
import { JsonBlock, TextBlock, ToolResultBlock } from '../types/messages.js'
import { createErrorResult, Tool, ToolStreamEvent } from '../tools/tool.js'
import type { ToolContext, ToolStreamGenerator } from '../tools/tool.js'
import type { ToolSpec } from '../tools/types.js'

/**
 * Description suffix appended to delegation tools to guide the model.
 * @internal
 */
export const DELEGATION_DESCRIPTION_SUFFIX =
  ' Calling this tool will return its response directly to the user as the final answer. It should be the only tool called in the turn.'

/**
 * Options for creating an agent tool via {@link Agent.asTool}.
 */
export interface AgentAsToolOptions {
  /**
   * Tool name exposed to the parent agent's model.
   * Must match the pattern `[a-zA-Z0-9_-]{1,64}`.
   *
   * Defaults to the agent's name. Throws if the resolved name is not a valid
   * tool name — provide an explicit name option to override.
   */
  name?: string

  /**
   * Tool description exposed to the parent agent's model.
   * Helps the model understand when to use this tool.
   *
   * Defaults to the agent's description, or a generic description if the
   * agent has no description set.
   */
  description?: string

  /**
   * Whether to preserve the agent's conversation history across invocations.
   *
   * When `false` (default), the agent's messages and state are reset to the
   * values they had at the time the tool was created, ensuring every call
   * starts from the same baseline. The orchestrator also stores the agent's
   * interrupted turn, so a sub-agent interrupt can be resumed after a restart.
   *
   * When `true`, the agent retains its conversation history across invocations,
   * allowing it to build context over multiple calls. It keeps its own state on
   * an interrupt too, so it needs its own session manager to resume after a restart.
   *
   * @defaultValue false
   */
  preserveContext?: boolean

  /**
   * When true, the orchestrator treats this tool's result as the final
   * response and exits without an additional model call.
   *
   * A delegation tool's description is automatically suffixed with an instruction
   * telling the model that this tool should be the only tool called in the turn.
   *
   * @defaultValue false
   */
  delegate?: boolean
}

/**
 * Configuration for creating an AgentAsTool.
 */
interface AgentToolConfig extends AgentAsToolOptions {
  agent: Agent
}

const INTERRUPTED_TURNS_KEY = 'subAgentInterruptedTurns'

/** Ids of the interrupts a stored sub-agent turn is waiting on, or undefined if its interrupt state is unreadable. */
function awaitedInterruptIds(turn: JSONValue): string[] | undefined {
  try {
    const snapshot = turn as unknown as Snapshot
    const data = snapshot.data.interrupts as unknown as InterruptStateData
    return Object.keys(InterruptState.fromJSON(data).interrupts)
  } catch {
    return undefined
  }
}

/**
 * @internal Not for external use. Use {@link Agent.asTool} to create instances.
 *
 * Adapter that exposes an Agent as a tool for use by other agents.
 *
 * The tool accepts a single `input` string parameter, invokes the wrapped
 * agent, and returns the text response.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 *
 * const researcher = new Agent({
 *   name: 'researcher',
 *   description: 'Finds information on a topic',
 *   printer: false,
 * })
 *
 * // Use via convenience method (default: fresh conversation each call)
 * const tool = researcher.asTool()
 *
 * // Preserve context across invocations
 * const tool = researcher.asTool({ preserveContext: true })
 *
 * const writer = new Agent({ tools: [tool] })
 * const result = await writer.invoke('Write about AI agents')
 * ```
 */
export class AgentAsTool extends Tool {
  readonly name: string
  readonly description: string
  readonly toolSpec: ToolSpec

  /**
   * When true, the orchestrator treats this tool's result as the final
   * response and exits without an additional model call.
   *
   * @defaultValue false
   */
  readonly delegate: boolean

  private readonly _agent: Agent
  private readonly _preserveContext: boolean
  private readonly _initialSnapshot: Snapshot | undefined
  private _busy = false

  constructor(config: AgentToolConfig) {
    super()
    this._agent = config.agent
    this._preserveContext = config.preserveContext ?? false
    this.delegate = config.delegate ?? false

    if (!this._preserveContext && this._agent.sessionManager != null) {
      throw new Error(
        `Agent '${this._agent.name}' has a SessionManager, which conflicts with preserveContext=false. ` +
          'The SessionManager persists conversation history externally, but preserveContext=false resets ' +
          'state between invocations. Use preserveContext=true or remove the SessionManager.'
      )
    }

    if (!this._preserveContext) {
      this._initialSnapshot = this._agent.takeSnapshot({ preset: 'session' })
    }

    this.name = config.name ?? config.agent.name

    this.description =
      config.description ??
      config.agent.description ??
      `Use the ${this.name} agent by providing a natural language input`

    if (this.delegate) {
      this.description += DELEGATION_DESCRIPTION_SUFFIX
    }

    this.toolSpec = {
      name: this.name,
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'The natural language input to send to the agent.',
          },
        },
        required: ['input'],
      },
    }
  }

  /**
   * The wrapped agent instance.
   */
  get agent(): Agent {
    return this._agent
  }

  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    const { toolUse, invocationState, cancelSignal } = toolContext
    const toolUseId = toolUse.toolUseId

    // Concurrency guard: loadSnapshot + agent.stream() must not overlap.
    if (this._busy) {
      return createErrorResult(`Agent '${this.name}' is already processing a request`, toolUseId)
    }

    this._busy = true
    try {
      // Sub-agent interrupt ids are namespaced per tool call, since two sub-agents can raise the same id.
      const prefix = `agent_as_tool:${encodeURIComponent(toolUseId)}:`
      const parentState = (toolContext.agent as unknown as { _interruptState?: InterruptState })._interruptState

      let input: string | InterruptResponseContent[]
      const resuming = parentState !== undefined && this._isResuming(parentState, prefix)
      if (resuming) {
        const resumed = await this._resumeFromInterrupt(parentState, toolUseId, prefix)
        if (resumed instanceof ToolResultBlock) {
          return resumed
        }
        input = resumed
      } else {
        input = (toolUse.input as { input: string }).input
        // Reset agent state if not preserving context
        if (this._initialSnapshot) {
          this._agent.loadSnapshot(this._initialSnapshot)
        }
      }

      // Stream the sub-agent, forwarding the outer invocation's state so
      // mutations in the inner agent's hooks/tools are visible to the outer
      // agent's downstream callbacks and final AgentResult.
      const gen = this._agent.stream(input, {
        invocationState,
        cancelSignal,
      })
      let next = await gen.next()
      while (!next.done) {
        const event = next.value
        if (event.type == 'toolStreamUpdateEvent') {
          yield event.event
        } else {
          yield new ToolStreamEvent({ data: next.value })
        }

        next = await gen.next()
      }
      const result = next.value

      if (result.stopReason === 'interrupt') {
        if (!result.interrupts?.length) {
          return createErrorResult(`Agent '${this.name}' interrupted without any interrupts`, toolUseId)
        }
        if (!parentState) {
          throw new InterruptError(result.interrupts)
        }
        this._raiseInterrupts(parentState, toolUseId, prefix, result.interrupts)
      }

      if (resuming) {
        // The turn is consumed only once the sub-agent has finished with it; a re-interrupt overwrote it above.
        delete (parentState.context[INTERRUPTED_TURNS_KEY] as Record<string, JSONValue> | undefined)?.[toolUseId]
      }

      if (result.stopReason === 'cancelled') {
        return createErrorResult(`Agent '${this.name}' cancelled`, toolUseId)
      }

      // Build the tool result
      if (result.structuredOutput !== undefined) {
        return new ToolResultBlock({
          toolUseId,
          status: 'success',
          content: [new JsonBlock({ json: result.structuredOutput as JSONValue })],
        })
      }

      return new ToolResultBlock({
        toolUseId,
        status: 'success',
        content: [new TextBlock(result.toString())], // toString defined by AgentResult
      })
    } catch (error) {
      if (error instanceof InterruptError) {
        throw error
      }
      return createErrorResult(error, toolUseId)
    } finally {
      this._busy = false
    }
  }

  /** Whether the parent is holding an interrupt raised by this tool call. */
  private _isResuming(parentState: InterruptState, prefix: string): boolean {
    return parentState.activated && Object.keys(parentState.interrupts).some((id) => id.startsWith(prefix))
  }

  /** Store the sub-agent's interrupted turn and raise its interrupts in the parent, namespaced to this tool call. */
  private _raiseInterrupts(
    parentState: InterruptState,
    toolUseId: string,
    prefix: string,
    interrupts: Interrupt[]
  ): never {
    this._storeInterruptedTurn(parentState, toolUseId)
    // Registered here, not only when the orchestrator catches the error: the concurrent executor keeps
    // one InterruptError per batch, so a second interrupting agent-tool would otherwise be dropped.
    const raised = interrupts.map((i) =>
      parentState.registerInterrupt(
        new Interrupt({
          id: `${prefix}${i.id}`,
          name: i.name,
          ...(i.reason !== undefined && { reason: i.reason }),
          source: 'tool',
        })
      )
    )
    throw new InterruptError(raised)
  }

  /**
   * Store an ephemeral sub-agent's interrupted turn in the parent's interrupt state.
   *
   * A `preserveContext: true` sub-agent keeps its own state instead, and needs its own session
   * manager for the interrupt to be resumable after a restart.
   */
  private _storeInterruptedTurn(parentState: InterruptState, toolUseId: string): void {
    if (this._preserveContext) {
      if (this._agent.sessionManager == null) {
        logger.warn(
          `Agent '${this.name}' interrupted with preserveContext=true and no session manager, ` +
            'so its interrupt cannot be resumed after a restart'
        )
      }
      return
    }

    const turns = (parentState.context[INTERRUPTED_TURNS_KEY] ??= {}) as Record<string, JSONValue>
    turns[toolUseId] = deepCopy(this._agent.takeSnapshot({ preset: 'session' }))
  }

  /**
   * Restore the sub-agent's interrupted turn and map the parent's responses back to its interrupt ids.
   *
   * Returns the responses to resume with, or an error result if there is no turn to restore. A stored
   * turn that fails to load, or one whose interrupts have no answer yet, raises its interrupts again so
   * the turn stays stored and the response can be applied on a later attempt.
   */
  private async _resumeFromInterrupt(
    parentState: InterruptState,
    toolUseId: string,
    prefix: string
  ): Promise<InterruptResponseContent[] | ToolResultBlock> {
    const responses = (parentState.resumeResponses ?? [])
      .filter((r) => r.interruptResponse.interruptId.startsWith(prefix))
      .map(
        (r) =>
          new InterruptResponseContent({
            interruptId: r.interruptResponse.interruptId.slice(prefix.length),
            response: r.interruptResponse.response,
          })
      )
    if (responses.length === 0) {
      throw new InterruptError(
        Object.values(parentState.interrupts).filter((i) => i.id.startsWith(prefix) && i.response === undefined)
      )
    }

    const turn = (parentState.context[INTERRUPTED_TURNS_KEY] as Record<string, JSONValue> | undefined)?.[toolUseId]
    if (turn !== undefined) {
      try {
        this._agent.loadSnapshot(turn as unknown as Snapshot)
      } catch (error) {
        logger.error(`Agent '${this.name}' failed to restore its interrupted turn: ${String(error)}`)
        const awaited = awaitedInterruptIds(turn)
        if (awaited === undefined) {
          logger.error(`Agent '${this.name}': the stored turn has no readable interrupt state to raise again`)
        }
        const pending = Object.values(parentState.interrupts).filter(
          (i) => i.id.startsWith(prefix) && awaited?.includes(i.id.slice(prefix.length))
        )
        if (pending.length > 0) {
          // The answer could not be applied, so the interrupts are unanswered again and the turn stays stored.
          for (const interrupt of pending) delete interrupt.response
          throw new InterruptError(pending)
        }
      }
    } else {
      // A context-preserving sub-agent restores its own turn from its session on initialization.
      await this._agent.initialize()
    }

    if (!this._agent._interruptState.activated) {
      logger.error(`Agent '${this.name}' cannot resume: its interrupted turn is not available`)
      return createErrorResult(
        `Agent '${this.name}' did NOT run and the human's response was NOT applied: its interrupted turn ` +
          'is not available. Do not report the requested action as completed; tell the user it failed and ' +
          'ask them to respond again.',
        toolUseId
      )
    }

    return responses
  }
}
