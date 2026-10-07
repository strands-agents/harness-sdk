import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CliConfigStore } from '../src/tui/config.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function configPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'strands-config-appearance-'))
  directories.push(directory)
  return join(directory, 'config.json')
}

describe('appearance persistence', () => {
  it.each([
    [{ base: 'merlin', light: { accent: '#123456' }, dark: {} }, 'merlin'],
    [{ base: 'missing', light: {}, dark: {} }, 'green'],
    [[], 'green'],
    [undefined, 'green'],
  ])('loads a saved custom theme %j as the preset %s', async (customTheme, expected) => {
    const path = await configPath()
    await writeFile(path, JSON.stringify({ settings: { frogTheme: 'custom', customTheme } }))

    const config = await CliConfigStore.load(path)

    expect(config.snapshot().settings.frogTheme).toBe(expected)
    expect(config.snapshot().settings).not.toHaveProperty('customTheme')
  })

  it('updates the theme without changing permission policy or unrelated settings', async () => {
    const path = await configPath()
    const permissions = { mode: 'default', allow: ['read'], futureSetting: true }
    await writeFile(
      path,
      JSON.stringify({
        permissions,
        settings: { animations: false, futureSetting: true, frogTheme: 'custom', customTheme: { base: 'solar' } },
      })
    )
    const config = await CliConfigStore.load(path)
    await config.setSettings({ frogTheme: 'kikker' })

    expect(config.snapshot().settings).toMatchObject({ frogTheme: 'kikker', animations: false })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      permissions,
      settings: { frogTheme: 'kikker', animations: false, futureSetting: true },
    })
    const reloaded = await CliConfigStore.load(path)
    expect(reloaded.snapshot().settings).toEqual(config.snapshot().settings)
    expect(reloaded.snapshot().permissions).toEqual({ mode: 'default', allow: ['read'] })
  })
})
