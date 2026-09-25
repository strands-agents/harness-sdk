import { sanitizeTerminalText } from '../terminal/sanitize.js'
import type { ChatRuntimeInfo, ChatTask } from './types.js'

export function readTaskValue(value: string): string | undefined {
  if (!value.startsWith('task:')) {
    return undefined
  }
  try {
    return decodeURIComponent(value.slice('task:'.length))
  } catch {
    return undefined
  }
}

export function isActiveTask(status: ChatTask['status']): boolean {
  return ['pending', 'queued', 'in_progress', 'working', 'paused'].includes(status)
}

export function cloneRuntime(runtime: ChatRuntimeInfo): ChatRuntimeInfo {
  return {
    agent: sanitizeTerminalText(runtime.agent),
    version: sanitizeTerminalText(runtime.version),
    backendId: sanitizeTerminalText(runtime.backendId),
    protocol: runtime.protocol,
    model: sanitizeTerminalText(runtime.model),
    ...(runtime.effort !== undefined ? { effort: sanitizeTerminalText(runtime.effort) } : {}),
    session: sanitizeTerminalText(runtime.session),
    cwd: sanitizeTerminalText(runtime.cwd),
    tools: runtime.tools.map((tool) => ({
      name: sanitizeTerminalText(tool.name),
      description: sanitizeTerminalText(tool.description),
    })),
    ...(runtime.configuration
      ? {
          configuration: runtime.configuration.map((item) => ({
            label: sanitizeTerminalText(item.label),
            value: sanitizeTerminalText(item.value),
          })),
        }
      : {}),
  }
}

export function cloneTask(task: ChatTask): ChatTask {
  return {
    ...task,
    id: sanitizeTerminalText(task.id),
    label: sanitizeTerminalText(task.label),
    ...(task.toolUseId ? { toolUseId: sanitizeTerminalText(task.toolUseId) } : {}),
    ...(task.detail ? { detail: sanitizeTerminalText(task.detail) } : {}),
    ...(task.result ? { result: sanitizeTerminalText(task.result) } : {}),
    ...(task.error ? { error: sanitizeTerminalText(task.error) } : {}),
  }
}

export function readyBackgroundGeneration(tasks: readonly ChatTask[]): string | undefined {
  const ready = tasks
    .filter((task) => task.source === 'background' && task.deliveryState === 'ready')
    .map((task) => `${task.id}\u0000${task.status}\u0000${task.result ?? ''}\u0000${task.error ?? ''}`)
    .sort()
  return ready.length > 0 ? ready.join('\u0001') : undefined
}

export function isUnresolvedBackgroundTask(task: ChatTask): boolean {
  return (
    task.source === 'background' &&
    (isActiveTask(task.status) || task.deliveryState === 'pending' || task.deliveryState === 'ready')
  )
}
