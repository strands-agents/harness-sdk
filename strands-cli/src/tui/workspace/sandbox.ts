import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  Sandbox,
  SandboxAbortError,
  SandboxPathNotFoundError,
  SandboxTimeoutError,
  type ExecuteOptions,
  type ExecutionResult,
  type FileInfo,
  type StreamChunk,
} from '@strands-agents/sdk'
import { LANGUAGE_PATTERN } from '@strands-agents/sdk/sandbox'

import { terminateProcessTree } from '../terminal/process-tree.js'

const SIGNAL_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGTERM: 15,
}

const PLATFORM_LABELS: Partial<Record<NodeJS.Platform, string>> = { win32: 'Windows', darwin: 'Darwin', linux: 'Linux' }

/** What the harness's environment plugin surfaces to the model instead of probing with `uname`/`pwd`. */
export interface WorkspaceEnvironment {
  readonly platform: string
  readonly cwd: string
  readonly shell: 'sh' | 'PowerShell'
}

interface Invocation {
  command: string
  args: string[]
  /** Fed to the child's stdin. */
  input?: string
  /** Written to a temp file whose path becomes the last argument (PowerShell `-File`). */
  script?: string
}

/**
 * Local sandbox anchored to the TUI's workspace. Files go through `fs`; commands run in `sh` on POSIX and in
 * PowerShell on Windows (plain Windows has no `sh`); code runs by feeding the interpreter on stdin, so no shell
 * is involved. Cancellation kills the whole process tree, not just the shell.
 */
export class WorkspaceSandbox extends Sandbox {
  readonly cwd: string
  readonly environment: WorkspaceEnvironment
  private readonly _platform: NodeJS.Platform

  constructor(cwd: string, options: { platform?: NodeJS.Platform } = {}) {
    super()
    this.cwd = resolve(cwd)
    this._platform = options.platform ?? process.platform
    this.environment = {
      platform: PLATFORM_LABELS[this._platform] ?? this._platform,
      cwd: this.cwd,
      shell: this._platform === 'win32' ? 'PowerShell' : 'sh',
    }
  }

  override readFile(path: string): Promise<Uint8Array> {
    return readFile(resolve(this.cwd, path))
  }

  override async writeFile(path: string, content: Uint8Array): Promise<void> {
    const fullPath = resolve(this.cwd, path)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content)
  }

  override async removeFile(path: string): Promise<void> {
    await unlink(resolve(this.cwd, path))
  }

  override async listFiles(path: string): Promise<FileInfo[]> {
    const fullPath = resolve(this.cwd, path)
    let entries
    try {
      entries = await readdir(fullPath, { withFileTypes: true })
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        throw new SandboxPathNotFoundError(path)
      }
      throw error
    }
    return Promise.all(
      entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry): Promise<FileInfo> => {
          try {
            const metadata = await stat(join(fullPath, entry.name))
            return { name: entry.name, isDir: metadata.isDirectory(), size: metadata.size }
          } catch {
            return { name: entry.name }
          }
        })
    )
  }

  /** The argv that runs `command` in this sandbox's shell. Exposed for tests; no process is started. */
  shellInvocation(command: string): Invocation {
    if (this._platform !== 'win32') {
      return { command: 'sh', args: ['-c', command] }
    }
    // The script goes through a temp file (`-File`): no command-line length cap and no quoting layer. UTF-8 in and
    // out keeps native commands readable (BOM-less for stdin pipes). The exit code mirrors `sh -c`: the last
    // statement's success, with a failing native command's own code when there is one. `$ErrorActionPreference`
    // stays at its default — `Stop` would turn native stderr output into a terminating error on PowerShell 5.1.
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      command,
      '$ok = $?',
      'if (-not $ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }',
    ].join('\n')
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'],
      script,
    }
  }

  executeStreaming(
    command: string,
    options: ExecuteOptions = {}
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    return this._run(this.shellInvocation(command), options)
  }

  executeCodeStreaming(
    code: string,
    language: string,
    options: ExecuteOptions = {}
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    if (!LANGUAGE_PATTERN.test(language)) {
      throw new Error(`language parameter contains invalid characters: ${language}`)
    }
    return this._run({ command: language, args: [], input: code }, options)
  }

  private async *_run(
    invocation: Invocation,
    options: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    let scriptPath: string | undefined
    if (invocation.script !== undefined) {
      scriptPath = join(tmpdir(), `strands-shell-${randomUUID()}.ps1`)
      // The BOM makes PowerShell 5.1 read the file as UTF-8 rather than the ANSI code page.
      await writeFile(scriptPath, `\uFEFF${invocation.script}`)
    }
    try {
      yield* this._spawn(
        invocation,
        scriptPath === undefined ? invocation.args : [...invocation.args, scriptPath],
        options
      )
    } finally {
      if (scriptPath !== undefined) await unlink(scriptPath).catch(() => undefined)
    }
  }

  private async *_spawn(
    invocation: Invocation,
    args: string[],
    options: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    const child = spawn(invocation.command, args, {
      cwd: options.cwd ? resolve(this.cwd, options.cwd) : this.cwd,
      env: { ...process.env, ...options.env },
      stdio: [invocation.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const chunks: StreamChunk[] = []
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    let done = false
    let failure: unknown
    let wake: (() => void) | undefined
    let timeout: NodeJS.Timeout | undefined
    let terminationTask: Promise<void> | undefined

    const notify = (): void => {
      wake?.()
      wake = undefined
    }
    const terminate = (error: Error): void => {
      if (done || failure) {
        return
      }
      failure = error
      terminationTask = terminateProcessTree(child)
      notify()
    }
    const appendOutput = (text: string, streamType: 'stdout' | 'stderr'): void => {
      if (!text) {
        return
      }
      if (streamType === 'stdout') {
        stdout += text
      } else {
        stderr += text
      }
      chunks.push({ type: 'streamChunk', data: text, streamType })
      notify()
    }

    child.stdout!.on('data', (data: Buffer) => {
      appendOutput(stdoutDecoder.write(data), 'stdout')
    })
    child.stderr!.on('data', (data: Buffer) => {
      appendOutput(stderrDecoder.write(data), 'stderr')
    })
    child.stdout!.on('end', () => appendOutput(stdoutDecoder.end(), 'stdout'))
    child.stderr!.on('end', () => appendOutput(stderrDecoder.end(), 'stderr'))
    child.on('error', (error) => {
      failure = error
      done = true
      notify()
    })
    child.on('close', (code, signal) => {
      exitCode = code ?? (signal ? 128 + (SIGNAL_CODES[signal] ?? 1) : 1)
      done = true
      notify()
    })
    if (invocation.input !== undefined) {
      // A missing interpreter surfaces through 'error' above; EPIPE here would only duplicate it.
      child.stdin!.on('error', () => {})
      child.stdin!.end(invocation.input)
    }

    const onAbort = (): void => terminate(new SandboxAbortError())
    if (options.signal?.aborted) {
      onAbort()
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true })
    }
    if (options.timeout !== undefined) {
      timeout = setTimeout(() => terminate(new SandboxTimeoutError(options.timeout!)), options.timeout * 1_000)
    }

    try {
      while (!done || chunks.length > 0) {
        for (const chunk of chunks.splice(0)) {
          yield chunk
        }
        if (!done) {
          await new Promise<void>((resolveWait) => {
            wake = resolveWait
          })
        }
      }
      if (failure) {
        throw failure
      }
      yield {
        type: 'executionResult',
        exitCode,
        stdout,
        stderr,
        outputFiles: [],
      }
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      if (!done) {
        terminationTask ??= terminateProcessTree(child)
      }
      await terminationTask
    }
  }
}
