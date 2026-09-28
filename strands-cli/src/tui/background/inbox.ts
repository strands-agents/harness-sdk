import { AsyncLocalStorage } from 'node:async_hooks'

interface BackgroundAgentEndpoint {
  taskId: string
  name: string
  task: string
}

type BackgroundAgentEndpointEvent =
  | {
      type: 'available'
      endpoint: BackgroundAgentEndpoint
    }
  | {
      type: 'unavailable'
      taskId: string
    }

interface BackgroundAgentDescriptor {
  taskId?: string
  name: string
  task: string
}

type BackgroundAgentEndpointListener = (event: BackgroundAgentEndpointEvent) => void

export class BackgroundAgentInbox {
  private readonly _scope = new AsyncLocalStorage<string>()
  private readonly _descriptors = new Map<string, BackgroundAgentDescriptor>()
  private readonly _targets = new Map<string, (prompt: string) => boolean>()
  private readonly _toolUseByTask = new Map<string, string>()
  private readonly _availableTasks = new Set<string>()
  private readonly _settledTools = new Set<string>()
  private readonly _listeners = new Set<BackgroundAgentEndpointListener>()

  run<T>(toolUseId: string, operation: () => Promise<T>): Promise<T> {
    return this._scope.run(toolUseId, operation)
  }

  start(toolUseId: string, name: string, task: string): void {
    this._settledTools.delete(toolUseId)
    const existing = this._descriptors.get(toolUseId)
    this._descriptors.set(toolUseId, {
      ...(existing?.taskId ? { taskId: existing.taskId } : {}),
      name,
      task,
    })
    this._publishAvailable(toolUseId)
  }

  observeAgent(enqueue: (prompt: string) => boolean): (() => void) | undefined {
    const toolUseId = this._scope.getStore()
    if (!toolUseId || this._settledTools.has(toolUseId) || this._targets.has(toolUseId)) {
      return undefined
    }
    this._targets.set(toolUseId, enqueue)
    this._publishAvailable(toolUseId)
    return () => {
      if (this._targets.get(toolUseId) !== enqueue) {
        return
      }
      this._targets.delete(toolUseId)
      const taskId = this._descriptors.get(toolUseId)?.taskId
      if (taskId) {
        this._closeTask(taskId)
      }
    }
  }

  linkTask(taskId: string, toolUseId: string): void {
    if (this._settledTools.has(toolUseId)) {
      return
    }
    const previousToolUseId = this._toolUseByTask.get(taskId)
    if (previousToolUseId && previousToolUseId !== toolUseId) {
      this._closeTask(taskId)
    }
    const descriptor = this._descriptors.get(toolUseId) ?? { name: 'subagent', task: '' }
    this._descriptors.set(toolUseId, { ...descriptor, taskId })
    this._toolUseByTask.set(taskId, toolUseId)
    this._publishAvailable(toolUseId)
  }

  send(taskId: string, prompt: string): boolean {
    const toolUseId = this._toolUseByTask.get(taskId)
    const target = toolUseId ? this._targets.get(toolUseId) : undefined
    return target?.(prompt) ?? false
  }

  complete(toolUseId: string): void {
    this._settledTools.add(toolUseId)
    const taskId = this._descriptors.get(toolUseId)?.taskId
    if (taskId) {
      this._closeTask(taskId)
    }
    this._targets.delete(toolUseId)
    this._descriptors.delete(toolUseId)
  }

  subscribe(listener: BackgroundAgentEndpointListener): () => void {
    this._listeners.add(listener)
    return () => {
      this._listeners.delete(listener)
    }
  }

  dispose(): void {
    for (const taskId of [...this._availableTasks]) {
      this._closeTask(taskId)
    }
    this._targets.clear()
    this._descriptors.clear()
    this._toolUseByTask.clear()
    this._settledTools.clear()
    this._listeners.clear()
  }

  private _publishAvailable(toolUseId: string): void {
    const descriptor = this._descriptors.get(toolUseId)
    const taskId = descriptor?.taskId
    if (!descriptor || !taskId || !this._targets.has(toolUseId) || this._availableTasks.has(taskId)) {
      return
    }
    this._availableTasks.add(taskId)
    this._publish({
      type: 'available',
      endpoint: {
        taskId,
        name: descriptor.name,
        task: descriptor.task,
      },
    })
  }

  private _closeTask(taskId: string): void {
    const toolUseId = this._toolUseByTask.get(taskId)
    this._toolUseByTask.delete(taskId)
    if (toolUseId) {
      const descriptor = this._descriptors.get(toolUseId)
      if (descriptor?.taskId === taskId) {
        this._descriptors.set(toolUseId, { name: descriptor.name, task: descriptor.task })
      }
    }
    if (!this._availableTasks.delete(taskId)) {
      return
    }
    this._publish({ type: 'unavailable', taskId })
  }

  private _publish(event: BackgroundAgentEndpointEvent): void {
    for (const listener of this._listeners) {
      listener(event)
    }
  }
}
