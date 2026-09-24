import {
  Message,
  SummarizingConversationManager,
  TextBlock,
  type Agent,
  type JSONValue,
  type Snapshot,
  type Usage,
} from '@strands-agents/sdk'

import type {
  ChatBackend,
  ChatContextUsage,
  ChatConversation,
  ChatEffortOption,
  ChatEvent,
  ChatForkState,
  ChatModelOption,
  ChatPermissionMode,
  ChatPermissionStatus,
  ChatRunResult,
  ChatTask,
} from './chat/controller.js'
import { projectAgentEvent, projectAgentResult } from './chat/sdk-projector.js'
import { sanitizeTerminalText } from './terminal/sanitize.js'
import type { BackgroundAgentActivity, BackgroundAgentActivityStore } from './background/activity.js'
import { readBackgroundTasks } from './background/tasks.js'
import { peerMessageMetadata, peerMessagePrompt, type PeerMessage } from './messaging.js'
import { effortDisplayLabel } from './model/selection.js'
import type { AgentModelRuntime } from './model/runtime.js'
import { contextWindowLimit } from './model/context.js'
import type { CedarPermissions, ToolPermissionBroker } from './permissions/policy.js'
import { ShellRunner } from './chat/shell.js'
import { clearStoredContext, persistContext, restoreContext } from './session/context.js'
import type { LiveSteering } from './steering.js'
import { latestRootModelUsage, RunUsage } from '../usage.js'

interface HarnessTodo {
  content: string
  activeForm: string
  status: 'pending' | 'in_progress' | 'completed'
}

const TASK_REFRESH_INTERVAL_MS = 200
const ALWAYS_BACKGROUND_TOOL_NAMES = new Set(['subagent'])

interface StrandsChatBackendOptions {
  sourceDefinition?: Omit<NonNullable<ChatConversation['sourceSelection']>, 'selected'>
  contextWindow?: () => Promise<number | undefined>
  taskActivity?: BackgroundAgentActivityStore
  permissions?: {
    broker: ToolPermissionBroker
    policy: CedarPermissions
  }
  steering?: LiveSteering
  contextScope?: string
  shellOutputDirectory?: string
  dispose?: () => void | Promise<void>
}

export class StrandsChatBackend implements ChatBackend {
  readonly id = 'strands'
  readonly protocol = 'strands'

  private readonly _sourceDefinition: StrandsChatBackendOptions['sourceDefinition']
  private readonly _contextWindow: (() => Promise<number | undefined>) | undefined
  private readonly _taskActivity: BackgroundAgentActivityStore | undefined
  private readonly _dispose: (() => void | Promise<void>) | undefined
  private readonly _permissions: ToolPermissionBroker | undefined
  private readonly _permissionPolicy: CedarPermissions | undefined
  private readonly _steering: LiveSteering | undefined
  private readonly _contextScope: string | undefined
  private readonly _shell: ShellRunner
  private readonly _taskListeners = new Set<(tasks: readonly ChatTask[]) => void>()
  private _taskSignature: string | undefined
  private _taskTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly _runtime: AgentModelRuntime,
    options: StrandsChatBackendOptions = {}
  ) {
    this._sourceDefinition = options.sourceDefinition
    this._contextWindow = options.contextWindow
    this._taskActivity = options.taskActivity
    this._permissions = options.permissions?.broker
    this._permissionPolicy = options.permissions?.policy
    this._steering = options.steering
    this._contextScope = options.contextScope
    this._shell = new ShellRunner(() => this._runtime.agent.sandbox, options.shellOutputDirectory)
    this._dispose = options.dispose
  }

  get name(): string {
    const name = this._runtime.agent.name
    return name === 'Strands Agent' ? 'Strands harness' : sanitizeTerminalText(name || 'Strands harness')
  }

  get agent(): Agent {
    return this._runtime.agent
  }

  info(): {
    description?: string
    model: string
    effort?: string
    sessionId?: string
    tools: { name: string; description: string }[]
  } {
    const efforts = this._runtime.listEfforts()
    const effort =
      efforts.length === 0
        ? 'Auto'
        : (efforts.find((option) => option.active)?.label ?? effortDisplayLabel(this._runtime.thinking))
    const sessionId = this._runtime.sessionId
    return {
      ...(this._runtime.agent.description
        ? { description: sanitizeTerminalText(this._runtime.agent.description) }
        : {}),
      model: sanitizeTerminalText(this._runtime.agent.model.modelId || this._runtime.agent.model.constructor.name),
      ...(effort ? { effort: sanitizeTerminalText(effort) } : {}),
      ...(sessionId ? { sessionId: sanitizeTerminalText(sessionId) } : {}),
      tools: this._runtime.agent.tools.map((tool) => ({
        name: sanitizeTerminalText(tool.name),
        description: sanitizeTerminalText(tool.description),
      })),
    }
  }

  contextUsage(): ChatContextUsage | undefined {
    const context = restoreContext(this._runtime, this._contextScope)
    if (context && context.contextWindow === undefined) {
      const contextWindow = contextWindowLimit(this._runtime.agent.model)
      if (contextWindow !== undefined) {
        return { ...context, contextWindow }
      }
    }
    return context
  }

  listModels(): Promise<readonly ChatModelOption[]> {
    return this._runtime.list().then((models) => models.map(sanitizeModelOption))
  }

  modelChangeMode(modelId: string): 'live' | 'restart' {
    return this._runtime.changeMode(modelId)
  }

  switchModel(modelId: string): Promise<string> {
    return this._runtime.switch(modelId).then(sanitizeTerminalText)
  }

  restartModel(modelId: string): Promise<string> {
    return this._runtime.restart(modelId).then(sanitizeTerminalText)
  }

  listEfforts(): readonly ChatEffortOption[] {
    return this._runtime.listEfforts()
  }

  setEffort(effort: string): Promise<string> {
    return this._runtime.setEffort(effort).then(sanitizeTerminalText)
  }

  streamShell(command: string): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    return this._shell.stream(command)
  }

  queueSteering(prompt: string): boolean {
    return this._steering?.enqueue(this._runtime.agent, prompt) ?? false
  }

  forkState(): ChatForkState {
    return {
      messages: this._runtime.agent.messages.map((message) => message.clone()),
      ...this._runtime.forkConfiguration(),
    }
  }

  async captureConversation(): Promise<Snapshot> {
    return this._runtime.agent.takeSnapshot({ include: ['messages', 'state'] })
  }

  sourceSelection(): ChatConversation['sourceSelection'] {
    if (!this._sourceDefinition) {
      return undefined
    }
    const { model, thinking } = this._runtime.forkConfiguration()
    return { ...this._sourceDefinition, selected: { model, thinking } }
  }

  backgroundTasksWaitForCompletion(): boolean | undefined {
    return this._runtime.backgroundTasksWaitForCompletion
  }

  setBackgroundTasksWaitForCompletion(waitForCompletion: boolean): Promise<void> {
    return this._runtime.setBackgroundTasksWaitForCompletion(waitForCompletion)
  }

  async compact(): Promise<boolean> {
    const manager = new SummarizingConversationManager({
      summaryRatio: 0.8,
      preserveRecentMessages: 2,
    })
    const reduced = await manager.reduce({ agent: this._runtime.agent, model: this._runtime.agent.model })
    if (reduced) {
      clearStoredContext(this._runtime.agent.messages.at(-1))
      await this._runtime.agent.sessionManager?.saveSnapshot({
        target: this._runtime.agent,
        isLatest: true,
      })
    }
    return reduced
  }

  clear(): Promise<void> {
    return this._runtime.clear()
  }

  watchTasks(listener: (tasks: readonly ChatTask[]) => void): () => void {
    this._taskListeners.add(listener)
    const tasks = this._readTasks()
    this._taskSignature = JSON.stringify(tasks)
    listener(tasks)
    if (!this._taskTimer) {
      this._taskTimer = setInterval(() => this._publishTaskUpdate(), TASK_REFRESH_INTERVAL_MS)
      this._taskTimer.unref()
    }
    return () => {
      this._taskListeners.delete(listener)
      if (this._taskListeners.size === 0) {
        clearInterval(this._taskTimer)
        this._taskTimer = undefined
      }
    }
  }

  watchPermissions(listener: Parameters<ToolPermissionBroker['subscribe']>[0]): () => void {
    return this._permissions?.subscribe(listener) ?? ((): void => {})
  }

  respondPermission(requestId: string, optionId?: string): boolean {
    return this._permissions?.respond(requestId, optionId) ?? false
  }

  permissionStatus(): ChatPermissionStatus | undefined {
    const status = this._permissionPolicy?.permissionStatus()
    return status
      ? {
          mode: status.permissions.mode,
          allowedTools: [...status.permissions.allow],
          configPath: sanitizeTerminalText(status.path),
        }
      : undefined
  }

  setPermissionMode(mode: ChatPermissionMode): Promise<void> {
    if (!this._permissionPolicy) {
      return Promise.reject(new Error('This runtime cannot configure permissions.'))
    }
    return this._permissionPolicy.setPermissionMode(mode)
  }

  allowPermission(toolName: string): Promise<void> {
    if (!this._permissionPolicy) {
      return Promise.reject(new Error('This runtime cannot configure permissions.'))
    }
    return this._permissionPolicy.allowTool(toolName)
  }

  removeAllowedPermission(toolName: string): Promise<void> {
    if (!this._permissionPolicy) {
      return Promise.reject(new Error('This runtime cannot configure permissions.'))
    }
    return this._permissionPolicy.removeAllowedTool(toolName)
  }

  getTaskActivity(taskId: string): BackgroundAgentActivity | undefined {
    return this._taskActivity?.get(taskId)
  }

  watchTaskActivity(taskId: string, listener: (activity: BackgroundAgentActivity | undefined) => void): () => void {
    return this._taskActivity?.subscribe(taskId, listener) ?? ((): void => {})
  }

  hasReadyBackgroundResults(): boolean {
    return readBackgroundTasks(this._runtime.agent).some((task) => task.deliveryState === 'ready')
  }

  async *stream(prompt: string): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    return yield* this._streamAgent(prompt)
  }

  async *streamPeer(message: PeerMessage): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    return yield* this._streamAgent([
      new Message({
        role: 'user',
        content: [new TextBlock(peerMessagePrompt(message))],
        metadata: { custom: peerMessageMetadata(message) },
      }),
    ])
  }

  async *streamBackgroundResults(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    if (!this.hasReadyBackgroundResults()) {
      return { stopReason: 'noBackgroundResults' }
    }
    return yield* this._streamAgent([])
  }

  async *_streamAgent(args: Parameters<Agent['stream']>[0]): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    const snapshot = this._runtime.agent.takeSnapshot({ preset: 'session' })
    const projectionOptions =
      this.backgroundTasksWaitForCompletion() === undefined
        ? {}
        : { alwaysBackgroundTools: ALWAYS_BACKGROUND_TOOL_NAMES }
    const initialTasks = this._taskUpdate()
    if (initialTasks) {
      yield initialTasks
    }

    try {
      const stream = this._runtime.stream(args)
      const runUsage = RunUsage.start(this._runtime.agent)
      let latestModelUsage: Usage | undefined
      let next = await stream.next()
      while (!next.done) {
        const event = next.value
        const rootEvent = !('agent' in event) || event.agent === this._runtime.agent
        if (rootEvent) {
          latestModelUsage = latestRootModelUsage(this._runtime.agent, event) || latestModelUsage
          for (const projected of projectAgentEvent(event, projectionOptions)) {
            yield projected
          }
        }
        if (event.type === 'toolResultEvent') {
          const tasks = this._taskUpdate()
          if (tasks) {
            yield tasks
          }
        }
        next = await stream.next()
      }
      const usage = runUsage.total()
      const result = projectAgentResult(this._runtime.agent, next.value, latestModelUsage, usage)
      if (usage?.incomplete) {
        result.watchUsage = (listener): (() => void) =>
          runUsage.onComplete((total) => {
            listener(
              total
                ? {
                    ...total,
                    cacheReadInputTokens: total.cacheReadInputTokens ?? 0,
                    cacheWriteInputTokens: total.cacheWriteInputTokens ?? 0,
                  }
                : undefined
            )
          })
      }
      const contextWindow = await this._contextWindow?.()
      if (contextWindow !== undefined) {
        result.context = { ...result.context, contextWindow }
      }
      await persistContext(this._runtime, this._contextScope, next.value, result.context)
      return result
    } catch (error) {
      try {
        this._runtime.agent.loadSnapshot(snapshot)
        await this._runtime.agent.sessionManager?.saveSnapshot({
          target: this._runtime.agent,
          isLatest: true,
        })
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Model invocation failed, and the previous session state could not be fully restored.',
          { cause: rollbackError }
        )
      }
      throw error
    }
  }

  cancel(): void {
    this._shell.cancel()
    this._permissions?.cancelAll()
    this._runtime.cancel()
  }

  async dispose(): Promise<void> {
    this._shell.dispose()
    clearInterval(this._taskTimer)
    this._taskTimer = undefined
    this._taskListeners.clear()
    this._permissions?.dispose()
    this._runtime.cancel()
    await this._dispose?.()
  }

  private _taskUpdate(): Extract<ChatEvent, { type: 'tasks' }> | undefined {
    const tasks = this._readTasks()
    const signature = JSON.stringify(tasks)
    if (signature === this._taskSignature) {
      return undefined
    }
    this._taskSignature = signature
    return { type: 'tasks', tasks }
  }

  private _readTasks(): ChatTask[] {
    const tasks = [...readTodos(this._runtime.agent), ...readBackgroundTasks(this._runtime.agent)]
    for (const task of tasks) {
      if (task.source !== 'background' || !task.toolUseId) {
        continue
      }
      const terminalStatus =
        task.status === 'completed'
          ? 'completed'
          : task.status === 'failed' || task.status === 'cancelled'
            ? 'failed'
            : undefined
      this._taskActivity?.linkTask(task.id, task.toolUseId, terminalStatus)
    }
    return tasks
  }

  private _publishTaskUpdate(): void {
    const update = this._taskUpdate()
    if (!update) {
      return
    }
    for (const listener of this._taskListeners) {
      listener(update.tasks)
    }
  }
}

function readTodos(agent: Agent): ChatTask[] {
  const value = agent.appState.get('todos')
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isHarnessTodo).map((todo, index) => ({
    id: `todo-${index + 1}`,
    label: sanitizeTerminalText(todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content),
    status: todo.status,
    source: 'todo',
  }))
}

function isHarnessTodo(value: JSONValue): value is HarnessTodo & JSONValue {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return false
  }
  return (
    typeof value.content === 'string' &&
    typeof value.activeForm === 'string' &&
    (value.status === 'pending' || value.status === 'in_progress' || value.status === 'completed')
  )
}

function sanitizeModelOption(model: ChatModelOption): ChatModelOption {
  return {
    ...model,
    id: sanitizeTerminalText(model.id),
    name: sanitizeTerminalText(model.name),
    description: sanitizeTerminalText(model.description),
    ...(model.value !== undefined ? { value: sanitizeTerminalText(model.value) } : {}),
    ...(model.catalog !== undefined ? { catalog: sanitizeTerminalText(model.catalog) } : {}),
  }
}
