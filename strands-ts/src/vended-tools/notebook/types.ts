/**
 * State structure for notebook storage.
 * Notebooks are stored in agent state under the 'notebooks' key.
 */
export interface NotebookState {
  /**
   * Map of notebook names to their content.
   * Each notebook stores plain text content with newline-separated lines.
   */
  notebooks: Record<string, string>
}

/**
 * Input parameters for create operation.
 * - mode: Operation mode, must be 'create'
 * - name: Name of the notebook to create
 * - newStr: Optional initial content for the notebook
 */
export interface CreateInput {
  mode: 'create'
  name?: string
  newStr?: string
}

/**
 * Input parameters for list operation.
 */
export interface ListInput {
  mode: 'list'
}

/**
 * Input parameters for read operation.
 * - mode: Operation mode, must be 'read'
 * - name: Name of the notebook to read
 * - readRange: Optional line range [start, end] to read. Supports negative indices.
 */
export interface ReadInput {
  mode: 'read'
  name?: string
  readRange?: [number, number]
}

/**
 * Input parameters for write operation (append to the end).
 * - mode: Operation mode, must be 'write'
 * - name: Name of the notebook to append to
 * - newStr: Text to append. A newline separator is added only when the notebook is non-empty and
 *   does not already end in one; an empty string is a no-op.
 */
export interface WriteAppendInput {
  mode: 'write'
  name?: string
  newStr: string
  oldStr?: never
  insertLine?: never
}

/**
 * Input parameters for write operation (string replacement).
 * - mode: Operation mode, must be 'write'
 * - name: Name of the notebook to write to
 * - oldStr: String to find and replace
 * - newStr: Replacement string
 */
export interface WriteReplaceInput {
  mode: 'write'
  name?: string
  oldStr: string
  newStr: string
}

/**
 * Input parameters for write operation (line insertion).
 * - mode: Operation mode, must be 'write'
 * - name: Name of the notebook to write to
 * - insertLine: Line number (supports negative indices) or search text for insertion point
 * - newStr: Text to insert
 */
export interface WriteInsertInput {
  mode: 'write'
  name?: string
  insertLine: string | number
  newStr: string
}

/**
 * Input parameters for clear operation.
 * - mode: Operation mode, must be 'clear'
 * - name: Name of the notebook to clear
 */
export interface ClearInput {
  mode: 'clear'
  name?: string
}

/**
 * Union type of all valid notebook inputs.
 */
export type NotebookInput =
  CreateInput | ListInput | ReadInput | WriteAppendInput | WriteReplaceInput | WriteInsertInput | ClearInput
