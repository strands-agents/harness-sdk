import type { HarnessAgentConfig } from '@strands-agents/harness'
import { Message, type ContentBlockData, type MessageData, type Snapshot } from '@strands-agents/sdk'
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, URL } from 'node:url'

import type { BackgroundAgentActivity } from '../agent/background.js'
import type { SetupChange } from '../agent/configuration.js'
import type { LoadedMcp, McpServerInfo, McpStartupProgress } from '../agent/mcp.js'
import type { AgentMessaging, PeerEndpointInfo, PeerMessage } from '../agent/messaging.js'
import type { ChatSkillsRuntime, SkillActivation, SkillInfo } from '../agent/skills.js'
import type {
  ChatBackend,
  ChatContextUsage,
  ChatConversation,
  ChatEvent,
  ChatForkState,
  ChatPermissionRequest,
  ChatRunResult,
  ChatTask,
} from '../agent/types.js'
import type { ParsedArgs } from '../cli/arguments.js'
import type { CliConfigSnapshot, CliConfigStore, DetectedProviderEnvironment } from '../config/store.js'
import { modelChangeMode } from '../model/runtime.js'
import { effortDisplayLabel, effortOptions, effortValue, validateEffortSelection } from '../model/selection.js'
import { terminateProcessTree } from '../terminal/process-tree.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/text.js'
import type { ImportedAgentProject } from './import.js'

/** @internal */
export interface TypescriptConfig {
  snapshot: CliConfigSnapshot
  environment: DetectedProviderEnvironment
}

/** @internal */
export interface TypescriptSeed extends Omit<ChatForkState, 'messages'> {
  messages: MessageData[]
}

/** @internal */
export interface TypescriptInit {
  project: ImportedAgentProject
  args: ParsedArgs
  cwd: string
  initialWorkspace: string
  peerEndpointId: string
  config: TypescriptConfig
  mcpPaths: readonly string[]
  mcpStrictPaths: readonly string[]
  mcpDigests?: Readonly<Record<string, string>>
  conversation?: ChatConversation
  preserveSession?: boolean
  freshSession?: boolean
  sessionId?: string
  sessionDirectory?: string
  seed?: TypescriptSeed
  restoreSeedMessages?: boolean
  selection?: ChatConversation['selection']
}

/** @internal */
export interface TypescriptMetadata {
  name: string
  info: ReturnType<NonNullable<ChatBackend['info']>>
  context: ChatContextUsage | undefined
  sessionId: string | undefined
  sessionDirectory: string
  sessionIdentity: ChatConversation['session']
  managedSession: boolean
  currentModel: string
  provider: string
  selection: NonNullable<ChatConversation['selection']>
  sourceSelection: ChatConversation['sourceSelection']
  privatePaths: readonly string[] | null
  profile: HarnessAgentConfig
  mcp: {
    paths: readonly string[]
    warnings: readonly string[]
    startup?: McpStartupProgress
  }
}

/** @internal */
export type TypescriptSetupChange = {
  token: number
  change: { agentProject: string }
}

/** @internal */
export type TypescriptStream =
  | { kind: 'model'; prompt: string | ContentBlockData[] }
  | { kind: 'peer'; message: PeerMessage }
  | { kind: 'shell'; command: string }
  | { kind: 'background' }

/** @internal */
export type TypescriptRotation =
  | { kind: 'model'; modelId: string; thinking?: ChatForkState['thinking'] }
  | { kind: 'effort'; thinking: ChatForkState['thinking'] }
  | { kind: 'clear'; thinking: ChatForkState['thinking'] }

/** @internal */
export interface TypescriptRunResult extends Omit<ChatRunResult, 'watchUsage'> {
  usageId?: number
}

/** @internal */
export interface TypescriptCalls {
  init: { input: TypescriptInit; result: { metadata: TypescriptMetadata; messages: MessageData[] } }
  start: { input: TypescriptStream; result: number }
  next: { input: number; result: IteratorResult<ChatEvent, TypescriptRunResult> }
  return: { input: number; result: void }
  cancel: { input: void; result: void }
  drainSteering: { input: void; result: string[] }
  steer: { input: { id: number; prompt: string }; result: boolean }
  listModels: { input: void; result: Awaited<ReturnType<NonNullable<ChatBackend['listModels']>>> }
  switchModel: { input: string; result: string | void }
  setEffort: { input: string; result: string }
  prepareRotation: {
    input: TypescriptRotation
    result: { selection: NonNullable<ChatConversation['selection']>; seed?: TypescriptSeed }
  }
  captureFork: { input: void; result: TypescriptSeed }
  captureConversation: { input: void; result: Snapshot }
  flush: { input: void; result: void }
  compact: { input: void; result: ChatContextUsage | undefined }
  nameSession: { input: number; result: string }
  cancelNaming: { input: number; result: void }
  respondPermission: { input: { requestId: string; optionId?: string; rule?: string }; result: boolean }
  setPermissionMode: { input: CliConfigSnapshot['permissions']['mode']; result: void }
  allowPermission: { input: string; result: void }
  removeAllowedPermission: { input: string; result: void }
  removeDeniedPermission: { input: string; result: void }
  config: { input: TypescriptConfig; result: void }
  listSkills: { input: void; result: readonly SkillInfo[] }
  activateSkill: { input: string; result: SkillActivation | undefined }
  listMcp: { input: boolean; result: readonly McpServerInfo[] }
  enableMcp: { input: { name: string; enabled: boolean }; result: string | undefined }
  watchActivity: { input: { id: string; enabled: boolean }; result: void }
  unwatchUsage: { input: number; result: void }
  deliverPeer: { input: { id: string; message: PeerMessage }; result: boolean }
  configurationFailed: { input: { token: number; message: string }; result: void }
  close: { input: void; result: void }
}

/** @internal */
export type TypescriptCall = {
  [Operation in keyof TypescriptCalls]: {
    type: 'call'
    id: number
    operation: Operation
    input: TypescriptCalls[Operation]['input']
  }
}[keyof TypescriptCalls]

/** @internal */
export type TypescriptHostCall =
  | {
      operation: 'permission'
      method: 'setPermissionMode' | 'allowTool' | 'denyTool' | 'removeAllowedTool' | 'removeDeniedTool'
      value: string
    }
  | { operation: 'listPeers'; senderId: string }
  | { operation: 'sendPeer'; senderId: string; to: string; body: string }

/** @internal */
export type TypescriptWorkerMessage =
  | { type: 'response'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string }
  | { type: 'hostCall'; id: number; call: TypescriptHostCall }
  | { type: 'metadata'; value: TypescriptMetadata }
  | { type: 'tasks'; value: readonly ChatTask[] }
  | { type: 'permission'; value: ChatPermissionRequest | undefined }
  | { type: 'activity'; id: string; value: BackgroundAgentActivity | undefined }
  | { type: 'consumed'; id: number }
  | { type: 'usage'; id: number; value: ChatRunResult['usage'] }
  | { type: 'peers'; value: readonly PeerEndpointInfo[] }
  | { type: 'configuration'; value: TypescriptSetupChange }
  | { type: 'configurationDiscarded' }

/** @internal */
export type TypescriptParentMessage =
  | TypescriptCall
  | { type: 'hostResponse'; id: number; result: unknown }
  | { type: 'hostError'; id: number; message: string }

const connections = new WeakMap<CliConfigStore, Set<TypescriptConnection>>()

type UsageReceipt = {
  settled: boolean
  value: ChatRunResult['usage']
  listeners: Set<(usage: ChatRunResult['usage']) => void>
}

/** One process owns one authored module graph and one constructed agent. */
class TypescriptConnection {
  metadata!: TypescriptMetadata
  tasks: readonly ChatTask[] = []
  permission: ChatPermissionRequest | undefined
  readonly activities = new Map<string, BackgroundAgentActivity | undefined>()
  onMessage: ((message: TypescriptWorkerMessage) => void) | undefined
  private readonly _pending = new Map<
    number,
    { operation: keyof TypescriptCalls; resolve(value: unknown): void; reject(error: Error): void }
  >()
  private readonly _usage = new Map<number, UsageReceipt>()
  private readonly _peers = new Map<string, { id: string; value: PeerEndpointInfo }>()
  private readonly _namespace = randomUUID()
  private _sequence = 0
  private _diagnostics = ''
  private _failure: Error | undefined
  private _disposal: Promise<void> | undefined

  constructor(
    private readonly _child: ChildProcess,
    private readonly _config: CliConfigStore,
    private readonly _messaging: AgentMessaging,
    private readonly _endpointId: string
  ) {
    let current = connections.get(_config)
    if (!current) connections.set(_config, (current = new Set()))
    current.add(this)
    for (const output of [_child.stdout, _child.stderr]) {
      output?.on('data', (chunk: Buffer) => {
        this._diagnostics = (this._diagnostics + chunk.toString()).slice(-8_192)
      })
    }
    _child.on('message', (message: TypescriptWorkerMessage) => this._receive(message))
    _child.on('error', (error) => this.fail(error))
    _child.on('exit', (code, signal) => {
      this.fail(
        new Error(`TypeScript agent exited (${signal ?? code}). ${sanitizeTerminalText(this._diagnostics).trim()}`)
      )
    })
    _child.on('disconnect', () => this.fail(new Error('TypeScript agent disconnected.')))
  }

  static async open(
    init: TypescriptInit,
    config: CliConfigStore,
    messaging: AgentMessaging,
    signal?: AbortSignal
  ): Promise<{ connection: TypescriptConnection; messages: Message[] }> {
    signal?.throwIfAborted()
    config.applyProviderEnvironment()
    const source = import.meta.url.endsWith('.ts')
    const worker = new URL(source ? './typescript-worker.ts' : './typescript-worker.js', import.meta.url)
    const child = fork(fileURLToPath(worker), [], {
      cwd: init.cwd,
      env: { ...process.env },
      execArgv: source ? ['--import', import.meta.resolve('tsx')] : [],
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
    })
    const connection = new TypescriptConnection(child, config, messaging, init.peerEndpointId)
    const cancel = (): void => connection.fail(new Error('TypeScript agent loading cancelled.'))
    signal?.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(() => connection.fail(new Error('TypeScript agent loading timed out.')), 60_000)
    try {
      signal?.throwIfAborted()
      const result = await connection.call('init', init)
      connection.metadata = result.metadata
      return { connection, messages: result.messages.map((message) => Message.fromJSON(message)) }
    } catch (error) {
      await connection.dispose()
      throw error
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
    }
  }

  call<Operation extends keyof TypescriptCalls>(
    operation: Operation,
    input: TypescriptCalls[Operation]['input']
  ): Promise<TypescriptCalls[Operation]['result']> {
    if (this._failure) return Promise.reject(this._failure)
    if (this._disposal) return Promise.reject(new Error('TypeScript agent is closing.'))
    const id = ++this._sequence
    return new Promise((resolve, reject) => {
      this._pending.set(id, {
        operation,
        resolve: (value) => resolve(value as TypescriptCalls[Operation]['result']),
        reject,
      })
      this._send({ type: 'call', id, operation, input } as TypescriptCall)
    })
  }

  notify<Operation extends keyof TypescriptCalls>(
    operation: Operation,
    input: TypescriptCalls[Operation]['input']
  ): void {
    void this.call(operation, input).catch((error: unknown) => this.fail(new Error(errorMessage(error))))
  }

  private _send(message: TypescriptParentMessage): void {
    try {
      this._child.send(message, (error) => {
        if (error) this.fail(error)
      })
    } catch (error) {
      this.fail(new Error(errorMessage(error)))
    }
  }

  private _receive(message: TypescriptWorkerMessage): void {
    if (this._failure) return
    if (message.type === 'response' || message.type === 'error') {
      const pending = this._pending.get(message.id)
      if (!pending) return
      this._pending.delete(message.id)
      if (message.type === 'error') {
        pending.reject(new Error(sanitizeTerminalText(message.message)))
      } else {
        if (pending.operation === 'next') {
          const result = message.result as TypescriptCalls['next']['result']
          if (result.done && result.value.usageId !== undefined) {
            const id = result.value.usageId
            const receipt: UsageReceipt = { settled: false, value: undefined, listeners: new Set() }
            this._usage.set(id, receipt)
            const value: ChatRunResult = {
              ...result.value,
              watchUsage: (listener) => {
                if (receipt.settled) {
                  listener(receipt.value)
                  return () => {}
                }
                receipt.listeners.add(listener)
                return () => {
                  receipt.listeners.delete(listener)
                  if (receipt.listeners.size === 0 && this._usage.delete(id)) this.notify('unwatchUsage', id)
                }
              },
            }
            pending.resolve({ done: true, value })
            return
          }
        }
        pending.resolve(message.result)
      }
      return
    }
    if (message.type === 'hostCall') {
      void this._hostCall(message.call).then(
        (result) => this._send({ type: 'hostResponse', id: message.id, result }),
        (error: unknown) => this._send({ type: 'hostError', id: message.id, message: errorMessage(error) })
      )
      return
    }
    if (message.type === 'metadata') this.metadata = message.value
    if (message.type === 'tasks') this.tasks = message.value
    if (message.type === 'permission') this.permission = message.value
    if (message.type === 'peers') this._updatePeers(message.value)
    if (message.type === 'usage') {
      const receipt = this._usage.get(message.id)
      if (receipt) {
        this._usage.delete(message.id)
        receipt.settled = true
        receipt.value = message.value
        for (const listener of receipt.listeners) listener(message.value)
        receipt.listeners.clear()
      }
    }
    this.onMessage?.(message)
  }

  private async _hostCall(call: TypescriptHostCall): Promise<unknown> {
    if (this._disposal) throw new Error('TypeScript agent is closing.')
    if (call.operation === 'permission') {
      if (call.method === 'setPermissionMode') {
        if (call.value !== 'default' && call.value !== 'bypassPermissions') throw new Error('Invalid permission mode.')
        await this._config.setPermissionMode(call.value)
      } else {
        await this._config[call.method](call.value)
      }
      await TypescriptBackend.syncConfiguration(this._config)
      return { snapshot: this._config.snapshot(), environment: this._config.providerEnvironment() }
    }
    const sender = call.senderId === this._endpointId ? this._endpointId : this._peers.get(call.senderId)?.id
    if (!sender) throw new Error('This agent is not registered for peer messaging.')
    if (call.operation === 'listPeers') return this._messaging.list(sender)
    return this._messaging.send(sender, call.to, call.body)
  }

  private _updatePeers(peers: readonly PeerEndpointInfo[]): void {
    const present = new Set(peers.map((peer) => peer.id))
    for (const [localId, peer] of this._peers) {
      if (present.has(localId)) continue
      this._messaging.unregister(peer.id)
      this._peers.delete(localId)
    }
    for (const value of peers) {
      const existing = this._peers.get(value.id)
      if (existing) {
        existing.value = value
        this._messaging.rename(existing.id, value.name)
        continue
      }
      const peer = { id: `${this._namespace}:${value.id}`, value }
      this._peers.set(value.id, peer)
      this._messaging.register({
        id: peer.id,
        name: value.name,
        ...(value.description ? { description: value.description } : {}),
        ...(value.backgroundTask ? { backgroundTask: value.backgroundTask } : {}),
        status: () => (this._failure || this._disposal ? undefined : peer.value.status),
        enqueue: (message) => this.call('deliverPeer', { id: value.id, message }),
      })
    }
  }

  fail(error: Error): void {
    if (this._failure) return
    this._failure = error
    for (const request of this._pending.values()) request.reject(error)
    this._pending.clear()
    for (const receipt of this._usage.values()) {
      receipt.settled = true
      for (const listener of receipt.listeners) listener(undefined)
      receipt.listeners.clear()
    }
    this._usage.clear()
    this.permission = undefined
    this.onMessage?.({ type: 'permission', value: undefined })
    this.tasks = this.tasks.map((task) =>
      task.source === 'background' && ['pending', 'queued', 'in_progress', 'working', 'paused'].includes(task.status)
        ? { ...task, status: 'failed', deliveryState: 'delivered', error: error.message }
        : task
    )
    this.onMessage?.({ type: 'tasks', value: this.tasks })
    for (const peer of this._peers.values()) this._messaging.unregister(peer.id)
    this._peers.clear()
    for (const id of this.activities.keys()) this.onMessage?.({ type: 'activity', id, value: undefined })
    this.activities.clear()
    connections.get(this._config)?.delete(this)
    void this.dispose()
  }

  dispose(): Promise<void> {
    return (this._disposal ??= this._close())
  }

  private async _close(): Promise<void> {
    connections.get(this._config)?.delete(this)
    const closing = this.call('close', undefined).catch(() => {})
    let timeout: NodeJS.Timeout | undefined
    await Promise.race([
      closing,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this._failure ? 1_000 : 60_000)
      }),
    ])
    clearTimeout(timeout)
    await terminateProcessTree(this._child)
    this.fail(new Error('TypeScript agent closed.'))
    this.onMessage = undefined
  }
}

interface StreamInvocation {
  cancelled: boolean
  connection?: TypescriptConnection
  cancelTimeout?: NodeJS.Timeout
}

export class TypescriptBackend implements ChatBackend {
  readonly id = 'typescript'
  readonly protocol = 'strands'
  readonly mcp: Omit<LoadedMcp, 'clients'>
  readonly skills: ChatSkillsRuntime
  private readonly _taskListeners = new Set<(tasks: readonly ChatTask[]) => void>()
  private readonly _permissionListeners = new Set<(request: ChatPermissionRequest | undefined) => void>()
  private readonly _metadataListeners = new Set<() => void>()
  private readonly _configurationListeners = new Set<() => void>()
  private readonly _disposeListeners = new Set<() => void>()
  private readonly _activityListeners = new Map<string, Set<(activity: BackgroundAgentActivity | undefined) => void>>()
  private readonly _steering = new Map<number, { prompt: string; consumed: () => void }>()
  private readonly _options: Omit<TypescriptInit, 'config'>
  private _sequence = 0
  private _invocation: StreamInvocation | undefined
  private _loading: { controller: AbortController; promise: Promise<void> } | undefined
  private _draining = false
  private _thinking: ChatForkState['thinking'] | undefined
  private _configuration: TypescriptSetupChange | undefined
  private _disposal: Promise<void> | undefined

  private constructor(
    private _connection: TypescriptConnection,
    options: Omit<TypescriptInit, 'config'>,
    private readonly _config: CliConfigStore,
    private readonly _messaging: AgentMessaging
  ) {
    this._options = { ...options }
    delete this._options.seed
    delete this._options.conversation
    delete this._options.freshSession
    delete this._options.preserveSession
    delete this._options.restoreSeedMessages
    delete this._options.sessionId
    this._observe(_connection)
    const mcpState = (): TypescriptMetadata['mcp'] => this.state.mcp
    this.mcp = {
      get paths(): readonly string[] {
        return mcpState().paths
      },
      get warnings(): readonly string[] {
        return mcpState().warnings
      },
      ...(this.state.mcp.startup
        ? {
            startup: {
              progress: (): McpStartupProgress => mcpState().startup!,
              subscribe: (listener: () => void): (() => void) => {
                this._metadataListeners.add(listener)
                return (): void => {
                  this._metadataListeners.delete(listener)
                }
              },
            },
          }
        : {}),
      list: (connect = false): Promise<readonly McpServerInfo[]> => this._connection.call('listMcp', connect),
      setEnabled: (name, enabled): Promise<string | undefined> => this._connection.call('enableMcp', { name, enabled }),
      dispose: (): Promise<void> => this.dispose(),
    }
    this.skills = {
      list: (): Promise<readonly SkillInfo[]> => this._connection.call('listSkills', undefined),
      activate: (name): Promise<SkillActivation | undefined> => this._connection.call('activateSkill', name),
    }
  }

  static async open(
    init: Omit<TypescriptInit, 'config'>,
    config: CliConfigStore,
    messaging: AgentMessaging,
    signal?: AbortSignal
  ): Promise<{ backend: TypescriptBackend; messages: Message[] }> {
    const { connection, messages } = await TypescriptConnection.open(
      { ...init, config: { snapshot: config.snapshot(), environment: config.providerEnvironment() } },
      config,
      messaging,
      signal
    )
    return { backend: new TypescriptBackend(connection, init, config, messaging), messages }
  }

  static async syncConfiguration(config: CliConfigStore): Promise<void> {
    const value = { snapshot: config.snapshot(), environment: config.providerEnvironment() }
    await Promise.all([...(connections.get(config) ?? [])].map((connection) => connection.call('config', value)))
  }

  syncConfiguration(): Promise<void> {
    return TypescriptBackend.syncConfiguration(this._config)
  }
  get state(): TypescriptMetadata {
    return this._connection.metadata
  }
  get cwd(): string {
    return this._options.cwd
  }
  get name(): string {
    return this.state.name
  }
  get sessionId(): string | undefined {
    return this.state.sessionId
  }
  get sessionDirectory(): string {
    return this.state.sessionDirectory
  }
  get sessionIdentity(): TypescriptMetadata['sessionIdentity'] {
    return this.state.sessionIdentity
  }
  get privatePaths(): readonly string[] | null {
    return this.state.privatePaths
  }
  reconstructable(): boolean {
    return true
  }
  info(): TypescriptMetadata['info'] {
    return {
      ...this.state.info,
      ...(this._thinking !== undefined ? { effort: effortDisplayLabel(this._thinking) } : {}),
    }
  }
  contextUsage(): ChatContextUsage | undefined {
    return this.state.context
  }
  modelSelection(): NonNullable<ChatConversation['selection']> {
    return {
      ...this.state.selection,
      thinking: this._thinking === undefined ? this.state.selection.thinking : this._thinking,
    }
  }
  sourceSelection(): ChatConversation['sourceSelection'] {
    const source = this.state.sourceSelection
    return source ? { ...source, selected: this.modelSelection() } : undefined
  }
  listModels(): Promise<TypescriptCalls['listModels']['result']> {
    return this._connection.call('listModels', undefined)
  }
  modelChangeMode(modelId: string): 'live' | 'restart' {
    return modelChangeMode(this.state.currentModel, this.state.provider, modelId)
  }
  switchModel(modelId: string): Promise<string | void> {
    return this._connection.call('switchModel', modelId)
  }
  async restartModel(modelId: string): Promise<string> {
    await this._rotate({ kind: 'model', modelId, thinking: this.modelSelection().thinking })
    return this.state.currentModel
  }
  listEfforts(): ReturnType<NonNullable<ChatBackend['listEfforts']>> {
    return effortOptions(this.state.selection.model, this.modelSelection().thinking)
  }
  async setEffort(effort: string): Promise<string> {
    validateEffortSelection(effort, this.listEfforts())
    if (effortValue(effort) === effortValue(this.state.selection.thinking)) {
      await this._connection.call('setEffort', effort)
      this._thinking = undefined
      return effort
    }
    this._thinking = effort
    return effort
  }
  async clear(): Promise<void> {
    await this._rotate({ kind: 'clear', thinking: this.modelSelection().thinking })
  }
  compact(): Promise<ChatContextUsage | undefined> {
    return this._connection.call('compact', undefined)
  }
  captureConversation(): Promise<Snapshot> {
    return this._connection.call('captureConversation', undefined)
  }
  flush(): Promise<void> {
    return this._connection.call('flush', undefined)
  }
  async captureFork(): Promise<TypescriptSeed> {
    return { ...(await this._connection.call('captureFork', undefined)), ...this.modelSelection() }
  }

  private _rotate(rotation: TypescriptRotation): Promise<void> {
    if (this._loading) return Promise.reject(new Error('The TypeScript agent is already loading.'))
    const controller = new AbortController()
    const promise = this._replace(rotation, controller.signal).finally(() => {
      this._loading = undefined
    })
    this._loading = { controller, promise }
    return promise
  }

  private async _replace(rotation: TypescriptRotation, signal: AbortSignal): Promise<void> {
    const previous = this._connection
    const { selection, seed } = await previous.call('prepareRotation', rotation)
    signal.throwIfAborted()
    const options: Omit<TypescriptInit, 'config'> = {
      ...this._options,
      selection,
      sessionDirectory: previous.metadata.sessionDirectory,
      ...(rotation.kind === 'clear'
        ? { freshSession: true }
        : {
            ...(previous.metadata.sessionId ? { sessionId: previous.metadata.sessionId } : {}),
            ...(seed ? { seed } : {}),
            restoreSeedMessages: true,
          }),
    }
    const { connection } = await TypescriptConnection.open(
      { ...options, config: { snapshot: this._config.snapshot(), environment: this._config.providerEnvironment() } },
      this._config,
      this._messaging,
      signal
    )
    if (this._disposal) {
      await connection.dispose()
      throw new Error('TypeScript agent closed.')
    }
    this._connection = connection
    this._thinking = undefined
    this._observe(connection)
    for (const [id, listeners] of this._activityListeners) {
      for (const listener of listeners) listener(undefined)
      if (this._activityListeners.has(id)) connection.notify('watchActivity', { id, enabled: true })
    }
    previous.onMessage = undefined
    await previous.dispose()
    for (const listener of this._taskListeners) listener(connection.tasks)
    for (const listener of this._permissionListeners) listener(connection.permission)
    for (const listener of this._metadataListeners) listener()
  }

  stream(prompt: string | ContentBlockData[]): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    return this._stream({ kind: 'model', prompt })
  }
  streamPeer(message: PeerMessage): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    return this._stream({ kind: 'peer', message })
  }
  streamShell(command: string): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    return this._stream({ kind: 'shell', command })
  }
  streamBackgroundResults(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    return this._stream({ kind: 'background' })
  }

  private async *_stream(input: TypescriptStream): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    if (this._invocation) throw new Error('The TypeScript agent is busy.')
    const invocation: StreamInvocation = { cancelled: false }
    this._invocation = invocation
    let connection = this._connection
    let streamId: number | undefined
    let completed = false
    try {
      if (
        input.kind !== 'shell' &&
        effortValue(this.modelSelection().thinking) !== effortValue(this.state.selection.thinking)
      ) {
        await this._rotate({ kind: 'effort', thinking: this.modelSelection().thinking })
        connection = this._connection
      }
      if (invocation.cancelled) throw new Error('TypeScript invocation cancelled.')
      invocation.connection = connection
      streamId = await connection.call('start', input)
      if (invocation.cancelled) throw new Error('TypeScript invocation cancelled.')
      while (true) {
        const result = await connection.call('next', streamId)
        if (result.done) {
          completed = true
          return result.value
        }
        yield result.value
      }
    } finally {
      if (!completed && streamId !== undefined) {
        this.cancel()
        await connection.call('return', streamId).catch(() => {})
      }
      this._invocation = undefined
      clearTimeout(invocation.cancelTimeout)
    }
  }

  cancel(): void {
    const invocation = this._invocation
    if (invocation) {
      invocation.cancelled = true
      this._loading?.controller.abort()
    }
    this._connection.notify('cancel', undefined)
    if (!invocation || invocation.cancelTimeout) return
    const connection = this._connection
    invocation.cancelTimeout = setTimeout(() => {
      connection.fail(new Error('The TypeScript agent did not stop after cancellation. Reload it to continue.'))
      void connection.dispose()
    }, 3_000)
  }

  queueSteering(prompt: string, onConsumed: () => void): boolean {
    const connection = this._invocation?.connection
    if (!connection || this._draining || this._disposal || !prompt.trim()) return false
    const id = ++this._sequence
    this._steering.set(id, { prompt, consumed: onConsumed })
    void connection.call('steer', { id, prompt }).catch((error: unknown) => {
      connection.fail(new Error(errorMessage(error)))
    })
    return true
  }

  async drainSteering(): Promise<string[]> {
    this._draining = true
    try {
      await this._connection.call('drainSteering', undefined)
      const pending = [...this._steering.values()].map((item) => item.prompt)
      this._steering.clear()
      return pending
    } catch (error) {
      this._steering.clear()
      throw error
    } finally {
      this._draining = false
    }
  }

  async generateSessionName(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const id = ++this._sequence
    const connection = this._connection
    const cancel = (): void => connection.notify('cancelNaming', id)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await connection.call('nameSession', id)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  permissionStatus(): ReturnType<NonNullable<ChatBackend['permissionStatus']>> {
    const snapshot = this._config.snapshot()
    return {
      mode: snapshot.permissions.mode,
      allowedTools: snapshot.permissions.allow,
      deniedTools: snapshot.permissions.deny,
      configPath: snapshot.path,
    }
  }
  setPermissionMode(mode: CliConfigSnapshot['permissions']['mode']): Promise<void> {
    return this._connection.call('setPermissionMode', mode)
  }
  allowPermission(rule: string): Promise<void> {
    return this._connection.call('allowPermission', rule)
  }
  removeAllowedPermission(rule: string): Promise<void> {
    return this._connection.call('removeAllowedPermission', rule)
  }
  removeDeniedPermission(rule: string): Promise<void> {
    return this._connection.call('removeDeniedPermission', rule)
  }
  respondPermission(requestId: string, optionId?: string, rule?: string): Promise<boolean> {
    return this._connection.call('respondPermission', {
      requestId,
      ...(optionId ? { optionId } : {}),
      ...(rule ? { rule } : {}),
    })
  }
  hasReadyBackgroundResults(): boolean {
    return this._connection.tasks.some((task) => task.source === 'background' && task.deliveryState === 'ready')
  }
  watchTasks(listener: (tasks: readonly ChatTask[]) => void): () => void {
    this._taskListeners.add(listener)
    listener(this._connection.tasks)
    return () => {
      this._taskListeners.delete(listener)
    }
  }
  watchPermissions(listener: (request: ChatPermissionRequest | undefined) => void): () => void {
    this._permissionListeners.add(listener)
    listener(this._connection.permission)
    return () => {
      this._permissionListeners.delete(listener)
    }
  }
  getTaskActivity(taskId: string): BackgroundAgentActivity | undefined {
    return this._connection.activities.get(taskId)
  }
  watchTaskActivity(taskId: string, listener: (activity: BackgroundAgentActivity | undefined) => void): () => void {
    let listeners = this._activityListeners.get(taskId)
    if (!listeners) {
      this._activityListeners.set(taskId, (listeners = new Set()))
      this._connection.notify('watchActivity', { id: taskId, enabled: true })
    }
    listeners.add(listener)
    listener(this.getTaskActivity(taskId))
    return () => {
      listeners.delete(listener)
      if (listeners.size > 0) return
      this._activityListeners.delete(taskId)
      this._connection.activities.delete(taskId)
      this._connection.notify('watchActivity', { id: taskId, enabled: false })
    }
  }
  subscribeConfiguration(listener: () => void): () => void {
    this._configurationListeners.add(listener)
    return () => {
      this._configurationListeners.delete(listener)
    }
  }
  takeConfigurationChange(): SetupChange | undefined {
    const pending = this._configuration
    if (!pending) return undefined
    this._configuration = undefined
    const connection = this._connection
    return {
      ...pending.change,
      onFailure: (message) => connection.call('configurationFailed', { token: pending.token, message }),
    }
  }
  onDispose(listener: () => void): () => void {
    this._disposeListeners.add(listener)
    return () => {
      this._disposeListeners.delete(listener)
    }
  }

  private _observe(connection: TypescriptConnection): void {
    connection.onMessage = (message): void => {
      if (this._connection !== connection || this._disposal) return
      if (message.type === 'tasks') for (const listener of this._taskListeners) listener(message.value)
      if (message.type === 'permission') for (const listener of this._permissionListeners) listener(message.value)
      if (message.type === 'metadata') for (const listener of this._metadataListeners) listener()
      if (message.type === 'activity') {
        const listeners = this._activityListeners.get(message.id)
        if (listeners) {
          connection.activities.set(message.id, message.value)
          for (const listener of listeners) listener(message.value)
        }
      }
      if (message.type === 'consumed') {
        const item = this._steering.get(message.id)
        this._steering.delete(message.id)
        item?.consumed()
      }
      if (message.type === 'configuration') {
        this._configuration = message.value
        for (const listener of this._configurationListeners) listener()
      }
      if (message.type === 'configurationDiscarded') this._configuration = undefined
    }
  }

  dispose(): Promise<void> {
    if (this._disposal) return this._disposal
    for (const listener of this._disposeListeners) listener()
    this._disposeListeners.clear()
    this._loading?.controller.abort()
    clearTimeout(this._invocation?.cancelTimeout)
    this._steering.clear()
    this._configuration = undefined
    this._taskListeners.clear()
    this._permissionListeners.clear()
    this._metadataListeners.clear()
    this._configurationListeners.clear()
    this._activityListeners.clear()
    this._disposal = Promise.allSettled([this._connection.dispose(), this._loading?.promise]).then(() => {})
    return this._disposal
  }
}
