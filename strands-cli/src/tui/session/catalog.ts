import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { userDirectory } from '../config.js'
import { strandsUserPath } from '../paths.js'
import { isRecord } from '../values.js'

const WORKSPACE_FILE = 'workspace.json'

interface SessionRoot {
  directory: string
  workspace: string
  lastSeenAt: string
}

interface WorkspaceDocument {
  version: 1
  workspace: string
  lastSeenAt: string
}

export function sessionRootDirectory(): string {
  return strandsUserPath('sessions')
}

/** The built-in agent's session directory for a workspace: `<root>/<workspace name>-<path hash>`. */
export function workspaceSessionDirectory(workspace: string, root = sessionRootDirectory()): string {
  const normalized = resolve(workspace)
  const name = (basename(normalized).replace(/[^A-Za-z0-9_.-]/g, '-') || 'root').slice(0, 64)
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  return join(resolve(root), `${name}-${hash}`)
}

/**
 * Session directories across workspaces: each workspace directory under the central root carries a
 * `workspace.json` naming its workspace. `session-roots.json` beside the root is read for workspaces
 * that keep sessions in their own `.agent/sessions` and is never written.
 */
export class SessionRootCatalog {
  private _roots: SessionRoot[] = []

  private constructor(
    private readonly _root: string,
    private readonly _previousRoot?: string
  ) {}

  static async load(root = sessionRootDirectory(), previousRoot?: string): Promise<SessionRootCatalog> {
    const normalizedRoot = resolve(root)
    const normalizedPreviousRoot =
      previousRoot === undefined && normalizedRoot === resolve(sessionRootDirectory())
        ? resolve(userDirectory('sessions'))
        : previousRoot === undefined
          ? undefined
          : resolve(previousRoot)
    const catalog = new SessionRootCatalog(normalizedRoot, normalizedPreviousRoot)
    await catalog.refresh()
    return catalog
  }

  roots(): readonly SessionRoot[] {
    return this._roots
  }

  async refresh(): Promise<void> {
    const sources = [
      readLegacyRoots(join(dirname(this._root), 'session-roots.json')),
      readCentralRoots(this._root),
      ...(this._previousRoot
        ? [
            readLegacyRoots(join(dirname(this._previousRoot), 'session-roots.json')),
            readCentralRoots(this._previousRoot),
          ]
        : []),
    ]
    this._replace((await Promise.all(sources)).flat())
  }

  /** Records the workspace of a directory under the central root; other directories are left untouched. */
  async register(directory: string, workspace: string): Promise<void> {
    const normalizedDirectory = resolve(directory)
    if (dirname(normalizedDirectory) !== this._root) {
      return
    }
    const document: WorkspaceDocument = {
      version: 1,
      workspace: resolve(workspace),
      lastSeenAt: new Date().toISOString(),
    }
    await writeWorkspaceDocument(normalizedDirectory, document)
    this._replace([...this._roots, { directory: normalizedDirectory, ...document }])
  }

  private _replace(roots: readonly SessionRoot[]): void {
    const byDirectory = new Map(roots.map((root) => [root.directory, root]))
    this._roots = [...byDirectory.values()].sort(
      (left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt) || left.directory.localeCompare(right.directory)
    )
  }
}

async function readCentralRoots(root: string): Promise<SessionRoot[]> {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const roots = await Promise.all(
    entries.filter((entry) => entry.isDirectory()).map((entry) => readWorkspaceDocument(join(root, entry.name)))
  )
  return roots.filter((root) => root !== undefined)
}

async function readWorkspaceDocument(directory: string): Promise<SessionRoot | undefined> {
  try {
    const document = JSON.parse(await fs.readFile(join(directory, WORKSPACE_FILE), 'utf8')) as unknown
    if (
      !isRecord(document) ||
      document.version !== 1 ||
      typeof document.workspace !== 'string' ||
      typeof document.lastSeenAt !== 'string'
    ) {
      return undefined
    }
    return { directory, workspace: resolve(document.workspace), lastSeenAt: document.lastSeenAt }
  } catch {
    return undefined
  }
}

async function writeWorkspaceDocument(directory: string, document: WorkspaceDocument): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, WORKSPACE_FILE)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(temporary, path)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function readLegacyRoots(path: string): Promise<SessionRoot[]> {
  let document: unknown
  try {
    document = JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    return []
  }
  if (!isRecord(document) || document.version !== 1 || !Array.isArray(document.roots)) {
    return []
  }
  return document.roots.flatMap((root): SessionRoot[] =>
    isRecord(root) &&
    typeof root.directory === 'string' &&
    typeof root.workspace === 'string' &&
    typeof root.lastSeenAt === 'string'
      ? [{ directory: resolve(root.directory), workspace: resolve(root.workspace), lastSeenAt: root.lastSeenAt }]
      : []
  )
}
