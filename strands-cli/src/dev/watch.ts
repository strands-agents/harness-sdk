import { lstatSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

import { errorMessage } from '../tui/terminal/sanitize.js'
import { isProjectFolder, VIRTUAL_ENVIRONMENT_MARKER } from './project.js'

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.js',
  '.mjs',
  '.py',
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
])

export interface ChangeBuffer {
  add(path: string): void
  close(): void
}

export interface SourceWatcherOptions {
  readonly root: string
  readonly onChange: (paths: readonly string[]) => void
  readonly onWarning: (message: string) => void
  readonly debounceMs?: number
  readonly maxDirectories?: number
}

export interface SourceWatcher {
  directories(): number
  close(): void
}

export function isSourceFile(name: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(name).toLowerCase())
}

export function createChangeBuffer(options: {
  readonly debounceMs: number
  readonly onChange: (paths: readonly string[]) => void
}): ChangeBuffer {
  const paths = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  const flush = (): void => {
    timer = undefined
    const changed = [...paths].sort()
    paths.clear()
    if (changed.length > 0) options.onChange(changed)
  }
  return {
    add: (path): void => {
      paths.add(path)
      clearTimeout(timer)
      timer = setTimeout(flush, options.debounceMs)
    },
    close: (): void => {
      clearTimeout(timer)
      paths.clear()
    },
  }
}

// One non-recursive watch per folder: a recursive watch on Linux adds an inotify watch for every
// folder below the root, `node_modules` and `.venv` included.
export function watchSources(options: SourceWatcherOptions): SourceWatcher {
  const { root, onWarning, maxDirectories = 1_000 } = options
  const buffer = createChangeBuffer({ debounceMs: options.debounceMs ?? 200, onChange: options.onChange })
  const watchers = new Map<string, FSWatcher>()
  const warned = new Set<string>()
  let closed = false

  const warn = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    onWarning(message)
  }
  const unwatch = (directory: string): void => {
    for (const [path, watcher] of watchers) {
      if (path !== directory && !path.startsWith(`${directory}${sep}`)) continue
      watcher.close()
      watchers.delete(path)
    }
  }
  const handle = (directory: string, name: string): void => {
    const path = join(directory, name)
    if (name === VIRTUAL_ENVIRONMENT_MARKER && directory !== root) {
      unwatch(directory)
      return
    }
    const kind = entryKind(path)
    if (kind === 'directory') {
      if (isProjectFolder(path, name) && addTree(path)) buffer.add(relative(root, path))
      return
    }
    if (kind === 'missing') unwatch(path)
    if (isSourceFile(name)) buffer.add(relative(root, path))
  }
  const addDirectory = (directory: string): boolean => {
    if (watchers.has(directory)) return false
    if (watchers.size >= maxDirectories) {
      warn(
        'limit',
        `Watching the first ${maxDirectories} folders only. Changes in other folders do not reload the agent.`
      )
      return false
    }
    try {
      const watcher = watch(directory, (_event, name) => {
        if (!closed && name) handle(directory, name.toString())
      })
      watcher.on('error', () => unwatch(directory))
      watchers.set(directory, watcher)
      return true
    } catch (error) {
      if (!isMissing(error)) warn(directory, `Cannot watch ${relative(root, directory) || '.'}: ${errorMessage(error)}`)
      return false
    }
  }
  // Breadth first, so that the folder limit drops the deepest folders, not the agent's own.
  const addTree = (start: string): boolean => {
    if (!addDirectory(start)) return false
    const queue = [start]
    while (queue.length > 0) {
      const directory = queue.shift()!
      for (const name of childDirectories(directory)) {
        const child = join(directory, name)
        if (addDirectory(child)) queue.push(child)
      }
    }
    return true
  }

  addTree(root)
  return {
    directories: (): number => watchers.size,
    close: (): void => {
      closed = true
      buffer.close()
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}

function entryKind(path: string): 'directory' | 'file' | 'missing' {
  try {
    return lstatSync(path).isDirectory() ? 'directory' : 'file'
  } catch {
    return 'missing'
  }
}

function childDirectories(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isProjectFolder(join(directory, entry.name), entry.name))
      .map((entry) => entry.name)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}
