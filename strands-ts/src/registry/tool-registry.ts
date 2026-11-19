import type { Tool } from '../tools/tool.js'
import type { ToolSpec } from '../tools/types.js'
import { ToolValidationError, ToolNotFoundError } from '../errors.js'

/** @internal Maximum tool-name length accepted by the registry. */
export const MAX_TOOL_NAME_LENGTH = 64

/**
 * Registry for managing Tool instances with name-based CRUDL operations.
 */
export class ToolRegistry {
  private _tools: Map<string, Tool> = new Map()

  /** Whether {@link toolSpecs} returns specs sorted by name. */
  sortToolSpecs: boolean

  /**
   * Creates a new ToolRegistry, optionally pre-populated with tools.
   *
   * @param tools - Optional initial tools to register
   * @param options - Registry options. `sortToolSpecs` makes {@link toolSpecs} return specs sorted by name;
   *   defaults to false, which keeps registration order.
   */
  constructor(tools?: Tool[], options?: { sortToolSpecs?: boolean }) {
    this.sortToolSpecs = options?.sortToolSpecs ?? false
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
      this._validateNewTool(t, this._tools)
      this._tools.set(t.name, t)
    }
  }

  /**
   * Swaps one source's tools for its new list in a single step, preserving the source's slot in registration order.
   * Each new tool is checked against the registry without `current` and against the new tools before it. A tool that
   * fails the check is skipped, so another source's tool with the same name stays registered.
   *
   * @param current - The source's registered tools; a tool not registered under its name is left alone
   * @param next - The source's new tools
   * @param options - Optional placement hints used when `current` has no registered tools in the registry
   * @returns The tools of `next` that were skipped, each with the reason
   * @internal
   */
  swap(current: Tool[], next: Tool[], options?: { insertBefore?: Tool }): { tool: Tool; error: ToolValidationError }[] {
    const removedNames = new Set<string>()
    for (const tool of current) {
      if (this._tools.get(tool.name) === tool) {
        removedNames.add(tool.name)
      }
    }

    const remaining = new Map<string, Tool>()
    let insertAt = -1
    for (const [name, tool] of this._tools) {
      if (removedNames.has(name)) {
        if (insertAt === -1) insertAt = remaining.size
      } else {
        remaining.set(name, tool)
      }
    }

    if (insertAt === -1) {
      insertAt = remaining.size
      const anchor = options?.insertBefore
      if (anchor !== undefined && remaining.get(anchor.name) === anchor) {
        let index = 0
        for (const tool of remaining.values()) {
          if (tool === anchor) {
            insertAt = index
            break
          }
          index += 1
        }
      }
    }

    const validationMap = new Map(remaining)
    const accepted: Tool[] = []
    const skipped: { tool: Tool; error: ToolValidationError }[] = []
    for (const tool of next) {
      try {
        this._validateNewTool(tool, validationMap)
        validationMap.set(tool.name, tool)
        accepted.push(tool)
      } catch (error) {
        if (!(error instanceof ToolValidationError)) throw error
        skipped.push({ tool, error })
      }
    }

    const rebuilt = new Map<string, Tool>()
    let index = 0
    for (const [name, tool] of remaining) {
      if (index === insertAt) {
        for (const nextTool of accepted) {
          rebuilt.set(nextTool.name, nextTool)
        }
      }
      rebuilt.set(name, tool)
      index += 1
    }
    if (insertAt >= remaining.size) {
      for (const nextTool of accepted) {
        rebuilt.set(nextTool.name, nextTool)
      }
    }

    this._tools = rebuilt
    return skipped
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

  /**
   * Returns the specs of all registered tools, sorted by name when {@link sortToolSpecs} is set.
   *
   * @returns Array of tool specs, sorted by name or in registration order
   */
  toolSpecs(): ToolSpec[] {
    const specs = this.list().map((tool) => tool.toolSpec)
    if (!this.sortToolSpecs) return specs
    return specs.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
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

  private _validateNewTool(tool: Tool, tools: Map<string, Tool>): void {
    this._validateProperties(tool)
    if (tools.has(tool.name)) {
      throw new ToolValidationError(`Tool with name '${tool.name}' already registered`)
    }
    this._checkNormalizedConflict(tool.name, tools)
  }

  private _checkNormalizedConflict(name: string, tools: Map<string, Tool> = this._tools): void {
    const normalized = name.replaceAll('-', '_')
    for (const existing of tools.keys()) {
      if (existing !== name && existing.replaceAll('-', '_') === normalized) {
        throw new ToolValidationError(
          `Tool name '${name}' already exists as '${existing}'.` +
            " Cannot add a duplicate tool which differs by a '-' or '_'"
        )
      }
    }
  }
}
