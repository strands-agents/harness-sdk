import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CliConfigStore } from '../src/tui/config.js'
import type { CustomTheme } from '../src/tui/chat/types.js'

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
  it('round-trips custom colors and color mode without changing permission policy or unrelated settings', async () => {
    const path = await configPath()
    const permissions = { mode: 'default', allow: ['read'], futureSetting: true }
    await writeFile(path, JSON.stringify({ permissions, settings: { animations: false, futureSetting: true } }))
    const config = await CliConfigStore.load(path)
    await config.setSettings({
      frogTheme: 'custom',
      colorMode: 'light',
      customTheme: { base: 'merlin', light: { accent: '#ABCDEF' }, dark: { frog: '#123ABC' } },
    })

    const expected = {
      frogTheme: 'custom',
      colorMode: 'light',
      customTheme: { base: 'merlin', light: { accent: '#abcdef' }, dark: { frog: '#123abc' } },
      animations: false,
    }
    expect(config.snapshot().settings).toMatchObject(expected)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      permissions,
      settings: { ...expected, futureSetting: true },
    })
    const reloaded = await CliConfigStore.load(path)
    expect(reloaded.snapshot().settings).toEqual(config.snapshot().settings)
    expect(reloaded.snapshot().permissions).toEqual({ mode: 'default', allow: ['read'] })
  })

  it.each([
    { base: 'custom', light: {}, dark: {} },
    { base: 'missing', light: {}, dark: {} },
    { base: 'green', light: [], dark: {} },
    { base: 'green', light: { accent: 'red' }, dark: {} },
    { base: 'green', light: {}, dark: { frog: '#123456\u001b[2J' } },
  ])('rejects invalid persisted and updated custom themes: %j', async (customTheme) => {
    const path = await configPath()
    await writeFile(path, JSON.stringify({ settings: { customTheme } }))
    await expect(CliConfigStore.load(path)).rejects.toThrow(`Invalid CLI config at ${path}: customTheme.`)

    const original = JSON.stringify({ permissions: { mode: 'default', allow: [] }, settings: { animations: false } })
    await writeFile(path, original)
    const config = await CliConfigStore.load(path)
    const before = config.snapshot()
    await expect(
      config.setSettings({ frogTheme: 'custom', customTheme: customTheme as unknown as CustomTheme })
    ).rejects.toThrow(`Invalid CLI config at ${path}: customTheme.`)
    expect(config.snapshot()).toEqual(before)
    expect(await readFile(path, 'utf8')).toBe(original)
  })
})
