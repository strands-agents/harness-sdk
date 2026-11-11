import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliConfigStore } from '../../src/config/store.js'
import { baseHarnessSelection, distinctHarnesses } from '../../src/dev/selection.js'
import { initializeDevWorkspace } from '../../src/dev/workspace.js'
import { strandsUserPath } from '../../src/paths.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const project = async (root: string) => {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'agent.ts'), 'export const agent = {}')
  return { root, entrypoint: join(root, 'agent.ts'), language: 'typescript' as const, name: 'Same name' }
}

describe('base harness selection', () => {
  beforeEach(async () => {
    const home = await temporaryDirectory()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('shouldShowTheSavedProfilePathWhenTheCliUsesItsBuiltInHarness', async () => {
    const root = await temporaryDirectory()
    const snapshot = CliConfigStore.memory().snapshot()
    snapshot.path = join(root, 'cli.toml')

    const base = await baseHarnessSelection(snapshot, await temporaryDirectory())

    expect(base.source).toBe(snapshot.path)
    expect(base.workspace).toBe(strandsUserPath('strands-dev'))
    expect(base.excludedEntrypoints).toEqual([])
  })

  it('shouldExcludeTheDefaultSourceAndReopenedCopyWhenTheyAreDiscoveredAgain', async () => {
    const root = await temporaryDirectory()
    const original = await project(join(root, 'original'))
    const copy = await project(strandsUserPath('strands-dev'))
    const other = await project(join(root, 'other'))
    await initializeDevWorkspace(copy.root, {
      version: 1,
      name: 'CLI copy',
      language: 'typescript',
      entrypoint: 'agent.ts',
      origin: { kind: 'cli' },
    })
    const snapshot = CliConfigStore.memory().snapshot()
    snapshot.agentProject = original.root

    const base = await baseHarnessSelection(snapshot, root)
    const found = await distinctHarnesses([original, copy, other, other], base.excludedEntrypoints)

    expect(base.source).toBe(original.entrypoint)
    expect(base.name).toBe('CLI copy')
    expect(base.workspace).toBe(strandsUserPath('strands-dev'))
    expect(found).toEqual([other])
  })

  it.each([
    ['at the project root', 'saved/agent.ts'],
    ['in a source folder', 'saved/src/agent.ts'],
  ])('shouldPlaceTheBaseCliWorkspaceInTheStrandsFolderWhenItsSavedProjectFileIs%s', async (_case, file) => {
    const root = await temporaryDirectory()
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, 'saved/package.json'), '{"type":"module"}')
    await writeFile(join(root, file), 'export const agent = {}')
    const snapshot = CliConfigStore.memory().snapshot()
    snapshot.agentProject = join(root, file)

    const base = await baseHarnessSelection(snapshot, root)

    expect(base.source).toBe(join(root, file))
    expect(base.workspace).toBe(strandsUserPath('strands-dev'))
  })

  it('shouldKeepTheGivenWorkspaceWhenTheUserPassesOne', async () => {
    const launch = await temporaryDirectory()

    const base = await baseHarnessSelection(CliConfigStore.memory().snapshot(), launch, 'chosen/strands-dev')

    expect(base.workspace).toBe(join(launch, 'chosen/strands-dev'))
  })

  it('shouldDeduplicatePhysicalPathsWhenAnAliasPointsToTheBaseSource', async () => {
    const root = await temporaryDirectory()
    const original = await project(join(root, 'original'))
    const alias = join(root, 'alias.ts')
    await symlink(original.entrypoint, alias)

    expect(await distinctHarnesses([{ ...original, entrypoint: alias }], [original.entrypoint])).toEqual([])
  })

  it('shouldKeepDifferentSourcesWhenTheirNamesMatch', async () => {
    const root = await temporaryDirectory()
    const first = await project(join(root, 'first'))
    const second = await project(join(root, 'second'))

    expect(await distinctHarnesses([first, second], [])).toEqual([first, second])
  })
})
