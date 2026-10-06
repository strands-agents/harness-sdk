/**
 * Agent-as-tool adapter.
 *
 * This module provides the AgentAsTool class that wraps an Agent as a tool
 * so it can be used by another agent. Agents passed directly in the tools
 * array are automatically wrapped via {@link Agent.asTool}.
 */

import type { Agent } from './agent.js'
import type { InvokeOptions } from '../types/agent.js'
import type { Snapshot } from '../types/snapshot.js'
import type { JSONValue } from '../types/json.js'
import { JsonBlock, LIMIT_STOP_REASONS, limitStopMessage, TextBlock, ToolResultBlock } from '../types/messages.js'
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
   * starts from the same baseline.
   *
   * When `true`, the agent retains its conversation history across invocations,
   * allowing it to build context over multiple calls.
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
    const { toolUse, invocationState, cancelSignal, invocation } = toolContext
    const toolUseId = toolUse.toolUseId

    // Concurrency guard: loadSnapshot + agent.stream() must not overlap.
    if (this._busy) {
      return createErrorResult(`Agent '${this.name}' is already processing a request`, toolUseId)
    }

    this._busy = true
    try {
      const { input } = toolUse.input as { input: string }

      // Reset agent state if not preserving context
      if (this._initialSnapshot) {
        this._agent.loadSnapshot(this._initialSnapshot)
      }

      // Stream the sub-agent, forwarding the outer invocation's state so
      // mutations in the inner agent's hooks/tools are visible to the outer
      // agent's downstream callbacks and final AgentResult. The request state is
      // passed explicitly so the child's model calls join the same request.
      const invokeOptions: InvokeOptions = {
        invocationState,
        cancelSignal,
        ...(invocation && { invocation }),
      }
      const gen = this._agent.stream(input, invokeOptions)
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

      if (result.stopReason === 'cancelled') {
        return createErrorResult(`Agent '${this.name}' cancelled`, toolUseId)
      }

      // Child stopped on one of the request's shared limits; surface it as an
      // error so the model doesn't treat the truncated answer as complete.
      if (LIMIT_STOP_REASONS.has(result.stopReason)) {
        return createErrorResult(limitStopMessage(this.name, result.stopReason), toolUseId)
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
      return createErrorResult(error, toolUseId)
    } finally {
      this._busy = false
    }
  }
}
