import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** A temp directory removed automatically after each test in the importing file. */
export async function temporaryDirectory(prefix = 'strands-cli-test-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

/** Registers a directory created elsewhere for the same per-test cleanup. */
export function trackTemporaryDirectory(directory: string): void {
  temporaryDirectories.push(directory)
}
