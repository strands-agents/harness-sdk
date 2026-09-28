import { basename, resolve } from 'node:path'

import type { ChatPanelRow, ChatTask, PondFrog } from '../chat/controller.js'
import type { SessionInfo } from './sessions.js'

// Bounds panel size; the pond scrolls, so this is far more than one screen shows.
const MAX_PADS = 1_000
const RECENT_MS = 7 * 24 * 60 * 60 * 1000
// A session saved this recently is probably open in another terminal. Sessions hold no lock, so this is a guess.
const AWAKE_MS = 5 * 60 * 1000
const LABEL_CHARS = 60

export interface PondConversation {
  id: string
  title: string
  current: boolean
  status: 'approval' | 'working' | 'interrupting' | 'failed' | 'idle' | 'closed'
  workspace: string
  sessionId?: string
  subagents: readonly { taskId: string; task: string; status: ChatTask['status'] }[]
}

interface Pad {
  cove: string
  workspace: string
  recency: number
  rows: { row: ChatPanelRow; frog: PondFrog }[]
}

export function pondConversationValue(conversationId: string, taskId: string): string {
  return `pond-task:${encodeURIComponent(conversationId)}:${encodeURIComponent(taskId)}`
}

export function readPondTaskValue(value: string | undefined): { conversationId: string; taskId: string } | undefined {
  const match = value?.match(/^pond-task:([^:]*):([^:]*)$/)
  return match ? { conversationId: decodeURIComponent(match[1]!), taskId: decodeURIComponent(match[2]!) } : undefined
}

/**
 * Frogs grouped cove by cove, pad by pad: a session frog first, then its subagents. Without a
 * query the pond holds the last week; a query searches every saved session and keeps the pads
 * where any frog, or the workspace, matches it.
 */
export function pondContent(
  conversations: readonly PondConversation[],
  sessions: readonly SessionInfo[],
  now = Date.now(),
  query = ''
): { rows: ChatPanelRow[]; pond: PondFrog[] } {
  const needle = query.trim().toLowerCase()
  const liveSessions = new Set(conversations.flatMap((conversation) => conversation.sessionId ?? []))
  const livePads = conversations.map((conversation) => conversationPad(conversation, now))
  const savedPads = sessions
    // Directories without a saved conversation (such as offloaded tool output) are not sessions.
    .filter((session) => session.messageCount !== undefined && !session.active && !liveSessions.has(session.id))
    .map((session) => sessionPad(session, now))
    .filter((pad) => needle !== '' || now - pad.recency <= RECENT_MS)
    .sort((left, right) => right.recency - left.recency)
  const pads = [...livePads, ...savedPads].filter((pad) => padMatches(pad, needle)).slice(0, MAX_PADS)

  const coveRecency = new Map<string, number>()
  for (const pad of pads) {
    coveRecency.set(pad.workspace, Math.max(coveRecency.get(pad.workspace) ?? 0, pad.recency))
  }
  const ordered = pads.sort(
    (left, right) =>
      coveRecency.get(right.workspace)! - coveRecency.get(left.workspace)! ||
      left.workspace.localeCompare(right.workspace) ||
      right.recency - left.recency
  )
  const entries = ordered.flatMap((pad) => pad.rows)
  return { rows: entries.map((entry) => entry.row), pond: entries.map((entry) => entry.frog) }
}

function padMatches(pad: Pad, needle: string): boolean {
  return (
    needle === '' ||
    pad.cove.toLowerCase().includes(needle) ||
    pad.rows.some(({ row }) => `${row.label} ${row.description}`.toLowerCase().includes(needle))
  )
}

function conversationPad(conversation: PondConversation, now: number): Pad {
  const workspace = resolve(conversation.workspace)
  const cove = basename(workspace) || workspace
  const pad = `conversation:${conversation.id}`
  const state: PondFrog['state'] =
    conversation.status === 'failed' || conversation.status === 'closed'
      ? 'failed'
      : conversation.status === 'idle'
        ? 'awake'
        : 'working'
  return {
    cove,
    workspace,
    // Live conversations outrank saved sessions; the current one leads its cove.
    recency: now + (conversation.current ? 2 : 1),
    rows: [
      {
        row: {
          label: conversation.title,
          description: `${conversation.status} · this terminal · ${cove}`,
          value: `conversation:${encodeURIComponent(conversation.id)}`,
          section: cove,
          ...(conversation.current ? { current: true } : {}),
        },
        frog: { cove, pad, kind: 'session', state, ...(conversation.current ? { current: true } : {}) },
      },
      ...conversation.subagents.map((subagent) => ({
        row: {
          label: truncate(subagent.task || 'subagent'),
          description: `subagent · ${subagent.status} · ${conversation.title}`,
          value: pondConversationValue(conversation.id, subagent.taskId),
          section: cove,
        },
        frog: {
          cove,
          pad,
          kind: 'subagent' as const,
          state: taskState(subagent.status),
        },
      })),
    ],
  }
}

function sessionPad(session: SessionInfo, now: number): Pad {
  const workspace = resolve(session.workspace ?? session.directory ?? '.')
  const cove = basename(workspace) || workspace
  const recency = session.updatedAt ? Date.parse(session.updatedAt) || 0 : 0
  const awake = now - recency <= AWAKE_MS
  const reference = session.reference ?? session.id
  const pad = `session:${reference}`
  const title = session.name ?? (session.preview ? truncate(session.preview) : session.id)
  return {
    cove,
    workspace,
    recency,
    rows: [
      {
        row: {
          label: title,
          description: [
            awake ? 'active in another terminal' : 'saved',
            session.messageCount === undefined ? undefined : `${session.messageCount} messages`,
            session.updatedAt ? relativeTime(recency, now) : undefined,
            cove,
          ]
            .filter(Boolean)
            .join(' · '),
          value: reference,
          section: cove,
        },
        frog: { cove, pad, kind: 'session', state: awake ? 'awake' : 'asleep' },
      },
      ...(session.subagents ?? []).map((subagent) => ({
        row: {
          label: truncate(subagent.task || 'subagent'),
          description: `subagent${subagent.agentType ? ` (${subagent.agentType})` : ''} · ${subagent.status} · opens ${title}`,
          value: reference,
          section: cove,
        },
        frog: {
          cove,
          pad,
          kind: 'subagent' as const,
          state: subagent.status === 'failed' ? ('failed' as const) : ('asleep' as const),
        },
      })),
    ],
  }
}

function taskState(status: ChatTask['status']): PondFrog['state'] {
  if (status === 'failed' || status === 'cancelled') {
    return 'failed'
  }
  return status === 'completed' ? 'asleep' : 'working'
}

function truncate(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= LABEL_CHARS ? line : `${line.slice(0, LABEL_CHARS - 3)}...`
}

function relativeTime(then: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}
