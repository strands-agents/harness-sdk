import {
  type Agent,
  type AgentStreamEvent,
  type AgentResult,
  type Tool,
  type ToolContext,
  type ToolResultContent,
  type ToolStreamGenerator,
} from '@strands-agents/sdk'
import type { HarnessAgentOptions } from '@strands-agents/harness'
import { PassThrough } from 'node:stream'
import { sanitizeTerminalText, sanitizeTerminalValue } from '../terminal/text.js'
import { isRecord } from '../values.js'
import { type BackgroundAgentInbox } from './messaging.js'
import { type ChatEntry, type ChatTask, type ChatEvent, type ChatRunResult } from './types.js'
import { projectAgentEvent as projectChatEvent, projectAgentResult } from './events.js'

type BackgroundTextEntry = Omit<Extract<ChatEntry, { type: 'reasoning' | 'assistant' }>, 'id'>

interface BackgroundToolEntry extends Omit<Extract<ChatEntry, { type: 'tool' }>, 'id' | 'background' | 'result'> {
  status: Exclude<Extract<ChatEntry, { type: 'tool' }>['status'], 'cancelled'>
  result?: string
}

type BackgroundAgentActivityEntry = BackgroundTextEntry | BackgroundToolEntry

export interface BackgroundAgentActivity {
  toolUseId: string
  taskId?: string
  name: string
  task: string
  status: 'working' | 'completed' | 'failed'
  entries: readonly BackgroundAgentActivityEntry[]
  error?: string
}

interface MutableActivity extends Omit<BackgroundAgentActivity, 'entries'> {
  entries: BackgroundAgentActivityEntry[]
}

export class BackgroundAgentActivityStore {
  private readonly _activities = new Map<string, MutableActivity>()
  private readonly _taskTools = new Map<string, string>()
  private readonly _toolTasks = new Map<string, string>()
  private readonly _taskListeners = new Map<string, Set<(activity: BackgroundAgentActivity | undefined) => void>>()
  private readonly _inbox: BackgroundAgentInbox | undefined
  private readonly _streams = new Map<string, PassThrough>()

  constructor(inbox?: BackgroundAgentInbox) {
    this._inbox = inbox
  }

  readonly onStart = (event: { name: string; task: string; toolUseId: string }): void => {
    const toolUseId = sanitizeTerminalText(event.toolUseId)
    const taskId = this._activities.get(toolUseId)?.taskId ?? this._toolTasks.get(toolUseId)
    this._activities.set(toolUseId, {
      toolUseId,
      ...(taskId ? { taskId } : {}),
      name: sanitizeTerminalText(event.name),
      task: sanitizeTerminalText(event.task),
      status: 'working',
      entries: [],
    })
    this._inbox?.start(toolUseId, sanitizeTerminalText(event.name), sanitizeTerminalText(event.task))
    this._notifyTool(toolUseId)
  }

  readonly onEvent = (event: { toolUseId: string; event: AgentStreamEvent }): void => {
    const toolUseId = sanitizeTerminalText(event.toolUseId)
    const activity = this._activities.get(toolUseId)
    if (!activity) {
      return
    }
    projectAgentEvent(activity, event.event)
    this._streams.get(toolUseId)?.write(event.event)
    this._notifyTool(toolUseId)
  }

  readonly onComplete = (event: { toolUseId: string }): void => {
    const toolUseId = sanitizeTerminalText(event.toolUseId)
    this._settle(toolUseId, 'completed')
    this._streams.get(toolUseId)?.end()
    this._inbox?.complete(toolUseId)
  }

  readonly onError = (event: { toolUseId: string; error: Error }): void => {
    const toolUseId = sanitizeTerminalText(event.toolUseId)
    this._settle(toolUseId, 'failed', event.error.message)
    this._streams.get(toolUseId)?.destroy(event.error)
    this._inbox?.complete(toolUseId)
  }

  linkTask(taskId: string, toolUseId: string, status?: BackgroundAgentActivity['status']): void {
    taskId = sanitizeTerminalText(taskId)
    toolUseId = sanitizeTerminalText(toolUseId)
    const previousTool = this._taskTools.get(taskId)
    if (previousTool && previousTool !== toolUseId) {
      this._toolTasks.delete(previousTool)
    }
    const previousTask = this._toolTasks.get(toolUseId)
    if (previousTask && previousTask !== taskId) {
      this._taskTools.delete(previousTask)
    }
    this._taskTools.set(taskId, toolUseId)
    this._toolTasks.set(toolUseId, taskId)
    this._inbox?.linkTask(taskId, toolUseId)
    const activity = this._activities.get(toolUseId)
    if (activity) {
      activity.taskId = taskId
      if (status) {
        activity.status = status
      }
    }
    this._notifyTask(taskId)
  }

  get(taskId: string): BackgroundAgentActivity | undefined {
    taskId = sanitizeTerminalText(taskId)
    const toolUseId = this._taskTools.get(taskId)
    const activity = toolUseId ? this._activities.get(toolUseId) : undefined
    return activity ? cloneActivity(activity) : undefined
  }

  retainTasks(tasks: readonly ChatTask[]): void {
    const tools = new Set(tasks.flatMap((task) => (task.toolUseId ? [task.toolUseId] : [])))
    for (const [toolUseId, activity] of this._activities) {
      // A subagent can start before its first task update reaches the CLI.
      if (!tools.has(toolUseId) && activity.status !== 'working') {
        this._activities.delete(toolUseId)
      }
    }
    for (const [toolUseId, taskId] of this._toolTasks) {
      if (!tools.has(toolUseId)) {
        this._toolTasks.delete(toolUseId)
        this._taskTools.delete(taskId)
        this._notifyTask(taskId)
      }
    }
  }

  subscribe(taskId: string, listener: (activity: BackgroundAgentActivity | undefined) => void): () => void {
    taskId = sanitizeTerminalText(taskId)
    const listeners = this._taskListeners.get(taskId) ?? new Set()
    listeners.add(listener)
    this._taskListeners.set(taskId, listeners)
    listener(this.get(taskId))
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this._taskListeners.delete(taskId)
      }
    }
  }

  runAgentScope<T>(toolUseId: string, operation: () => Promise<T>): Promise<T> {
    return this._inbox?.run(toolUseId, operation) ?? operation()
  }

  async *follow(toolUseId: string, agent: Agent): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
    const stream = new PassThrough({ objectMode: true })
    this._streams.set(toolUseId, stream)
    let result: AgentResult | undefined
    try {
      for await (const event of stream as AsyncIterable<AgentStreamEvent>) {
        if ('agent' in event && event.agent !== agent) continue
        if (event.type === 'agentResultEvent') result = event.result
        yield* projectChatEvent(event)
      }
      if (!result) throw new Error('Subagent ended without a result.')
      return projectAgentResult(agent, result)
    } finally {
      this._streams.delete(toolUseId)
      stream.destroy()
    }
  }

  private _settle(toolUseId: string, status: 'completed' | 'failed', error?: string): void {
    const activity = this._activities.get(toolUseId)
    if (!activity) {
      return
    }
    activity.status = status
    if (error) {
      activity.error = sanitizeTerminalText(error)
    }
    this._notifyTool(toolUseId)
  }

  private _notifyTool(toolUseId: string): void {
    const taskId = this._activities.get(toolUseId)?.taskId ?? this._toolTasks.get(toolUseId)
    if (taskId) {
      this._notifyTask(taskId)
    }
  }

  private _notifyTask(taskId: string): void {
    const listeners = this._taskListeners.get(taskId)
    if (!listeners?.size) {
      return
    }
    const activity = this.get(taskId)
    for (const listener of listeners) {
      listener(activity)
    }
  }
}

export function observeSubagentActivity(subagentTool: Tool, observer: BackgroundAgentActivityStore): () => void {
  if (subagentTool.name !== 'subagent') {
    throw new TypeError('observeSubagentActivity requires the subagent tool')
  }

  const originalStream = subagentTool.stream
  const wrappedStream = async function* (this: Tool, context: ToolContext): ToolStreamGenerator {
    const toolUseId = context.toolUse.toolUseId
    const input = context.toolUse.input
    const task = isRecord(input) && typeof input.task === 'string' ? input.task : ''
    observer.onStart({ name: 'subagent', task, toolUseId })

    try {
      const stream = originalStream.call(this, context)
      let next = await observer.runAgentScope(toolUseId, () => stream.next())
      while (!next.done) {
        const data = next.value.data
        if (data !== null && typeof data === 'object' && 'type' in data && typeof data.type === 'string') {
          observer.onEvent({ toolUseId, event: data as AgentStreamEvent })
        }
        yield next.value
        next = await observer.runAgentScope(toolUseId, () => stream.next())
      }

      if (next.value.status === 'success') {
        observer.onComplete({ toolUseId })
      } else {
        observer.onError({
          toolUseId,
          error: next.value.error ?? new Error(formatToolResult(next.value.content) || 'Subagent failed.'),
        })
      }
      return next.value
    } catch (error) {
      observer.onError({
        toolUseId,
        error: error instanceof Error ? error : new Error(String(error)),
      })
      throw error
    }
  }

  subagentTool.stream = wrappedStream
  return () => {
    if (subagentTool.stream === wrappedStream) {
      subagentTool.stream = originalStream
    }
  }
}

function projectAgentEvent(activity: MutableActivity, event: AgentStreamEvent): void {
  if (event.type === 'modelStreamUpdateEvent') {
    const inner = event.event
    if (inner.type !== 'modelContentBlockDeltaEvent') {
      return
    }
    if (inner.delta.type === 'reasoningContentDelta' && inner.delta.text) {
      appendText(activity, 'reasoning', inner.delta.text)
    } else if (inner.delta.type === 'textDelta' && inner.delta.text) {
      appendText(activity, 'assistant', inner.delta.text)
    }
    return
  }

  if (event.type === 'beforeToolCallEvent') {
    const toolUseId = sanitizeTerminalText(event.toolUse.toolUseId)
    const existing = findTool(activity, toolUseId)
    if (existing) {
      existing.name = sanitizeTerminalText(event.toolUse.name)
      existing.input = sanitizeTerminalValue(event.toolUse.input)
      existing.status = 'running'
      delete existing.result
      delete existing.error
    } else {
      activity.entries.push({
        type: 'tool',
        toolUseId,
        name: sanitizeTerminalText(event.toolUse.name),
        input: sanitizeTerminalValue(event.toolUse.input),
        status: 'running',
      })
    }
    return
  }

  if (event.type === 'toolResultEvent' || event.type === 'afterToolCallEvent') {
    settleTool(
      activity,
      sanitizeTerminalText(event.type === 'toolResultEvent' ? event.result.toolUseId : event.toolUse.toolUseId),
      event.result.status,
      event.result.content,
      event.result.error?.message
    )
  }
}

function appendText(activity: MutableActivity, type: BackgroundTextEntry['type'], value: string): void {
  const text = sanitizeTerminalText(value)
  if (!text) {
    return
  }
  const previous = activity.entries.at(-1)
  if (previous?.type === type) {
    previous.text += text
  } else {
    activity.entries.push({ type, text })
  }
}

function settleTool(
  activity: MutableActivity,
  toolUseId: string,
  status: 'success' | 'error',
  content: readonly ToolResultContent[],
  error?: string
): void {
  let tool = findTool(activity, toolUseId)
  if (!tool) {
    tool = {
      type: 'tool',
      toolUseId,
      name: 'tool',
      input: {},
      status: 'running',
    }
    activity.entries.push(tool)
  }
  tool.status = status
  const result = formatToolResult(content)
  if (result) {
    tool.result = result
  }
  if (error) {
    tool.error = sanitizeTerminalText(error)
  }
}

function findTool(activity: MutableActivity, toolUseId: string): BackgroundToolEntry | undefined {
  return activity.entries.find(
    (entry): entry is BackgroundToolEntry => entry.type === 'tool' && entry.toolUseId === toolUseId
  )
}

function formatToolResult(content: readonly ToolResultContent[]): string {
  return sanitizeTerminalText(
    content
      .map((block) => {
        if (block.type === 'textBlock') {
          return block.text
        }
        if (block.type === 'jsonBlock') {
          return JSON.stringify(block.json, null, 2)
        }
        if (block.type === 'imageBlock') {
          return `[image: ${block.format}]`
        }
        if (block.type === 'videoBlock') {
          return `[video: ${block.format}]`
        }
        return `[document: ${block.name}.${block.format}]`
      })
      .join('\n')
  )
}

function cloneActivity(activity: MutableActivity): BackgroundAgentActivity {
  return {
    toolUseId: activity.toolUseId,
    ...(activity.taskId ? { taskId: activity.taskId } : {}),
    name: activity.name,
    task: activity.task,
    status: activity.status,
    entries: activity.entries.map((entry) =>
      entry.type === 'tool'
        ? {
            ...entry,
            input: sanitizeTerminalValue(entry.input),
          }
        : { ...entry }
    ),
    ...(activity.error ? { error: activity.error } : {}),
  }
}

interface StoredBackgroundTask {
  taskId: string
  toolUseId: string
  toolName: string
  status: 'queued' | 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'
  result?: { content?: unknown }
  error?: { message?: string }
  lastUpdatedAt?: string
}

export function interactiveBackgroundTasks(
  options: HarnessAgentOptions
): Exclude<HarnessAgentOptions['backgroundTasks'], undefined> {
  const configured = options.backgroundTasks
  if (configured === false) {
    return false
  }
  return { ...(configured === true ? {} : configured), waitForCompletion: false }
}

export function hasReadyBackgroundResults(agent: Agent): boolean {
  return readBackgroundTasks(agent).some((task) => task.deliveryState === 'ready')
}

export function readBackgroundTasks(agent: Agent): ChatTask[] {
  const state = agent.appState.get('strands.backgroundTasks')
  if (!Array.isArray(state)) {
    return []
  }

  return state
    .flatMap((stored) => {
      const record = readStoredBackgroundTask(stored)
      if (!record) {
        return []
      }
      const terminal = record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled'
      return [
        {
          id: record.taskId,
          label: record.toolName.length <= 140 ? record.toolName : `${record.toolName.slice(0, 137)}...`,
          status: record.status === 'input_required' ? ('paused' as const) : record.status,
          source: 'background' as const,
          detail: `${record.toolName} | ${record.taskId}`,
          toolUseId: record.toolUseId,
          deliveryState: terminal ? ('ready' as const) : ('pending' as const),
          ...(record.result ? { result: formatStoredResult(record.result) } : {}),
          ...(record.error?.message ? { error: sanitizeTerminalText(record.error.message) } : {}),
          updatedAt: record.lastUpdatedAt,
        },
      ]
    })
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
    .map(({ updatedAt: _updatedAt, ...task }) => task)
}

function readStoredBackgroundTask(value: unknown): StoredBackgroundTask | undefined {
  const record = asRecord(value)
  const taskId = stringValue(record?.taskId)
  const toolUseId = stringValue(record?.toolUseId)
  const toolName = stringValue(record?.toolName)
  const status = stringValue(record?.status)
  const result = asRecord(record?.result)
  const error = asRecord(record?.error)
  if (!taskId || !toolUseId || !toolName || !isBackgroundTaskStatus(status)) {
    return undefined
  }
  return {
    taskId,
    toolUseId,
    toolName,
    status,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    ...(typeof record?.lastUpdatedAt === 'string' ? { lastUpdatedAt: record.lastUpdatedAt } : {}),
  }
}

function formatStoredResult(value: { content?: unknown }): string {
  const content = value.content
  if (!Array.isArray(content)) {
    return sanitizeTerminalText(JSON.stringify(value))
  }
  return sanitizeTerminalText(
    content
      .map((block) => {
        const record = asRecord(block)
        if (!record) {
          return String(block)
        }
        if (typeof record.text === 'string') {
          return record.text
        }
        if (record.json !== undefined) {
          return JSON.stringify(record.json, null, 2)
        }
        if (record.type === 'imageBlock' || record.image !== undefined) {
          return '[image]'
        }
        if (record.type === 'videoBlock' || record.video !== undefined) {
          return '[video]'
        }
        if (record.type === 'documentBlock' || record.document !== undefined) {
          return '[document]'
        }
        return JSON.stringify(record)
      })
      .join('\n')
  )
}

function isBackgroundTaskStatus(value: string | undefined): value is StoredBackgroundTask['status'] {
  return ['queued', 'working', 'input_required', 'completed', 'failed', 'cancelled'].includes(value ?? '')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const clean = sanitizeTerminalText(value).trim()
  return clean || undefined
}
