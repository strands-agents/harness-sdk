import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

import { isRecord } from './values.js'

/** True when `path` is `root` or lies beneath it, compared lexically. */
export function containsPath(root: string, path: string): boolean {
  const result = relative(root, path)
  return result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result)
}

/** Expands a leading `~` to the home directory; `~\` counts only where `\` separates paths. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') || (sep === '\\' && path.startsWith('~\\')) ? join(homedir(), path.slice(2)) : path
}

/** A path under the CLI's user state root, `~/.strands`. */
export function strandsUserPath(...segments: string[]): string {
  return join(homedir(), '.strands', ...segments)
}

/** True when a filesystem error means the path, or one of its parent directories, does not exist. */
export function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
