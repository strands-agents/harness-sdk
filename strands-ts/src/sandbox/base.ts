/**
 * Base sandbox interface.
 *
 * Defines the abstract {@link Sandbox} class that all sandbox implementations
 * must extend. The class provides six abstract operations (command execution,
 * code execution, and file I/O) and convenience wrappers for common patterns.
 */

import type { ExecutionResult, FileInfo, StreamChunk } from './types.js'
import type { Tool } from '../tools/tool.js'

/**
 * Options for command and code execution.
 */
export interface ExecuteOptions {
  /** Maximum execution time in seconds. `undefined` means no timeout. */
  timeout?: number | undefined
  /** Working directory for execution. `undefined` means use the sandbox default. */
  cwd?: string | undefined
  /** Abort signal to cancel execution. The process is killed when the signal fires. */
  signal?: AbortSignal | undefined
  /**
   * Environment variables to set for this command. Built-in sandboxes always apply these,
   * though the mechanism differs (Docker `-e` flags, SSH `env` prefix); custom `Sandbox`
   * implementations must handle env explicitly or it has no effect.
   */
  env?: Record<string, string> | undefined
}

/**
 * Abstract execution environment.
 *
 * A Sandbox provides the runtime context where tools execute code,
 * run commands, and interact with a filesystem. Multiple tools share
 * the same Sandbox instance, giving them a common working directory
 * and filesystem.
 *
 * Streaming methods (`executeStreaming`, `executeCodeStreaming`) are the abstract primitives.
 * Non-streaming convenience methods (`execute`, `executeCode`) consume
 * the stream and return the final result.
 */
export abstract class Sandbox {
  /**
   * Execute a shell command, streaming output.
   *
   * Yields {@link StreamChunk} objects for stdout and stderr as output
   * arrives. The final yield is an {@link ExecutionResult} with the
   * exit code and complete output.
   *
   * @param command - The shell command to execute.
   * @param options - Execution options.
   * @returns Async iterable yielding StreamChunks followed by a final ExecutionResult.
   */
  abstract executeStreaming(command: string, options?: ExecuteOptions): AsyncIterable<StreamChunk | ExecutionResult>

  /**
   * Execute source code via a language interpreter, streaming output.
   *
   * @param code - The source code to execute.
   * @param language - The interpreter to use (e.g., `"python3"`, `"node"`).
   * @param options - Execution options.
   * @returns Async iterable yielding StreamChunks followed by a final ExecutionResult.
   */
  abstract executeCodeStreaming(
    code: string,
    language: string,
    options?: ExecuteOptions
  ): AsyncIterable<StreamChunk | ExecutionResult>

  /**
   * Read a file from the sandbox filesystem as raw bytes.
   *
   * Returns `Uint8Array` to support both text and binary files.
   * Use {@link readText} for a convenience wrapper that decodes to a string.
   *
   * @param path - Path to the file to read.
   * @returns The file contents as raw bytes.
   * @throws `SandboxPathNotFoundError` if the path does not exist, `SandboxIsADirectoryError` if it is a directory,
   *   `SandboxPermissionError` if it cannot be read (each also has a Node fs-style `code`). Other failures throw an Error.
   */
  abstract readFile(path: string): Promise<Uint8Array>

  /**
   * Write raw bytes to a file in the sandbox filesystem.
   *
   * Implementations should create parent directories if they do not exist.
   * Use {@link writeText} for a convenience wrapper that encodes a string.
   *
   * @param path - Path to the file to write.
   * @param content - The content to write.
   */
  abstract writeFile(path: string, content: Uint8Array): Promise<void>

  /**
   * Remove a file from the sandbox filesystem.
   *
   * @param path - Path to the file to remove.
   * @throws Error if the file does not exist.
   */
  abstract removeFile(path: string): Promise<void>

  /**
   * List files in a sandbox directory.
   *
   * Returns {@link FileInfo} entries with name, isDir, and size metadata.
   * Fields `isDir` and `size` may be `undefined` if the backend cannot
   * determine them.
   *
   * @param path - Path to the directory to list.
   * @returns Array of FileInfo entries for the directory contents.
   * @throws Error if the directory does not exist.
   */
  abstract listFiles(path: string): Promise<FileInfo[]>

  /**
   * Tools this sandbox vends to an agent, registered during `Agent.initialize()`.
   * A tool is skipped if the user already registered one with the same name.
   * Override to provide them.
   */
  getTools(): Tool[] {
    return []
  }

  // ---- Non-streaming convenience methods ----

  /**
   * Execute a shell command and return the result.
   *
   * Consumes {@link executeStreaming} and returns the final {@link ExecutionResult}.
   * Use `executeStreaming` when you need to process output as it arrives.
   *
   * @param command - The shell command to execute.
   * @param options - Execution options.
   * @returns The execution result with exit code and output.
   */
  async execute(command: string, options?: ExecuteOptions): Promise<ExecutionResult> {
    for await (const chunk of this.executeStreaming(command, options)) {
      if (chunk.type === 'executionResult') {
        return chunk
      }
    }
    throw new Error('executeStreaming() did not yield an ExecutionResult')
  }

  /**
   * Execute source code and return the result.
   *
   * Consumes {@link executeCodeStreaming} and returns the final {@link ExecutionResult}.
   * Use `executeCodeStreaming` when you need to process output as it arrives.
   *
   * @param code - The source code to execute.
   * @param language - The interpreter to use.
   * @param options - Execution options.
   * @returns The execution result with exit code and output.
   */
  async executeCode(code: string, language: string, options?: ExecuteOptions): Promise<ExecutionResult> {
    for await (const chunk of this.executeCodeStreaming(code, language, options)) {
      if (chunk.type === 'executionResult') {
        return chunk
      }
    }
    throw new Error('executeCodeStreaming() did not yield an ExecutionResult')
  }

  /**
   * Read a text file from the sandbox filesystem.
   *
   * Convenience wrapper over {@link readFile} that decodes bytes as UTF-8.
   * For other encodings, call `readFile` and decode manually.
   *
   * @param path - Path to the file to read.
   * @returns The file contents decoded as a UTF-8 string.
   */
  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path))
  }

  /**
   * Write a text file to the sandbox filesystem.
   *
   * Convenience wrapper over {@link writeFile} that encodes a string as UTF-8.
   * For other encodings, encode manually and call `writeFile`.
   *
   * @param path - Path to the file to write.
   * @param content - The text content to write.
   */
  async writeText(path: string, content: string): Promise<void> {
    await this.writeFile(path, new TextEncoder().encode(content))
  }
}
