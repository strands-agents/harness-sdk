import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../../src/cli/arguments.js'
import { CliConfigStore } from '../../src/config/store.js'
import { prepareDevRun } from '../../src/dev/prepare.js'
import * as search from '../../src/dev/search.js'
import * as picker from '../../src/dev/picker.js'
import { initializeDevWorkspace } from '../../src/dev/workspace.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const fixture = async (): Promise<string> => {
  const root = await temporaryDirectory()
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(
    join(root, 'agent.ts'),
    "import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ name: 'Local' })\n"
  )
  return root
}

const config = (): CliConfigStore => CliConfigStore.memory({}, {}, { profile: { name: 'Saved CLI', skills: false } })

const originalInputTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const originalOutputTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
const terminal = (enabled: boolean): void => {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: enabled })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: enabled })
}

afterEach(() => {
  vi.restoreAllMocks()
  if (originalInputTty) Object.defineProperty(process.stdin, 'isTTY', originalInputTty)
  else Reflect.deleteProperty(process.stdin, 'isTTY')
  if (originalOutputTty) Object.defineProperty(process.stdout, 'isTTY', originalOutputTty)
  else Reflect.deleteProperty(process.stdout, 'isTTY')
})

describe('prepareDevRun', () => {
  it('shouldOpenAnExplicitHarnessWithoutScanningWhenAgentIsProvided', async () => {
    const root = await fixture()
    const saved = config()
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(saved)
    const discover = vi.spyOn(search, 'discoverHarnesses')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const prepared = await prepareDevRun(parseArgs(['dev', '--agent', join(root, 'agent.ts')]))

    expect(prepared?.workspace.root).toBe(root)
    expect(prepared?.args.agent).toBe(join(root, 'agent.ts'))
    expect(discover).not.toHaveBeenCalled()
    expect(CliConfigStore.load).toHaveBeenCalledWith(undefined, { persist: false })
    expect(saved.snapshot().agentProject).toBe(join(root, 'agent.ts'))
  })

  it('shouldUseTheWorkspaceEntrypointWhenTheGlobalDefaultDiffers', async () => {
    const root = await fixture()
    await initializeDevWorkspace(root, {
      version: 1,
      name: 'Local',
      language: 'typescript',
      entrypoint: 'agent.ts',
      origin: { kind: 'discovered' },
    })
    const saved = config()
    await saved.useAgentProject('/global/default.ts')
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(saved)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const prepared = await prepareDevRun(parseArgs(['dev', '--workspace', root]))

    expect(prepared?.args.agent).toBe(join(root, 'agent.ts'))
    expect(prepared?.config.snapshot().settings).toMatchObject({
      mcpDiscovery: false,
      skillDiscovery: false,
      telemetry: false,
    })
  })

  it('shouldLeaveTheManifestUnchangedWhenAgentOverridesOneLaunch', async () => {
    const root = await fixture()
    await writeFile(join(root, 'other.ts'), 'export const agent = null')
    await initializeDevWorkspace(root, {
      version: 1,
      name: 'Local',
      language: 'typescript',
      entrypoint: 'agent.ts',
      origin: { kind: 'discovered' },
    })
    const before = await readFile(join(root, '.strands/config.json'), 'utf8')
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const prepared = await prepareDevRun(parseArgs(['dev', '--agent', join(root, 'other.ts')]))

    expect(prepared?.args.agent).toBe(join(root, 'other.ts'))
    expect(await readFile(join(root, '.strands/config.json'), 'utf8')).toBe(before)
  })

  it('shouldRequireSelectionWhenNoTerminalOrWorkspaceExists', async () => {
    const cwd = await temporaryDirectory()
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    terminal(false)
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())

    await expect(prepareDevRun(parseArgs(['dev']))).rejects.toThrow('Run strands dev init')
  })

  it('shouldShowTheBaseCliBeforeDiscoveredHarnessesWhenThePickerOpens', async () => {
    const cwd = await temporaryDirectory()
    const root = await fixture()
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    terminal(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const harness = { name: 'Found', entrypoint: join(root, 'agent.ts'), root, language: 'typescript' as const }
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [harness], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockImplementation(async (_options, _screen, open) =>
      open({ kind: 'discovered', harness }, _screen.signal)
    )
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    const prepared = await prepareDevRun(parseArgs(['dev', '--search-root', '../other']), { screen })

    expect(picker.chooseHarness).toHaveBeenCalledWith(
      { cliName: 'Saved CLI', harnesses: [harness], warnings: [] },
      screen,
      expect.any(Function)
    )
    expect(prepared?.workspace.root).toBe(root)
    expect(search.discoverHarnesses).toHaveBeenCalledWith([cwd, join(cwd, '../other')])
  })

  it('shouldNotWriteFilesWhenTheUserCancelsSelection', async () => {
    const cwd = await temporaryDirectory()
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    terminal(true)
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockResolvedValue(undefined)

    const screen = { signal: new AbortController().signal, show: vi.fn() }
    expect(await prepareDevRun(parseArgs(['dev']), { screen })).toBeUndefined()
    await expect(readFile(join(cwd, '.strands/config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
