import { z } from 'zod'
import { createErrorResult, Tool } from './tool.js'
import type { ToolContext, ToolStreamGenerator } from './tool.js'
import type { ToolSpec, ToolUse } from './types.js'
import { FunctionTool } from './function-tool.js'
import { zodSchemaToJsonSchema } from './zod-utils.js'
import type { JSONSchema, JSONValue } from '../types/json.js'
import {
  ToolResultBlock,
  toolResultContentFromData,
  type ToolResultContent,
  type ToolResultContentData,
} from '../types/messages.js'
import type { Interrupt } from '../interrupt.js'

/**
 * Default `Interrupt.name` of the interrupts a client tool raises.
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
  /** `Interrupt.name` of the interrupts this tool raises. Defaults to {@link CLIENT_TOOL_INTERRUPT_NAME}. */
  interruptName?: string
}

/**
 * A tool whose execution is handed back to the caller through an interrupt.
 *
 * When the model calls it, the agent stops with an interrupt named {@link ClientTool.interruptName}
 * whose `reason` is the tool use, `{ toolUseId, name, input }`. Resume the agent with an `InterruptResponseContent`; the
 * response becomes the tool result. A `{ status: 'success' | 'error', content: [...] }` response is
 * used as the tool result as-is, which lets the caller report a failure.
 *
 * @example
 * ```typescript
 * const getLocation = new ClientTool({ name: 'get_location', description: "Get the user's location." })
 * const agent = new Agent({ tools: [getLocation] })
 * const result = await agent.invoke('Where am I?')
 * const interrupt = result.interrupts!.find((i) => getLocation.isInterrupt(i))! // reason narrowed to ToolUse
 * await agent.invoke([new InterruptResponseContent({ interruptId: interrupt.id, response: { city: 'Seattle' } })])
 * ```
 */
export class ClientTool extends Tool {
  readonly name: string
  readonly description: string
  readonly toolSpec: ToolSpec
  /** `Interrupt.name` of the interrupts this tool raises. */
  readonly interruptName: string
  private readonly _zodSchema?: z.ZodType

  constructor(config: ClientToolConfig) {
    super()
    this.name = config.name
    this.description = config.description
    this.interruptName = config.interruptName ?? CLIENT_TOOL_INTERRUPT_NAME
    let inputSchema: JSONSchema = { type: 'object', properties: {}, additionalProperties: false }
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
    let input = toolUse.input
    if (this._zodSchema) {
      const parsed = this._zodSchema.safeParse(input)
      if (!parsed.success) return createErrorResult(parsed.error, toolUse.toolUseId)
      input = parsed.data as JSONValue
    }

    const reason = { toolUseId: toolUse.toolUseId, name: this.name, input } satisfies ToolUse
    const response = toolContext.interrupt<JSONValue>({ name: this.interruptName, reason })
    const content = toolResultContent(response)
    if (content) {
      const { status } = response as { status: 'success' | 'error' }
      return new ToolResultBlock({ toolUseId: toolUse.toolUseId, status, content })
    }
    // Reuse FunctionTool's conversion of plain values to tool result content.
    return yield* new FunctionTool({ name: this.name, description: this.description, callback: () => response }).stream(
      toolContext
    )
  }

  /**
   * Whether `interrupt` is a call to this tool, narrowing its `reason` to the tool use.
   */
  isInterrupt(interrupt: Interrupt): interrupt is Interrupt & { reason: ToolUse } {
    const reason = interrupt.reason
    return (
      interrupt.name === this.interruptName &&
      typeof reason === 'object' &&
      reason !== null &&
      !Array.isArray(reason) &&
      reason.name === this.name
    )
  }
}

/** Content blocks of a `{ status, content }` tool-result response, or undefined for any other value. */
function toolResultContent(value: JSONValue): ToolResultContent[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { status, content } = value
  if ((status !== 'success' && status !== 'error') || !Array.isArray(content) || content.length === 0) return undefined
  try {
    return content.map((item) => toolResultContentFromData(item as unknown as ToolResultContentData))
  } catch {
    return undefined
  }
}
