import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { errorMessage, sanitizeTerminalText } from '../terminal/sanitize.js'
import type { SessionRootCatalog } from './catalog.js'

export { SessionRootCatalog } from './catalog.js'

const SESSION_REFERENCE_PREFIX = 'strands-session:'
const SESSION_METADATA_FILE = 'cli-session.json'
export const DEFAULT_SESSION_DIR = './.agent/sessions'

interface SessionInfo extends Partial<SessionMetadata> {
  id: string
  name?: string
  reference?: string
  active: boolean
  directory?: string
  workspace?: string
}

export interface SessionTarget {
  sessionId: string
  name?: string
  sessionDirectory: string
  workspace: string
  active: boolean
}

export interface ChatSessionRuntime {
  readonly current: string | undefined
  readonly directory: string
  list(): Promise<readonly SessionInfo[]>
  resolve(reference: string): Promise<SessionTarget>
  renameCurrent?(name: string): Promise<{ sessionId: string; name: string }>
}

interface SessionMetadata {
  messageCount: number
  updatedAt: string
  preview?: string
}

interface SessionNameDocument {
  version: 1
  name: string
}

export class FileSessionRuntime implements ChatSessionRuntime {
  private readonly _directory: string
  private readonly _workspace: string
  private readonly _catalog: SessionRootCatalog | undefined
  readonly directory: string

  constructor(
    private readonly _host: {
      readonly sessionId: string | undefined
      readonly sessionDirectory: string
    },
    directory: string,
    options: { catalog?: SessionRootCatalog; workspace?: string } = {}
  ) {
    this._directory = resolve(directory)
    this._workspace = resolve(options.workspace ?? dirname(dirname(this._directory)))
    this._catalog = options.catalog
    this.directory = options.catalog ? 'all registered workspaces' : sanitizeTerminalText(directory)
  }

  get current(): string | undefined {
    return this._host.sessionId === undefined ? undefined : sanitizeTerminalText(this._host.sessionId)
  }

  async list(): Promise<readonly SessionInfo[]> {
    await this._catalog?.refresh()
    const roots = new Map((this._catalog?.roots() ?? []).map((root) => [root.directory, root]))
    roots.set(this._directory, {
      directory: this._directory,
      workspace: this._workspace,
      lastSeenAt: roots.get(this._directory)?.lastSeenAt ?? '',
    })
    const currentDirectory = resolve(this._host.sessionDirectory)
    const results = await Promise.allSettled(
      [...roots.values()].map(async (root) => {
        const current = root.directory === currentDirectory ? this.current : undefined
        const listed = await listFileSessions(root.directory, current)
        return listed.map((session) => ({
          ...session,
          reference: root.directory === this._directory ? session.id : sessionReference(root.directory, session.id),
          directory: sanitizeTerminalText(root.directory),
          workspace: sanitizeTerminalText(root.workspace),
        }))
      })
    )
    const sessions = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    return sessions.sort((left, right) => {
      if (left.active !== right.active) {
        return left.active ? -1 : 1
      }
      const byUpdated = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
      return byUpdated || left.id.localeCompare(right.id) || (left.directory ?? '').localeCompare(right.directory ?? '')
    })
  }

  async resolve(reference: string): Promise<SessionTarget> {
    await this._catalog?.refresh()
    const selected = parseSessionReference(reference) ?? {
      directory: this._directory,
      id: sanitizeSessionId(reference),
    }
    const root =
      this._catalog?.roots().find((candidate) => candidate.directory === selected.directory) ??
      (selected.directory === this._directory
        ? { directory: this._directory, workspace: this._workspace, lastSeenAt: '' }
        : undefined)
    if (!root) {
      throw new Error(`The workspace for session ${JSON.stringify(selected.id)} is no longer registered.`)
    }
    const name = await readSessionName(join(root.directory, selected.id))
    return {
      sessionId: selected.id,
      ...(name ? { name } : {}),
      sessionDirectory: selected.directory,
      workspace: root.workspace,
      active:
        selected.id === this._host.sessionId && resolve(selected.directory) === resolve(this._host.sessionDirectory),
    }
  }

  async renameCurrent(name: string): Promise<{ sessionId: string; name: string }> {
    if (!this._host.sessionId) {
      throw new Error('The current session is not file-backed.')
    }
    const sessionId = sanitizeSessionId(this._host.sessionId)
    const normalizedName = normalizeSessionText(name)
    if (!normalizedName) {
      throw new Error('Session names cannot be empty.')
    }
    await writeSessionName(join(resolve(this._host.sessionDirectory), sessionId), normalizedName)
    return {
      sessionId: sanitizeTerminalText(sessionId),
      name: normalizedName,
    }
  }
}

async function listFileSessions(directory: string, current?: string): Promise<SessionInfo[]> {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) {
      return current ? [{ id: sanitizeTerminalText(current), active: true }] : []
    }
    throw error
  }

  const sessions = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readSession(directory, entry.name, entry.name === current))
    )
  ).filter((session) => session !== undefined)

  if (current && !sessions.some((session) => session.id === current)) {
    sessions.push({ id: sanitizeTerminalText(current), active: true })
  }

  return sessions
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.trim().replace(/[^A-Za-z0-9_.-]/g, '-') || 'default'
}

function sessionReference(directory: string, id: string): string {
  return `${SESSION_REFERENCE_PREFIX}${Buffer.from(JSON.stringify([directory, id])).toString('base64url')}`
}

function parseSessionReference(reference: string): { directory: string; id: string } | undefined {
  if (!reference.startsWith(SESSION_REFERENCE_PREFIX)) {
    return undefined
  }
  try {
    const encoded = reference.slice(SESSION_REFERENCE_PREFIX.length)
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string'
    ) {
      throw new Error('expected [directory, sessionId]')
    }
    return {
      directory: resolve(parsed[0]),
      id: sanitizeSessionId(parsed[1]),
    }
  } catch (error) {
    throw new Error(`Invalid saved-session reference: ${errorMessage(error)}`, { cause: error })
  }
}

async function readSession(directory: string, id: string, active: boolean): Promise<SessionInfo | undefined> {
  const path = join(directory, id)
  let updatedAt: string | undefined
  try {
    updatedAt = (await fs.stat(path)).mtime.toISOString()
  } catch (error) {
    if (isMissing(error)) {
      return undefined
    }
  }

  const [metadata, name] = await Promise.all([readSessionMetadata(path), readSessionName(path)])
  return {
    id: sanitizeTerminalText(id),
    ...(name ? { name } : {}),
    active,
    ...(metadata ?? (updatedAt ? { updatedAt } : {})),
  }
}

async function readSessionName(sessionDirectory: string): Promise<string | undefined> {
  try {
    const document = JSON.parse(await fs.readFile(join(sessionDirectory, SESSION_METADATA_FILE), 'utf8')) as unknown
    if (!isRecord(document) || document.version !== 1 || typeof document.name !== 'string') {
      return undefined
    }
    return normalizeSessionText(document.name) || undefined
  } catch {
    return undefined
  }
}

async function writeSessionName(sessionDirectory: string, name: string): Promise<void> {
  await fs.mkdir(sessionDirectory, { recursive: true })
  const document: SessionNameDocument = { version: 1, name }
  await fs.writeFile(join(sessionDirectory, SESSION_METADATA_FILE), `${JSON.stringify(document, null, 2)}\n`, {
    mode: 0o600,
  })
}

function normalizeSessionText(text: string): string {
  return sanitizeTerminalText(text).replace(/\s+/g, ' ').trim()
}

async function readSessionMetadata(sessionDirectory: string): Promise<SessionMetadata | undefined> {
  const scopeDirectory = join(sessionDirectory, 'scopes', 'agent')
  let agents
  try {
    agents = await fs.readdir(scopeDirectory, { withFileTypes: true })
  } catch {
    return undefined
  }

  const candidates = (
    await Promise.all(
      agents
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(scopeDirectory, entry.name, 'snapshots', 'snapshot_latest.json')
          try {
            return { path, stat: await fs.stat(path) }
          } catch {
            return undefined
          }
        })
    )
  )
    .filter((candidate) => candidate !== undefined)
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)

  for (const candidate of candidates) {
    try {
      const snapshot = JSON.parse(await fs.readFile(candidate.path, 'utf8')) as unknown
      if (!isRecord(snapshot) || !isRecord(snapshot.data) || !Array.isArray(snapshot.data.messages)) {
        continue
      }
      const messages: unknown[] = snapshot.data.messages
      const preview = messagePreview(messages)
      return {
        messageCount: messages.length,
        updatedAt: candidate.stat.mtime.toISOString(),
        ...(preview ? { preview } : {}),
      }
    } catch {
      continue
    }
  }
  return undefined
}

export async function hasSavedSession(sessionDirectory: string, sessionId: string): Promise<boolean> {
  return (await readSessionMetadata(join(resolve(sessionDirectory), sessionId))) !== undefined
}

function messagePreview(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.content)) {
      continue
    }
    const text = message.content
      .flatMap((block) => (isRecord(block) && typeof block.text === 'string' ? [block.text] : []))
      .join(' ')
    const normalized = normalizeSessionText(text)
    if (normalized) {
      return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

export function sessionWorkspaceLabel(workspace: string | undefined, directory: string | undefined): string {
  if (workspace) {
    return basename(workspace) || workspace
  }
  return directory ?? 'unknown workspace'
}
