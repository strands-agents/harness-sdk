import { watch, type FSWatcher } from 'node:fs'
import { extname, resolve } from 'node:path'

import { containsPath } from '../paths.js'
import type { ImportedAgentProject } from './import.js'
import { IGNORED_DIRECTORIES } from './packaging.js'
import { PREPARATION_INPUTS } from './preparation-plan.js'

const WATCH_IGNORED_DIRECTORIES = new Set([...IGNORED_DIRECTORIES, 'dist'])
const STATE_DIRECTORIES = new Set(['.agent', '.strands'])
const SKILLS_DIRECTORY = 'skills'
const MCP_CONFIG_SUFFIX = 'mcp.json'
const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py']
const INSTRUCTION_EXTENSIONS = ['.md', '.txt']
const CONFIG_EXTENSIONS = ['.yaml', '.yml', '.toml', '.cedar']
const SOURCE_EXTENSIONS = new Set([...CODE_EXTENSIONS, ...INSTRUCTION_EXTENSIONS, ...CONFIG_EXTENSIONS])
const SETUP_FILES = new Set([...PREPARATION_INPUTS, 'tsconfig.json'])
const RELOAD_DEBOUNCE_MS = 200

export const isAgentSourceFile = (path: string): boolean => {
  const parts = path.split(/[\\/]/u).filter(Boolean)
  const name = parts.at(-1)
  if (
    !name ||
    parts.some((part) => WATCH_IGNORED_DIRECTORIES.has(part)) ||
    parts.some((part, index) => STATE_DIRECTORIES.has(part) && parts[index + 1] !== SKILLS_DIRECTORY)
  ) {
    return false
  }
  const lowerName = name.toLowerCase()
  return (
    parts.slice(0, -1).includes(SKILLS_DIRECTORY) ||
    SOURCE_EXTENSIONS.has(extname(lowerName)) ||
    lowerName.endsWith(MCP_CONFIG_SUFFIX) ||
    SETUP_FILES.has(name)
  )
}

export function watchAgentProject(
  project: ImportedAgentProject,
  onChange: (paths: readonly string[]) => void,
  onError: (error: Error) => void,
  privatePaths: readonly string[] = []
): () => void {
  let watcher: FSWatcher
  let timer: ReturnType<typeof setTimeout> | undefined
  const changedPaths = new Set<string>()
  const ignoredPaths = privatePaths.map((path) => resolve(project.root, path))
  try {
    watcher = watch(project.root, { recursive: true, persistent: false }, (_event, filename) => {
      const path = filename?.toString()
      if (
        path &&
        (!isAgentSourceFile(path) ||
          ignoredPaths.some((privatePath) => containsPath(privatePath, resolve(project.root, path))))
      ) {
        return
      }
      changedPaths.add(path ?? 'agent source')
      clearTimeout(timer)
      timer = setTimeout(() => {
        const paths = [...changedPaths].sort()
        changedPaths.clear()
        onChange(paths)
      }, RELOAD_DEBOUNCE_MS)
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
