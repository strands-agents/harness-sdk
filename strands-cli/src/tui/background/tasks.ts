import type { Agent } from '@strands-agents/sdk'

import type { ChatTask } from '../chat/controller.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'

interface StoredBackgroundTask {
  taskId: string
  toolUseId: string
  toolName: string
  status: 'queued' | 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'
  result?: { content?: unknown }
  error?: { message?: string }
  lastUpdatedAt?: string
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
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const clean = sanitizeTerminalText(value).trim()
  return clean || undefined
}
