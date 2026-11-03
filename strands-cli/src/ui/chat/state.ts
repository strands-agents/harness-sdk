import { graphemes, sanitizeTerminalText } from '../../terminal/text.js'
import { type ChatRuntimeInfo } from './types.js'
import { type ChatTask } from '../../agent/types.js'
import { type ChatSnapshot } from './controller.js'

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
    ...(runtime.sessionName !== undefined ? { sessionName: sanitizeTerminalText(runtime.sessionName) } : {}),
    cwd: runtime.cwd,
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

export function isConfigurationTool(name: string): boolean {
  return name.replaceAll('-', '_').toLowerCase() === 'strands_config'
}

export function readConversationValue(value: string | undefined): string | undefined {
  if (!value?.startsWith('conversation:')) {
    return undefined
  }
  return decodeURIComponent(value.slice('conversation:'.length))
}

export function conversationTitle(prompt: string): string {
  const oneLine = sanitizeTerminalText(prompt).replace(/\s+/g, ' ').trim()
  const characters = graphemes(oneLine)
  return characters.length <= 48 ? oneLine || 'Fork' : `${characters.slice(0, 45).join('')}...`
}

export function conversationStatus(snapshot: ChatSnapshot): {
  label: 'approval' | 'working' | 'interrupting' | 'failed' | 'idle' | 'closed'
  tone: 'success' | 'warning' | 'danger'
} {
  if (snapshot.panel?.kind === 'permission') {
    return { label: 'approval', tone: 'warning' }
  }
  if (snapshot.status === 'running') {
    return { label: 'working', tone: 'success' }
  }
  if (snapshot.status === 'interrupting') {
    return { label: 'interrupting', tone: 'warning' }
  }
  if (snapshot.status === 'closed') {
    return { label: 'closed', tone: 'danger' }
  }
  if (snapshot.completedTurns.at(-1)?.status === 'error') {
    return { label: 'failed', tone: 'danger' }
  }
  return { label: 'idle', tone: 'success' }
}
