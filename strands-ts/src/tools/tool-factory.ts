import type { InvokableTool } from './tool.js'
import { FunctionTool } from './function-tool.js'
import type { FunctionToolConfig } from './function-tool.js'
import type { JSONValue } from '../types/json.js'
import { z } from 'zod'
import { ZodTool, type ZodToolConfig } from './zod-tool.js'

/**
 * Checks whether a value is a Zod schema type.
 *
 * @param value - The value to check
 * @returns True if the value is a Zod schema
 */
function isZodType(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType
}

/**
 * Creates an InvokableTool from a Zod schema and callback function.
 *
 * @typeParam TInput - Zod schema type for input validation
 * @typeParam TReturn - Return type of the callback function
 * @param config - Tool configuration with Zod schema
 * @returns An InvokableTool with typed input and output
 */
export function tool<TInput extends z.ZodType, TReturn = JSONValue>(
  config: ZodToolConfig<TInput, TReturn>
): InvokableTool<z.infer<TInput>, TReturn>

/**
 * Creates an InvokableTool from a JSON schema and callback function.
 *
 * @param config - Tool configuration with optional JSON schema
 * @returns An InvokableTool with unknown input
 */
export function tool(config: FunctionToolConfig): InvokableTool<unknown, JSONValue>

/**
 * Creates an InvokableTool from either a Zod schema or JSON schema configuration.
 *
 * When a Zod schema is provided as `inputSchema`, input is validated at runtime and
 * the callback receives typed input. When a JSON schema (or no schema) is provided,
 * the callback receives `unknown` input with no runtime validation.
 *
 * @example
 * ```typescript
 * import { tool } from '@strands-agents/sdk'
 * import { z } from 'zod'
 *
 * // With Zod schema (typed + validated)
 * const calculator = tool({
 *   name: 'calculator',
 *   description: 'Adds two numbers',
 *   inputSchema: z.object({ a: z.number(), b: z.number() }),
 *   callback: (input) => input.a + input.b,
 * })
 *
 * // With JSON schema (untyped, no validation)
 * const greeter = tool({
 *   name: 'greeter',
 *   description: 'Greets a person',
 *   inputSchema: {
 *     type: 'object',
 *     properties: { name: { type: 'string' } },
 *     required: ['name'],
 *   },
 *   callback: (input) => `Hello, ${(input as { name: string }).name}!`,
 * })
 * ```
 *
 * @param config - Tool configuration
 * @returns An InvokableTool that implements the Tool interface with invoke() method
 */
export function tool(
  config: ZodToolConfig<z.ZodType | undefined, JSONValue> | FunctionToolConfig
): InvokableTool<unknown, JSONValue> {
  if (config.inputSchema && isZodType(config.inputSchema)) {
    return new ZodTool(config as ZodToolConfig<z.ZodType, JSONValue>)
  }

  return new FunctionTool(config as FunctionToolConfig)
}
