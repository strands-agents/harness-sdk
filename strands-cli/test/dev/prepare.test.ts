import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../../src/cli/arguments.js'
import { containsPath } from '../../src/paths.js'
import { CliConfigStore } from '../../src/config/store.js'
import { bindWorkspace } from '../../src/dev/binding.js'
import { bindExistingAgent } from '../../src/dev/create.js'
import type { HarnessChoice } from '../../src/dev/picker.js'
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
      harnesses: [{ ...harness, preparationStatus: 'Needs setup' }],
      warnings: ['Workspace config version must be 1.'],
    })
    vi.spyOn(picker, 'chooseHarness').mockImplementation(async (_options, _screen, open) =>
      open({ kind: 'discovered', harness }, _screen.signal)
    )
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    const prepared = await prepareDevRun(parseArgs(['dev', '--search-root', '../other']), { screen })

    expect(picker.chooseHarness).toHaveBeenCalledWith(
      {
        cli: { name: 'Saved CLI', path: 'in-memory' },
        harnesses: [{ ...harness, preparationStatus: 'Needs setup' }],
        folderFor: expect.any(Function),
        newProject: join(cwd, 'strands-workspace'),
      },
      screen,
      expect.any(Function)
    )
    expect(prepared?.workspace.root).toBe(root)
    expect(prepared?.workspace.directory).toBe(join(root, 'strands-dev'))
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
      'a launch folder with an unrelated .config folder',
      [],
      (launch) => mkdir(join(launch, '.config')),
      (launch) => join(launch, 'strands-dev'),
    ],
  ])('shouldStartTheFolderFieldInsideStrandsDevWhenTheUserGives%s', async (_case, flags, arrange, expected) => {
    const launch = process.cwd()
    await arrange(launch)
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockResolvedValue(undefined)
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    await prepareDevRun(parseArgs(['dev', 'init', ...flags]), { screen, deferPreparation: true })

    expect(vi.mocked(picker.chooseHarness).mock.calls[0]?.[0].folderFor?.({ kind: 'cli' })).toBe(expected(launch))
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
    return vi.mocked(picker.chooseHarness).mock.calls[0]![0]
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
    const reopened = await fixture()
    const workspace = await bindExistingAgent(join(process.cwd(), 'elsewhere'), join(reopened, 'agent.ts'))

    const options = await pickerOptions([found(plain), found(taken), { ...found(reopened), workspace }])

    expect(options.folderFor?.({ kind: 'discovered', harness: found(plain) })).toBe(join(plain, 'strands-dev'))
    expect(options.folderFor?.({ kind: 'discovered', harness: found(taken) })).toBe(join(taken, 'strands-dev-2'))
    expect(options.folderFor?.({ kind: 'discovered', harness: found(reopened) })).toBe(join(process.cwd(), 'elsewhere'))
    expect(options.folderFor?.(createChoice)).toBeUndefined()
  })

  it('shouldAskForTheFolderOfEveryChoiceWhenTheUserGivesAWorkspacePath', async () => {
    const root = await fixture()

    const options = await pickerOptions([found(root)], ['init', '--workspace', 'chosen'])

    expect(options.folderFor?.({ kind: 'discovered', harness: found(root) })).toBe(
      join(process.cwd(), 'chosen', 'strands-dev')
    )
    expect(options.folderFor?.(createChoice)).toBe(join(process.cwd(), 'chosen', 'strands-dev'))
    expect(options.newProject).toBeUndefined()
  })

  it('shouldCreateTheNewHarnessInStrandsWorkspaceInTheLaunchFolderWhenItHasNoFolder', async () => {
    const launch = process.cwd()
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockImplementation(async (_options, screen, open) =>
      open(createChoice, screen.signal)
    )
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    const first = await prepareDevRun(parseArgs(['dev']), { screen, deferPreparation: true })
    const second = await prepareDevRun(parseArgs(['dev']), { screen, deferPreparation: true, forceSelection: true })

    const project = join(launch, 'strands-workspace')
    expect(first?.workspace.root).toBe(project)
    expect(first?.workspace.directory).toBe(join(project, 'strands-dev'))
    expect(first?.workspace.config).toMatchObject({ name: 'fresh', origin: { kind: 'created' } })
    expect(JSON.parse(await readFile(join(project, 'strands-dev/.config'), 'utf8')).agent.path).toBe('..')
    expect(containsPath(project, first!.workspace.entrypoint)).toBe(true)
    expect(second?.workspace.root).toBe(join(launch, 'strands-workspace-2'))
    expect((await readdir(launch)).sort()).toEqual(['strands-workspace', 'strands-workspace-2'])
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
  const selectInFolder = async (choice: (root: string) => HarnessChoice, folder: string, root?: string) => {
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
      open(choice(harnessRoot), screen.signal, folder)
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

    await expect(selectInFolder(choice, folder)).rejects.toThrow('The folder contains the workspace of')
    expect(await readFile(join(folder, '.config'), 'utf8')).toBe(before)
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

  it('shouldSuggestTheNextUnusedFolderWhenTheUserReturnsToSelection', async () => {
    const launch = process.cwd()
    await bindExistingAgent(join(launch, 'strands-dev'), join(await fixture(), 'agent.ts'))
    await mkdir(join(launch, 'strands-dev-2'))
    await writeFile(join(launch, 'strands-dev-2/notes.txt'), 'notes')
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config())
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [], warnings: [] })
    vi.spyOn(picker, 'chooseHarness').mockResolvedValue(undefined)
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    await prepareDevRun(parseArgs(['dev']), { screen, deferPreparation: true, forceSelection: true })

    expect(vi.mocked(picker.chooseHarness).mock.calls[0]?.[0].folderFor?.({ kind: 'cli' })).toBe(
      join(launch, 'strands-dev-3')
    )
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
