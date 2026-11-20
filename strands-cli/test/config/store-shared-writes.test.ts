import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { configurationFromStore } from '../../src/agent/configuration.js'
import { CliConfigStore } from '../../src/config/store.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const AGENT = '/home/test/.strands/strands-dev/agent/agent.ts'
const PROFILE = '[profile]\nname = "Base"\ninstructions = "Answer briefly."\nmodel = "bedrock/first-model"\n'

const configFile = async (toml = `${PROFILE}\n[settings]\nfrogTheme = "green"\n`): Promise<string> => {
  const path = join(await temporaryDirectory(), 'cli.toml')
  await writeFile(path, toml)
  return path
}

const onDisk = async (path: string) => (await CliConfigStore.load(path, { persist: false })).snapshot()

describe('CliConfigStore shared writes', () => {
  it('shouldKeepAProfileChangeFromAnotherProcessWhenAnOlderStoreWritesASetting', async () => {
    const path = await configFile()
    const older = await CliConfigStore.load(path)
    await (
      await CliConfigStore.load(path)
    ).updateProfile((profile) => ({ ...profile, instructions: 'Answer in full.' }))

    await older.setSettings({ frogTheme: 'merlin' })

    const saved = await onDisk(path)
    expect([saved.profile.instructions, saved.settings.frogTheme]).toEqual(['Answer in full.', 'merlin'])
  })

  it('shouldMergeTheProfileFieldByFieldWhenTwoProcessesChangeDifferentFields', async () => {
    const path = await configFile()
    const older = await CliConfigStore.load(path)
    await (
      await CliConfigStore.load(path)
    ).updateProfile((profile) => ({ ...profile, instructions: 'Answer in full.' }))

    await older.setProfileModel('bedrock/second-model', 'low')

    const { profile } = await onDisk(path)
    expect([profile.instructions, profile.model, profile.effort]).toEqual([
      'Answer in full.',
      'bedrock/second-model',
      'low',
    ])
  })

  it('shouldWriteOnlyTheChangedFieldWhenAProfileUpdateRuns', async () => {
    const path = await configFile()

    await (await CliConfigStore.load(path)).updateProfile((profile) => ({ ...profile, effort: 'low' }))

    expect(await readFile(path, 'utf8')).toBe(
      '[profile]\nname = "Base"\ninstructions = "Answer briefly."\nmodel = "bedrock/first-model"\neffort = "low"\n\n[settings]\nfrogTheme = "green"\n'
    )
  })

  it('shouldKeepAnAgentProjectThatAnotherProcessSavedWhenAnOlderStoreWrites', async () => {
    const path = await configFile()
    const older = await CliConfigStore.load(path)
    const other = await CliConfigStore.load(path)
    await other.useAgentProject(AGENT)

    await older.setPermissionMode('bypassPermissions')

    expect((await onDisk(path)).agentProject).toBe(AGENT)
  })

  it('shouldWriteTheValueThatTheStoreSetWithoutSavingWhenItLaterSavesSetup', async () => {
    const path = await configFile()
    const store = await CliConfigStore.load(path)
    await store.useLayer({ source: 'dev', read: async () => undefined, write: async () => undefined })
    await store.useAgentProject(AGENT)
    await store.useLayer(undefined)

    await store.saveSetup(configurationFromStore(store), { agentProject: AGENT })

    expect((await onDisk(path)).agentProject).toBe(AGENT)
  })

  it('shouldReportAProfileChangeOnlyWhenAnotherProcessChangedTheProfile', async () => {
    const path = await configFile()
    const store = await CliConfigStore.load(path)
    await store.setSettings({ frogTheme: 'merlin' })
    expect(await store.reload()).toBe(false)

    await (
      await CliConfigStore.load(path)
    ).updateProfile((profile) => ({ ...profile, instructions: 'Answer in full.' }))

    expect(await store.reload()).toBe(true)
    expect(store.snapshot().profile.instructions).toBe('Answer in full.')
  })

  it('shouldUpdateTheProfileFromTheFileOnDiskWhenUpdateProfileRuns', async () => {
    const path = await configFile()
    const store = await CliConfigStore.load(path)
    await writeFile(path, (await readFile(path, 'utf8')).replace('Answer briefly.', 'Answer in full.'))

    await store.updateProfile((profile) => ({ ...profile, effort: 'low' }))

    const { profile } = await onDisk(path)
    expect([profile.instructions, profile.effort]).toEqual(['Answer in full.', 'low'])
    expect(store.snapshot().profile.instructions).toBe('Answer in full.')
  })
})
