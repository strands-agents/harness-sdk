/**
 * Test fixtures and helpers for Tool testing.
 * This module provides utilities for testing Tool implementations.
 */

import type { Tool, ToolContext } from '../tools/tool.js'
import { TextBlock, ToolResultBlock } from '../types/messages.js'
import type { JSONValue } from '../types/json.js'
import { StateStore } from '../state-store.js'
import { ToolRegistry } from '../registry/tool-registry.js'
import type { PlainToolResultBlock } from './slim-types.js'
import type { InvocationState, LocalAgent } from '../types/agent.js'

/**
 * Helper to create a mock ToolContext for testing.
 *
 * @param toolUse - The tool use request
 * @param appState - Optional initial app state
 * @param invocationState - Optional initial invocation state
 * @returns Mock ToolContext object
 */
export function createMockContext(
  toolUse: { name: string; toolUseId: string; input: JSONValue },
  appState?: Record<string, JSONValue>,
  invocationState?: InvocationState
): ToolContext {
  const cancelSignal = new AbortController().signal
  return {
    toolUse,
    agent: {
      id: 'mock-agent',
      appState: new StateStore(appState),
      messages: [],
      toolRegistry: new ToolRegistry(),
      cancelSignal,
      addHook: () => () => {},
    } as unknown as LocalAgent,
    invocationState: invocationState ?? {},
    cancelSignal,
    interrupt: (): never => {
      throw new Error('interrupt not available in mock context')
    },
  }
}

/**
 * Result function type for createMockTool - accepts plain objects or class instances.
 * Can optionally receive the ToolContext for interrupt-aware tools.
 */
type ToolResultFn =
  | (() => PlainToolResultBlock | AsyncGenerator<never, PlainToolResultBlock, never>)
  | ((
      context: ToolContext
    ) => PlainToolResultBlock | AsyncGenerator<never, PlainToolResultBlock, never> | string | void)

/**
 * Helper to create a mock tool for testing.
 *
 * @param name - The name of the mock tool
 * @param resultFn - Function that returns a ToolResultBlock (plain object or class instance) or an AsyncGenerator
 * @returns Mock Tool object
 */
export function createMockTool(name: string, resultFn: ToolResultFn): Tool {
  return {
    name,
    description: `Mock tool ${name}`,
    toolSpec: {
      name,
      description: `Mock tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
    },
    // eslint-disable-next-line require-yield
    async *stream(context): AsyncGenerator<never, ToolResultBlock, never> {
      const result = resultFn(context)
      if (typeof result === 'string') {
        return new ToolResultBlock({
          toolUseId: context.toolUse.toolUseId,
          status: 'success',
          content: [new TextBlock(result)],
        })
      }
      if (result === undefined || result === null) {
        return new ToolResultBlock({
          toolUseId: context.toolUse.toolUseId,
          status: 'success',
          content: [],
        })
      }
      if (typeof result === 'object' && result !== null && Symbol.asyncIterator in result) {
        // For generators that throw errors
        const gen = result as AsyncGenerator<never, ToolResultBlock, never>
        let done = false
        while (!done) {
          const { value, done: isDone } = await gen.next()
          done = isDone ?? false
          if (done) {
            return value
          }
        }
        // This should never be reached but TypeScript needs a return
        throw new Error('Generator ended unexpectedly')
      } else {
        return result as ToolResultBlock
      }
    },
  }
}

/**
 * Helper to create a simple mock tool with minimal configuration for testing.
 * This is a lighter-weight version of createMockTool for scenarios where the tool's
 * execution behavior is not relevant to the test.
 *
 * @param name - Optional name of the mock tool (defaults to a random UUID)
 * @returns Mock Tool object
 */
export function createRandomTool(name?: string): Tool {
  const toolName = name ?? globalThis.crypto.randomUUID()
  return createMockTool(
    toolName,
    () =>
      new ToolResultBlock({
        toolUseId: 'test-id',
        status: 'success' as const,
        content: [],
      })
  )
}
