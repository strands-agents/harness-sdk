import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { isSourceCheckout, sourceBuildFingerprint, sourceBuildRequired } from '../bin/strands.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('source launcher', () => {
  it('distinguishes a repository checkout from a packaged CLI', async () => {
    const repository = await temporaryRepository()
    const packageRoot = join(repository, 'strands-cli')

    expect(isSourceCheckout(packageRoot)).toBe(true)
    await rm(join(packageRoot, 'src'), { recursive: true })
    expect(isSourceCheckout(packageRoot)).toBe(false)
  })

  it('fingerprints source contents and build configuration', async () => {
    const repository = await temporaryRepository()
    const first = sourceBuildFingerprint(repository)

    await writeFile(join(repository, 'strands-cli', 'src', 'main.ts'), 'export const version = 2\n')
    const second = sourceBuildFingerprint(repository)

    expect(second).not.toBe(first)
    expect(sourceBuildFingerprint(repository)).toBe(second)
  })

  it('rebuilds for missing output, missing state, or a changed fingerprint', async () => {
    const repository = await temporaryRepository()
    const entrypoint = join(repository, 'strands-cli', 'dist', 'src', 'main.js')
    const stateFile = join(repository, 'node_modules', '.cache', 'strands-cli', 'source-build.json')
    await mkdir(join(repository, 'strands-cli', 'dist', 'src'), { recursive: true })
    await mkdir(join(repository, 'node_modules', '.cache', 'strands-cli'), { recursive: true })

    expect(sourceBuildRequired(repository, stateFile, 'one')).toBe(true)
    await writeFile(entrypoint, 'export {}\n')
    expect(sourceBuildRequired(repository, stateFile, 'one')).toBe(true)
    await writeFile(stateFile, '{"fingerprint":"one","outputs":["strands-cli/dist/src/main.js"]}\n')
    expect(sourceBuildRequired(repository, stateFile, 'one')).toBe(false)
    expect(sourceBuildRequired(repository, stateFile, 'two')).toBe(true)
  })
})

async function temporaryRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'strands-source-launcher-'))
  temporaryDirectories.push(repository)
  await Promise.all([
    mkdir(join(repository, 'strands-cli', 'src'), { recursive: true }),
    mkdir(join(repository, 'harness-ts', 'src'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(repository, 'package.json'), '{}\n'),
    writeFile(join(repository, 'package-lock.json'), '{}\n'),
    writeFile(join(repository, 'strands-cli', 'package.json'), '{}\n'),
    writeFile(join(repository, 'strands-cli', 'tsconfig.base.json'), '{}\n'),
    writeFile(join(repository, 'strands-cli', 'src', 'tsconfig.json'), '{}\n'),
    writeFile(join(repository, 'strands-cli', 'src', 'main.ts'), 'export const version = 1\n'),
    writeFile(join(repository, 'harness-ts', 'package.json'), '{}\n'),
    writeFile(join(repository, 'harness-ts', 'tsconfig.base.json'), '{}\n'),
    writeFile(join(repository, 'harness-ts', 'src', 'tsconfig.json'), '{}\n'),
    writeFile(join(repository, 'harness-ts', 'src', 'index.ts'), 'export const marker = true\n'),
  ])
  return repository
}
