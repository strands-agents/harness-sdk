import { z } from 'zod'
import { createErrorResult, Tool } from './tool.js'
import type { ToolContext, ToolStreamGenerator } from './tool.js'
import type { ToolSpec } from './types.js'
import { FunctionTool } from './function-tool.js'
import { zodSchemaToJsonSchema } from './zod-utils.js'
import type { JSONSchema, JSONValue } from '../types/json.js'
import { ToolResultBlock, toolResultContentFromData, type ToolResultBlockData } from '../types/messages.js'

/**
 * Name of every interrupt a client tool raises (`Interrupt.name`).
 */
export const CLIENT_TOOL_INTERRUPT_NAME = 'strands:client-tool'

/**
 * Configuration for a {@link ClientTool}.
 */
export interface ClientToolConfig {
  /** Tool name shown to the model. */
  name: string
  /** Tool description shown to the model. */
  description: string
  /**
   * A Zod schema, which also validates the model's input before the interrupt, or a JSON schema,
   * passed through unvalidated. Defaults to an object with no properties.
   */
  inputSchema?: z.ZodType | JSONSchema
}

/**
 * A tool whose execution is handed back to the caller through an interrupt.
 *
 * When the model calls it, the agent stops with an interrupt named {@link CLIENT_TOOL_INTERRUPT_NAME}
 * whose `reason` is `{ name, input }`. Resume the agent with an `InterruptResponseContent`; the
 * response becomes the tool result. A response shaped like `{ status, content }` is used as the
 * tool result as-is.
 *
 * @example
 * ```typescript
 * const agent = new Agent({ tools: [new ClientTool({ name: 'get_location', description: "Get the user's location." })] })
 * const result = await agent.invoke('Where am I?')
 * const interrupt = result.interrupts![0]! // interrupt.reason is { name: 'get_location', input: {} }
 * await agent.invoke([new InterruptResponseContent({ interruptId: interrupt.id, response: { city: 'Seattle' } })])
 * ```
 */
export class ClientTool extends Tool {
  readonly name: string
  readonly description: string
  readonly toolSpec: ToolSpec
  private readonly _zodSchema?: z.ZodType

  constructor(config: ClientToolConfig) {
    super()
    this.name = config.name
    this.description = config.description
    let inputSchema: JSONSchema = { type: 'object', properties: {} }
    if (config.inputSchema instanceof z.ZodType) {
      this._zodSchema = config.inputSchema
      inputSchema = zodSchemaToJsonSchema(config.inputSchema)
    } else if (config.inputSchema) {
      inputSchema = config.inputSchema
    }
    this.toolSpec = { name: this.name, description: this.description, inputSchema }
  }

  async *stream(toolContext: ToolContext): ToolStreamGenerator {
    const { toolUse } = toolContext
    const parsed = this._zodSchema?.safeParse(toolUse.input)
    if (parsed && !parsed.success) {
      return createErrorResult(parsed.error, toolUse.toolUseId)
    }

    const response = toolContext.interrupt<JSONValue>({
      name: CLIENT_TOOL_INTERRUPT_NAME,
      reason: { name: this.name, input: toolUse.input },
    })
    if (isToolResultData(response)) {
      return new ToolResultBlock({
        toolUseId: toolUse.toolUseId,
        status: response.status,
        content: response.content.map(toolResultContentFromData),
      })
    }
    // Reuse FunctionTool's conversion of plain values to tool result content.
    return yield* new FunctionTool({ name: this.name, description: this.description, callback: () => response }).stream(
      toolContext
    )
  }
}

function isToolResultData(value: unknown): value is Pick<ToolResultBlockData, 'status' | 'content'> {
  if (typeof value !== 'object' || value === null) return false
  const { status, content } = value as Record<string, unknown>
  return (status === 'success' || status === 'error') && Array.isArray(content)
}
