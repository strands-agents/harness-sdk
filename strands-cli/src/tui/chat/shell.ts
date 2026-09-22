import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { userDirectory } from '../config.js'
import type { Agent, ExecutionResult } from '@strands-agents/sdk'
import type { ChatEvent, ChatRunResult } from './types.js'
import {
  limitShellOutputChunk,
  SHELL_OUTPUT_HARD_LIMIT_BYTES,
  SHELL_OUTPUT_HARD_LIMIT_LABEL,
  SHELL_OUTPUT_LIMIT_NOTICE,
  SHELL_OUTPUT_PREVIEW_BYTES,
  shellOutputHardLimitSummary,
  shellOutputSummary,
} from '../terminal/shell-output.js'

const SHELL_COMMAND_TIMEOUT_SECONDS = 120

interface ShellOutputFile {
  path: string
  handle: FileHandle
  bytesWritten: number
  closed: boolean
}

export class ShellRunner {
  private _abort: AbortController | undefined

  constructor(
    private readonly _sandbox: () => Agent['sandbox'],
    private readonly _outputDirectory = userDirectory('tool-results')
  ) {}

  async *stream(command: string): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    const toolUseId = `shell-${randomUUID()}`
    const abort = new AbortController()
    this._abort?.abort()
    this._abort = abort
    yield { type: 'toolStart', toolUseId, name: 'shell', input: { command } }

    let output = ''
    let outputBytes = 0
    let preview = ''
    let previewBytes = 0
    let totalOutputBytes = 0
    let outputFile: ShellOutputFile | undefined
    let hardLimitReached = false
    let persistenceError: Error | undefined
    try {
      let result: ExecutionResult | undefined
      let sawStreamOutput = false
      for await (const event of this._sandbox().executeStreaming(command, {
        timeout: SHELL_COMMAND_TIMEOUT_SECONDS,
        signal: abort.signal,
      })) {
        if (event.type === 'streamChunk') {
          if (!event.data) {
            continue
          }
          sawStreamOutput = true
          totalOutputBytes += Buffer.byteLength(event.data)
          const previewChunk = limitShellOutputChunk(event.data, previewBytes, SHELL_OUTPUT_PREVIEW_BYTES)
          preview += previewChunk.text
          previewBytes += previewChunk.bytes

          if (outputFile) {
            try {
              hardLimitReached = await appendShellOutput(outputFile, event.data)
            } catch (error) {
              persistenceError = shellOutputPersistenceError(error)
              abort.abort()
              throw persistenceError
            }
            if (hardLimitReached) {
              abort.abort()
              break
            }
            continue
          }

          const visible = limitShellOutputChunk(event.data, outputBytes)
          if (!visible.truncated) {
            output += visible.text
            outputBytes += visible.bytes
            yield {
              type: 'toolOutputDelta',
              toolUseId,
              stream: event.streamType,
              text: visible.text,
            }
            continue
          }

          try {
            outputFile = await createShellOutputFile(this._outputDirectory)
            await appendShellOutput(outputFile, output)
            hardLimitReached = await appendShellOutput(outputFile, event.data)
          } catch (error) {
            persistenceError = shellOutputPersistenceError(error)
            abort.abort()
            throw persistenceError
          }
          if (hardLimitReached) {
            abort.abort()
          }
          if (visible.text) {
            output += visible.text
            yield {
              type: 'toolOutputDelta',
              toolUseId,
              stream: event.streamType,
              text: visible.text,
            }
          }
          yield {
            type: 'toolOutputDelta',
            toolUseId,
            stream: event.streamType,
            text: SHELL_OUTPUT_LIMIT_NOTICE,
          }
          if (hardLimitReached) {
            break
          }
        } else {
          result = event
        }
      }

      if (hardLimitReached && outputFile) {
        await closeShellOutputFile(outputFile)
        yield shellOutputHardLimitResult(toolUseId, outputFile.path, preview)
        return { stopReason: 'endTurn' }
      }
      if (!result) {
        throw new Error('Sandbox shell execution ended without a result.')
      }
      if (abort.signal.aborted) {
        return { stopReason: 'cancelled' }
      }

      if (!sawStreamOutput) {
        const resultOutput = combinedShellOutput(result)
        totalOutputBytes = Buffer.byteLength(resultOutput)
        preview = limitShellOutputChunk(resultOutput, 0, SHELL_OUTPUT_PREVIEW_BYTES).text
        const visible = limitShellOutputChunk(resultOutput, 0)
        output = visible.text
        if (visible.truncated) {
          try {
            outputFile = await createShellOutputFile(this._outputDirectory)
            hardLimitReached = await appendShellOutput(outputFile, resultOutput)
          } catch (error) {
            persistenceError = shellOutputPersistenceError(error)
            throw persistenceError
          }
        }
      }

      if (hardLimitReached && outputFile) {
        await closeShellOutputFile(outputFile)
        yield shellOutputHardLimitResult(toolUseId, outputFile.path, preview)
        return { stopReason: 'endTurn' }
      }
      await closeShellOutputFile(outputFile)
      const finalOutput = outputFile ? shellOutputSummary(totalOutputBytes, outputFile.path, preview) : output
      yield {
        type: 'toolResult',
        toolUseId,
        status: result.exitCode === 0 ? 'success' : 'error',
        content: finalOutput ? [{ type: 'text', text: finalOutput }] : [],
        ...(result.exitCode === 0 ? {} : { error: `Shell command exited with status ${result.exitCode}.` }),
      }
      return { stopReason: 'endTurn' }
    } catch (error) {
      if (hardLimitReached && outputFile) {
        await closeShellOutputFile(outputFile)
        yield shellOutputHardLimitResult(toolUseId, outputFile.path, preview)
        return { stopReason: 'endTurn' }
      }
      if (persistenceError) {
        await discardShellOutputFile(outputFile)
        outputFile = undefined
        yield {
          type: 'toolResult',
          toolUseId,
          status: 'error',
          content: output ? [{ type: 'text', text: output }] : [],
          error: persistenceError.message,
        }
        return { stopReason: 'endTurn' }
      }
      if (abort.signal.aborted) {
        return { stopReason: 'cancelled' }
      }
      await closeShellOutputFile(outputFile)
      const finalOutput = outputFile ? shellOutputSummary(totalOutputBytes, outputFile.path, preview) : output
      yield {
        type: 'toolResult',
        toolUseId,
        status: 'error',
        content: finalOutput ? [{ type: 'text', text: finalOutput }] : [],
        error: error instanceof Error ? error.message : String(error),
      }
      return { stopReason: 'endTurn' }
    } finally {
      await closeShellOutputFile(outputFile)
      if (this._abort === abort) {
        this._abort = undefined
      }
    }
  }

  cancel(): void {
    this._abort?.abort()
  }

  dispose(): void {
    this._abort?.abort()
    this._abort = undefined
  }
}

function combinedShellOutput(result: ExecutionResult): string {
  if (!result.stdout) {
    return result.stderr
  }
  if (!result.stderr) {
    return result.stdout
  }
  return `${result.stdout}${result.stdout.endsWith('\n') ? '' : '\n'}${result.stderr}`
}

async function createShellOutputFile(directory: string): Promise<ShellOutputFile> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700)
  }

  const path = join(directory, `${randomUUID()}.txt`)
  const handle = await open(path, 'wx', 0o600)
  try {
    if (process.platform !== 'win32') {
      await handle.chmod(0o600)
    }
    return { path, handle, bytesWritten: 0, closed: false }
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(path).catch(() => {})
    throw error
  }
}

async function appendShellOutput(file: ShellOutputFile, chunk: string): Promise<boolean> {
  const limited = limitShellOutputChunk(chunk, file.bytesWritten, SHELL_OUTPUT_HARD_LIMIT_BYTES)
  if (limited.text) {
    await file.handle.writeFile(limited.text)
    file.bytesWritten += limited.bytes
  }
  return limited.truncated
}

async function closeShellOutputFile(file: ShellOutputFile | undefined): Promise<void> {
  if (!file || file.closed) {
    return
  }
  file.closed = true
  await file.handle.close()
}

async function discardShellOutputFile(file: ShellOutputFile | undefined): Promise<void> {
  if (!file) {
    return
  }
  await closeShellOutputFile(file).catch(() => {})
  await unlink(file.path).catch(() => {})
}

function shellOutputPersistenceError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`Failed to save large shell output: ${detail}`)
}

function shellOutputHardLimitResult(
  toolUseId: string,
  path: string,
  preview: string
): Extract<ChatEvent, { type: 'toolResult' }> {
  return {
    type: 'toolResult',
    toolUseId,
    status: 'error',
    content: [{ type: 'text', text: shellOutputHardLimitSummary(path, preview) }],
    error: `Shell command exceeded the ${SHELL_OUTPUT_HARD_LIMIT_LABEL} emergency output limit and was stopped.`,
  }
}
