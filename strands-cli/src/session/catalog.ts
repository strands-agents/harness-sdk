import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
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
  directory?: string
  workspace: string
  lastSeenAt: string
}

function sessionRootDirectory(): string {
  return strandsUserPath('state', 'sessions')
}

/**
 * Indexes session directories across workspaces with `external-<hash>.json` references.
 * Existing directories under the catalog root are discovered through their `workspace.json`.
 * `session-roots.json` beside the root is read for existing registrations and is never written.
 */
export class SessionRootCatalog {
  private _roots: SessionRoot[] = []

  private constructor(
    private readonly _root: string,
    private readonly _previousRoot?: string
  ) {}

  static async load(root = sessionRootDirectory(), previousRoot?: string): Promise<SessionRootCatalog> {
    const normalizedRoot = resolve(root)
    const normalizedPreviousRoot = previousRoot === undefined ? undefined : resolve(previousRoot)
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

  /** Records a session directory without creating or changing custom session storage. */
  async register(directory: string, workspace: string): Promise<void> {
    const normalizedDirectory = resolve(directory)
    const central = dirname(normalizedDirectory) === this._root
    const hash = createHash('sha256').update(normalizedDirectory).digest('hex').slice(0, 12)
    const path = central ? join(normalizedDirectory, WORKSPACE_FILE) : join(this._root, `external-${hash}.json`)
    const document: WorkspaceDocument = {
      version: 1,
      ...(!central ? { directory: normalizedDirectory } : {}),
      workspace: resolve(workspace),
      lastSeenAt: new Date().toISOString(),
    }
    await writeWorkspaceDocument(path, document)
    this._replace([...this._roots, { directory: normalizedDirectory, ...document }])
  }

  private _replace(roots: readonly SessionRoot[]): void {
    const byDirectory = new Map<string, SessionRoot>()
    for (const root of roots) {
      const previous = byDirectory.get(root.directory)
      if (!previous || previous.lastSeenAt <= root.lastSeenAt) {
        byDirectory.set(root.directory, root)
      }
    }
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
    entries.map((entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) {
        return readWorkspaceDocument(join(path, WORKSPACE_FILE), path)
      }
      if (entry.isFile() && /^external-[a-f0-9]{12}\.json$/.test(entry.name)) {
        return readWorkspaceDocument(path)
      }
      return undefined
    })
  )
  return roots.filter((root) => root !== undefined)
}

async function readWorkspaceDocument(path: string, centralDirectory?: string): Promise<SessionRoot | undefined> {
  try {
    const document = JSON.parse(await fs.readFile(path, 'utf8')) as unknown
    if (
      !isRecord(document) ||
      document.version !== 1 ||
      typeof document.workspace !== 'string' ||
      typeof document.lastSeenAt !== 'string'
    ) {
      return undefined
    }
    const directory = centralDirectory ?? document.directory
    return typeof directory === 'string'
      ? { directory: resolve(directory), workspace: resolve(document.workspace), lastSeenAt: document.lastSeenAt }
      : undefined
  } catch {
    return undefined
  }
}

async function writeWorkspaceDocument(path: string, document: WorkspaceDocument): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, path)
        break
      } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw error
        }
        await setTimeout(20 * 2 ** attempt)
      }
    }
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
