import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { isSourceCheckout, sourceBuildFingerprint, sourceBuildRequired } from '../../bin/strands.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

describe('source launcher', () => {
  it('distinguishes a repository checkout from a packaged CLI', async () => {
    const repository = await temporaryRepository()
    const packageRoot = join(repository, 'strands-cli')

    expect(isSourceCheckout(packageRoot)).toBe(true)
    await rm(join(packageRoot, 'src'), { recursive: true })
    expect(isSourceCheckout(packageRoot)).toBe(false)
  })

  it('fingerprints CLI source without unrelated Python changes', async () => {
    const repository = await temporaryRepository()
    const pythonSource = join(repository, 'harness-py', 'src')
    const cliProject = join(repository, 'strands-cli', 'src', 'project')
    await mkdir(pythonSource, { recursive: true })
    await mkdir(cliProject, { recursive: true })
    await writeFile(join(pythonSource, 'agent.py'), 'VERSION = 1\n')
    await writeFile(join(repository, 'harness-py', 'README.md'), 'Python SDK\n')
    await writeFile(join(cliProject, 'worker.py'), 'VERSION = 1\n')
    const first = sourceBuildFingerprint(repository)

    await writeFile(join(pythonSource, 'agent.py'), 'VERSION = 2\n')
    await writeFile(join(repository, 'harness-py', 'README.md'), 'Updated Python SDK\n')
    expect(sourceBuildFingerprint(repository)).toBe(first)

    await writeFile(join(repository, 'strands-cli', 'src', 'main.ts'), 'export const version = 2\n')
    const second = sourceBuildFingerprint(repository)

    expect(second).not.toBe(first)
    expect(sourceBuildFingerprint(repository)).toBe(second)
    await writeFile(join(cliProject, 'worker.py'), 'VERSION = 2\n')
    expect(sourceBuildFingerprint(repository)).not.toBe(second)
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
  const repository = await temporaryDirectory('strands-source-launcher-')
  await mkdir(join(repository, 'strands-cli', 'src'), { recursive: true })
  await Promise.all([
    writeFile(join(repository, 'package.json'), '{}\n'),
    writeFile(join(repository, 'package-lock.json'), '{}\n'),
    writeFile(join(repository, 'strands-cli', 'package.json'), '{}\n'),
    writeFile(join(repository, 'strands-cli', 'tsconfig.base.json'), '{}\n'),
    writeFile(join(repository, 'strands-cli', 'src', 'tsconfig.json'), '{}\n'),
    writeFile(join(repository, 'strands-cli', 'src', 'main.ts'), 'export const version = 1\n'),
  ])
  return repository
}
