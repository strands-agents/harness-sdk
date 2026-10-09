import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { userDirectory } from '../config.js'

const CATALOG_LOCK_TIMEOUT_MS = 5_000
const CATALOG_LOCK_STALE_MS = 30_000

interface SessionRoot {
  directory: string
  workspace: string
  lastSeenAt: string
}

interface SessionRootDocument {
  version: 1
  roots: SessionRoot[]
}

export class SessionRootCatalog {
  private readonly _roots = new Map<string, SessionRoot>()

  private constructor(private readonly _path: string) {}

  static async load(path = userDirectory('session-roots.json')): Promise<SessionRootCatalog> {
    const catalog = new SessionRootCatalog(path)
    catalog._replace(await readSessionRootDocument(path))
    return catalog
  }

  roots(): readonly SessionRoot[] {
    return [...this._roots.values()].sort(
      (left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt) || left.directory.localeCompare(right.directory)
    )
  }

  async refresh(): Promise<void> {
    await withCatalogLock(this._path, async () => {
      this._replace(await readSessionRootDocument(this._path))
    })
  }

  async register(directory: string, workspace: string): Promise<void> {
    const normalizedDirectory = resolve(directory)
    const normalizedWorkspace = resolve(workspace)
    await withCatalogLock(this._path, async () => {
      const roots = new Map((await readSessionRootDocument(this._path)).map((root) => [root.directory, root]))
      roots.set(normalizedDirectory, {
        directory: normalizedDirectory,
        workspace: normalizedWorkspace,
        lastSeenAt: new Date().toISOString(),
      })
      const merged = [...roots.values()]
      await writeSessionRootDocument(this._path, merged)
      this._replace(merged)
    })
  }

  private _replace(roots: readonly SessionRoot[]): void {
    this._roots.clear()
    for (const root of roots) {
      this._roots.set(root.directory, root)
    }
  }
}

async function readSessionRootDocument(path: string): Promise<SessionRoot[]> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) {
      return []
    }
    throw error
  }

  try {
    const document = JSON.parse(text) as unknown
    if (!isRecord(document) || document.version !== 1 || !Array.isArray(document.roots)) {
      return []
    }
    return document.roots.flatMap((root): SessionRoot[] => {
      if (
        !isRecord(root) ||
        typeof root.directory !== 'string' ||
        typeof root.workspace !== 'string' ||
        typeof root.lastSeenAt !== 'string'
      ) {
        return []
      }
      return [
        {
          directory: resolve(root.directory),
          workspace: resolve(root.workspace),
          lastSeenAt: root.lastSeenAt,
        },
      ]
    })
  } catch {
    return []
  }
}

async function writeSessionRootDocument(path: string, roots: readonly SessionRoot[]): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const document: SessionRootDocument = { version: 1, roots: [...roots] }
  try {
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(temporary, path)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function withCatalogLock(path: string, operation: () => Promise<void>): Promise<void> {
  const lockPath = `${path}.lock`
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + CATALOG_LOCK_TIMEOUT_MS
  let lock
  for (;;) {
    try {
      lock = await fs.open(lockPath, 'wx', 0o600)
      break
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error
      }
      if (await catalogLockIsStale(lockPath)) {
        await fs.rm(lockPath, { force: true })
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to update the session catalog at ${path}.`, { cause: error })
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25))
    }
  }

  try {
    await lock.writeFile(`${process.pid}\n`)
    return await operation()
  } finally {
    try {
      await lock.close()
    } finally {
      await fs.rm(lockPath, { force: true })
    }
  }
}

async function catalogLockIsStale(path: string): Promise<boolean> {
  try {
    const [ownerText, stat] = await Promise.all([fs.readFile(path, 'utf8'), fs.stat(path)])
    const owner = Number.parseInt(ownerText.trim(), 10)
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0)
      } catch (error) {
        if (hasErrorCode(error, 'ESRCH')) {
          return true
        }
      }
    }
    return Date.now() - stat.mtimeMs > CATALOG_LOCK_STALE_MS
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && codes.some((code) => error.code === code))
}
