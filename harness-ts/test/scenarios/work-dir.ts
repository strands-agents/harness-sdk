import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

/**
 * Runs each test of the calling suite in its own temp working directory, where the harness keeps its
 * session and memory files and the built-in tools resolve paths. Returns a getter for that directory.
 */
export function useWorkDir(): () => string {
  let previous: string
  let dir: string
  beforeEach(() => {
    previous = process.cwd()
    dir = mkdtempSync(join(tmpdir(), 'strands-scenario-'))
    process.chdir(dir)
  })
  afterEach(() => {
    process.chdir(previous)
    rmSync(dir, { recursive: true, force: true })
  })
  return () => dir
}
