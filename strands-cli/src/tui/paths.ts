import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

/** True when `path` is `root` or lies beneath it, compared lexically. */
export function containsPath(root: string, path: string): boolean {
  const result = relative(root, path)
  return result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result)
}

/** A path under the CLI's user state root, `~/.strands`. */
export function strandsUserPath(...segments: string[]): string {
  return join(homedir(), '.strands', ...segments)
}
