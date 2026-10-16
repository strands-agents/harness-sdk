import { watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'

import { containsPath } from '../paths.js'
import { hasIgnoredDirectory, IGNORED_DIRECTORIES } from './packaging.js'
import type { ImportedAgentProject } from './import.js'

const WATCH_IGNORED_DIRECTORIES = new Set([...IGNORED_DIRECTORIES, '.agent', 'dist'])
const RELOAD_DEBOUNCE_MS = 200

export function watchAgentProject(
  project: ImportedAgentProject,
  onChange: () => void,
  onError: (error: Error) => void,
  privatePaths: readonly string[] = []
): () => void {
  let watcher: FSWatcher
  let timer: ReturnType<typeof setTimeout> | undefined
  const ignoredPaths = privatePaths.map((path) => resolve(project.root, path))
  try {
    watcher = watch(project.root, { recursive: true, persistent: false }, (_event, filename) => {
      const path = filename?.toString()
      if (
        path &&
        (hasIgnoredDirectory(path, WATCH_IGNORED_DIRECTORIES) ||
          ignoredPaths.some((privatePath) => containsPath(privatePath, resolve(project.root, path))))
      ) {
        return
      }
      clearTimeout(timer)
      timer = setTimeout(onChange, RELOAD_DEBOUNCE_MS)
    })
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)))
    return () => {}
  }
  watcher.on('error', onError)
  return () => {
    clearTimeout(timer)
    watcher.close()
  }
}
