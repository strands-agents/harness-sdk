import { Buffer } from 'buffer'
import { readFile, writeFile, unlink, mkdir, readdir, stat } from 'fs/promises'
import { dirname, isAbsolute, join } from 'path'
import { Sandbox } from './base.js'
import type { ExecuteOptions } from './base.js'
import { LANGUAGE_PATTERN, shellQuote } from './constants.js'
import { SandboxPathNotFoundError } from './errors.js'
import { streamProcess } from './stream-process.js'
import type { ExecutionResult, FileInfo, StreamChunk } from './types.js'
import { buildShellEnvPrefix, validateEnvKeys } from './posix-shell.js'

/**
 * The argv that runs `command` in PowerShell. `-EncodedCommand` (base64 of UTF-16LE) carries the script
 * without any command-line quoting; it inflates the text 2.67x against Windows' 32,767-character limit, so
 * commands over ~12 KB fail to spawn. The wrapper makes output UTF-8 (5.1 defaults to the OEM code page)
 * and mirrors `sh -c`'s exit code: the last statement's success, or the failing native command's own code.
 * `$ErrorActionPreference` is left alone because `Stop` turns native stderr output into a terminating error.
 */
function powershellArgs(command: string): string[] {
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    command,
    '$ok = $?',
    'if (-not $ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }',
  ].join('\n')
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/** The host environment with `extra` applied; Windows env names are case-insensitive, so `PATH` replaces `Path`. */
function hostEnvWith(extra?: Record<string, string>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const [key, value] of Object.entries(extra ?? {})) {
    for (const existing of Object.keys(env)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete env[existing]
    }
    env[key] = value
  }
  return env
}

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
    if (process.platform === 'win32') {
      // No `sh` on Windows: run the command in PowerShell; cwd and env go through spawn, not a shell prefix.
      if (options?.env) validateEnvKeys(options.env)
      yield* streamProcess('powershell.exe', powershellArgs(command), {
        timeout: options?.timeout,
        signal: options?.signal,
        cwd,
        env: hostEnvWith(options?.env),
        enoentMessage: 'PowerShell not found: powershell.exe is required to run commands on Windows',
      })
    } else {
      yield* streamProcess('sh', ['-c', `cd ${shellQuote(cwd)} && ${buildShellEnvPrefix(options?.env)}${command}`], {
        timeout: options?.timeout,
        signal: options?.signal,
      })
    }
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
    if (process.platform === 'win32') {
      // No shell involved: the interpreter is spawned directly and reads the code from stdin.
      if (options?.env) validateEnvKeys(options.env)
      yield* streamProcess(language, [], {
        timeout: options?.timeout,
        signal: options?.signal,
        cwd,
        env: hostEnvWith(options?.env),
        input: code,
        enoentMessage: `Language interpreter not found: ${language}`,
      })
      return
    }
    const encoded = btoa(Array.from(new TextEncoder().encode(code), (b) => String.fromCharCode(b)).join(''))
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
