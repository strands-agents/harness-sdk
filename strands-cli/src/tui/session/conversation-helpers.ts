import type { ChatSnapshot } from '../chat/controller.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'

export function unquote(value: string): string {
  if (value.length < 2) {
    return value
  }
  const first = value[0]
  const last = value.at(-1)
  if (first === '"' && last === '"') {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  return first === "'" && last === "'" ? value.slice(1, -1) : value
}

export function readConversationValue(value: string | undefined): string | undefined {
  if (!value?.startsWith('conversation:')) {
    return undefined
  }
  return decodeURIComponent(value.slice('conversation:'.length))
}

export function conversationTitle(prompt: string): string {
  const oneLine = sanitizeTerminalText(prompt).replace(/\s+/g, ' ').trim()
  return oneLine.length <= 48 ? oneLine || 'Fork' : `${oneLine.slice(0, 45)}...`
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
