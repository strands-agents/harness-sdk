import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { fileURLToPath, URL } from 'node:url'
import { Message, type MessageData, type JSONValue, type ContentBlockData } from '@strands-agents/sdk'
import type { HarnessAgentConfig } from '@strands-agents/harness'
import { isAuthorized } from '@cedar-policy/cedar-wasm/nodejs'

import type { ChatBackend, ChatConversation, ChatEvent, ChatRunResult, ChatPermissionMode } from '../chat/types.js'
import type { SetupChange } from '../agent-configuration.js'
import type { ImportedAgentProject } from './import.js'
import { prepareArchiveDependencies } from './archive.js'
import { CliConfigStore } from '../config.js'
import {
  effortOptions,
  profileEffort,
  effortDisplayLabel,
  effortForModel,
  validateEffortSelection,
  validateModelSelection,
  type EffortInput,
} from '../model/selection.js'
import { discoverProviderModels } from '../provider/discovery.js'
import { DEFAULT_CEDAR_POLICIES, pathIsWithinWorkspace, ToolPermissionBroker } from '../permissions/policy.js'
import { createDiffPreview } from '../permissions/file-change-preview.js'
import { terminateProcessTree } from '../terminal/process-tree.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import type { SkillInfo } from '../skills.js'

function decodeBytes(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && '$bytes' in value && typeof value.$bytes === 'string') {
    return Uint8Array.from(Buffer.from(value.$bytes, 'base64'))
  }
  return value
}

interface PythonState {
  name: string
  reconstructable: boolean
  description: string
  model: string
  modelSpecifier?: string
  thinking: Exclude<EffortInput, undefined>
  sourceSelection?: ChatConversation['sourceSelection']
  sessionId?: string
  sessionDirectory: string
  session?: ChatConversation['session']
  messages: MessageData[]
  tools: { name: string; description: string }[]
  skills: SkillInfo[]
  privatePaths: string[]
}

type WorkerMessage =
  | { type: 'ready'; state: PythonState }
  | { type: 'event'; event: ChatEvent }
  | {
      type: 'authorize'
      id: string
      name: string
      input: Record<string, JSONValue>
      before?: string
      pathInWorkspace: boolean
    }
  | { type: 'result'; result: ChatRunResult; state: PythonState; reload?: boolean }
  | { type: 'error'; message: string }

export interface PythonOptions {
  sourceSelection?: ChatConversation['sourceSelection']
  overrides?: Partial<HarnessAgentConfig>
  assignments?: readonly string[]
  interactive?: boolean
  sessionId?: string
  sessionDir?: string
  sessionStorageDirectory?: string
  mcpServers?: Exclude<HarnessAgentConfig['mcpServers'], string>
  skillPaths?: readonly string[]
  cwd?: string
  resume?: boolean
}

export class PythonBackend implements ChatBackend {
  readonly id = 'python'
  readonly protocol = 'strands'
  private _state!: PythonState
  private readonly _messages: WorkerMessage[] = []
  private readonly _permissions = new ToolPermissionBroker()
  private _wake: (() => void) | undefined
  private _failure: Error | undefined
  private _running = false
  private _reloadRequested = false
  private _disposed = false
  private _diagnostics = ''
  private _cancelTimeout: NodeJS.Timeout | undefined

  private constructor(
    private readonly _child: ChildProcess,
    private readonly _project: ImportedAgentProject,
    private readonly _config: CliConfigStore,
    readonly cwd: string
  ) {
    for (const output of [_child.stdout, _child.stderr]) {
      output?.on('data', (chunk: Buffer) => {
        this._diagnostics = (this._diagnostics + chunk.toString()).slice(-8_192)
      })
    }
    const input = createInterface({ input: _child.stdio[3] as Readable })
    input.on('line', (line) => {
      try {
        const message: unknown = JSON.parse(line, decodeBytes)
        if (
          !message ||
          typeof message !== 'object' ||
          !('type' in message) ||
          !['ready', 'event', 'authorize', 'result', 'error'].includes(String(message.type))
        ) {
          throw new Error('Unexpected Python message')
        }
        this._messages.push(message as WorkerMessage)
        this._wake?.()
      } catch {
        this._fail(new Error('The Python agent returned an invalid message.'))
      }
    })
    _child.on('error', (error) => this._fail(error))
    _child.on('close', (code, signal) => {
      this._fail(
        new Error(`Python agent exited (${signal ?? code}). ${sanitizeTerminalText(this._diagnostics).trim()}`)
      )
      input.close()
    })
    _child.stdin?.on('error', (error) => this._fail(error))
  }

  static async open(
    project: ImportedAgentProject,
    config: CliConfigStore,
    options: PythonOptions = {},
    signal?: AbortSignal
  ): Promise<PythonBackend> {
    await prepareArchiveDependencies(project.root, project.language)
    const python = join(project.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const projectEnvironment = existsSync(python)
    const worker = fileURLToPath(new URL('./worker.py', import.meta.url))
    const cwd = resolve(options.cwd ?? process.cwd())
    config.applyProviderEnvironment()
    const backend = new PythonBackend(
      spawn(projectEnvironment ? python : 'python3', ['-u', worker, project.entrypoint, project.root], {
        cwd,
        env: {
          ...process.env,
          ...(projectEnvironment ? { PATH: [dirname(python), process.env.PATH].filter(Boolean).join(delimiter) } : {}),
          ...(process.env.AWS_REGION ? { AWS_DEFAULT_REGION: process.env.AWS_REGION } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      }),
      project,
      config,
      cwd
    )
    const cancel = (): void => backend._fail(new Error('Python agent loading cancelled.'))
    signal?.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(() => backend._fail(new Error('Python agent loading timed out.')), 60_000)
    try {
      signal?.throwIfAborted()
      await backend._request({ type: 'init', ...options })
      return backend
    } catch (error) {
      await backend.dispose()
      throw error
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
    }
  }

  get name(): string {
    return sanitizeTerminalText(this._state.name)
  }
  reconstructable(): boolean {
    return this._state.reconstructable
  }
  get sessionId(): string | undefined {
    return this._state.sessionId
  }
  get sessionDirectory(): string {
    return this._state.sessionDirectory
  }
  get sessionIdentity(): PythonState['session'] {
    return this._state.session
  }
  get messages(): Message[] {
    return this._state.messages.map((message) => Message.fromJSON(message))
  }
  get skills(): readonly SkillInfo[] {
    return this._state.skills
  }
  get privatePaths(): readonly string[] {
    return this._state.privatePaths
  }

  info(): ReturnType<NonNullable<ChatBackend['info']>> {
    return {
      description: sanitizeTerminalText(this._state.description),
      model: sanitizeTerminalText(this._state.model),
      effort: this.listEfforts().length === 0 ? 'Auto' : effortDisplayLabel(this._state.thinking),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      tools: this._state.tools,
    }
  }

  async *stream(prompt: string | ContentBlockData[]): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    if (this._running) throw new Error('The Python agent is busy.')
    this._running = true
    let completed = false
    try {
      this._send({ type: 'prompt', prompt })
      while (true) {
        const message = await this._next()
        if (message.type === 'error') {
          completed = true
          this._reloadRequested = false
          throw new Error(sanitizeTerminalText(message.message))
        }
        if (message.type === 'result') {
          this._state = message.state
          this._reloadRequested = message.reload === true
          completed = true
          return message.result
        }
        if (message.type === 'authorize') {
          const approved = await this._authorize(message)
          this._send({ type: 'permission', requestId: message.id, approved })
        } else if (message.type === 'event') {
          yield message.event
        }
      }
    } finally {
      if (!completed) {
        this.cancel()
        // Do not allow a later prompt to consume a cancelled turn's queued events.
        await this.dispose()
      }
      this._running = false
      clearTimeout(this._cancelTimeout)
      this._cancelTimeout = undefined
    }
  }

  takeReloadRequest(): SetupChange | undefined {
    if (!this._reloadRequested) return undefined
    this._reloadRequested = false
    return {
      agentProject: this._project.entrypoint,
      onFailure: async (message): Promise<void> => {
        await this._request({ type: 'reload-failed', message })
      },
    }
  }

  async listModels(): Promise<Awaited<ReturnType<NonNullable<ChatBackend['listModels']>>>> {
    const environment = this._config.providerEnvironment()
    const catalogs = await Promise.all(
      this._config.snapshot().providers.enabled.map(async (provider) => {
        const result = await discoverProviderModels(provider, environment)
        return result.models.map((model) => ({
          id: `${provider}/${model.id}`,
          name: model.name,
          description: provider,
          catalog: provider,
          active: `${provider}/${model.id}` === this._state.model,
        }))
      })
    )
    const models = catalogs.flat()
    return models.some((model) => model.active)
      ? models
      : [
          { id: this._state.model, name: this._state.model, description: 'Current Python model', active: true },
          ...models,
        ]
  }

  modelChangeMode(): 'restart' {
    return 'restart'
  }

  async restartModel(model: string): Promise<string> {
    if (model !== (this._state.modelSpecifier ?? this._state.model)) {
      await validateModelSelection(model, discoverProviderModels, this._config.providerEnvironment())
    }
    await this._request({ type: 'reset', model, thinking: effortForModel(model, this._state.thinking) })
    return this._state.model
  }

  listEfforts(): ReturnType<NonNullable<ChatBackend['listEfforts']>> {
    return effortOptions(this._state.model, this._state.thinking)
  }

  async setEffort(thinking: string): Promise<string> {
    validateEffortSelection(thinking, this.listEfforts())
    await this._request({ type: 'reset', thinking: thinking === 'none' ? null : thinking })
    return effortDisplayLabel(this._state.thinking)
  }

  async clear(): Promise<void> {
    await this._request({ type: 'reset', clear: true, sessionId: randomUUID() })
  }

  async compact(): Promise<boolean> {
    const result = await this._request({ type: 'compact' })
    return result.stopReason === 'compacted'
  }

  async activateSkill(name: string): Promise<SkillInfo | undefined> {
    await this._request({ type: 'skill', name })
    return this.skills.find((skill) => skill.name === name)
  }

  async fork(options: PythonOptions, signal?: AbortSignal): Promise<PythonBackend> {
    const target = await PythonBackend.open(
      this._project,
      this._config,
      {
        ...options,
        sessionId: randomUUID(),
        sessionStorageDirectory: this.sessionDirectory,
        cwd: this.cwd,
        overrides: {
          ...options.overrides,
          effort: profileEffort(this._state.thinking),
          ...(this._state.modelSpecifier ? { model: this._state.modelSpecifier } : {}),
        },
      },
      signal
    )
    try {
      const snapshot = await this._request({ type: 'snapshot' })
      await target._request({ type: 'seed', snapshot: snapshot.finalText })
      return target
    } catch (error) {
      await target.dispose()
      throw error
    }
  }

  async captureConversation(): Promise<ChatConversation['snapshot']> {
    const result = await this._request({ type: 'conversation' })
    return JSON.parse(result.finalText!, decodeBytes) as ChatConversation['snapshot']
  }

  sourceSelection(): ChatConversation['sourceSelection'] {
    return this._state.sourceSelection
  }

  async restoreConversation(conversation: ChatConversation): Promise<void> {
    await this._request({
      type: 'conversation',
      snapshot: conversation.snapshot,
      preserveReasoning: conversation.model === this.info().model,
    })
  }

  watchPermissions(listener: Parameters<ToolPermissionBroker['subscribe']>[0]): () => void {
    return this._permissions.subscribe(listener)
  }

  permissionStatus(): ReturnType<NonNullable<ChatBackend['permissionStatus']>> {
    const { mode, allow } = this._config.snapshot().permissions
    return { mode, allowedTools: allow, configPath: this._config.snapshot().path }
  }

  async setPermissionMode(mode: ChatPermissionMode): Promise<void> {
    this._permissions.cancelAll()
    await this._config.setPermissionMode(mode)
  }

  allowPermission(name: string): Promise<void> {
    return this._config.allowTool(name)
  }
  removeAllowedPermission(name: string): Promise<void> {
    return this._config.removeAllowedTool(name)
  }

  respondPermission(requestId: string, optionId?: string): boolean {
    if (this._permissions.respond(requestId, optionId)) return true
    this._send({ type: 'permission', requestId, approved: optionId === 'allow' })
    return true
  }

  cancel(): void {
    this._permissions.cancelAll()
    if (!this._disposed && !this._failure) {
      this._send({ type: 'cancel' })
      if (this._running && !this._cancelTimeout) {
        this._cancelTimeout = setTimeout(() => {
          this._fail(new Error('The Python agent did not stop after cancellation. Reload it to continue.'))
          void this.dispose()
        }, 3_000)
      }
    }
  }

  async dispose(): Promise<void> {
    if (this._disposed) return
    this._disposed = true
    clearTimeout(this._cancelTimeout)
    this._permissions.dispose()
    this._child.stdin?.end(`${JSON.stringify({ type: 'close' })}\n`)
    let timeout: NodeJS.Timeout | undefined
    await Promise.race([
      new Promise<void>((resolve) => {
        if (this._child.exitCode !== null || this._child.signalCode !== null) resolve()
        else this._child.once('close', () => resolve())
      }),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 1_000)
      }),
    ])
    clearTimeout(timeout)
    if (this._child.exitCode === null && this._child.signalCode === null) await terminateProcessTree(this._child)
    this._fail(new Error('Python agent closed.'))
  }

  private async _authorize(message: Extract<WorkerMessage, { type: 'authorize' }>): Promise<boolean> {
    const configured = this._config.snapshot().permissions
    if (configured.mode === 'bypassPermissions' || configured.allow.includes(message.name)) return true
    const authorization = isAuthorized({
      principal: { type: 'User', id: 'anonymous' },
      action: { type: 'Action', id: message.name },
      resource: { type: 'Resource', id: 'agent' },
      entities: [],
      context: {
        input: message.input,
        session: {
          path_in_workspace:
            message.pathInWorkspace && message.name === 'read' && pathIsWithinWorkspace(message.input.path, this.cwd),
        },
      },
      policies: { staticPolicies: DEFAULT_CEDAR_POLICIES },
    })
    if (authorization.type === 'failure') throw new Error('Cedar permission evaluation failed.')
    if (authorization.response.decision === 'allow') return true
    const path = message.input.path
    const after =
      message.name === 'write'
        ? message.input.content
        : message.name === 'edit' &&
            typeof message.input.old_str === 'string' &&
            typeof message.input.new_str === 'string'
          ? message.before?.replace(message.input.old_str, message.input.new_str)
          : undefined
    const diff =
      typeof path === 'string' && typeof after === 'string' && message.before !== undefined
        ? createDiffPreview(path, message.before, after)
        : undefined
    const decision = await this._permissions.request(message.name, message.input, diff)
    if (decision === 'allow-tool-always') await this._config.allowTool(message.name)
    return decision !== 'deny'
  }

  private async _request(command: object): Promise<ChatRunResult> {
    if (this._running) throw new Error('Wait for the Python agent to finish before changing it.')
    this._running = true
    try {
      this._send(command)
      const message = await this._next()
      if (message.type === 'error') throw new Error(sanitizeTerminalText(message.message))
      if (message.type !== 'ready' && message.type !== 'result') throw new Error('Unexpected Python response.')
      this._state = message.state
      return message.type === 'result' ? message.result : { stopReason: 'ready' }
    } finally {
      this._running = false
      clearTimeout(this._cancelTimeout)
      this._cancelTimeout = undefined
    }
  }

  private _send(message: object): void {
    if (this._failure) throw this._failure
    this._child.stdin!.write(
      `${JSON.stringify(message, (_key, value: unknown) =>
        value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString('base64') } : value
      )}\n`
    )
  }

  private _fail(error: Error): void {
    this._failure ??= error
    this._permissions.cancelAll()
    this._wake?.()
  }

  private async _next(): Promise<WorkerMessage> {
    while (this._messages.length === 0) {
      if (this._failure) throw this._failure
      await new Promise<void>((resolve) => {
        this._wake = resolve
      })
      this._wake = undefined
    }
    return this._messages.shift()!
  }
}
