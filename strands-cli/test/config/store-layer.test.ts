import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { configurationFromStore } from '../../src/agent/configuration.js'
import { CliConfigStore, type ConfigLayer } from '../../src/config/store.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const SOURCE = '/workspace/strands-dev/.config'

const layer = (saved?: unknown): ConfigLayer & { writes: Record<string, unknown>[] } => {
  const writes: Record<string, unknown>[] = []
  return {
    source: SOURCE,
    writes,
    read: async () => saved,
    write: async (sections) => {
      writes.push(sections)
    },
  }
}

const devStore = async (toml = '[settings]\nfrogTheme = "green"\n') => {
  const path = join(await temporaryDirectory(), 'cli.toml')
  await writeFile(path, toml)
  return { path, toml, config: await CliConfigStore.load(path, { persist: false }) }
}

describe('CliConfigStore layer', () => {
  it('shouldSaveOnlyTheChangedSettingsInTheLayerAndLeaveTheCliFileAlone', async () => {
    const { path, toml, config } = await devStore()
    const target = layer()
    await config.useLayer(target)

    await config.setSettings({ frogTheme: 'merlin' })

    expect(target.writes.at(-1)).toEqual({ settings: { frogTheme: 'merlin' } })
    expect(config.snapshot().settings.frogTheme).toBe('merlin')
    expect(await readFile(path, 'utf8')).toBe(toml)
  })

  it('shouldApplyTheSavedSettingsPermissionsAndProviderEnvironmentWhenTheLayerIsAttached', async () => {
    const { config } = await devStore()

    await config.useLayer(
      layer({
        settings: { frogTheme: 'merlin', toolOutput: 'full' },
        permissions: { mode: 'bypassPermissions', allow: ['shell'], deny: [] },
        providers: { environment: { AWS_PROFILE: 'work' } },
      })
    )

    const snapshot = config.snapshot()
    expect(snapshot.settings).toMatchObject({ frogTheme: 'merlin', toolOutput: 'full' })
    expect(snapshot.permissions).toEqual({ mode: 'bypassPermissions', allow: ['shell'], deny: [] })
    expect(config.configuredProviderEnvironment()).toEqual({ AWS_PROFILE: 'work' })
  })

  it('shouldNotSaveSettingsThatTheDevSessionSetBeforeTheLayer', async () => {
    const { config } = await devStore('[settings]\nmcpDiscovery = true\n')
    await config.setSettings({ mcpDiscovery: false })
    const target = layer()
    await config.useLayer(target)

    await config.setSettings({ animations: false })

    expect(target.writes).toEqual([{ settings: { animations: false } }])
  })

  it('shouldSavePermissionChangesInTheLayer', async () => {
    const { config } = await devStore()
    const target = layer()
    await config.useLayer(target)

    await config.setPermissionMode('bypassPermissions')
    await config.allowTool('shell')

    expect(target.writes.at(-1)).toEqual({ permissions: { mode: 'bypassPermissions', allow: ['shell'], deny: [] } })
  })

  it('shouldKeepProviderCredentialsOutOfTheLayer', async () => {
    const { config } = await devStore()
    const target = layer()
    await config.useLayer(target)

    await config.saveSetup({
      ...configurationFromStore(config),
      providerEnvironment: { AWS_PROFILE: 'work', ANTHROPIC_API_KEY: 'secret-key' },
    })

    expect(target.writes.at(-1)).toEqual({ providers: { environment: { AWS_PROFILE: 'work' } } })
    expect(JSON.stringify(target.writes)).not.toContain('secret-key')
  })

  it.each<[string, (config: CliConfigStore) => Promise<void>]>([
    ['a setup preview', (config) => config.saveSetup({ ...configurationFromStore(config) }, { persist: false })],
    ['the dev agent project', (config) => config.useAgentProject('/workspace/agent.ts')],
    ['a profile model', (config) => config.setProfileModel('bedrock/next-model', 'high')],
  ])('shouldNotWriteTheLayerForChangesTo%s', async (_case, change) => {
    const { config } = await devStore()
    const target = layer()
    await config.useLayer(target)

    await change(config)

    expect(target.writes).toEqual([])
  })

  it('shouldRestoreTheValuesFromBeforeTheLayerWhenAnotherWorkspaceIsOpened', async () => {
    const { config } = await devStore()
    await config.useLayer(layer({ settings: { frogTheme: 'merlin' } }))

    await config.useLayer(layer())

    expect(config.snapshot().settings.frogTheme).toBe('green')
    await config.useLayer(undefined)
    expect(config.snapshot().settings.frogTheme).toBe('green')
  })

  describe('settings that the saved CLI config holds', () => {
    it('shouldTakeThemAsTheValuesInUseAndDropTheLayersOwnValueOfThem', async () => {
      const { path, toml, config } = await devStore()
      const target = layer({ settings: { frogTheme: 'merlin', toolOutput: 'full' } })
      await config.useLayer(target)

      await config.adoptSavedSettings({ frogTheme: 'spectre' })

      expect(config.snapshot().settings).toMatchObject({ frogTheme: 'spectre', toolOutput: 'full' })
      expect(target.writes).toEqual([{ settings: { toolOutput: 'full' } }])
      expect(await readFile(path, 'utf8')).toBe(toml)
    })

    it('shouldLeaveTheLayerAloneWhenItHeldNoValueOfThem', async () => {
      const { config } = await devStore()
      const target = layer({ settings: { toolOutput: 'full' } })
      await config.useLayer(target)

      await config.adoptSavedSettings({ frogTheme: 'spectre' })

      expect(config.snapshot().settings).toMatchObject({ frogTheme: 'spectre', toolOutput: 'full' })
      expect(target.writes).toEqual([])
    })

    it('shouldNotSaveThemInTheLayerWithALaterChange', async () => {
      const { config } = await devStore()
      const target = layer()
      await config.useLayer(target)
      await config.adoptSavedSettings({ frogTheme: 'spectre' })

      await config.setSettings({ toolOutput: 'full' })

      expect(target.writes).toEqual([{ settings: { toolOutput: 'full' } }])
      expect(config.snapshot().settings.frogTheme).toBe('spectre')
    })

    it('shouldKeepThemWhenAnotherWorkspaceIsOpened', async () => {
      const { config } = await devStore()
      await config.useLayer(layer({ settings: { frogTheme: 'merlin' } }))
      await config.adoptSavedSettings({ frogTheme: 'spectre' })

      await config.useLayer(layer())

      expect(config.snapshot().settings.frogTheme).toBe('spectre')
    })

    it('shouldTakeThemWithoutALayerToo', async () => {
      const { path, toml, config } = await devStore()

      await config.adoptSavedSettings({ frogTheme: 'spectre' })

      expect(config.snapshot().settings.frogTheme).toBe('spectre')
      expect(await readFile(path, 'utf8')).toBe(toml)
    })
  })

  describe('with autoOptimize saved before it was split in two', () => {
    it('shouldReadTheOldOnOffAsAutoAcceptWhenTheLayerIsAttached', async () => {
      const { config } = await devStore()

      await config.useLayer(layer({ settings: { autoOptimize: true } }))

      // Merged over the CLI's own settings unmigrated, the old value was dropped and auto-accept read off.
      expect(config.snapshot().settings).toMatchObject({ autoAcceptOptimizationResults: true })
      expect(config.snapshot().settings.autoOptimize).toBeUndefined()
    })

    it('shouldSaveItUnderTheNewNameOnceAnotherSettingChanges', async () => {
      const { config } = await devStore()
      const target = layer({ settings: { autoOptimize: true } })
      await config.useLayer(target)

      await config.setSettings({ autoOptimize: 20 })

      expect(target.writes.at(-1)).toEqual({ settings: { autoAcceptOptimizationResults: true, autoOptimize: 20 } })
    })

    it('shouldReadTheOldOnOffFromTheCliFileToo', async () => {
      const { config } = await devStore('[settings]\nautoOptimize = true\n')

      expect(config.snapshot().settings).toMatchObject({ autoAcceptOptimizationResults: true })
      expect(config.snapshot().settings.autoOptimize).toBeUndefined()
    })
  })

  it('shouldRejectALayerThatIsNotValid', async () => {
    const { config } = await devStore()

    await expect(config.useLayer(layer({ settings: 'merlin' }))).rejects.toThrow(SOURCE)
    expect(config.snapshot().settings.frogTheme).toBe('green')
  })
})
