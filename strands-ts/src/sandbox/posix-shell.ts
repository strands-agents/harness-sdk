/**
 * Shell sandbox with default implementations for file and code operations.
 *
 * Subclasses only need to implement {@link PosixShellSandbox.executeStreaming} —
 * all other operations are implemented by running shell commands through it.
 * Use this for remote environments where only shell access is available
 * (Docker containers, SSH connections, cloud runtimes).
 */

import { Sandbox } from './base.js'
import type { ExecuteOptions } from './base.js'
import { ENV_KEY_PATTERN, LANGUAGE_PATTERN, shellQuote } from './constants.js'
import { SandboxPathNotFoundError } from './errors.js'
import type { ExecutionResult, FileInfo, StreamChunk } from './types.js'
import { decodeBase64, encodeBase64 } from '../types/media.js'

/**
 * Validate environment variable names against {@link ENV_KEY_PATTERN}.
 * @throws If any key is not a valid POSIX environment variable name.
 */
export function validateEnvKeys(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`)
    }
  }
}

/**
 * Build a shell `export KEY=VALUE && ...` prefix for a command, or `''` when there are none.
 * Keys are validated; values are {@link shellQuote}d. Used by shell-string backends (e.g. SSH);
 * backends that set env via native flags (e.g. Docker's `-e`) call {@link validateEnvKeys} directly.
 *
 * Uses `export` rather than an `env KEY=VALUE` command wrapper so the variables are set in the
 * shell itself and inherited by every stage of a pipeline. `executeCode` runs `base64 ... | <lang>`,
 * and an `env` wrapper would only bind the left side of the pipe, never reaching the interpreter.
 * The trailing `&&` keeps the surrounding `cd ... && <prefix><command>` chain fail-fast.
 */
export function buildShellEnvPrefix(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) {
    return ''
  }
  validateEnvKeys(env)
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`)
  return `export ${assignments.join(' ')} && `
}

/**
 * Abstract sandbox that provides shell-based defaults for file and code operations.
 * Assumes a POSIX-compatible shell (sh/bash) on the target.
 *
 * Subclasses only need to implement {@link executeStreaming}. The remaining
 * operations — `executeCodeStreaming`, `readFile`, `writeFile`, `removeFile`,
 * and `listFiles` — are implemented via shell commands piped through
 * `executeStreaming`.
 *
 * Subclasses may override any method with a native implementation for
 * better performance or to handle edge cases (e.g., binary-safe file
 * transfer via Docker stdin pipes, or native API calls for cloud backends).
 *
 * Subclasses must apply `options.env` in `executeStreaming` or it has no effect:
 * backends that build a shell-command string prepend {@link buildShellEnvPrefix};
 * backends that set env via process flags (e.g. Docker's `-e`) call
 * {@link validateEnvKeys} and pass the values directly.
 */
export abstract class PosixShellSandbox extends Sandbox {
  async *executeCodeStreaming(
    code: string,
    language: string,
    options?: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    if (!LANGUAGE_PATTERN.test(language)) {
      throw new Error(`language parameter contains invalid characters: ${language}`)
    }
    const encoded = encodeBase64(new TextEncoder().encode(code))
    const eof = `STRANDS_EOF_${crypto.randomUUID().slice(0, 16)}`
    yield* this.executeStreaming(`base64 -d << '${eof}' | ${language}\n${encoded}\n${eof}`, options)
  }

  async readFile(path: string): Promise<Uint8Array> {
    const result = await this.execute(`base64 < ${shellQuote(path)}`)
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to read file: ${path}`)
    }
    return decodeBase64(result.stdout.replace(/\s/g, ''))
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const encoded = encodeBase64(content)
    const quoted = shellQuote(path)
    const eof = `STRANDS_EOF_${crypto.randomUUID().slice(0, 16)}`
    const cmd = `mkdir -p "$(dirname ${quoted})" && base64 -d << '${eof}' > ${quoted}\n${encoded}\n${eof}`
    const result = await this.execute(cmd)
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to write file: ${path}`)
    }
  }

  async removeFile(path: string): Promise<void> {
    const result = await this.execute(`rm ${shellQuote(path)}`)
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to remove file: ${path}`)
    }
  }

  async listFiles(path: string): Promise<FileInfo[]> {
    const quoted = shellQuote(path)
    // Exit 77 distinguishes a missing directory from ls's own failures (locale-independent).
    const result = await this.execute(`test -d ${quoted} || exit 77; env QUOTING_STYLE=literal ls -1ap ${quoted}`)
    if (result.exitCode === 77) {
      throw new SandboxPathNotFoundError(path)
    }
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to list directory: ${path}`)
    }

    const entries: FileInfo[] = []
    for (const raw of result.stdout.split('\n')) {
      const line = raw.replace(/\r$/, '')
      if (!line || line === './' || line === '../') {
        continue
      }
      const isDir = line.endsWith('/')
      const name = isDir ? line.slice(0, -1) : line
      if (name) {
        entries.push({ name, isDir })
      }
    }
    return entries
  }
}
