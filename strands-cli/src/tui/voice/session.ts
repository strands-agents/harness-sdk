import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { terminateProcessTree } from '../terminal/process-tree.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'

const DEFAULT_START_TIMEOUT_MS = 30_000
const DEFAULT_STOP_TIMEOUT_MS = 2_000
const STDERR_LIMIT = 8_000
const SIDECAR_ERROR_LINE_LIMIT = 6
const SIDECAR_ERROR_LINE_LENGTH = 120
export const VOICE_METER_WIDTH = 14

export function voiceMeterFill(inputLevel: number): number {
  return Math.max(0, Math.min(VOICE_METER_WIDTH, Math.round(inputLevel * VOICE_METER_WIDTH)))
}

type VoiceSessionStatus =
  'off' | 'connecting' | 'listening' | 'hearing' | 'speaking' | 'muted' | 'interrupted' | 'error'

export type VoiceEndpointingSensitivity = 'HIGH' | 'MEDIUM' | 'LOW'

export const VOICE_IDS = [
  'tiffany',
  'matthew',
  'amy',
  'ambre',
  'florian',
  'beatrice',
  'lorenzo',
  'greta',
  'lennart',
  'lupe',
  'carlos',
] as const

export type VoiceId = (typeof VOICE_IDS)[number]

export interface VoiceSessionSnapshot {
  status: VoiceSessionStatus
  muted: boolean
  inputLevel: number
  inputLevelDb: number
  spokenReplies: boolean
  endpointingSensitivity: VoiceEndpointingSensitivity
  voice: VoiceId
  model?: string
  message?: string
}

export interface VoiceInput {
  readonly subscribe: (listener: () => void) => () => void
  readonly onTranscript: (listener: (transcript: string) => void) => () => void
  readonly onSpeechStart: (listener: () => void) => () => void
  getSnapshot(): VoiceSessionSnapshot
  start(): Promise<void>
  stop(): Promise<void>
  speak(text: string): boolean
  toggleMuted(): boolean
  setMuted(muted: boolean): boolean
  setSpokenReplies(enabled: boolean): boolean
  setEndpointingSensitivity(sensitivity: VoiceEndpointingSensitivity): Promise<boolean>
  setVoice(voice: VoiceId): Promise<boolean>
  dispose(): Promise<void>
}

interface PythonVoiceSessionOptions {
  cwd?: string
  command?: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  startTimeoutMs?: number
  stopTimeoutMs?: number
}

interface SidecarEvent {
  type?: unknown
  role?: unknown
  text?: unknown
  current_transcript?: unknown
  is_final?: unknown
  model?: unknown
  message?: unknown
  code?: unknown
  muted?: unknown
  level?: unknown
  db?: unknown
  reason?: unknown
}

export class PythonVoiceSession implements VoiceInput {
  private readonly _listeners = new Set<() => void>()
  private readonly _transcriptListeners = new Set<(transcript: string) => void>()
  private readonly _speechStartListeners = new Set<() => void>()
  private _snapshot: VoiceSessionSnapshot = {
    status: 'off',
    muted: false,
    inputLevel: 0,
    inputLevelDb: -60,
    spokenReplies: false,
    endpointingSensitivity: 'LOW',
    voice: 'tiffany',
  }
  private _process: ChildProcessWithoutNullStreams | undefined
  private _stdoutBuffer = ''
  private _stderr = ''
  private _stopping = false
  private _utteranceActive = false
  private _speechQueue: string[] = []
  private _speechInFlight = false
  private _startTask: Promise<void> | undefined
  private _stopTask: Promise<void> | undefined
  private _failureCleanup: Promise<void> | undefined
  private _lifecycleGeneration = 0
  private _disposed = false

  constructor(private readonly _options: PythonVoiceSessionOptions = {}) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener)
    return () => {
      this._listeners.delete(listener)
    }
  }

  readonly onTranscript = (listener: (transcript: string) => void): (() => void) => {
    this._transcriptListeners.add(listener)
    return () => {
      this._transcriptListeners.delete(listener)
    }
  }

  readonly onSpeechStart = (listener: () => void): (() => void) => {
    this._speechStartListeners.add(listener)
    return () => {
      this._speechStartListeners.delete(listener)
    }
  }

  getSnapshot(): VoiceSessionSnapshot {
    return { ...this._snapshot }
  }

  start(): Promise<void> {
    if (this._disposed) {
      return Promise.reject(new Error('Voice session has been disposed.'))
    }
    if (this._process && this._snapshot.status !== 'error' && this._snapshot.status !== 'off') {
      return this._startTask ?? Promise.resolve()
    }
    this._startTask ??= this._start(++this._lifecycleGeneration)
    return this._startTask
  }

  stop(): Promise<void> {
    this._lifecycleGeneration++
    this._stopTask ??= this._stop()
    return this._stopTask
  }

  speak(text: string): boolean {
    const clean = text.trim()
    if (
      !clean ||
      !this._process ||
      !this._snapshot.spokenReplies ||
      this._snapshot.status === 'off' ||
      this._snapshot.status === 'error'
    ) {
      return false
    }
    this._speechQueue.push(clean)
    this._pumpSpeechQueue()
    return true
  }

  toggleMuted(): boolean {
    return this.setMuted(!this._snapshot.muted)
  }

  setMuted(muted: boolean): boolean {
    if (!this._process || this._snapshot.status === 'off' || this._snapshot.status === 'error') {
      return false
    }
    if (this._snapshot.muted === muted) {
      return true
    }
    this._writeControl({ type: 'set_muted', muted })
    this._setConnectedSnapshot('listening', muted)
    return true
  }

  setSpokenReplies(enabled: boolean): boolean {
    if (this._snapshot.spokenReplies === enabled) {
      return true
    }
    if (!enabled) {
      this._clearSpeechQueue()
      this._writeControl({ type: 'stop_speaking' })
    }
    this._setSnapshot({ ...this._snapshot, spokenReplies: enabled })
    return true
  }

  setEndpointingSensitivity(sensitivity: VoiceEndpointingSensitivity): Promise<boolean> {
    return this._setModelOption('endpointingSensitivity', sensitivity)
  }

  setVoice(voice: VoiceId): Promise<boolean> {
    return this._setModelOption('voice', voice)
  }

  private async _setModelOption<K extends 'voice' | 'endpointingSensitivity'>(
    key: K,
    value: VoiceSessionSnapshot[K]
  ): Promise<boolean> {
    if (this._snapshot[key] === value) {
      return true
    }
    const restart = this._snapshot.status !== 'off' && this._snapshot.status !== 'error'
    this._setSnapshot({ ...this._snapshot, [key]: value })
    if (restart) {
      await this.stop()
      await this.start()
    }
    return true
  }

  async dispose(): Promise<void> {
    this._disposed = true
    const startTask = this._startTask
    await this.stop()
    await startTask?.catch(() => {})
    this._listeners.clear()
    this._transcriptListeners.clear()
    this._speechStartListeners.clear()
  }

  private async _start(generation: number): Promise<void> {
    await this._stopTask
    await this._failureCleanup
    if (this._disposed || generation !== this._lifecycleGeneration) {
      this._startTask = undefined
      return
    }
    if (this._process) {
      await this._stop()
    }
    this._stopTask = undefined
    this._stopping = false
    this._utteranceActive = false
    this._clearSpeechQueue()
    this._stdoutBuffer = ''
    this._stderr = ''
    this._setSnapshot({ status: 'connecting', muted: false, inputLevel: 0, inputLevelDb: -60 })

    const command = this._options.command ?? 'uv'
    const args = this._options.args ?? [
      'run',
      '--python',
      '3.13',
      resolveVoiceSidecarPath(),
      '--sidecar',
      '--endpointing-sensitivity',
      this._snapshot.endpointingSensitivity,
      '--voice',
      this._snapshot.voice,
    ]
    const child = spawn(command, [...args], {
      cwd: this._options.cwd ?? process.cwd(),
      env: { ...process.env, ...this._options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this._process = child
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this._readStdout(chunk))
    child.stderr.on('data', (chunk: string) => {
      this._stderr = `${this._stderr}${chunk}`.slice(-STDERR_LIMIT)
    })
    child.once('error', (error) => {
      if (this._process === child && !this._stopping) {
        this._fail(error.message)
      }
    })
    child.once('exit', (code, signal) => {
      if (this._process === child) {
        this._process = undefined
        if (!this._stopping) {
          this._fail(this._processExitMessage(code, signal))
        }
      }
    })

    try {
      await new Promise<void>((resolveStart, rejectStart) => {
        let settled = false
        const finish = (error?: Error): void => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timeout)
          unsubscribe()
          child.off('error', finish)
          child.off('exit', onExit)
          if (error) {
            rejectStart(error)
          } else {
            resolveStart()
          }
        }
        const unsubscribe = this.subscribe(() => {
          if (this._snapshot.status === 'listening' || this._snapshot.status === 'muted') {
            finish()
          } else if (this._snapshot.status === 'error') {
            finish(new Error(this._snapshot.message ?? 'Voice input failed to start.'))
          }
        })
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          if (this._stopping) {
            finish()
          } else {
            finish(new Error(this._processExitMessage(code, signal)))
          }
        }
        const timeout = setTimeout(
          () => finish(new Error('Voice input timed out while connecting.')),
          this._options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
        )
        child.once('error', finish)
        child.once('exit', onExit)
      })
    } catch (error) {
      await this._stop()
      throw error
    } finally {
      this._startTask = undefined
    }
  }

  private async _stop(): Promise<void> {
    try {
      await this._failureCleanup
      const child = this._process
      if (child) {
        this._stopping = true
        this._writeControl({ type: 'stop' })
        await this._terminateChild(child)
      }
      this._stopping = false
      this._utteranceActive = false
      this._clearSpeechQueue()
      this._setSnapshot({ status: 'off', muted: false, inputLevel: 0, inputLevelDb: -60 })
    } finally {
      this._stopTask = undefined
    }
  }

  private async _terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const timeout = this._options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
    if (!(await waitForExit(child, timeout))) {
      await terminateProcessTree(child, timeout)
    }
    if (this._process === child) {
      this._process = undefined
    }
  }

  private _readStdout(chunk: string): void {
    this._stdoutBuffer += chunk
    const lines = this._stdoutBuffer.split('\n')
    this._stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      try {
        this._handleEvent(JSON.parse(trimmed) as SidecarEvent)
      } catch {
        this._fail(`Voice sidecar emitted invalid JSON: ${trimmed.slice(0, 160)}`)
      }
    }
  }

  private _handleEvent(event: SidecarEvent): void {
    const { type } = event
    if (type === 'connection_start') {
      this._setSnapshot({
        status: this._snapshot.muted ? 'muted' : 'listening',
        muted: this._snapshot.muted,
        ...(typeof event.model === 'string' ? { model: event.model } : {}),
      })
      return
    }
    if (type === 'mute_changed' && typeof event.muted === 'boolean') {
      this._setConnectedSnapshot('listening', event.muted)
      return
    }
    if (type === 'input_level' && typeof event.level === 'number' && Number.isFinite(event.level)) {
      const inputLevel = Math.max(0, Math.min(1, event.level))
      const inputLevelDb =
        typeof event.db === 'number' && Number.isFinite(event.db) ? Math.max(-60, Math.min(0, event.db)) : -60
      const displayedInputLevel = this._snapshot.muted ? 0 : inputLevel
      if (voiceMeterFill(displayedInputLevel) === voiceMeterFill(this._snapshot.inputLevel)) {
        return
      }
      this._setSnapshot({
        ...this._snapshot,
        inputLevel: displayedInputLevel,
        inputLevelDb: this._snapshot.muted ? -60 : inputLevelDb,
      })
      return
    }
    if (type === 'interruption') {
      this._clearSpeechQueue()
      this._signalSpeechStart()
      this._setConnectedSnapshot('interrupted')
      return
    }
    if (type === 'speech_output_start') {
      this._setConnectedSnapshot('speaking')
      return
    }
    if (type === 'speech_output_complete') {
      this._speechInFlight = false
      this._setConnectedSnapshot('listening')
      this._pumpSpeechQueue()
      return
    }
    if (type === 'speech_output_interrupted' || type === 'speech_output_stopped') {
      this._clearSpeechQueue()
      this._setConnectedSnapshot('listening')
      return
    }
    if (type === 'transcript' && event.role === 'user') {
      const transcript =
        typeof event.current_transcript === 'string'
          ? event.current_transcript.trim()
          : typeof event.text === 'string'
            ? event.text.trim()
            : ''
      if (!transcript) {
        return
      }
      if (event.is_final !== true) {
        this._signalSpeechStart()
        this._setConnectedSnapshot('hearing')
        return
      }
      this._utteranceActive = false
      this._setConnectedSnapshot('listening')
      for (const listener of this._transcriptListeners) {
        listener(transcript)
      }
      return
    }
    if (type === 'fatal_error' || type === 'error') {
      const code = typeof event.code === 'string' ? `${event.code}: ` : ''
      const message = typeof event.message === 'string' ? event.message : 'Voice sidecar reported an error.'
      this._fail(`${code}${message}`)
      return
    }
    if (type === 'connection_close' && !this._stopping) {
      const reason = typeof event.reason === 'string' ? `: ${event.reason}` : ''
      this._fail(`Voice connection closed${reason}`)
    }
  }

  private _signalSpeechStart(): void {
    if (this._utteranceActive || this._snapshot.muted) {
      return
    }
    this._utteranceActive = true
    for (const listener of this._speechStartListeners) {
      listener()
    }
  }

  private _writeControl(command: Record<string, unknown>): void {
    if (!this._process?.stdin.writable) {
      return
    }
    this._process.stdin.write(`${JSON.stringify(command)}\n`)
  }

  private _pumpSpeechQueue(): void {
    if (
      this._speechInFlight ||
      this._speechQueue.length === 0 ||
      !this._process ||
      !this._snapshot.spokenReplies ||
      this._snapshot.status === 'off' ||
      this._snapshot.status === 'error'
    ) {
      return
    }
    const text = this._speechQueue.shift()
    this._speechInFlight = true
    this._writeControl({ type: 'speak', text })
  }

  private _clearSpeechQueue(): void {
    this._speechQueue.length = 0
    this._speechInFlight = false
  }

  private _fail(message: string): void {
    this._clearSpeechQueue()
    const detail = summarizeSidecarError(this._stderr)
    this._setSnapshot({
      status: 'error',
      muted: false,
      inputLevel: 0,
      inputLevelDb: -60,
      message: detail ? `${message}\n${detail}` : message,
    })
    const child = this._process
    if (!child || this._stopping || this._failureCleanup) {
      return
    }
    this._lifecycleGeneration++
    this._stopping = true
    this._writeControl({ type: 'stop' })
    this._failureCleanup = this._terminateChild(child)
      .catch((error) => {
        const failure = error instanceof Error ? error.message : String(error)
        this._setSnapshot({
          status: 'error',
          muted: false,
          inputLevel: 0,
          inputLevelDb: -60,
          message: `${this._snapshot.message ?? message}\nFailed to stop voice sidecar: ${failure}`,
        })
      })
      .finally(() => {
        this._stopping = false
        this._utteranceActive = false
        this._clearSpeechQueue()
        this._failureCleanup = undefined
      })
  }

  private _setConnectedSnapshot(status: VoiceSessionStatus, muted = this._snapshot.muted): void {
    this._setSnapshot({
      status: muted ? 'muted' : status,
      muted,
      inputLevel: muted ? 0 : this._snapshot.inputLevel,
      inputLevelDb: muted ? -60 : this._snapshot.inputLevelDb,
      ...(this._snapshot.model ? { model: this._snapshot.model } : {}),
    })
  }

  private _processExitMessage(code: number | null, signal: NodeJS.Signals | null): string {
    const outcome = signal ? `signal ${signal}` : `status ${code ?? 'unknown'}`
    return `Voice sidecar exited with ${outcome}.`
  }

  private _setSnapshot(snapshot: Pick<VoiceSessionSnapshot, 'status' | 'muted'> & Partial<VoiceSessionSnapshot>): void {
    this._snapshot = {
      status: snapshot.status,
      muted: snapshot.muted,
      inputLevel: snapshot.inputLevel ?? this._snapshot.inputLevel,
      inputLevelDb: snapshot.inputLevelDb ?? this._snapshot.inputLevelDb,
      spokenReplies: snapshot.spokenReplies ?? this._snapshot.spokenReplies,
      endpointingSensitivity: snapshot.endpointingSensitivity ?? this._snapshot.endpointingSensitivity,
      voice: snapshot.voice ?? this._snapshot.voice,
      ...(snapshot.model ? { model: snapshot.model } : {}),
      ...(snapshot.message ? { message: snapshot.message } : {}),
    }
    for (const listener of this._listeners) {
      listener()
    }
  }
}

export function resolveVoiceSidecarPath(moduleDirectory = import.meta.dirname): string {
  const candidates = [
    resolve(moduleDirectory, 'sidecar.py'),
    resolve(moduleDirectory, '../../../../src/tui/voice/sidecar.py'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

function summarizeSidecarError(stderr: string): string {
  return sanitizeTerminalText(stderr)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-SIDECAR_ERROR_LINE_LIMIT)
    .map((line) =>
      line.length > SIDECAR_ERROR_LINE_LENGTH ? `${line.slice(0, SIDECAR_ERROR_LINE_LENGTH - 3)}...` : line
    )
    .join('\n')
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => finish(false), timeoutMs)
    const onExit = (): void => finish(true)
    child.once('exit', onExit)

    function finish(exited: boolean): void {
      clearTimeout(timeout)
      child.off('exit', onExit)
      resolveExit(exited)
    }
  })
}
