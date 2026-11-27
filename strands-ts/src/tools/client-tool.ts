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
 * whose `reason` is the tool use, `{ toolUseId, name, input }`. Resume the agent with an `InterruptResponseContent`; the
 * response becomes the tool result. A `{ status: 'success' | 'error', content: [...] }` response is
 * used as the tool result as-is, which lets the caller report a failure.
 *
 * @example
 * ```typescript
 * const agent = new Agent({ tools: [new ClientTool({ name: 'get_location', description: "Get the user's location." })] })
 * const result = await agent.invoke('Where am I?')
 * const interrupt = result.interrupts![0]! // isClientToolInterrupt(interrupt) narrows reason to ToolUse
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
    const response = toolContext.interrupt<JSONValue>({ name: CLIENT_TOOL_INTERRUPT_NAME, reason })
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
}

/**
 * Whether an interrupt was raised by a {@link ClientTool}, narrowing its `reason` to the tool use.
 */
export function isClientToolInterrupt(interrupt: Interrupt): interrupt is Interrupt & { reason: ToolUse } {
  return interrupt.name === CLIENT_TOOL_INTERRUPT_NAME
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
