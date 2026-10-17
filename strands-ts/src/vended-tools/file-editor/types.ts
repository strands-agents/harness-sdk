// The Zod schema in `file-editor.ts` (`fileEditorInputSchema`) is the single
// source of truth for the validated input shape. These interfaces exist as a
// discriminated union so consumers can narrow on `command` in TypeScript; when
// you add or rename a field on the schema, update the matching interface here
// too.

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
  /**
   * When true, replace every occurrence of `old_str`. Defaults to false; a
   * match count \> 1 is rejected without this flag to prevent silent broad
   * edits.
   */
  replace_all?: boolean
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
 * Input parameters for find_line operation.
 */
export interface FindLineInput {
  command: 'find_line'
  path: string
  search_text: string
  /**
   * When true, whitespace between tokens is collapsed and matching is
   * case-insensitive.
   */
  fuzzy?: boolean
}

/**
 * Input parameters for undo_edit operation.
 */
export interface UndoEditInput {
  command: 'undo_edit'
  path: string
}

/**
 * Union type of all valid file editor inputs.
 */
export type FileEditorInput = ViewInput | CreateInput | StrReplaceInput | InsertInput | FindLineInput | UndoEditInput
