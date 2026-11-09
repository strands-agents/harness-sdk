import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../../src/cli/arguments.js'
import { CliConfigStore } from '../../src/config/store.js'
import { prepareDevRun } from '../../src/dev/prepare.js'
import * as search from '../../src/dev/search.js'
import * as picker from '../../src/dev/picker.js'
import { initializeDevWorkspace } from '../../src/dev/workspace.js'
import * as installer from '../../src/project/archive.js'
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

beforeEach(async () => {
  vi.spyOn(process, 'cwd').mockReturnValue(await temporaryDirectory())
  vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalInputTty) Object.defineProperty(process.stdin, 'isTTY', originalInputTty)
  else Reflect.deleteProperty(process.stdin, 'isTTY')
  if (originalOutputTty) Object.defineProperty(process.stdout, 'isTTY', originalOutputTty)
  else Reflect.deleteProperty(process.stdout, 'isTTY')
})

describe('prepareDevRun', () => {
  it('shouldInitializeTheLaunchDirectoryAndCopyAnExistingAgentOnce', async () => {
    const launch = process.cwd()
    const source = await fixture()
    const saved = config()
    const original = await readFile(join(source, 'agent.ts'), 'utf8')
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(saved)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const first = await prepareDevRun(parseArgs(['dev', 'init', '--agent', join(source, 'agent.ts')]))

    const directory = join(launch, 'strands-dev')
    const binding = JSON.parse(await readFile(join(directory, '.config'), 'utf8'))
    expect(binding.agent).toMatchObject({ path: source, entrypoint: 'agent.ts' })
    expect(first?.workspace.directory).toBe(directory)
    expect(first?.args.agent).toBe(join(source, 'agent.ts'))
    const marker = JSON.parse(await readFile(join(directory, 'tmp/initial.json'), 'utf8'))
    expect(await readFile(join(directory, 'tmp', marker.id, 'agent/agent.ts'), 'utf8')).toBe(original)

    const second = await prepareDevRun(parseArgs(['dev', 'init']))

    expect(second?.args.agent).toBe(first?.args.agent)
    expect(await readdir(join(directory, 'tmp'))).toHaveLength(2)
    expect(await readFile(join(source, 'agent.ts'), 'utf8')).toBe(original)
  })

  it('shouldUpgradeTheLegacyBaseSelectionWithoutChangingItsSource', async () => {
    const launch = process.cwd()
    const root = join(launch, 'strands-dev/base-cli')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'src/agent.ts'), 'export const agent = {}')
    await writeFile(join(root, '.strands-entrypoint'), './src/agent.ts\n')
    await initializeDevWorkspace(root, {
      version: 1,
      name: 'Legacy base',
      language: 'typescript',
      entrypoint: 'src/agent.ts',
      origin: { kind: 'cli' },
    })
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockImplementation(async (_options, screen, open) =>
      open({ kind: 'cli' }, screen.signal)
    )
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    const prepared = await prepareDevRun(parseArgs(['dev', 'init']), { screen })

    expect(prepared?.workspace.root).toBe(root)
    expect(prepared?.workspace.directory).toBe(join(launch, 'strands-dev'))
    expect(JSON.parse(await readFile(join(launch, 'strands-dev/.config'), 'utf8')).agent.path).toBe(root)
    expect(await readFile(join(root, 'src/agent.ts'), 'utf8')).toBe('export const agent = {}')
    expect(await readdir(join(launch, 'strands-dev/tmp'))).toHaveLength(2)
  })

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
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({
      harnesses: [harness],
      warnings: ['Workspace config version must be 1.'],
    })
    vi.spyOn(picker, 'chooseHarness').mockImplementation(async (_options, _screen, open) =>
      open({ kind: 'discovered', harness }, _screen.signal)
    )
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    const prepared = await prepareDevRun(parseArgs(['dev', '--search-root', '../other']), { screen })

    expect(picker.chooseHarness).toHaveBeenCalledWith(
      {
        cliName: 'Saved CLI',
        cliPath: 'in-memory',
        cliWorkspace: join(cwd, 'strands-dev'),
        harnesses: [harness],
      },
      screen,
      expect.any(Function)
    )
    expect(prepared?.workspace.root).toBe(root)
    expect(JSON.stringify(vi.mocked(picker.chooseHarness).mock.calls ?? [])).not.toContain(
      'Workspace config version must be 1.'
    )
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
