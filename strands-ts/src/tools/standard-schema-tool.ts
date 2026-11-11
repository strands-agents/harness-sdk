import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import type { InvokableTool, ToolContext, ToolStreamGenerator } from './tool.js'
import { Tool } from './tool.js'
import type { ToolSpec } from './types.js'
import type { JSONSchema, JSONValue } from '../types/json.js'
import { FunctionTool } from './function-tool.js'

/**
 * A schema that validates through Standard Schema and describes itself through Standard JSON Schema.
 *
 * Zod 4, ArkType and any other library that implements both interfaces qualify.
 * See https://standardschema.dev.
 */
export type StandardToolSchema = StandardSchemaV1 & StandardJSONSchemaV1

/**
 * Output type of a Standard Schema, used as the tool callback's input type.
 */
type StandardInferred<TInput extends StandardToolSchema> = StandardSchemaV1.InferOutput<TInput>

type ToolCallbackResult<TReturn> = AsyncGenerator<unknown, TReturn, never> | Promise<TReturn> | TReturn

/**
 * Configuration for creating a tool from a Standard Schema.
 *
 * @typeParam TInput - Schema type for input validation
 * @typeParam TReturn - Return type of the callback function
 */
export interface StandardSchemaToolConfig<TInput extends StandardToolSchema, TReturn = JSONValue> {
  /** The name of the tool */
  name: string

  /** A description of what the tool does (optional) */
  description?: string

  /**
   * Schema for input validation. Its JSON Schema is the tool's input schema.
   */
  inputSchema: TInput

  /**
   * Callback function that implements the tool's functionality.
   *
   * The return value must be JSON-serializable.
   *
   * @param input - Validated input, as the schema outputs it
   * @param context - Optional execution context
   * @returns The result (can be a value, Promise, or AsyncGenerator)
   */
  callback: (input: StandardInferred<TInput>, context?: ToolContext) => ToolCallbackResult<TReturn>
}

/**
 * Whether a value validates through Standard Schema, whether or not it also produces a JSON Schema.
 *
 * @param value - The value to check
 * @returns True if the value implements Standard Schema
 */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  const props = (value as Partial<StandardSchemaV1>)['~standard']
  return typeof props === 'object' && props !== null && typeof props.validate === 'function'
}

/**
 * Whether a Standard Schema also produces a JSON Schema for its input.
 *
 * @param value - A Standard Schema
 * @returns True if the schema implements Standard JSON Schema
 */
export function hasStandardJsonSchema(value: StandardSchemaV1): value is StandardToolSchema {
  const props = value['~standard'] as Partial<StandardJSONSchemaV1.Props>
  return (
    typeof props.jsonSchema === 'object' && props.jsonSchema !== null && typeof props.jsonSchema.input === 'function'
  )
}

/**
 * Converts a Standard JSON Schema to the tool's input schema.
 * Strips the $schema property to reduce token usage.
 *
 * @param schema - The schema to convert
 * @returns JSON Schema representation of the schema's input
 */
function standardSchemaToJsonSchema(schema: StandardToolSchema): JSONSchema {
  const result = schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as JSONSchema & {
    $schema?: string
  }
  const { $schema: _$schema, ...jsonSchema } = result
  return jsonSchema as JSONSchema
}

/**
 * Returns the validated value, or throws with every issue the schema reported.
 *
 * @param name - The tool name, for the error message
 * @param result - The schema's validation result
 * @returns The validated value
 */
function unwrap<T>(name: string, result: StandardSchemaV1.Result<T>): T {
  if (result.issues === undefined) return result.value
  const details = result.issues.map((issue) => {
    const path = (issue.path ?? []).map((segment) => (typeof segment === 'object' ? segment.key : segment))
    return path.length > 0 ? `${path.join('.')}: ${issue.message}` : issue.message
  })
  throw new Error(`invalid input for tool ${name}: ${details.join('; ')}`)
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, never> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in value
}

/**
 * Runs the callback once asynchronous validation resolves. An async generator, so that a callback that streams
 * still streams.
 *
 * @param pending - The pending validation result
 * @param run - Validates the result and calls the callback
 * @returns The callback's final value
 */
async function* afterValidation<T>(
  pending: Promise<StandardSchemaV1.Result<T>>,
  run: (result: StandardSchemaV1.Result<T>) => unknown
): AsyncGenerator<JSONValue, JSONValue, never> {
  const output = run(await pending)
  if (isAsyncGenerator(output)) return (yield* output as AsyncGenerator<JSONValue, JSONValue, never>) as JSONValue
  return (await output) as JSONValue
}

/**
 * Tool implementation for any schema that implements Standard Schema and Standard JSON Schema.
 * Extends Tool abstract class and implements InvokableTool interface.
 */
export class StandardSchemaTool<TInput extends StandardToolSchema, TReturn = JSONValue>
  extends Tool
  implements InvokableTool<StandardInferred<TInput>, TReturn>
{
  /**
   * Internal FunctionTool for delegating stream operations.
   */
  private readonly _functionTool: FunctionTool

  /**
   * Schema for input validation.
   */
  private readonly _inputSchema: TInput

  /**
   * User callback function.
   */
  private readonly _callback: (input: StandardInferred<TInput>, context?: ToolContext) => ToolCallbackResult<TReturn>

  constructor(config: StandardSchemaToolConfig<TInput, TReturn>) {
    super()
    const { name, description = '', inputSchema, callback } = config
    this._inputSchema = inputSchema
    this._callback = callback

    this._functionTool = new FunctionTool({
      name,
      description,
      inputSchema: standardSchemaToJsonSchema(inputSchema),
      callback: (
        input: unknown,
        toolContext: ToolContext
      ): AsyncGenerator<JSONValue, JSONValue, never> | Promise<JSONValue> | JSONValue => {
        const run = (result: StandardSchemaV1.Result<StandardInferred<TInput>>): unknown =>
          callback(unwrap(name, result), toolContext)
        const result = this._inputSchema['~standard'].validate(input) as
          StandardSchemaV1.Result<StandardInferred<TInput>> | Promise<StandardSchemaV1.Result<StandardInferred<TInput>>>
        if (result instanceof Promise) return afterValidation(result, run)
        return run(result) as AsyncGenerator<JSONValue, JSONValue, never> | Promise<JSONValue> | JSONValue
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
  async invoke(input: StandardInferred<TInput>, context?: ToolContext): Promise<TReturn> {
    const validated = unwrap(this.name, await this._inputSchema['~standard'].validate(input))
    const result = this._callback(validated as StandardInferred<TInput>, context)
    if (isAsyncGenerator(result)) {
      const generator = result as AsyncGenerator<unknown, TReturn, undefined>
      let iterResult = await generator.next()
      while (!iterResult.done) {
        iterResult = await generator.next()
      }
      return iterResult.value
    }
    return await result
  }
}
