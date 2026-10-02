/**
 * Captures the version of the code that produced a run — git SHA plus a dirty
 * flag — so an A/B comparison can tell what code each saved run corresponds to.
 */

import { execFileSync } from 'node:child_process'
import type { SourceVersion } from './types.js'

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

export function captureSourceVersion(): SourceVersion {
  const dirty = git(['status', '--porcelain']) !== ''
  return {
    gitSha: git(['rev-parse', '--short', 'HEAD']) || 'unknown',
    gitDirty: dirty,
    ...(dirty && { patch: git(['diff']) || undefined }),
  }
}
