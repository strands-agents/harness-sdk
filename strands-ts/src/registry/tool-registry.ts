import type { Tool } from '../tools/tool.js'
import { ToolValidationError, ToolNotFoundError } from '../errors.js'

/** @internal Maximum tool-name length accepted by the registry. */
export const MAX_TOOL_NAME_LENGTH = 64

/**
 * Registry for managing Tool instances with name-based CRUDL operations.
 */
export class ToolRegistry {
  private _tools: Map<string, Tool> = new Map()

  /**
   * Creates a new ToolRegistry, optionally pre-populated with tools.
   *
   * @param tools - Optional initial tools to register
   */
  constructor(tools?: Tool[]) {
    if (tools) {
      this.add(tools)
    }
  }

  /**
   * Registers one or more tools.
   *
   * @param tool - A single tool or array of tools to register
   * @throws ToolValidationError If a tool's properties are invalid or its name is already registered
   */
  add(tool: Tool | Tool[]): void {
    const tools = Array.isArray(tool) ? tool : [tool]
    for (const t of tools) {
      this._validateProperties(t)
      if (this._tools.has(t.name)) {
        throw new ToolValidationError(`Tool with name '${t.name}' already registered`)
      }
      this._checkNormalizedConflict(t.name)
      this._tools.set(t.name, t)
    }
  }

  /**
   * Registers one or more tools, replacing any existing tools with the same name.
   *
   * @param tools - Array of tools to register
   * @throws ToolValidationError If a tool's properties are invalid
   */
  addOrReplace(newTools: Tool[]): void {
    for (const tool of newTools) {
      this._validateProperties(tool)
      if (!this._tools.has(tool.name)) {
        this._checkNormalizedConflict(tool.name)
      }
      this._tools.set(tool.name, tool)
    }
  }

  /**
   * Retrieves a tool by name.
   *
   * @param name - The name of the tool to retrieve
   * @returns The tool if found, otherwise undefined
   */
  get(name: string): Tool | undefined {
    return this._tools.get(name)
  }

  /**
   * Resolves a tool name using normalization strategies and returns the tool.
   *
   * Resolution order:
   * 1. Exact match
   * 2. Underscore-to-hyphen substitution (e.g. `my_tool` → `my-tool`)
   * 3. Case-insensitive match
   *
   * @param name - The name to look up
   * @returns The resolved tool
   * @throws ToolNotFoundError if no tool with the given name exists
   */
  resolve(name: string): Tool {
    // 1. Direct match
    const exact = this._tools.get(name)
    if (exact) {
      return exact
    }

    const tools = this.list()

    // 2. Underscore-to-hyphen normalization
    if (name.includes('_')) {
      const match = tools.find((t) => t.name.replace(/-/g, '_') === name)
      if (match) {
        return match
      }
    }

    // 3. Case-insensitive match
    const lowerName = name.toLowerCase()
    const caseMatch = tools.find((t) => t.name.toLowerCase() === lowerName)
    if (caseMatch) {
      return caseMatch
    }

    throw new ToolNotFoundError(name)
  }

  /**
   * Removes a tool by name. No-op if the tool does not exist.
   *
   * @param name - The name of the tool to remove
   */
  remove(name: string): void {
    this._tools.delete(name)
  }

  /**
   * Removes all registered tools.
   */
  clear(): void {
    this._tools.clear()
  }

  /**
   * Returns all registered tools.
   *
   * @returns Array of all registered tools
   */
  list(): Tool[] {
    return Array.from(this._tools.values())
  }

  private _validateProperties(tool: Tool): void {
    if (typeof tool.name !== 'string') {
      throw new ToolValidationError('Tool name must be a string')
    }

    if (tool.name.length < 1 || tool.name.length > MAX_TOOL_NAME_LENGTH) {
      throw new ToolValidationError(`Tool name must be between 1 and ${MAX_TOOL_NAME_LENGTH} characters`)
    }

    const validNamePattern = /^[a-zA-Z0-9_-]+$/
    if (!validNamePattern.test(tool.name)) {
      throw new ToolValidationError('Tool name must contain only alphanumeric characters, hyphens, and underscores')
    }

    if (tool.description !== undefined && tool.description !== null) {
      if (typeof tool.description !== 'string' || tool.description.length < 1) {
        throw new ToolValidationError('Tool description must be a non-empty string')
      }
    }
  }

  private _checkNormalizedConflict(name: string): void {
    const normalized = name.replaceAll('-', '_')
    for (const existing of this._tools.keys()) {
      if (existing !== name && existing.replaceAll('-', '_') === normalized) {
        throw new ToolValidationError(
          `Tool name '${name}' already exists as '${existing}'.` +
            " Cannot add a duplicate tool which differs by a '-' or '_'"
        )
      }
    }
  }
}
