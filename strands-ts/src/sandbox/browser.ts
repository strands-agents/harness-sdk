/**
 * Sandbox for browsers: files live in the Origin Private File System (or a folder the user picked),
 * and JavaScript runs in a throwaway Web Worker.
 */

import { Sandbox } from './base.js'
import type { ExecuteOptions } from './base.js'
import { LANGUAGE_PATTERN } from './constants.js'
import { SandboxAbortError, SandboxPathNotFoundError, SandboxTimeoutError } from './errors.js'
import type { ExecutionResult, FileInfo, StreamChunk, StreamType } from './types.js'
import { Queue } from '../queue.js'

/**
 * Configuration for {@link BrowserSandbox}.
 */
export interface BrowserSandboxConfig {
  /**
   * Directory that file operations are rooted at. Defaults to the Origin Private File System root
   * (`navigator.storage.getDirectory()`). Pass a handle from `window.showDirectoryPicker()` to work
   * on a folder on the user's machine.
   */
  root?: FileSystemDirectoryHandle | Promise<FileSystemDirectoryHandle>
}

/** Languages {@link BrowserSandbox.executeCodeStreaming} accepts. */
const JAVASCRIPT_LANGUAGES = new Set(['javascript', 'js'])

/** Message posted by the worker. */
type WorkerMessage =
  | { kind: 'chunk'; streamType: StreamType; data: string }
  | { kind: 'exit'; exitCode: number }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'abort' }

/**
 * Worker that runs one script as an async function body (so top-level `await` works) and forwards
 * console output: log/info/debug to stdout, warn/error to stderr.
 */
const WORKER_SOURCE = `
const format = (value) => {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}
const emit = (streamType, args) =>
  self.postMessage({ kind: 'chunk', streamType, data: args.map(format).join(' ') + '\\n' })
console.log = console.info = console.debug = (...args) => emit('stdout', args)
console.warn = console.error = (...args) => emit('stderr', args)
self.onmessage = async (event) => {
  const AsyncFunction = (async () => {}).constructor
  try {
    await new AsyncFunction(event.data.code)()
    self.postMessage({ kind: 'exit', exitCode: 0 })
  } catch (error) {
    const text = error instanceof Error
      ? (error.stack && error.stack.includes(error.message) ? error.stack : error.name + ': ' + error.message + '\\n' + (error.stack || ''))
      : String(error)
    emit('stderr', [text])
    self.postMessage({ kind: 'exit', exitCode: 1 })
  }
}
`

/** OPFS reports a missing entry as NotFoundError and a file/directory mix-up as TypeMismatchError. */
function isMissingEntryError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')
}

/**
 * Sandbox for browsers.
 *
 * - Files: read, write, list, and remove under {@link BrowserSandboxConfig.root}. Paths are POSIX-style;
 *   absolute and relative paths both resolve from the root and `..` never escapes it.
 * - Code: `executeCode(code, 'javascript')` runs the code in a dedicated Web Worker with console
 *   output captured. The worker has no access to the page's DOM or variables. `cwd` and `env` do not apply.
 * - Shell commands are not supported; {@link executeStreaming} throws.
 *
 * Requires a secure context (HTTPS or localhost) for the Origin Private File System.
 *
 * @example
 * ```typescript
 * import { BrowserSandbox } from '@strands-agents/sdk/sandbox/browser'
 *
 * // Private, per-origin storage
 * const sandbox = new BrowserSandbox()
 *
 * // A folder on the user's machine (Chromium; must be called from a user gesture)
 * const folder = new BrowserSandbox({ root: await window.showDirectoryPicker({ mode: 'readwrite' }) })
 * ```
 */
export class BrowserSandbox extends Sandbox {
  private _root: Promise<FileSystemDirectoryHandle> | undefined

  constructor(config: BrowserSandboxConfig = {}) {
    super()
    if (config.root !== undefined) this._root = Promise.resolve(config.root)
  }

  /**
   * Shell commands cannot run in a browser.
   *
   * @throws Error always
   */
  // eslint-disable-next-line require-yield
  async *executeStreaming(command: string): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    throw new Error(`BrowserSandbox cannot run shell commands: ${command}`)
  }

  /**
   * Run JavaScript in a dedicated Web Worker, streaming its console output.
   *
   * @param code - Script body; top-level `await` is allowed
   * @param language - `javascript` or `js`
   * @param options - `timeout` (seconds) and `signal` terminate the worker; `cwd` and `env` are ignored
   * @throws SandboxTimeoutError if the timeout elapses
   * @throws SandboxAbortError if the signal aborts
   */
  async *executeCodeStreaming(
    code: string,
    language: string,
    options?: ExecuteOptions
  ): AsyncGenerator<StreamChunk | ExecutionResult, void, undefined> {
    if (!LANGUAGE_PATTERN.test(language)) {
      throw new Error(`language parameter contains invalid characters: ${language}`)
    }
    if (!JAVASCRIPT_LANGUAGES.has(language.toLowerCase())) {
      throw new Error(`BrowserSandbox runs JavaScript only, got: ${language}`)
    }
    if (options?.signal?.aborted) throw new SandboxAbortError()

    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
    const worker = new Worker(url)
    const messages = new Queue<WorkerMessage>()
    worker.onmessage = (event: MessageEvent<WorkerMessage>): void => messages.push(event.data)
    worker.onerror = (event: ErrorEvent): void => {
      event.preventDefault()
      messages.push({ kind: 'error', message: event.message })
    }
    const timeout = options?.timeout
    const timer =
      timeout === undefined ? undefined : setTimeout(() => messages.push({ kind: 'timeout' }), timeout * 1000)
    const onAbort = (): void => messages.push({ kind: 'abort' })
    options?.signal?.addEventListener('abort', onAbort, { once: true })

    let stdout = ''
    let stderr = ''
    const result = (exitCode: number): ExecutionResult => ({
      type: 'executionResult',
      exitCode,
      stdout,
      stderr,
      outputFiles: [],
    })

    try {
      worker.postMessage({ code })
      for (;;) {
        await messages.wait()
        const message = messages.shift()!.data
        switch (message.kind) {
          case 'chunk':
            if (message.streamType === 'stdout') stdout += message.data
            else stderr += message.data
            yield { type: 'streamChunk', data: message.data, streamType: message.streamType }
            break
          case 'exit':
            yield result(message.exitCode)
            return
          case 'error':
            stderr += `${message.message}\n`
            yield result(1)
            return
          case 'timeout':
            throw new SandboxTimeoutError(timeout!, stdout, stderr)
          case 'abort':
            throw new SandboxAbortError()
        }
      }
    } finally {
      worker.terminate()
      URL.revokeObjectURL(url)
      if (timer !== undefined) clearTimeout(timer)
      options?.signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Read a file.
   *
   * @throws SandboxPathNotFoundError if the file does not exist
   */
  async readFile(path: string): Promise<Uint8Array> {
    const { directory, name } = await this._parent(path, false)
    try {
      const file = await (await directory.getFileHandle(name)).getFile()
      return new Uint8Array(await file.arrayBuffer())
    } catch (error) {
      throw isMissingEntryError(error) ? new SandboxPathNotFoundError(path) : error
    }
  }

  /** Write a file, creating parent directories as needed. */
  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const { directory, name } = await this._parent(path, true)
    const writable = await (await directory.getFileHandle(name, { create: true })).createWritable()
    try {
      await writable.write(content as Uint8Array<ArrayBuffer>)
    } finally {
      await writable.close()
    }
  }

  /**
   * Remove a file (or an empty directory).
   *
   * @throws SandboxPathNotFoundError if the entry does not exist
   */
  async removeFile(path: string): Promise<void> {
    const { directory, name } = await this._parent(path, false)
    try {
      await directory.removeEntry(name)
    } catch (error) {
      throw isMissingEntryError(error) ? new SandboxPathNotFoundError(path) : error
    }
  }

  /**
   * List a directory, sorted by name.
   *
   * @throws SandboxPathNotFoundError if the directory does not exist
   */
  async listFiles(path: string): Promise<FileInfo[]> {
    const directory = await this._directory(path, splitPath(path), false)
    const results: FileInfo[] = []
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === 'directory') {
        results.push({ name, isDir: true })
      } else {
        results.push({ name, isDir: false, size: (await (handle as FileSystemFileHandle).getFile()).size })
      }
    }
    return results.sort((a, b) => a.name.localeCompare(b.name))
  }

  private _getRoot(): Promise<FileSystemDirectoryHandle> {
    this._root ??= globalThis.navigator.storage.getDirectory()
    return this._root
  }

  /** Resolve the directory containing `path` and the entry name within it. */
  private async _parent(
    path: string,
    create: boolean
  ): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
    const segments = splitPath(path)
    const name = segments.pop()
    if (name === undefined) throw new SandboxPathNotFoundError(path)
    return { directory: await this._directory(path, segments, create), name }
  }

  /** Walk `segments` from the root, optionally creating missing directories. */
  private async _directory(path: string, segments: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let directory = await this._getRoot()
    try {
      for (const segment of segments) {
        directory = await directory.getDirectoryHandle(segment, { create })
      }
    } catch (error) {
      throw isMissingEntryError(error) ? new SandboxPathNotFoundError(path) : error
    }
    return directory
  }
}

/** Split a POSIX-style path into segments under the root, resolving `.` and `..` without escaping it. */
function splitPath(path: string): string[] {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments
}
