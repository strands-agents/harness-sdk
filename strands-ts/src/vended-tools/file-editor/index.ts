/**
 * File editor tool for programmatic filesystem interaction.
 *
 * @deprecated `fileEditor` is deprecated in favor of the focused `edit` vended tool
 * (`@strands-agents/sdk/vended-tools/edit`). It will be removed in a future release.
 */

export { fileEditor, makeFileEditor, DEFAULT_FILE_EDITOR_DESCRIPTION } from './file-editor.js'
export type { MakeFileEditorOptions } from './file-editor.js'
export type { FileEditorInput, FileEditorOptions, IFileReader } from './types.js'
