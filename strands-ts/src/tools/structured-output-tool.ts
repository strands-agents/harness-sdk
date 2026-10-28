import { z } from 'zod'
import { Tool, type ToolContext, type ToolStreamGenerator } from './tool.js'
import type { ToolSpec } from './types.js'
import { JsonBlock, TextBlock, ToolResultBlock, type Message } from '../types/messages.js'
import type { JSONValue } from '../types/json.js'
import { zodSchemaToJsonSchema } from './zod-utils.js'
import { StructuredOutputError } from '../errors.js'

/** Tool name used for structured output validation. */
export const STRUCTURED_OUTPUT_TOOL_NAME = 'strands_structured_output'

/**
 * Error message when the model neither called the structured output tool nor returned a JSON object.
 *
 * @internal
 */
export const NO_STRUCTURED_OUTPUT_MESSAGE =
  'The model did not produce structured output: it neither called the structured output tool nor returned a JSON object.'

/**
 * Tool that validates LLM output against a Zod schema.
 * Provides validation feedback to the LLM for retry on failures.
 */
export class StructuredOutputTool extends Tool {
  private _schema: z.ZodSchema
  private _toolSpec: ToolSpec

  /**
   * Creates a new StructuredOutputTool.
   *
   * @param schema - The Zod schema to validate against
   */
  constructor(schema: z.ZodSchema) {
    super()
    this._schema = schema
    this._toolSpec = this._buildSpec()
  }

  /** @returns The tool name. */
  get name(): string {
    return this._toolSpec.name
  }

  /** @returns The tool description. */
  get description(): string {
    return this._toolSpec.description
  }

  /** @returns The full tool specification. */
  get toolSpec(): ToolSpec {
    return this._toolSpec
  }

  /**
   * Validates input against the schema.
   * On success, returns a ToolResultBlock with the validated JSON.
   * On failure, returns formatted validation errors for LLM retry.
   *
   * @param toolContext - The tool execution context
   * @returns Generator that returns a ToolResultBlock
   */
  // Validation is synchronous, so no streaming events are yielded
  // eslint-disable-next-line require-yield
  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    const { toolUse } = toolContext

    try {
      const validated = this._schema.parse(toolUse.input) as JSONValue

      return new ToolResultBlock({
        toolUseId: toolUse.toolUseId,
        status: 'success',
        content: [new JsonBlock({ json: validated })],
      })
    } catch (error) {
      const validationError = error instanceof Error ? error : new Error(String(error))

      return new ToolResultBlock({
        toolUseId: toolUse.toolUseId,
        status: 'error',
        content: [new TextBlock(validationError.message)],
        error: validationError,
      })
    }
  }

  /**
   * Validates the final text of the structured output retry as structured output.
   *
   * A provider that cannot force the structured output tool may return the result as JSON text instead. The text
   * must be exactly one JSON object.
   *
   * @param message - The assistant message that ended the structured output retry without a tool call
   * @returns The validated structured output
   * @throws StructuredOutputError if the text is not a JSON object or does not validate against the schema
   */
  resultFromText(message: Message): JSONValue {
    const data = jsonObjectFromMessage(message)
    if (data === undefined) {
      throw new StructuredOutputError(NO_STRUCTURED_OUTPUT_MESSAGE)
    }

    const result = this._schema.safeParse(data)
    if (!result.success) {
      throw new StructuredOutputError(`Structured output failed validation: ${result.error.message}`)
    }
    return result.data as JSONValue
  }

  /**
   * Builds the tool specification from the schema.
   *
   * @returns Tool specification with name, description, and input schema
   */
  private _buildSpec(): ToolSpec {
    const instruction =
      'This tool MUST only be invoked as the last and final tool before returning the completed result to the caller.'

    return {
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      description: this._schema.description
        ? `${instruction}\n<description>${this._schema.description}</description>`
        : instruction,
      inputSchema: zodSchemaToJsonSchema(this._schema),
    }
  }
}

/**
 * Parses a message's text as one JSON object, the form native structured output returns.
 *
 * @param message - The assistant message to parse
 * @returns The parsed object, or undefined if the text is not exactly one JSON object
 */
function jsonObjectFromMessage(message: Message): Record<string, JSONValue> | undefined {
  const text = message.content.map((block) => (block.type === 'textBlock' ? block.text : '')).join('')
  try {
    const data = JSON.parse(text) as JSONValue
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? data : undefined
  } catch {
    return undefined
  }
}
