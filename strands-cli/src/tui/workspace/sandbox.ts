import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
import { isMissingPathError } from '../paths.js'

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

const PLATFORM_LABELS: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows',
  darwin: 'Darwin',
  linux: 'Linux',
}

export interface WorkspaceEnvironment {
  readonly platform: string
  readonly cwd: string
  readonly shell: 'sh' | 'PowerShell'
  readonly tempDir: string
}

interface Invocation {
  command: string
  args: string[]
  input?: string
  script?: string
}

export class WorkspaceSandbox extends Sandbox {
  readonly cwd: string
  readonly environment: WorkspaceEnvironment
  private readonly platform: NodeJS.Platform

  constructor(cwd: string, options: { platform?: NodeJS.Platform } = {}) {
    super()
    this.cwd = resolve(cwd)
    this.platform = options.platform ?? process.platform
    this.environment = {
      platform: PLATFORM_LABELS[this.platform] ?? this.platform,
      cwd: this.cwd,
      shell: this.platform === 'win32' ? 'PowerShell' : 'sh',
      tempDir: tmpdir(),
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
      if (isMissingPathError(error)) {
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

  async *executeStreaming(
    command: string,
    options: ExecuteOptions = {}
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    yield* this.run(this.shellInvocation(command), options)
  }

  async *executeCodeStreaming(
    code: string,
    language: string,
    options: ExecuteOptions = {}
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    if (!LANGUAGE_PATTERN.test(language)) {
      throw new Error(`language parameter contains invalid characters: ${language}`)
    }
    yield* this.run({ command: language, args: [], input: code }, options)
  }

  shellInvocation(command: string): Invocation {
    if (this.platform !== 'win32') {
      return { command: 'sh', args: ['-c', command] }
    }
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'],
      script: [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        command,
        '$ok = $?',
        'if (-not $ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }',
      ].join('\n'),
    }
  }

  private async *run(
    invocation: Invocation,
    options: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    let scriptPath: string | undefined
    if (invocation.script !== undefined) {
      scriptPath = join(tmpdir(), `strands-shell-${randomUUID()}.ps1`)
      await writeFile(scriptPath, `\uFEFF${invocation.script}`)
    }
    try {
      yield* this.spawn(invocation, scriptPath ? [...invocation.args, scriptPath] : invocation.args, options)
    } finally {
      if (scriptPath) {
        await unlink(scriptPath).catch(() => undefined)
      }
    }
  }

  private async *spawn(
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
    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
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

    child.stdout!.on('data', (data: string) => appendOutput(data, 'stdout'))
    child.stderr!.on('data', (data: string) => appendOutput(data, 'stderr'))
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
