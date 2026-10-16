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

export const VOICE_PROVIDERS = ['bedrock', 'openai'] as const

export type VoiceProvider = (typeof VOICE_PROVIDERS)[number]

export const BEDROCK_VOICE_MODEL_IDS = ['amazon.nova-2-5-sonic'] as const
export const OPENAI_VOICE_MODEL_IDS = ['gpt-realtime-2.1'] as const
export const VOICE_MODEL_IDS = [...BEDROCK_VOICE_MODEL_IDS, ...OPENAI_VOICE_MODEL_IDS] as const

export type VoiceModelId = (typeof VOICE_MODEL_IDS)[number]

export const VOICE_MODEL_OPTIONS = {
  bedrock: [{ label: 'Nova 2.5 Sonic', value: 'amazon.nova-2-5-sonic' }],
  openai: [{ label: 'GPT Realtime 2.1', value: 'gpt-realtime-2.1' }],
} as const satisfies Record<VoiceProvider, readonly { label: string; value: VoiceModelId }[]>

export const BEDROCK_VOICE_IDS = [
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

export const OPENAI_VOICE_IDS = ['alloy', 'coral', 'sage', 'verse'] as const
export const VOICE_IDS = [...BEDROCK_VOICE_IDS, ...OPENAI_VOICE_IDS] as const

export type VoiceId = (typeof VOICE_IDS)[number]

const DEFAULT_VOICE_BY_PROVIDER = {
  bedrock: 'tiffany',
  openai: 'coral',
} as const satisfies Record<VoiceProvider, VoiceId>

const DEFAULT_MODEL_BY_PROVIDER = {
  bedrock: BEDROCK_VOICE_MODEL_IDS[0],
  openai: OPENAI_VOICE_MODEL_IDS[0],
} as const satisfies Record<VoiceProvider, VoiceModelId>

export type VoiceSupervisorAction = 'get_current_work' | 'send_instruction' | 'cancel_current_work'

export interface VoiceSupervisorRequest {
  requestId: string
  action: VoiceSupervisorAction
  instruction?: string
}

export type VoiceSupervisorResponse = { ok: true; result: unknown } | { ok: false; error: string }

export interface VoiceSessionSnapshot {
  status: VoiceSessionStatus
  muted: boolean
  inputLevel: number
  inputLevelDb: number
  spokenReplies: boolean
  endpointingSensitivity: VoiceEndpointingSensitivity
  provider: VoiceProvider
  voice: VoiceId
  model: string
  message?: string
}

export interface VoiceInput {
  readonly subscribe: (listener: () => void) => () => void
  readonly onSupervisorRequest: (listener: (request: VoiceSupervisorRequest) => void) => () => void
  getSnapshot(): VoiceSessionSnapshot
  start(): Promise<void>
  stop(): Promise<void>
  narrate(text: string): boolean
  resolveSupervisorRequest(requestId: string, response: VoiceSupervisorResponse): boolean
  toggleMuted(): boolean
  setMuted(muted: boolean): boolean
  setSpokenReplies(enabled: boolean): boolean
  setEndpointingSensitivity(sensitivity: VoiceEndpointingSensitivity): Promise<boolean>
  setProvider(provider: VoiceProvider): Promise<boolean>
  setModel(model: VoiceModelId): Promise<boolean>
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
  request_id?: unknown
  action?: unknown
  instruction?: unknown
}

export class PythonVoiceSession implements VoiceInput {
  private readonly _listeners = new Set<() => void>()
  private readonly _supervisorListeners = new Set<(request: VoiceSupervisorRequest) => void>()
  private _snapshot: VoiceSessionSnapshot = {
    status: 'off',
    muted: false,
    inputLevel: 0,
    inputLevelDb: -60,
    spokenReplies: false,
    endpointingSensitivity: 'LOW',
    provider: 'bedrock',
    voice: 'tiffany',
    model: DEFAULT_MODEL_BY_PROVIDER.bedrock,
  }
  private _process: ChildProcessWithoutNullStreams | undefined
  private _stdoutBuffer = ''
  private _stderr = ''
  private _stopping = false
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

  readonly onSupervisorRequest = (listener: (request: VoiceSupervisorRequest) => void): (() => void) => {
    this._supervisorListeners.add(listener)
    return () => {
      this._supervisorListeners.delete(listener)
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

  narrate(text: string): boolean {
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
    this._writeControl({ type: 'narrate', text: clean })
    return true
  }

  resolveSupervisorRequest(requestId: string, response: VoiceSupervisorResponse): boolean {
    if (!this._process || this._snapshot.status === 'off' || this._snapshot.status === 'error') {
      return false
    }
    this._writeControl({ type: 'supervisor_result', request_id: requestId, ...response })
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
    this._writeControl({ type: 'set_spoken_replies', enabled })
    if (!enabled) {
      this._writeControl({ type: 'stop_speaking' })
    }
    this._setSnapshot({ ...this._snapshot, spokenReplies: enabled })
    return true
  }

  setEndpointingSensitivity(sensitivity: VoiceEndpointingSensitivity): Promise<boolean> {
    return this._setModelOption('endpointingSensitivity', sensitivity)
  }

  async setProvider(provider: VoiceProvider): Promise<boolean> {
    if (this._snapshot.provider === provider) {
      return true
    }
    const restart = this._snapshot.status !== 'off' && this._snapshot.status !== 'error'
    this._setSnapshot({
      status: this._snapshot.status,
      muted: this._snapshot.muted,
      inputLevel: this._snapshot.inputLevel,
      inputLevelDb: this._snapshot.inputLevelDb,
      spokenReplies: this._snapshot.spokenReplies,
      endpointingSensitivity: this._snapshot.endpointingSensitivity,
      provider,
      voice: DEFAULT_VOICE_BY_PROVIDER[provider],
      model: DEFAULT_MODEL_BY_PROVIDER[provider],
    })
    if (restart) {
      await this.stop()
      await this.start()
    }
    return true
  }

  setModel(model: VoiceModelId): Promise<boolean> {
    if (!VOICE_MODEL_OPTIONS[this._snapshot.provider].some((option) => option.value === model)) {
      return Promise.resolve(false)
    }
    return this._setModelOption('model', model)
  }

  setVoice(voice: VoiceId): Promise<boolean> {
    const choices: readonly VoiceId[] = this._snapshot.provider === 'bedrock' ? BEDROCK_VOICE_IDS : OPENAI_VOICE_IDS
    if (!choices.includes(voice)) {
      return Promise.resolve(false)
    }
    return this._setModelOption('voice', voice)
  }

  private async _setModelOption<K extends 'model' | 'voice' | 'endpointingSensitivity'>(
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
    this._supervisorListeners.clear()
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
    this._stdoutBuffer = ''
    this._stderr = ''
    this._setSnapshot({ status: 'connecting', muted: false, inputLevel: 0, inputLevelDb: -60 })

    const command = this._options.command ?? 'uv'
    const args = this._options.args ?? [
      'run',
      '--python',
      '3.13',
      resolveVoiceSidecarPath(),
      '--provider',
      this._snapshot.provider,
      '--endpointing-sensitivity',
      this._snapshot.endpointingSensitivity,
      '--model',
      this._snapshot.model,
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
      this._writeControl({ type: 'set_spoken_replies', enabled: this._snapshot.spokenReplies })
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
    if (type === 'connection_restart') {
      this._setConnectedSnapshot('connecting')
      return
    }
    if (type === 'speech_output_start') {
      this._setConnectedSnapshot('speaking')
      return
    }
    if (type === 'speech_output_complete') {
      this._setConnectedSnapshot('listening')
      return
    }
    if (type === 'speech_output_interrupted' || type === 'speech_output_stopped') {
      this._setConnectedSnapshot('listening')
      return
    }
    if (
      type === 'supervisor_request' &&
      typeof event.request_id === 'string' &&
      isVoiceSupervisorAction(event.action)
    ) {
      const request: VoiceSupervisorRequest = {
        requestId: event.request_id,
        action: event.action,
        ...(typeof event.instruction === 'string' ? { instruction: event.instruction } : {}),
      }
      for (const listener of this._supervisorListeners) {
        listener(request)
      }
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
        this._setConnectedSnapshot('hearing')
        return
      }
      this._setConnectedSnapshot('listening')
      return
    }
    if (type === 'fatal_error' || type === 'error') {
      const code = typeof event.code === 'string' ? `${event.code}: ` : ''
      const message = typeof event.message === 'string' ? event.message : 'Voice sidecar reported an error.'
      this._fail(`${code}${message}`)
      return
    }
    if (type === 'connection_stop' && !this._stopping) {
      const reason = typeof event.reason === 'string' ? `: ${event.reason}` : ''
      this._fail(`Voice connection closed${reason}`)
    }
  }

  private _writeControl(command: Record<string, unknown>): void {
    if (!this._process?.stdin.writable) {
      return
    }
    this._process.stdin.write(`${JSON.stringify(command)}\n`)
  }

  private _fail(message: string): void {
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
      provider: snapshot.provider ?? this._snapshot.provider,
      voice: snapshot.voice ?? this._snapshot.voice,
      model: snapshot.model ?? this._snapshot.model,
      ...(snapshot.message ? { message: snapshot.message } : {}),
    }
    for (const listener of this._listeners) {
      listener()
    }
  }
}

function isVoiceSupervisorAction(value: unknown): value is VoiceSupervisorAction {
  return value === 'get_current_work' || value === 'send_instruction' || value === 'cancel_current_work'
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
