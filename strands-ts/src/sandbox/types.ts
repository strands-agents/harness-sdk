/**
 * Data types for the sandbox abstraction.
 *
 * These types represent the inputs and outputs of sandbox operations —
 * execution results, file metadata, and streaming chunks.
 */

/**
 * Type of a streaming output chunk — distinguishes stdout from stderr.
 */
export type StreamType = 'stdout' | 'stderr'

/**
 * A typed chunk of streaming output from command or code execution.
 *
 * Allows consumers to distinguish stdout from stderr during streaming,
 * enabling richer UIs and more precise output handling.
 */
export interface StreamChunk {
  readonly type: 'streamChunk'
  readonly data: string
  readonly streamType: StreamType
}

/**
 * Metadata about a file or directory in a sandbox.
 *
 * Provides minimal structured information that lets tools distinguish
 * files from directories and report sizes. `isDir` and `size` are
 * `undefined` when the backend cannot determine them accurately.
 */
export interface FileInfo {
  readonly name: string
  readonly isDir?: boolean
  readonly size?: number
}

/**
 * A file produced as output by code execution.
 *
 * Used to carry binary artifacts (images, charts, PDFs, compiled files)
 * from sandbox execution back to the agent. Shell-based sandboxes
 * typically return an empty array. Jupyter-backed or API-backed
 * sandboxes can populate this with generated artifacts.
 */
export interface OutputFile {
  readonly name: string
  readonly content: Uint8Array
  readonly mimeType: string
}

/**
 * Result of command or code execution in a sandbox.
 */
export interface ExecutionResult {
  readonly type: 'executionResult'
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly outputFiles: OutputFile[]
}
