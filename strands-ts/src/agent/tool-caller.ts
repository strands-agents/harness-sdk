/**
 * Direct tool calling support through agent.tool accessor.
 *
 * Enables method-style tool invocation without model inference:
 * ```typescript
 * const agent = new Agent({ tools: [myTool] })
 * const result = await agent.tool.calculator!.invoke({ a: 5, b: 3 })
 * ```
 */

import type { JSONValue } from '../types/json.js'
import type { ToolResultBlock } from '../types/messages.js'
import { Message } from '../types/messages.js'
import { TextBlock, ToolUseBlock } from '../types/messages.js'
import type { InvocationState } from '../types/agent.js'
import type { Tool, ToolContext } from '../tools/tool.js'
import { ToolStreamEvent } from '../tools/tool.js'
import type { ToolUse } from '../tools/types.js'
import type { Agent } from './agent.js'
import { ConcurrentInvocationError } from '../errors.js'

/**
 * Options for direct tool call execution.
 */
export interface DirectToolCallOptions {
  /**
   * Whether to record this tool call in the agent's message history.
   * Defaults to `true`. Set to `false` to execute the tool without
   * affecting conversation context.
   */
  recordDirectToolCall?: boolean
}

/**
 * A handle to a specific tool, providing `.invoke()` and `.stream()` methods.
 *
 * Returned by the Proxy get trap when accessing `agent.tool.toolName`.
 * This aligns with the agent-level `agent.invoke()` / `agent.stream()` pattern.
 */
export interface ToolHandle {
  /**
   * Invoke the tool and return the final result.
   *
   * @param input - The input parameters for the tool
   * @param options - Optional configuration for this call
   * @returns The tool result
   */
  invoke: (input?: JSONValue, options?: DirectToolCallOptions) => Promise<ToolResultBlock>

  /**
   * Stream the tool execution, yielding intermediate events and returning the final result.
   *
   * @param input - The input parameters for the tool
   * @param options - Optional configuration for this call
   * @returns Async generator that yields ToolStreamEvents and returns ToolResultBlock
   */
  stream: (
    input?: JSONValue,
    options?: DirectToolCallOptions
  ) => AsyncGenerator<ToolStreamEvent, ToolResultBlock, undefined>
}

/**
 * The public type of the tool caller proxy.
 * Provides dynamic property access where each property is a {@link ToolHandle}
 * with `.invoke()` and `.stream()` methods.
 */
export type ToolCallerProxy = Record<string, ToolHandle>

/**
 * Helper passed in from Agent for appending messages and firing MessageAddedEvent hooks.
 *
 * Defined here (not in agent.ts) so that the message-mutation capability stays
 * encapsulated — only the Agent knows how to mutate messages safely, and it
 * passes a bound helper into ToolCaller. ToolCaller never gets direct access
 * to `agent.messages` or the hooks registry.
 */
export type AppendMessageFn = (message: Message, invocationState?: InvocationState) => Promise<void>

/**
 * Provides direct tool calling through the agent.
 *
 * Enables programmatic tool invocation without model inference via
 * `agent.tool.toolName.invoke(input)` or `agent.tool.toolName.stream(input)`.
 * Tools are called directly, bypassing the model loop, and results are optionally
 * recorded in message history for context continuity.
 *
 * Supports underscore-to-hyphen and case-insensitive name normalization
 * via {@link ToolRegistry.resolve}.
 *
 * @example
 * ```typescript
 * const agent = new Agent({ tools: [calculatorTool] })
 *
 * // Invoke and get the result
 * const result = await agent.tool.calculator!.invoke({ operation: 'add', a: 5, b: 3 })
 * console.log(result.status) // 'success'
 *
 * // Stream intermediate events
 * for await (const event of agent.tool.calculator!.stream({ operation: 'add', a: 5, b: 3 })) {
 *   console.log('progress:', event)
 * }
 * ```
 *
 * @internal This class is not intended for direct instantiation by users.
 */
export class ToolCaller {
  private readonly _agent: Agent
  private readonly _appendMessage: AppendMessageFn

  /**
   * Creates a ToolCaller proxy for the given agent.
   *
   * Encapsulates the Proxy cast so callers don't need to handle the
   * implementation detail that the constructor returns a Proxy, not
   * a plain ToolCaller instance.
   *
   * @param agent - The owning agent instance
   * @param appendMessage - Helper provided by the agent to append messages and fire hooks.
   *   Passed in (rather than calling a public agent method) so message mutation stays
   *   encapsulated within the agent.
   */
  static create(agent: Agent, appendMessage: AppendMessageFn): ToolCallerProxy {
    return new ToolCaller(agent, appendMessage) as unknown as ToolCallerProxy
  }

  private constructor(agent: Agent, appendMessage: AppendMessageFn) {
    this._agent = agent
    this._appendMessage = appendMessage

    // Return a Proxy that intercepts property access to resolve tool names
    return new Proxy(this, {
      get(target: ToolCaller, prop: string | symbol, receiver: unknown): ToolHandle | unknown {
        // Pass through symbol properties (Symbol.toPrimitive, Symbol.iterator, etc.)
        // Uses Reflect.get for proper receiver forwarding.
        if (typeof prop === 'symbol') {
          return Reflect.get(target, prop, receiver)
        }

        // Prevent accidental thenable behavior — if a user writes `await agent.tool`
        // the JS runtime checks for `.then`. Without this guard, the Proxy would return
        // a ToolHandle for a non-existent tool named "then", which is confusing.
        // Note: this means a tool literally named "then" cannot be accessed via this proxy.
        if (prop === 'then') {
          return undefined
        }

        // Return a ToolHandle with .invoke() and .stream() for the named tool.
        // We intentionally do NOT fall through to `prop in target` here — that would
        // cause tool names that collide with inherited Object properties (e.g.,
        // 'constructor', 'toString', 'valueOf') to return the wrong value.
        return target._createToolHandle(prop)
      },
    })
  }

  /**
   * Creates a ToolHandle for the given tool name.
   */
  private _createToolHandle(name: string): ToolHandle {
    return {
      invoke: (input?: JSONValue, options?: DirectToolCallOptions): Promise<ToolResultBlock> => {
        return this._callTool(name, input ?? {}, options)
      },
      stream: (
        input?: JSONValue,
        options?: DirectToolCallOptions
      ): AsyncGenerator<ToolStreamEvent, ToolResultBlock, undefined> => {
        return this._streamTool(name, input ?? {}, options)
      },
    }
  }

  /**
   * Executes a tool by name with the given input, consuming the full stream and returning the result.
   *
   * @param name - The tool name (supports underscore-to-hyphen and case-insensitive resolution)
   * @param input - The input parameters for the tool
   * @param options - Optional configuration for this call
   * @returns The tool result
   */
  private async _callTool(name: string, input: JSONValue, options?: DirectToolCallOptions): Promise<ToolResultBlock> {
    const gen = this._streamTool(name, input, options)
    let result = await gen.next()
    while (!result.done) {
      result = await gen.next()
    }
    return result.value
  }

  /**
   * Streams a tool execution by name, yielding intermediate events.
   *
   * @param name - The tool name
   * @param input - The input parameters for the tool
   * @param options - Optional configuration for this call
   * @returns Async generator that yields ToolStreamEvents and returns ToolResultBlock
   */
  private async *_streamTool(
    name: string,
    input: JSONValue,
    options?: DirectToolCallOptions
  ): AsyncGenerator<ToolStreamEvent, ToolResultBlock, undefined> {
    const shouldRecord = options?.recordDirectToolCall ?? true

    // If recording, check that the agent is not currently invoking
    if (shouldRecord && this._agent.isInvoking) {
      throw new ConcurrentInvocationError(
        'Direct tool call cannot be made while the agent is in the middle of an invocation. ' +
          'Set recordDirectToolCall: false to allow direct tool calls during agent invocation.'
      )
    }

    // Resolve the tool via the registry's normalization (exact → hyphen → case-insensitive)
    const tool = this._agent.toolRegistry.resolve(name)

    // Generate unique tool use ID
    const toolUseId = `tooluse_${globalThis.crypto.randomUUID()}`
    const toolUse: ToolUse = {
      toolUseId,
      name: tool.name,
      input,
    }

    // Create tool context
    const toolContext: ToolContext = {
      toolUse,
      agent: this._agent,
      invocationState: {},
      cancelSignal: this._agent.cancelSignal,
      interrupt: (): never => {
        throw new Error('Interrupts are not supported in direct tool calls')
      },
    }

    // Execute the tool, yielding stream events
    const toolResult = yield* this._executeTool(tool, toolContext)

    // Record in message history if configured
    if (shouldRecord) {
      await this._recordToolExecution(toolUse, toolResult)
    }

    return toolResult
  }

  /**
   * Executes a tool's stream generator, yielding events and returning the final result.
   */
  private async *_executeTool(
    tool: Tool,
    toolContext: ToolContext
  ): AsyncGenerator<ToolStreamEvent, ToolResultBlock, undefined> {
    const generator = tool.stream(toolContext)
    let result = await generator.next()
    while (!result.done) {
      yield result.value
      result = await generator.next()
    }
    return result.value
  }

  /**
   * Records a tool execution in the agent's message history and fires MessageAddedEvent hooks.
   *
   * Creates a sequence of 3 messages that represent the tool execution:
   * 1. An assistant message with the ToolUseBlock (what was called and with what input)
   * 2. A user message with the ToolResultBlock (tool output)
   * 3. An assistant message acknowledging the result
   *
   * Each message fires a {@link MessageAddedEvent} so that hooks registered via
   * `agent.addHook(MessageAddedEvent, ...)` are notified of direct tool call messages.
   */
  private async _recordToolExecution(toolUse: ToolUse, toolResult: ToolResultBlock): Promise<void> {
    const toolUseBlock = new ToolUseBlock({
      toolUseId: toolUse.toolUseId,
      name: toolUse.name,
      input: toolUse.input,
    })

    const toolUseMsg = new Message({ role: 'assistant', content: [toolUseBlock] })
    const toolResultMsg = new Message({ role: 'user', content: [toolResult] })
    const assistantMsg = new Message({
      role: 'assistant',
      content: [new TextBlock(`agent.tool.${toolUse.name} was called.`)],
    })

    // Append messages and fire MessageAddedEvent hooks for each, using the
    // helper provided by Agent. This keeps message mutation encapsulated in
    // the agent — ToolCaller never touches `agent.messages` directly.
    await this._appendMessage(toolUseMsg)
    await this._appendMessage(toolResultMsg)
    await this._appendMessage(assistantMsg)
  }
}
