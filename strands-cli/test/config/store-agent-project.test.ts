import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { configurationFromStore } from '../../src/agent/configuration.js'
import { CliConfigStore } from '../../src/config/store.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const AGENT = '/home/test/.strands/strands-dev/agent/agent.ts'

const configFile = async (toml = '[settings]\nfrogTheme = "green"\n'): Promise<string> => {
  const path = join(await temporaryDirectory(), 'cli.toml')
  await writeFile(path, toml)
  return path
}

const onDisk = async (path: string) => (await CliConfigStore.load(path, { persist: false })).snapshot()

describe('CliConfigStore agent project', () => {
  it('shouldKeepTheAgentProjectThatAnotherProcessSavedWhenAnOlderStoreWritesASetting', async () => {
    const path = await configFile()
    const older = await CliConfigStore.load(path)
    await (await CliConfigStore.load(path)).setAgentProject(AGENT)

    await older.setSettings({ frogTheme: 'merlin' })

    const saved = await onDisk(path)
    expect([saved.agentProject, saved.settings.frogTheme]).toEqual([AGENT, 'merlin'])
    expect(older.snapshot().agentProject).toBe(AGENT)
  })

  it('shouldKeepTheAgentProjectClearedWhenAnotherProcessClearedItBeforeAnOlderStoreWrites', async () => {
    const path = await configFile(`agentProject = "${AGENT}"\n[settings]\nfrogTheme = "green"\n`)
    const older = await CliConfigStore.load(path)
    const other = await CliConfigStore.load(path)
    await other.saveProfile(other.snapshot().profile)

    await older.setPermissionMode('bypassPermissions')

    expect((await onDisk(path)).agentProject).toBeUndefined()
  })

  it('shouldWriteTheAgentProjectThatTheStoreSetWithoutSavingWhenItLaterSavesSetup', async () => {
    const path = await configFile()
    const store = await CliConfigStore.load(path)
    await store.useLayer({ source: 'dev', read: async () => undefined, write: async () => undefined })
    await store.useAgentProject(AGENT)
    await store.useLayer(undefined)

    await store.saveSetup(configurationFromStore(store), { agentProject: AGENT })

    expect((await onDisk(path)).agentProject).toBe(AGENT)
  })

  it('shouldClearTheAgentProjectWhenTheStoreSavesAProfile', async () => {
    const path = await configFile(`agentProject = "${AGENT}"\n`)
    const store = await CliConfigStore.load(path)

    await store.saveProfile(store.snapshot().profile)

    expect((await onDisk(path)).agentProject).toBeUndefined()
  })

  it('shouldSetTheAgentProjectWithoutWritingOtherSectionsWhenSetAgentProjectIsCalled', async () => {
    const path = await configFile('')
    const store = await CliConfigStore.load(path)

    await store.setAgentProject(AGENT)

    const saved = await onDisk(path)
    expect(saved.agentProject).toBe(AGENT)
    expect(store.snapshot().agentProject).toBe(AGENT)
  })
})
