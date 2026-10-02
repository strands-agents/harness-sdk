import { spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  PosixShellSandbox,
  SandboxAbortError,
  SandboxPathNotFoundError,
  SandboxTimeoutError,
  type ExecuteOptions,
  type ExecutionResult,
  type FileInfo,
  type StreamChunk,
} from '@strands-agents/sdk'

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

export class WorkspaceSandbox extends PosixShellSandbox {
  readonly cwd: string

  constructor(cwd: string) {
    super()
    this.cwd = resolve(cwd)
  }

  override readFile(path: string): Promise<Uint8Array> {
    return readFile(resolve(this.cwd, path))
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

  async *executeStreaming(
    command: string,
    options: ExecuteOptions = {}
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    const child = spawn('sh', ['-c', command], {
      cwd: options.cwd ? resolve(this.cwd, options.cwd) : this.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
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

    child.stdout.on('data', (data: Buffer) => {
      appendOutput(stdoutDecoder.write(data), 'stdout')
    })
    child.stderr.on('data', (data: Buffer) => {
      appendOutput(stderrDecoder.write(data), 'stderr')
    })
    child.stdout.on('end', () => appendOutput(stdoutDecoder.end(), 'stdout'))
    child.stderr.on('end', () => appendOutput(stderrDecoder.end(), 'stderr'))
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
