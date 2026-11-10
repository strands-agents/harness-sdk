/**
 * Configuration options for the file editor tool.
 */
export interface FileEditorOptions {
  /**
   * Maximum file size in bytes that can be read (default: 1048576 / 1MB).
   */
  maxFileSize?: number
}

/**
 * Input parameters for view operation.
 */
export interface ViewInput {
  command: 'view'
  path: string
  view_range?: [number, number]
}

/**
 * Input parameters for create operation.
 */
export interface CreateInput {
  command: 'create'
  path: string
  file_text: string
}

/**
 * Input parameters for str_replace operation.
 */
export interface StrReplaceInput {
  command: 'str_replace'
  path: string
  old_str: string
  new_str?: string
}

/**
 * Input parameters for insert operation.
 */
export interface InsertInput {
  command: 'insert'
  path: string
  insert_line: number
  new_str: string
}

/**
 * Union type of all valid file editor inputs.
 */
export type FileEditorInput = ViewInput | CreateInput | StrReplaceInput | InsertInput

/**
 * Interface for pluggable file readers.
 * Allows extending the file editor to support different file types.
 */
export interface IFileReader {
  /**
   * Reads the file content and returns it as a string.
   *
   * @param path - Absolute path to the file
   * @returns File content as a string
   */
  read(path: string): Promise<string>
}
