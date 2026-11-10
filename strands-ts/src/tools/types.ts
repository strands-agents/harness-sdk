import type { JSONSchema, JSONValue } from '../types/json.js'

/**
 * Status of a tool execution.
 * Indicates whether the tool executed successfully or encountered an error.
 */
export type ToolResultStatus = 'success' | 'error'

/**
 * Specification for a tool that can be used by the model.
 * Defines the tool's name, description, and input schema.
 */
export interface ToolSpec {
  /**
   * The unique name of the tool.
   */
  name: string

  /**
   * A description of what the tool does.
   * This helps the model understand when to use the tool.
   */
  description: string

  /**
   * JSON Schema defining the expected input structure for the tool.
   * If omitted, defaults to an empty object schema allowing no input parameters.
   */
  inputSchema?: JSONSchema

  /**
   * JSON Schema defining the expected output structure for the tool.
   */
  outputSchema?: JSONSchema

  /**
   * Untrusted tool-behavior hints (e.g. MCP `readOnlyHint`, `destructiveHint`); never a security boundary.
   *
   * Not sent to model provider APIs. A missing key means unknown, not `false` — per MCP spec
   * `destructiveHint` and `openWorldHint` default to `true` when absent — and the field is absent
   * entirely for non-MCP tools.
   */
  annotations?: Record<string, JSONValue | undefined>
}

/**
 * Represents a tool usage request from the model.
 * The model generates this when it wants to use a tool.
 */
export interface ToolUse {
  /**
   * The name of the tool to execute.
   */
  name: string

  /**
   * Unique identifier for this tool use instance.
   * Used to match tool results back to their requests.
   */
  toolUseId: string

  /**
   * The input parameters for the tool.
   * Must be JSON-serializable.
   */
  input: JSONValue
}

/**
 * Specifies how the model should choose which tool to use.
 *
 * - `{ auto: {} }` - Let the model decide whether to use a tool
 * - `{ any: {} }` - Force the model to use one of the available tools
 * - `{ tool: { name: 'name' } }` - Force the model to use a specific tool
 */
export type ToolChoice = { auto: Record<string, never> } | { any: Record<string, never> } | { tool: { name: string } }
