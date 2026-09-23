import { readFile, writeFile, unlink, mkdir, readdir, stat } from 'fs/promises'
import { dirname, isAbsolute, join } from 'path'
import { Sandbox } from './base.js'
import type { ExecuteOptions } from './base.js'
import { LANGUAGE_PATTERN, shellQuote } from './constants.js'
import { SandboxPathNotFoundError } from './errors.js'
import { streamProcess } from './stream-process.js'
import type { ExecutionResult, FileInfo, StreamChunk } from './types.js'
import { buildShellEnvPrefix } from './posix-shell.js'
import { encodeBase64 } from '../types/media.js'

/** Returns true if the error is a missing entry (ENOENT) or a non-directory path component (ENOTDIR). */
function isMissingPathError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return false
  }
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
}

/**
 * Runs on the host with no isolation. Used as the default when no sandbox is configured.
 */
export class NotASandboxLocalEnvironment extends Sandbox {
  private _resolvePath(path: string): string {
    return isAbsolute(path) ? path : join(process.cwd(), path)
  }

  async *executeStreaming(
    command: string,
    options?: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    const cwd = options?.cwd ?? process.cwd()
    yield* streamProcess('sh', ['-c', `cd ${shellQuote(cwd)} && ${buildShellEnvPrefix(options?.env)}${command}`], {
      timeout: options?.timeout,
      signal: options?.signal,
    })
  }

  async *executeCodeStreaming(
    code: string,
    language: string,
    options?: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    if (!LANGUAGE_PATTERN.test(language)) {
      throw new Error(`language parameter contains invalid characters: ${language}`)
    }
    const cwd = options?.cwd ?? process.cwd()
    const encoded = encodeBase64(new TextEncoder().encode(code))
    const eof = `STRANDS_EOF_${crypto.randomUUID().slice(0, 16)}`
    yield* streamProcess(
      'sh',
      [
        '-c',
        `cd ${shellQuote(cwd)} && ${buildShellEnvPrefix(options?.env)}base64 -d << '${eof}' | ${language}\n${encoded}\n${eof}`,
      ],
      {
        timeout: options?.timeout,
        signal: options?.signal,
        enoentMessage: `Language interpreter not found: ${language}`,
      }
    )
  }

  async readFile(path: string): Promise<Uint8Array> {
    return readFile(this._resolvePath(path))
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const fullPath = this._resolvePath(path)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content)
  }

  async removeFile(path: string): Promise<void> {
    await unlink(this._resolvePath(path))
  }

  async listFiles(path: string): Promise<FileInfo[]> {
    const fullPath = this._resolvePath(path)
    let entries
    try {
      entries = await readdir(fullPath, { withFileTypes: true })
    } catch (err) {
      // A missing path (or a file where a directory was expected) is non-existence;
      // permission and other errors propagate so callers can surface them.
      if (isMissingPathError(err)) {
        throw new SandboxPathNotFoundError(path)
      }
      throw err
    }
    const results: FileInfo[] = []

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        const entryStat = await stat(join(fullPath, entry.name))
        results.push({ name: entry.name, isDir: entryStat.isDirectory(), size: entryStat.size })
      } catch {
        results.push({ name: entry.name })
      }
    }

    return results
  }
}
