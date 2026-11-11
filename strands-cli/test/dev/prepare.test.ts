import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { strToU8, zipSync } from 'fflate'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../../src/cli/arguments.js'
import { containsPath, strandsUserPath } from '../../src/paths.js'
import { CliConfigStore } from '../../src/config/store.js'
import { bindWorkspace } from '../../src/dev/binding.js'
import { bindExistingAgent } from '../../src/dev/create.js'
import type { FolderSuggestion, HarnessChoice } from '../../src/dev/picker.js'
import { prepareDevRun } from '../../src/dev/prepare.js'
import * as search from '../../src/dev/search.js'
import type { DiscoveredHarness } from '../../src/dev/search.js'
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
  const home = await temporaryDirectory()
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (originalInputTty) Object.defineProperty(process.stdin, 'isTTY', originalInputTty)
  else Reflect.deleteProperty(process.stdin, 'isTTY')
  if (originalOutputTty) Object.defineProperty(process.stdout, 'isTTY', originalOutputTty)
  else Reflect.deleteProperty(process.stdout, 'isTTY')
})

describe('prepareDevRun', () => {
  it('shouldInitializeTheWorkspaceNextToTheAgentAndCopyTheAgentOnce', async () => {
    const launch = process.cwd()
    const source = await fixture()
    const saved = config()
    const original = await readFile(join(source, 'agent.ts'), 'utf8')
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(saved)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const first = await prepareDevRun(parseArgs(['dev', 'init', '--agent', join(source, 'agent.ts')]))

    const directory = join(source, 'strands-dev')
    const binding = JSON.parse(await readFile(join(directory, '.config'), 'utf8'))
    expect(binding.agent).toMatchObject({ path: source, entrypoint: 'agent.ts' })
    expect(first?.workspace.directory).toBe(directory)
    expect(first?.args.agent).toBe(join(source, 'agent.ts'))
    const marker = JSON.parse(await readFile(join(directory, 'tmp/initial.json'), 'utf8'))
    expect(await readFile(join(directory, 'tmp', marker.id, 'agent/agent.ts'), 'utf8')).toBe(original)
    expect(await readdir(join(directory, 'tmp', marker.id, 'agent'))).not.toContain('strands-dev')
    expect(await readdir(launch)).toEqual([])

    vi.mocked(process.cwd).mockReturnValue(source)
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
      open({ kind: 'cli' }, screen.signal, join(launch, 'strands-dev'))
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
      harnesses: [{ ...harness, preparationStatus: 'Needs setup' }],
      warnings: ['Workspace config version must be 1.'],
    })
    const reported: DiscoveredHarness[] = []
    vi.spyOn(picker, 'chooseHarness').mockImplementation(async (options, _screen, open) => {
      await options.search?.((found) => reported.push(found), _screen.signal)
      return open({ kind: 'discovered', harness }, _screen.signal)
    })
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    const prepared = await prepareDevRun(parseArgs(['dev', '--search-root', '../other']), { screen })

    expect(picker.chooseHarness).toHaveBeenCalledWith(
      {
        cli: { name: 'Saved CLI', path: 'in-memory' },
        harnesses: [],
        search: expect.any(Function),
        folderFor: expect.any(Function),
        newProject: join(cwd, 'strands-workspace'),
        modelNotice: expect.any(Function),
      },
      screen,
      expect.any(Function)
    )
    expect(reported).toEqual([{ ...harness, preparationStatus: 'Needs setup' }])
    expect(prepared?.workspace.root).toBe(root)
    expect(prepared?.workspace.directory).toBe(join(root, 'strands-dev'))
    expect(JSON.stringify(vi.mocked(picker.chooseHarness).mock.calls ?? [])).not.toContain(
      'Workspace config version must be 1.'
    )
    expect(search.discoverHarnesses).toHaveBeenCalledWith(
      [cwd, join(cwd, '../other')],
      expect.objectContaining({ found: expect.any(Function) })
    )
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

describe('workspace path option', () => {
  it.each<[string, (parent: string) => Promise<unknown>]>([
    ['a new folder', async () => undefined],
    [
      'a folder with other files',
      async (parent) => {
        await mkdir(parent)
        await writeFile(join(parent, 'notes.txt'), 'notes')
      },
    ],
  ])('shouldCreateAndReopenStrandsDevInsideTheWorkspacePathWhenItIs%s', async (_case, arrange) => {
    const parent = join(process.cwd(), 'chosen')
    await arrange(parent)
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const created = await prepareDevRun(parseArgs(['dev', 'init', '--create', 'typescript', '--workspace', parent]), {
      deferPreparation: true,
    })
    const reopened = await prepareDevRun(parseArgs(['dev', '--workspace', parent]), { deferPreparation: true })

    expect(created?.workspace.directory).toBe(join(parent, 'strands-dev'))
    expect(created?.args.dev?.workspace).toBe(join(parent, 'strands-dev'))
    expect(reopened?.workspace.entrypoint).toBe(created?.workspace.entrypoint)
  })

  it('shouldBindAnExplicitAgentInsideTheWorkspacePath', async () => {
    const parent = join(process.cwd(), 'chosen')
    const source = await fixture()
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const prepared = await prepareDevRun(
      parseArgs(['dev', 'init', '--agent', join(source, 'agent.ts'), '--workspace', parent]),
      { deferPreparation: true }
    )

    expect(prepared?.workspace.directory).toBe(join(parent, 'strands-dev'))
    expect(prepared?.workspace.root).toBe(source)
  })

  it.each<[string, string[], (launch: string) => Promise<unknown>, (launch: string) => string]>([
    [
      'the workspace path',
      ['--workspace', 'chosen'],
      async () => undefined,
      (launch) => join(launch, 'chosen', 'strands-dev'),
    ],
    [
      'no workspace path from a launch folder with an unrelated .config folder',
      [],
      (launch) => mkdir(join(launch, '.config')),
      () => strandsUserPath('strands-dev'),
    ],
  ])('shouldStartTheBaseCliFolderFieldWhenTheUserGives%s', async (_case, flags, arrange, expected) => {
    const launch = process.cwd()
    await arrange(launch)
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockResolvedValue(undefined)
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    await prepareDevRun(parseArgs(['dev', 'init', ...flags]), { screen, deferPreparation: true })

    expect(vi.mocked(picker.chooseHarness).mock.calls[0]?.[0].folderFor?.({ kind: 'cli' })).toEqual({
      path: expected(launch),
      detected: false,
    })
  })
})

describe('default workspace placement', () => {
  const pickerOptions = async (
    harnesses: DiscoveredHarness[],
    flags: string[] = []
  ): Promise<Parameters<typeof picker.chooseHarness>[0]> => {
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses, warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockResolvedValue(undefined)
    const screen = { signal: new AbortController().signal, show: vi.fn() }
    await prepareDevRun(parseArgs(['dev', ...flags]), { screen, deferPreparation: true })
    const options = vi.mocked(picker.chooseHarness).mock.calls[0]![0]
    await options.search?.(() => {}, new AbortController().signal)
    return options
  }
  const found = (root: string): DiscoveredHarness => ({
    name: 'Found',
    entrypoint: join(root, 'agent.ts'),
    root,
    language: 'typescript',
  })
  const createChoice: HarnessChoice = { kind: 'create', language: 'typescript', name: 'fresh' }

  it('shouldSuggestAStrandsDevFolderNextToEachFoundHarnessWhenThePickerOpens', async () => {
    const plain = await fixture()
    const taken = await fixture()
    await bindExistingAgent(join(taken, 'strands-dev'), join(await fixture(), 'agent.ts'))
    const bound = await fixture()
    const workspace = await bindExistingAgent(join(bound, 'strands-dev'), join(bound, 'agent.ts'))
    const moved = await fixture()
    const elsewhere = await bindExistingAgent(join(process.cwd(), 'elsewhere'), join(moved, 'agent.ts'))

    const options = await pickerOptions([
      found(plain),
      found(taken),
      { ...found(bound), workspace },
      { ...found(moved), workspace: elsewhere },
    ])

    const folder = (root: string): FolderSuggestion | undefined =>
      options.folderFor?.({ kind: 'discovered', harness: found(root) })
    expect(folder(plain)).toEqual({ path: join(plain, 'strands-dev'), detected: false })
    expect(folder(taken)).toEqual({
      path: join(taken, 'strands-dev'),
      detected: false,
      occupiedBy: expect.stringContaining('agent.ts'),
    })
    expect(folder(bound)).toEqual({ path: join(bound, 'strands-dev'), detected: true })
    expect(folder(moved)).toEqual({ path: join(moved, 'strands-dev'), detected: false })
    expect(options.folderFor?.(createChoice)).toBeUndefined()
  })

  it('shouldAskForTheFolderOfEveryChoiceWhenTheUserGivesAWorkspacePath', async () => {
    const root = await fixture()

    const options = await pickerOptions([found(root)], ['init', '--workspace', 'chosen'])

    const chosen = { path: join(process.cwd(), 'chosen', 'strands-dev'), detected: false }
    expect(options.folderFor?.({ kind: 'discovered', harness: found(root) })).toEqual(chosen)
    expect(options.folderFor?.(createChoice)).toEqual(chosen)
    expect(options.newProject).toBeUndefined()
  })

  it('shouldCreateTheNewHarnessInStrandsWorkspaceAndReuseItWhenTheSameHarnessIsCreatedAgain', async () => {
    const launch = process.cwd()
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockImplementation(async (_options, screen, open) =>
      open(createChoice, screen.signal)
    )
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    const first = await prepareDevRun(parseArgs(['dev']), { screen, deferPreparation: true })
    const second = await prepareDevRun(parseArgs(['dev']), { screen, deferPreparation: true })

    const project = join(launch, 'strands-workspace')
    expect(first?.workspace.root).toBe(project)
    expect(first?.workspace.directory).toBe(join(project, 'strands-dev'))
    expect(first?.workspace.config).toMatchObject({ name: 'fresh', origin: { kind: 'created' } })
    expect(JSON.parse(await readFile(join(project, 'strands-dev/.config'), 'utf8')).agent.path).toBe('..')
    expect(containsPath(project, first!.workspace.entrypoint)).toBe(true)
    expect(second?.workspace.root).toBe(project)
    expect(await readdir(launch)).toEqual(['strands-workspace'])
  })

  it('shouldAskBeforeReplacingStrandsWorkspaceWhenItHoldsAnotherNewHarness', async () => {
    const launch = process.cwd()
    const other: HarnessChoice = { kind: 'create', language: 'typescript', name: 'other' }
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness')
      .mockImplementationOnce(async (_options, screen, open) => open(createChoice, screen.signal))
      .mockImplementationOnce(async (_options, screen, open) => open(other, screen.signal))
      .mockImplementationOnce(async (_options, screen, open) => open(other, screen.signal, undefined, true))
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    await prepareDevRun(parseArgs(['dev']), { screen, deferPreparation: true })
    await expect(prepareDevRun(parseArgs(['dev']), { screen, deferPreparation: true })).rejects.toThrow(
      'Workspace folder is in use.'
    )
    const replaced = await prepareDevRun(parseArgs(['dev']), { screen, deferPreparation: true })
    await replaced!.keep()

    expect(replaced?.workspace.root).toBe(join(launch, 'strands-workspace'))
    expect(replaced?.workspace.config.name).toBe('other')
    expect(await readdir(launch)).toEqual(['strands-workspace'])
  })

  it('shouldSuggestTheFolderOfTheHarnessFileWhenDiscoveryFindsIt', async () => {
    const launch = process.cwd()
    const harness = 'from strands_harness import create_harness\n\nagent = create_harness(name="Desk")\n'
    const typescript =
      "import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ name: 'Desk' })\n"
    await mkdir(join(launch, 'arielnab'))
    await writeFile(join(launch, 'arielnab/agent.py'), harness)
    await mkdir(join(launch, 'repo/src'), { recursive: true })
    await writeFile(join(launch, 'repo/pyproject.toml'), '[project]\nname = "repo"\n')
    await writeFile(join(launch, 'repo/src/agent.py'), harness)
    await mkdir(join(launch, 'web/src'), { recursive: true })
    await writeFile(join(launch, 'web/package.json'), '{"type":"module"}')
    await writeFile(join(launch, 'web/src/agent.ts'), typescript)
    await mkdir(join(launch, 'exported/agent'), { recursive: true })
    await writeFile(join(launch, 'exported/agent/agent.py'), harness)
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(picker, 'chooseHarness').mockResolvedValue(undefined)
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    await prepareDevRun(parseArgs(['dev']), { screen, deferPreparation: true })

    const options = vi.mocked(picker.chooseHarness).mock.calls[0]![0]
    const harnesses = (await options.search?.(() => {}, new AbortController().signal)) ?? []
    const folders = Object.fromEntries(
      harnesses.map((harness) => [harness.entrypoint, options.folderFor?.({ kind: 'discovered', harness })?.path])
    )
    expect(folders).toEqual({
      [join(launch, 'arielnab/agent.py')]: join(launch, 'arielnab/strands-dev'),
      [join(launch, 'exported/agent/agent.py')]: join(launch, 'exported/agent/strands-dev'),
      [join(launch, 'repo/src/agent.py')]: join(launch, 'repo/src/strands-dev'),
      [join(launch, 'web/src/agent.ts')]: join(launch, 'web/src/strands-dev'),
    })
  })

  it('shouldRefuseTheFolderOfAnotherAgentWhenAgentIsGivenWithoutAWorkspace', async () => {
    const root = await fixture()
    await bindExistingAgent(join(root, 'strands-dev'), join(await fixture(), 'agent.ts'))
    const before = await readFile(join(root, 'strands-dev/.config'), 'utf8')
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    await expect(
      prepareDevRun(parseArgs(['dev', 'init', '--agent', join(root, 'agent.ts')]), { deferPreparation: true })
    ).rejects.toThrow(/Workspace folder is in use[\s\S]+--workspace <path>/u)
    expect(await readFile(join(root, 'strands-dev/.config'), 'utf8')).toBe(before)
    expect(await readdir(root)).not.toContain('strands-dev-2')
  })

  it('shouldPutTheWorkspaceNextToTheAgentFileWhenAgentPointsIntoASourceFolder', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'src/agent.ts'), 'export const agent = {}')
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const prepared = await prepareDevRun(parseArgs(['dev', 'init', '--agent', join(root, 'src/agent.ts')]), {
      deferPreparation: true,
    })

    expect(prepared?.workspace.root).toBe(root)
    expect(prepared?.workspace.directory).toBe(join(root, 'src/strands-dev'))
  })

  it('shouldPutTheWorkspaceNextToTheArchiveWhenAgentIsAZip', async () => {
    const folder = await temporaryDirectory()
    const archive = join(folder, 'agent.zip')
    await writeFile(
      archive,
      zipSync({
        'package.json': strToU8('{"type":"module"}'),
        'agent.ts': strToU8("import { createHarness } from '@strands-agents/harness'\nexport const agent = {}\n"),
      })
    )
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const prepared = await prepareDevRun(parseArgs(['dev', 'init', '--agent', archive]), { deferPreparation: true })

    expect(prepared?.workspace.directory).toBe(join(folder, 'strands-dev'))
  })

  it.each<[string, (launch: string) => Promise<string | undefined>, (launch: string, project?: string) => string]>([
    ['only a saved profile', async () => undefined, () => strandsUserPath('strands-dev')],
    ['a saved project', async () => fixture(), () => strandsUserPath('strands-dev')],
  ])('shouldUseTheStrandsFolderWhenCreatingTheCliHarnessWith%s', async (_case, arrange, expected) => {
    const launch = process.cwd()
    const project = await arrange(launch)
    const saved = config()
    if (project) await saved.useAgentProject(join(project, 'agent.ts'))
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(saved)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const prepared = await prepareDevRun(parseArgs(['dev', 'init', '--create', 'cli']), { deferPreparation: true })

    expect(prepared?.workspace.directory).toBe(expected(launch, project))
  })

  it('shouldReopenTheCreatedProjectWhenTheSameHarnessIsCreatedAgain', async () => {
    const launch = process.cwd()
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const create = (): ReturnType<typeof prepareDevRun> =>
      prepareDevRun(parseArgs(['dev', 'init', '--create', 'python']), { deferPreparation: true })

    const first = await create()
    const second = await create()

    expect(second?.workspace.root).toBe(first?.workspace.root)
    expect(await readdir(launch)).toEqual(['strands-workspace'])
  })

  it('shouldBindALegacyStrandsDevRootInPlaceWhenItIsReopened', async () => {
    const launch = process.cwd()
    const root = join(launch, 'strands-dev')
    await mkdir(root)
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'agent.ts'), 'export const agent = {}')
    await initializeDevWorkspace(root, {
      version: 1,
      name: 'Legacy',
      language: 'typescript',
      entrypoint: 'agent.ts',
      origin: { kind: 'discovered' },
    })
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const prepared = await prepareDevRun(parseArgs(['dev', 'init']), { deferPreparation: true })

    expect(prepared?.workspace.directory).toBe(root)
    await expect(readdir(join(root, 'strands-dev'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['typescript', 'python'])(
    'shouldCreateTheProjectAndItsWorkspaceInTheLaunchFolderWhenCreatingA%sHarness',
    async (language) => {
      const launch = process.cwd()
      vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
      vi.spyOn(process.stderr, 'write').mockReturnValue(true)

      const prepared = await prepareDevRun(parseArgs(['dev', 'init', '--create', language]), {
        deferPreparation: true,
      })

      expect(prepared?.workspace.root).toBe(join(launch, 'strands-workspace'))
      expect(prepared?.workspace.directory).toBe(join(launch, 'strands-workspace', 'strands-dev'))
      expect(prepared?.workspace.config.language).toBe(language)
    }
  )
})

describe('workspace folder selection', () => {
  const selectInFolder = async (
    choice: (root: string) => HarnessChoice,
    folder: string,
    root?: string,
    replace?: boolean
  ) => {
    const harnessRoot = root ?? (await fixture())
    const harness = {
      name: 'Local',
      entrypoint: join(harnessRoot, 'agent.ts'),
      root: harnessRoot,
      language: 'typescript' as const,
    }
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [harness], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockImplementation(async (_options, screen, open) =>
      open(choice(harnessRoot), screen.signal, folder, replace)
    )
    const screen = { signal: new AbortController().signal, show: vi.fn() }
    return prepareDevRun(parseArgs(['dev']), { screen, deferPreparation: true })
  }
  const discovered = (root: string): HarnessChoice => ({
    kind: 'discovered',
    harness: { name: 'Local', entrypoint: join(root, 'agent.ts'), root, language: 'typescript' },
  })

  it.each([
    ['an absolute path', (launch: string) => join(launch, 'custom/workspace')],
    ['a path relative to the launch folder', () => 'custom/workspace'],
  ])('shouldBindTheAgentInsideTheChosenFolderWhenItIs%s', async (_case, folder) => {
    const launch = process.cwd()

    const prepared = await selectInFolder(discovered, folder(launch))

    expect(prepared?.workspace.directory).toBe(join(launch, 'custom/workspace/strands-dev'))
    expect(JSON.parse(await readFile(join(launch, 'custom/workspace/strands-dev/.config'), 'utf8')).origin.kind).toBe(
      'discovered'
    )
    await expect(readdir(join(launch, 'strands-dev'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each<[string, (folder: string) => Promise<unknown>]>([
    ['is empty', (folder) => mkdir(folder)],
    [
      'holds other files',
      async (folder) => {
        await mkdir(folder)
        await writeFile(join(folder, 'notes.txt'), 'notes')
      },
    ],
  ])('shouldCreateStrandsDevInsideTheChosenFolderWhenIt%s', async (_case, arrange) => {
    const folder = join(process.cwd(), 'chosen')
    await arrange(folder)

    const prepared = await selectInFolder(() => ({ kind: 'create', language: 'typescript', name: 'fresh' }), folder)

    expect(prepared?.workspace.directory).toBe(join(folder, 'strands-dev'))
    expect(prepared?.workspace.config).toMatchObject({ name: 'fresh', origin: { kind: 'created' } })
  })

  it('shouldCreateANewHarnessInPlaceWhenTheChosenFolderIsAnEmptyStrandsDevFolder', async () => {
    const folder = join(process.cwd(), 'strands-dev')
    await mkdir(folder)

    const prepared = await selectInFolder(() => ({ kind: 'create', language: 'typescript', name: 'fresh' }), folder)

    expect(prepared?.workspace.directory).toBe(folder)
  })

  it('shouldReuseTheFolderWhenItAlreadyHoldsTheSelectedAgent', async () => {
    const root = await fixture()
    const folder = join(process.cwd(), 'existing')
    await bindExistingAgent(folder, join(root, 'agent.ts'))
    const before = await readFile(join(folder, '.config'), 'utf8')

    const prepared = await selectInFolder(discovered, folder, root)

    expect(prepared?.workspace.directory).toBe(folder)
    expect(await readFile(join(folder, '.config'), 'utf8')).toBe(before)
  })

  it.each<[string, (root: string) => HarnessChoice]>([
    ['a local project', discovered],
    ['the Base CLI', () => ({ kind: 'cli' })],
    ['a new harness', () => ({ kind: 'create', language: 'python', name: 'fresh' })],
  ])('shouldRefuseAFolderThatHoldsAnotherAgentWhenTheChoiceIs%s', async (_case, choice) => {
    const folder = join(process.cwd(), 'taken')
    await bindExistingAgent(folder, join(await fixture(), 'agent.ts'))
    const before = await readFile(join(folder, '.config'), 'utf8')

    await expect(selectInFolder(choice, folder)).rejects.toThrow('Workspace folder is in use.')
    expect(await readFile(join(folder, '.config'), 'utf8')).toBe(before)
  })

  const backups = async (folder: string): Promise<string[]> =>
    (await readdir(dirname(folder))).filter((name) => name.startsWith(`.${basename(folder)}-`))

  it.each<[string, (root: string) => HarnessChoice, string]>([
    ['a local project', discovered, 'discovered'],
    ['the Base CLI', () => ({ kind: 'cli' }), 'cli'],
    ['a new harness', () => ({ kind: 'create', language: 'python', name: 'fresh' }), 'created'],
  ])('shouldReplaceTheFolderAndKeepABackupUntilSetupSucceedsWhenTheChoiceIs%s', async (_case, choice, kind) => {
    const folder = join(process.cwd(), 'taken')
    await bindExistingAgent(folder, join(await fixture(), 'agent.ts'))

    const prepared = await selectInFolder(choice, folder, undefined, true)

    expect(prepared?.workspace.directory).toBe(folder)
    expect(JSON.parse(await readFile(join(folder, '.config'), 'utf8')).origin.kind).toBe(kind)
    expect(await backups(folder)).toHaveLength(1)
    await prepared!.keep()
    expect(await backups(folder)).toEqual([])
  })

  it('shouldPutTheOldFolderBackWhenOpeningTheNewAgentFailsAfterTheReplace', async () => {
    const root = await fixture()
    const folder = join(process.cwd(), 'taken')
    await bindExistingAgent(folder, join(await fixture(), 'agent.ts'))
    const before = await readFile(join(folder, '.config'), 'utf8')
    await rm(join(root, 'agent.ts'))

    await expect(selectInFolder(discovered, folder, root, true)).rejects.toThrow()

    expect(await readFile(join(folder, '.config'), 'utf8')).toBe(before)
    expect(await backups(folder)).toEqual([])
  })

  it('shouldPutTheOldFolderBackBeforeTheNextChoiceWhenOpeningFailsAfterTheReplace', async () => {
    const root = await fixture()
    const folder = join(process.cwd(), 'taken')
    await bindExistingAgent(folder, join(await fixture(), 'agent.ts'))
    const before = await readFile(join(folder, '.config'), 'utf8')
    await rm(join(root, 'agent.ts'))
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockImplementation(async (_options, screen, open) => {
      await expect(open(discovered(root), screen.signal, folder, true)).rejects.toThrow()
      expect(await readFile(join(folder, '.config'), 'utf8')).toBe(before)
      return open({ kind: 'create', language: 'typescript', name: 'fresh' }, screen.signal, 'other')
    })
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    const prepared = await prepareDevRun(parseArgs(['dev']), { screen, deferPreparation: true })
    await prepared!.keep()

    expect(prepared?.workspace.directory).toBe(join(process.cwd(), 'other/strands-dev'))
    expect(await readFile(join(folder, '.config'), 'utf8')).toBe(before)
    expect(await backups(folder)).toEqual([])
  })

  it('shouldKeepTheBackupOutsideTheProjectWhenTheWorkspaceIsInsideIt', async () => {
    const root = await fixture()
    const folder = join(root, 'strands-dev')
    await bindExistingAgent(folder, join(await fixture(), 'agent.ts'))

    const prepared = await selectInFolder(discovered, folder, root, true)

    expect(prepared?.workspace.directory).toBe(folder)
    expect((await readdir(root)).filter((name) => name.endsWith('.replaced'))).toEqual([])
    expect((await readdir(dirname(root))).filter((name) => name.startsWith('.strands-dev-'))).toHaveLength(1)
    await prepared!.keep()
    expect((await readdir(dirname(root))).filter((name) => name.startsWith('.strands-dev-'))).toEqual([])
  })

  it('shouldListenForExitOnlyWhileAReplacedFolderCanBeRestored', async () => {
    const folder = join(process.cwd(), 'taken')
    await bindExistingAgent(folder, join(await fixture(), 'agent.ts'))
    const before = await readFile(join(folder, '.config'), 'utf8')
    const listeners = process.listenerCount('exit')

    const prepared = await selectInFolder(discovered, folder, undefined, true)
    expect(process.listenerCount('exit')).toBe(listeners + 1)
    const restore = process.listeners('exit').at(-1) as () => void
    restore()

    expect(await readFile(join(folder, '.config'), 'utf8')).toBe(before)
    expect(await backups(folder)).toEqual([])
    await prepared!.discard()
    expect(process.listenerCount('exit')).toBe(listeners)
  })

  it('shouldRestoreTheReplacedWorkspaceWhenTheUserGoesBack', async () => {
    const folder = join(process.cwd(), 'taken')
    await bindExistingAgent(folder, join(await fixture(), 'agent.ts'))
    const before = await readFile(join(folder, '.config'), 'utf8')

    const prepared = await selectInFolder(discovered, folder, undefined, true)
    await prepared!.discard()

    expect(await readFile(join(folder, '.config'), 'utf8')).toBe(before)
    expect(await backups(folder)).toEqual([])
  })

  it.each<[string, 'cli' | 'created', HarnessChoice]>([
    ['the Base CLI', 'cli', { kind: 'cli' }],
    ['the same new harness', 'created', { kind: 'create', language: 'typescript', name: 'fresh' }],
  ])('shouldReuseTheFolderWhenItHoldsAWorkspaceFor%s', async (_case, kind, choice) => {
    const root = await fixture()
    const folder = join(process.cwd(), 'existing')
    await mkdir(folder)
    await bindWorkspace(folder, {
      version: 1,
      name: 'fresh',
      agent: { path: root, entrypoint: 'agent.ts', language: 'typescript' },
      origin: { kind },
    })
    const before = await readFile(join(folder, '.config'), 'utf8')

    const prepared = await selectInFolder(() => choice, folder)

    expect(prepared?.workspace.directory).toBe(folder)
    expect(prepared?.workspace.root).toBe(root)
    expect(await readFile(join(folder, '.config'), 'utf8')).toBe(before)
  })

  it('shouldExpandTheHomeFolderInTheChosenPath', async () => {
    const prepared = await selectInFolder(discovered, '~/dev-workspace')

    expect(prepared?.workspace.directory).toBe(join(homedir(), 'dev-workspace', 'strands-dev'))
  })

  it('shouldReportABrokenBindingInTheChosenFolderWithoutReplacingIt', async () => {
    const folder = join(process.cwd(), 'broken')
    await mkdir(folder)
    await writeFile(join(folder, '.config'), '{')

    await expect(selectInFolder(discovered, folder)).rejects.toThrow('Invalid JSON in workspace binding')
    expect(await readFile(join(folder, '.config'), 'utf8')).toBe('{')
  })

  it.each<[string, () => Promise<unknown>, Record<string, unknown>]>([
    [
      'its own workspace',
      () => prepareDevRun(parseArgs(['dev', 'init', '--create', 'cli']), { deferPreparation: true }),
      { detected: true },
    ],
    [
      'the workspace of another agent',
      async () => bindExistingAgent(strandsUserPath('strands-dev'), join(await fixture(), 'agent.ts')),
      { detected: false, occupiedBy: expect.stringContaining('agent.ts') },
    ],
    [
      'a Base CLI workspace made from another agent',
      async () => {
        await mkdir(strandsUserPath('strands-dev'), { recursive: true })
        const other = await fixture()
        await bindWorkspace(strandsUserPath('strands-dev'), {
          version: 1,
          name: 'Strands harness',
          agent: { path: other, entrypoint: 'agent.ts', language: 'typescript' },
          origin: { kind: 'cli', source: join(other, 'agent.ts') },
        })
      },
      { detected: false, occupiedBy: expect.stringContaining('Strands harness') },
    ],
  ])('shouldReportWhetherTheBaseCliFolderHolds%s', async (_case, arrange, expected) => {
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await arrange()
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockResolvedValue(undefined)
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    await prepareDevRun(parseArgs(['dev']), { screen, deferPreparation: true })

    expect(vi.mocked(picker.chooseHarness).mock.calls[0]?.[0].folderFor?.({ kind: 'cli' })).toEqual({
      path: strandsUserPath('strands-dev'),
      ...expected,
    })
  })

  it('shouldCreateANewProjectWhenTheBaseCliFolderHasABrokenBinding', async () => {
    await mkdir(strandsUserPath('strands-dev'), { recursive: true })
    await writeFile(strandsUserPath('strands-dev/.config'), '{')
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const prepared = await prepareDevRun(parseArgs(['dev', 'init', '--create', 'typescript']), {
      deferPreparation: true,
    })

    expect(prepared?.workspace.root).toBe(join(process.cwd(), 'strands-workspace'))
  })

  it('shouldCreateTheNewHarnessInAnEmptyStrandsWorkspaceFolder', async () => {
    await mkdir(join(process.cwd(), 'strands-workspace'))
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const prepared = await prepareDevRun(parseArgs(['dev', 'init', '--create', 'typescript']), {
      deferPreparation: true,
    })

    expect(prepared?.workspace.directory).toBe(join(process.cwd(), 'strands-workspace', 'strands-dev'))
  })

  it.each([
    ['its agent project is a folder', true],
    ['its config path goes through a symbolic link', false],
  ])('shouldMatchTheBaseCliWorkspaceWhen%s', async (_case, project) => {
    const other = await fixture()
    const real = await temporaryDirectory()
    const linked = join(await temporaryDirectory(), 'linked')
    await symlink(real, linked)
    await writeFile(
      join(real, 'cli.toml'),
      `${project ? `agentProject = "${other}"\n` : ''}[profile]\nname = "Saved"\n`
    )
    await mkdir(strandsUserPath('strands-dev'), { recursive: true })
    await bindWorkspace(strandsUserPath('strands-dev'), {
      version: 1,
      name: 'Saved',
      agent: { path: other, entrypoint: 'agent.ts', language: 'typescript' },
      origin: { kind: 'cli', source: project ? join(other, 'agent.ts') : join(real, 'cli.toml') },
    })
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(
      await CliConfigStore.load(join(linked, 'cli.toml'), { persist: false })
    )
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockResolvedValue(undefined)

    await prepareDevRun(parseArgs(['dev']), {
      screen: { signal: new AbortController().signal, show: vi.fn() },
      deferPreparation: true,
    })

    expect(vi.mocked(picker.chooseHarness).mock.calls[0]?.[0].folderFor?.({ kind: 'cli' })).toEqual({
      path: strandsUserPath('strands-dev'),
      detected: true,
    })
  })

  it('shouldListTheAgentOfAStaleBaseCliWorkspaceAsADiscoveredProject', async () => {
    const other = await fixture()
    await mkdir(strandsUserPath('strands-dev'), { recursive: true })
    await bindWorkspace(strandsUserPath('strands-dev'), {
      version: 1,
      name: 'Strands harness',
      agent: { path: other, entrypoint: 'agent.ts', language: 'typescript' },
      origin: { kind: 'cli', source: join(other, 'agent.ts') },
    })
    const harness = { name: 'Other', entrypoint: join(other, 'agent.ts'), root: other, language: 'typescript' as const }
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [harness], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockResolvedValue(undefined)

    await prepareDevRun(parseArgs(['dev']), {
      screen: { signal: new AbortController().signal, show: vi.fn() },
      deferPreparation: true,
    })

    const options = vi.mocked(picker.chooseHarness).mock.calls[0]![0]
    const listed = (await options.search?.(() => {}, new AbortController().signal)) ?? []
    expect(listed.map(({ entrypoint }) => entrypoint)).toEqual([join(other, 'agent.ts')])
    expect(options.cli?.name).toBe('Saved CLI')
  })

  it.each([
    ['is a strands-dev folder with other files', 'The folder already contains files.'],
    ['is a file', 'The path is a file, not a folder.'],
  ])('shouldRefuseAPathThat%s', async (kind, message) => {
    const folder = join(process.cwd(), kind === 'is a file' ? 'used' : 'strands-dev')
    if (kind === 'is a file') await writeFile(folder, 'notes')
    else {
      await mkdir(folder)
      await writeFile(join(folder, 'notes.txt'), 'notes')
    }

    await expect(selectInFolder(discovered, folder)).rejects.toThrow(message)
    await expect(readFile(join(folder, '.config'))).rejects.toMatchObject({
      code: expect.stringMatching(/ENOENT|ENOTDIR/),
    })
  })
})

describe('new harness model', () => {
  it('shouldTellTheCreateFormWhichLanguageCannotLoadTheSavedModelModule', async () => {
    const store = CliConfigStore.memory(
      {},
      {},
      {
        profile: {
          name: 'Saved CLI',
          skills: false,
          model: 'bedrock/us.example.model',
          modelModule: { kind: 'model', module: './models/custom.mjs', files: ['./models/custom.mjs'] },
        },
      }
    )
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(store)
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockResolvedValue(undefined)

    await prepareDevRun(parseArgs(['dev']), {
      screen: { signal: new AbortController().signal, show: vi.fn() },
      deferPreparation: true,
    })

    const options = vi.mocked(picker.chooseHarness).mock.calls[0]![0]
    expect(options.modelNotice?.('python')).toBe(
      'Python cannot load the model module custom.mjs. The new harness uses bedrock/us.example.model.'
    )
    expect(options.modelNotice?.('typescript')).toBeUndefined()
  })
})

describe('selection after the user goes back', () => {
  const failedHarness = async (): Promise<DiscoveredHarness> => {
    const root = await fixture()
    return { name: 'Failed', entrypoint: join(root, 'agent.ts'), root, language: 'typescript' }
  }
  const exists = async (path: string): Promise<boolean> =>
    readdir(path).then(
      () => true,
      () => false
    )
  const screen = () => ({ signal: new AbortController().signal, show: vi.fn() })
  interface Reselection {
    first: HarnessChoice
    second?: HarnessChoice
    flags?: string[]
    folder?: string
  }
  const selectTwice = async (
    store: CliConfigStore,
    failed: DiscoveredHarness,
    { first, second, flags = [], folder }: Reselection
  ) => {
    const savedConfig = store.snapshot()
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [failed], warnings: [] })
    vi.spyOn(picker, 'chooseHarness')
      .mockImplementationOnce(async (_options, screen, open) => open(first, screen.signal, folder))
      .mockImplementationOnce(async (_options, screen, open) => (second ? open(second, screen.signal) : undefined))
    const args = parseArgs(['dev', ...flags])
    const options = { config: store, savedConfig, screen: screen(), deferPreparation: true }
    const rejected = (await prepareDevRun(args, options))!
    const prepared = await prepareDevRun(args, { ...options, rejected })
    const picked = vi.mocked(picker.chooseHarness).mock.calls[1]![0]
    const listed = (await picked.search?.(() => {}, new AbortController().signal)) ?? []
    return { rejected, prepared, picked, listed: listed.map(({ entrypoint }) => entrypoint) }
  }

  it.each<[string, (failed: DiscoveredHarness) => HarnessChoice, string[]]>([
    ['TheFailedHarness', (harness) => ({ kind: 'discovered', harness }), []],
    [
      'TheFailedHarnessInTheWorkspaceFolder',
      (harness) => ({ kind: 'discovered', harness }),
      ['init', '--workspace', 'chosen'],
    ],
    ['ANewHarness', () => ({ kind: 'create', language: 'typescript', name: 'fresh' }), []],
  ])('shouldOfferTheSavedBaseCliAndListEveryHarnessAfter%s', async (_case, first, flags) => {
    const failed = await failedHarness()

    const { picked, listed } = await selectTwice(config(), failed, { first: first(failed), flags })

    expect(picked.cli).toEqual({ name: 'Saved CLI', path: 'in-memory' })
    expect(listed).toEqual([failed.entrypoint])
  })

  it('shouldBindTheBaseCliToItsSavedProject', async () => {
    const base = await fixture()
    const store = config()
    await store.useAgentProject(join(base, 'agent.ts'))
    const failed = await failedHarness()

    const { prepared } = await selectTwice(store, failed, {
      first: { kind: 'discovered', harness: failed },
      second: { kind: 'cli' },
    })

    expect(prepared?.workspace.root).toBe(base)
    expect(prepared?.workspace.config.origin).toEqual({ kind: 'cli', source: join(base, 'agent.ts') })
  })

  it.each<[string, (failed: DiscoveredHarness) => Reselection, (failed: DiscoveredHarness) => string]>([
    [
      'AFoundHarness',
      (harness) => ({ first: { kind: 'discovered', harness } }),
      ({ root }) => join(root, 'strands-dev'),
    ],
    [
      'ANewHarness',
      () => ({ first: { kind: 'create', language: 'typescript', name: 'fresh' } }),
      () => join(process.cwd(), 'strands-workspace'),
    ],
    ['TheBaseCli', () => ({ first: { kind: 'cli' } }), () => strandsUserPath('strands-dev')],
    [
      'AFolderWithNewParents',
      (harness) => ({ first: { kind: 'discovered', harness }, folder: join(process.cwd(), 'new/place') }),
      () => join(process.cwd(), 'new'),
    ],
  ])('shouldDeleteWhatTheRejectedRunMadeFor%s', async (_case, reselection, made) => {
    const failed = await failedHarness()

    const { rejected, picked } = await selectTwice(config(), failed, reselection(failed))

    expect(containsPath(made(failed), rejected.workspace.directory!)).toBe(true)
    expect(await exists(made(failed))).toBe(false)
    expect((await readdir(failed.root)).sort()).toEqual(['agent.ts', 'package.json'])
    expect(picked.folderFor?.({ kind: 'discovered', harness: failed })).toEqual({
      path: join(failed.root, 'strands-dev'),
      detected: false,
    })
    expect(picked.newProject).toBe(join(process.cwd(), 'strands-workspace'))
  })

  it('shouldKeepAFolderThatTheRejectedRunMadeWhenItGotOtherFiles', async () => {
    const store = config()
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness')
      .mockImplementationOnce(async (_options, screen, open) => open({ kind: 'cli' }, screen.signal))
      .mockResolvedValueOnce(undefined)
    const options = { config: store, savedConfig: store.snapshot(), screen: screen(), deferPreparation: true }
    const rejected = (await prepareDevRun(parseArgs(['dev']), options))!
    await writeFile(strandsUserPath('cli.toml'), '[profile]\n')

    await prepareDevRun(parseArgs(['dev']), { ...options, rejected })

    expect(rejected.workspace.directory).toBe(strandsUserPath('strands-dev'))
    expect(await readdir(strandsUserPath())).toEqual(['cli.toml'])
  })

  it('shouldDeleteTheWorkspaceThatAnAgentFlagMade', async () => {
    const failed = await failedHarness()
    const store = config()
    vi.spyOn(picker, 'chooseHarness').mockResolvedValue(undefined)
    const options = { config: store, savedConfig: store.snapshot(), screen: screen(), deferPreparation: true }

    const rejected = await prepareDevRun(parseArgs(['dev', '--agent', failed.entrypoint]), options)
    await prepareDevRun(parseArgs(['dev']), { ...options, rejected: rejected! })

    expect(rejected?.workspace.directory).toBe(join(failed.root, 'strands-dev'))
    expect(await exists(join(failed.root, 'strands-dev'))).toBe(false)
  })

  it('shouldEmptyAnEmptyFolderThatTheRejectedRunFilled', async () => {
    const failed = await failedHarness()
    const folder = join(process.cwd(), 'strands-dev')
    await mkdir(folder)

    await selectTwice(config(), failed, { first: { kind: 'discovered', harness: failed }, folder })

    expect(await readdir(folder)).toEqual([])
  })

  it('shouldKeepAWorkspaceThatExistedBeforeTheRejectedRunAndSuggestItAgain', async () => {
    const failed = await failedHarness()
    const folder = join(failed.root, 'strands-dev')
    await bindExistingAgent(folder, failed.entrypoint)
    const before = await readFile(join(folder, '.config'), 'utf8')

    const { picked } = await selectTwice(config(), failed, { first: { kind: 'discovered', harness: failed } })

    expect(await readFile(join(folder, '.config'), 'utf8')).toBe(before)
    expect(picked.folderFor?.({ kind: 'discovered', harness: failed })).toEqual({ path: folder, detected: true })
  })

  it('shouldSuggestTheHarnessFolderInsteadOfANumberedOneAfterTheUserGoesBack', async () => {
    const failed = await failedHarness()
    await mkdir(join(failed.root, 'strands-dev'))
    await writeFile(join(failed.root, 'strands-dev/notes.txt'), 'notes')
    const kept = join(failed.root, 'strands-dev-2')
    await bindExistingAgent(kept, failed.entrypoint)

    const { picked } = await selectTwice(config(), failed, {
      first: { kind: 'discovered', harness: failed },
      folder: kept,
    })

    expect(await exists(kept)).toBe(true)
    expect(picked.folderFor?.({ kind: 'discovered', harness: failed })).toEqual({
      path: join(failed.root, 'strands-dev'),
      detected: false,
    })
    expect(await exists(join(failed.root, 'strands-dev-3'))).toBe(false)
  })

  it('shouldReuseTheKeptWorkspaceAfterASecondBack', async () => {
    const failed = await failedHarness()
    const kept = join(failed.root, 'strands-dev')
    await bindExistingAgent(kept, failed.entrypoint)
    const store = config()
    const discovered = { kind: 'discovered', harness: failed } as const
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [failed], warnings: [] })
    vi.spyOn(picker, 'chooseHarness')
      .mockImplementationOnce(async (_options, screen, open) => open(discovered, screen.signal))
      .mockImplementationOnce(async (options, screen, open) => {
        await options.search?.(() => {}, screen.signal)
        return open(discovered, screen.signal)
      })
      .mockResolvedValueOnce(undefined)
    const options = { config: store, savedConfig: store.snapshot(), screen: screen(), deferPreparation: true }

    const first = (await prepareDevRun(parseArgs(['dev']), options))!
    const second = (await prepareDevRun(parseArgs(['dev']), { ...options, rejected: first }))!
    await prepareDevRun(parseArgs(['dev']), { ...options, rejected: second })

    const picked = vi.mocked(picker.chooseHarness).mock.calls[2]![0]
    await picked.search?.(() => {}, new AbortController().signal)
    expect(second.workspace.directory).toBe(kept)
    expect(await exists(kept)).toBe(true)
    expect(await exists(join(failed.root, 'strands-dev-2'))).toBe(false)
    expect(picked.folderFor?.(discovered)).toEqual({ path: kept, detected: true })
  })

  it('shouldSuggestTheKeptBaseCliWorkspaceAgainAfterItWasRejected', async () => {
    await mkdir(strandsUserPath(), { recursive: true })
    await mkdir(strandsUserPath('strands-dev'))
    await bindWorkspace(strandsUserPath('strands-dev'), {
      version: 1,
      name: 'Saved CLI',
      agent: { path: await fixture(), entrypoint: 'agent.ts', language: 'typescript' },
      origin: { kind: 'cli' },
    })
    await mkdir(strandsUserPath('strands-dev-2'))
    await writeFile(strandsUserPath('strands-dev-2/notes.txt'), 'notes')

    const { picked } = await selectTwice(config(), await failedHarness(), { first: { kind: 'cli' } })

    expect(await exists(strandsUserPath('strands-dev'))).toBe(true)
    expect(picked.folderFor?.({ kind: 'cli' })).toEqual({ path: strandsUserPath('strands-dev'), detected: true })
    expect(await exists(strandsUserPath('strands-dev-3'))).toBe(false)
  })

  it('shouldReuseTheBaseCliWorkspaceWhenAnotherHarnessWasRejected', async () => {
    await mkdir(strandsUserPath('strands-dev'), { recursive: true })
    await bindWorkspace(strandsUserPath('strands-dev'), {
      version: 1,
      name: 'Saved CLI',
      agent: { path: await fixture(), entrypoint: 'agent.ts', language: 'typescript' },
      origin: { kind: 'cli' },
    })
    const failed = await failedHarness()

    const { picked } = await selectTwice(config(), failed, { first: { kind: 'discovered', harness: failed } })

    expect(picked.folderFor?.({ kind: 'cli' })).toEqual({ path: strandsUserPath('strands-dev'), detected: true })
  })

  it('shouldWarnInThePickerWhenTheRejectedFoldersCannotBeDeleted', async () => {
    const failed = await failedHarness()
    const store = config()
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [failed], warnings: [] })
    vi.spyOn(picker, 'chooseHarness')
      .mockImplementationOnce(async (_options, screen, open) =>
        open({ kind: 'discovered', harness: failed }, screen.signal)
      )
      .mockResolvedValueOnce(undefined)
    const options = { config: store, savedConfig: store.snapshot(), screen: screen(), deferPreparation: true }
    const rejected = (await prepareDevRun(parseArgs(['dev']), options))!

    await prepareDevRun(parseArgs(['dev']), {
      ...options,
      rejected: { ...rejected, discard: vi.fn().mockRejectedValue(new Error('EBUSY: resource busy')) },
    })

    expect(vi.mocked(picker.chooseHarness).mock.calls[1]![0].warning).toBe(
      'Could not delete the folders of the failed setup: EBUSY: resource busy'
    )
  })
})
