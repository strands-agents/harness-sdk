import type { InvokableTool, ToolContext, ToolStreamGenerator } from './tool.js'
import { Tool } from './tool.js'
import type { ToolSpec } from './types.js'
import type { JSONSchema, JSONValue } from '../types/json.js'
import { FunctionTool } from './function-tool.js'
import { z, ZodVoid } from 'zod'
import { zodSchemaToJsonSchema } from './zod-utils.js'

/**
 * Helper type to infer input type from Zod schema or default to never.
 */
type ZodInferred<TInput> = TInput extends z.ZodType ? z.infer<TInput> : never

/**
 * Configuration for creating a Zod-based tool.
 *
 * @typeParam TInput - Zod schema type for input validation
 * @typeParam TReturn - Return type of the callback function
 */
export interface ZodToolConfig<TInput extends z.ZodType | undefined, TReturn = JSONValue> {
  /** The name of the tool */
  name: string

  /** A description of what the tool does (optional) */
  description?: string

  /**
   * Zod schema for input validation and JSON schema generation.
   * If omitted or z.void(), the tool takes no input parameters.
   */
  inputSchema?: TInput

  /**
   * Callback function that implements the tool's functionality.
   *
   * The return value must be JSON-serializable.
   *
   * @param input - Validated input matching the Zod schema
   * @param context - Optional execution context
   * @returns The result (can be a value, Promise, or AsyncGenerator)
   */
  callback: (
    input: ZodInferred<TInput>,
    context?: ToolContext
  ) => AsyncGenerator<unknown, TReturn, never> | Promise<TReturn> | TReturn
}

/**
 * Zod-based tool implementation.
 * Extends Tool abstract class and implements InvokableTool interface.
 */
export class ZodTool<TInput extends z.ZodType | undefined, TReturn = JSONValue>
  extends Tool
  implements InvokableTool<ZodInferred<TInput>, TReturn>
{
  /**
   * Internal FunctionTool for delegating stream operations.
   */
  private readonly _functionTool: FunctionTool

  /**
   * Zod schema for input validation.
   * Note: undefined is normalized to z.void() in constructor, so this is always defined.
   */
  private readonly _inputSchema: z.ZodType

  /**
   * User callback function.
   */
  private readonly _callback: (
    input: ZodInferred<TInput>,
    context?: ToolContext
  ) => AsyncGenerator<unknown, TReturn, never> | Promise<TReturn> | TReturn

  constructor(config: ZodToolConfig<TInput, TReturn>) {
    super()
    const { name, description = '', inputSchema, callback } = config

    // Normalize undefined to z.void() to simplify logic throughout
    this._inputSchema = inputSchema ?? z.void()
    this._callback = callback

    let generatedSchema: JSONSchema

    // Handle z.void() - use default empty object schema
    if (this._inputSchema instanceof ZodVoid) {
      generatedSchema = {
        type: 'object',
        properties: {},
        additionalProperties: false,
      }
    } else {
      generatedSchema = zodSchemaToJsonSchema(this._inputSchema)
    }

    // Create a FunctionTool with a validation wrapper
    this._functionTool = new FunctionTool({
      name,
      description,
      inputSchema: generatedSchema,
      callback: (
        input: unknown,
        toolContext: ToolContext
      ): AsyncGenerator<JSONValue, JSONValue, never> | Promise<JSONValue> | JSONValue => {
        // Only validate if schema is not z.void() (after normalization, it's never undefined)
        const validatedInput = this._inputSchema instanceof ZodVoid ? input : this._inputSchema.parse(input)
        // Execute user callback with validated input
        return callback(validatedInput as ZodInferred<TInput>, toolContext) as
          AsyncGenerator<JSONValue, JSONValue, never> | Promise<JSONValue> | JSONValue
      },
    })
  }

  /**
   * The unique name of the tool.
   */
  get name(): string {
    return this._functionTool.name
  }

  /**
   * Human-readable description of what the tool does.
   */
  get description(): string {
    return this._functionTool.description
  }

  /**
   * OpenAPI JSON specification for the tool.
   */
  get toolSpec(): ToolSpec {
    return this._functionTool.toolSpec
  }

  /**
   * Executes the tool with streaming support.
   * Delegates to internal FunctionTool implementation.
   *
   * @param toolContext - Context information including the tool use request and invocation state
   * @returns Async generator that yields ToolStreamEvents and returns a ToolResultBlock
   */
  stream(toolContext: ToolContext): ToolStreamGenerator {
    return this._functionTool.stream(toolContext)
  }

  /**
   * Invokes the tool directly with type-safe input and returns the unwrapped result.
   *
   * Unlike stream(), this method:
   * - Returns the raw result (not wrapped in ToolResult)
   * - Consumes async generators and returns only the final value
   * - Lets errors throw naturally (not wrapped in error ToolResult)
   *
   * @param input - The input parameters for the tool
   * @param context - Optional tool execution context
   * @returns The unwrapped result
   */
  async invoke(input: ZodInferred<TInput>, context?: ToolContext): Promise<TReturn> {
    // Only validate if schema is not z.void() (after normalization, it's never undefined)
    const validatedInput = this._inputSchema instanceof ZodVoid ? input : this._inputSchema.parse(input)

    // Execute callback with validated input
    const result = this._callback(validatedInput as ZodInferred<TInput>, context)

    // Handle different return types
    if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
      const generator = result as AsyncGenerator<unknown, TReturn, undefined>
      let iterResult = await generator.next()
      while (!iterResult.done) {
        iterResult = await generator.next()
      }
      return iterResult.value
    } else {
      // Regular value or Promise - return directly
      return await result
    }
  }
}
