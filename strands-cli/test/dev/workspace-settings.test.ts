import { createElement, type ComponentProps, type ReactElement } from 'react'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { parseArgs } from '../../src/cli/arguments.js'
import { CliConfigStore, type CliConfigSnapshot } from '../../src/config/store.js'
import { bindWorkspace } from '../../src/dev/binding.js'
import { bindExistingAgent } from '../../src/dev/create.js'
import * as initial from '../../src/dev/initialize.js'
import { prepareWorkspaceChange } from '../../src/dev/manage.js'
import { HarnessPicker } from '../../src/dev/picker.js'
import { WorkspaceReplacementConfirmation, confirmWorkspaceReplacement } from '../../src/dev/settings.js'
import { runInkChat } from '../../src/ui/run.js'
import * as preparation from '../../src/project/preparation.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import * as terminal from '../../src/terminal/terminal.js'

const info = { root: '/workspace/strands-dev', entrypoint: '/agents/main/agent.ts', origin: 'discovered' }

type PickerProps = ComponentProps<typeof HarnessPicker>
type ConfirmationProps = ComponentProps<typeof WorkspaceReplacementConfirmation>

const project = async (root: string): Promise<string> => {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(
    join(root, 'agent.ts'),
    "import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ name: 'Agent' })\n"
  )
  return join(root, 'agent.ts')
}

const shown = <Props>(show: Mock, type: unknown): Props[] =>
  show.mock.calls
    .map(([content]) => content as ReactElement<Props> | undefined)
    .filter((content): content is ReactElement<Props> => content?.type === type)
    .map(({ props }) => props)

const playground = async () => {
  const launch = await realpath(await temporaryDirectory())
  const directory = join(launch, 'strands-dev')
  await mkdir(directory)
  return {
    launch,
    directory,
    current: await project(join(launch, 'current')),
    other: await project(join(launch, 'other')),
  }
}

const importFromSettings = async (
  { launch, directory }: { launch: string; directory: string },
  overrides: { savedConfig?: CliConfigSnapshot; agent?: string } = {}
) => {
  const abort = new AbortController()
  const screen = { signal: abort.signal, show: vi.fn() }
  const select = vi.fn(async () => undefined)
  const args = {
    ...parseArgs(['dev', '--workspace', directory]),
    ...(overrides.agent ? { agent: overrides.agent } : {}),
  }
  const binding = await readFile(join(directory, '.config'), 'utf8')
  const change = prepareWorkspaceChange({
    args,
    savedConfig: overrides.savedConfig ?? CliConfigStore.memory().snapshot(),
    launchDirectory: launch,
    action: 'import',
    screen,
    select,
  })
  const pickers = (): PickerProps[] =>
    shown<PickerProps>(screen.show, HarnessPicker).filter(({ discovery }) => discovery !== 'running')
  const confirmations = (): ConfirmationProps[] =>
    shown<ConfirmationProps>(screen.show, WorkspaceReplacementConfirmation)
  await vi.waitFor(() => expect(pickers()).toHaveLength(1))
  return { abort, args, binding, change, select, pickers, confirmations }
}

const withAgentProject = (agentProject: string): CliConfigSnapshot => ({
  ...CliConfigStore.memory().snapshot(),
  agentProject,
})

describe('workspace Settings', () => {
  it('shouldShowWorkspaceActionsOnlyWhenTheSessionRunsInDev', async () => {
    const action = vi.fn()
    const dev = new ChatController(idleBackend(), { runtime: { devWorkspace: info }, workspaceAction: action })
    const normal = new ChatController(idleBackend(), { workspaceAction: action })
    try {
      await dev.submit('/settings')
      expect(dev.getSnapshot().panel?.filters).toContainEqual({
        id: 'settings:Workspace',
        label: 'Strands dev workspace',
      })
      await dev.activatePanelRow({ label: '', description: '', value: 'settings:Workspace' })
      expect(dev.getSnapshot().panel?.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Workspace folder', description: info.root }),
          expect.objectContaining({ value: 'workspace:edit' }),
          expect.objectContaining({ value: 'workspace:import' }),
        ])
      )
      expect(dev.getSnapshot().panel?.rows.some(({ value }) => value === 'workspace:create')).toBe(false)
      expect(await dev.activatePanelRow({ label: '', description: '', value: 'workspace:create' })).toBe(false)
      await dev.activatePanelRow({ label: '', description: '', value: 'workspace:import' })
      expect(action).toHaveBeenCalledExactlyOnceWith('import')
      await normal.submit('/settings')
      expect(normal.getSnapshot().panel?.filters?.some(({ id }) => id === 'settings:Workspace')).toBe(false)
      expect(await normal.activatePanelRow({ label: '', description: '', value: 'settings:Workspace' })).toBe(false)
    } finally {
      await dev.dispose()
      await normal.dispose()
    }
  })

  it('shouldRequireTypedDeleteBeforeConfirmingTheReplacement', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frame = captureFrame(output)
    const confirm = vi.fn()
    const cancel = vi.fn()
    render(
      createElement(WorkspaceReplacementConfirmation, {
        directory: info.root,
        replacement: 'Other agent · /agents/other/agent.ts',
        onConfirm: confirm,
        onCancel: cancel,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('This is a DELETE operation.'))
    expect(frame().join('\n')).toContain(info.root)
    expect(frame().join('\n')).toContain('All files in this folder will be replaced')
    expect(frame().join('\n')).toContain('outside this folder will not be deleted')
    expect(frame().join('\n')).toContain('Replacement: Other agent · /agents/other/agent.ts')
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Type DELETE exactly'))
    expect(confirm).not.toHaveBeenCalled()
    input.write('DELETE')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('confirm: DELETE'))
    input.write('\r')
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(cancel).not.toHaveBeenCalled()
  })

  it('shouldCopyTheConfirmationErrorWithoutTypingIntoTheApprovalWhenControlYIsPressed', async () => {
    const copy = vi.spyOn(terminal, 'copyTerminalText').mockResolvedValue(true)
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frame = captureFrame(output)
    render(
      createElement(WorkspaceReplacementConfirmation, {
        directory: info.root,
        replacement: 'Other agent · /agents/other/agent.ts',
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('This is a DELETE operation.'))
    input.write('DEL')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('confirm: DEL▏'))
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Enter confirm · Ctrl+Y copy error · Esc back'))

    input.write('\u0019')

    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    expect(copy.mock.calls[0]![0]).toBe('Type DELETE exactly to confirm, or press Esc to select a different agent.')
    expect(frame().join('\n')).toContain('confirm: DEL▏')
    copy.mockRestore()
  })

  it('shouldKeepTheWholeConfirmationErrorReadableOnAnEightyByTwentyFourScreen', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    const frame = captureFrame(output)
    const running = runInkChat(
      async (): Promise<never> => {
        throw new Error('Unexpected agent startup')
      },
      {
        input,
        output,
        errorOutput: output,
        intro: false,
        config: CliConfigStore.memory({}, { animations: false }),
        renderApp: render as NonNullable<NonNullable<Parameters<typeof runInkChat>[1]>['renderApp']>,
        prepare: async (screen) => {
          await confirmWorkspaceReplacement(info.root, 'Other agent · /agents/other/agent.ts', screen)
          return false
        },
      }
    )
    try {
      await vi.waitFor(() => expect(frame().join('\n')).toContain('This is a DELETE operation.'))
      input.write('\r')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Ctrl+Y copy error'))

      const text = frame()
        .map((line) => line.replace(/[│╭╮╰╯─]/gu, '').trim())
        .join(' ')
        .replace(/\s+/gu, ' ')
      expect(text).toContain('Type DELETE exactly to confirm, or press Esc to select a different agent.')
      expect(text).toContain('Enter confirm · Ctrl+Y copy error · Esc back')
    } finally {
      input.write('\u001b')
      await running
    }
  })

  it('shouldGoBackWithoutConfirmingWhenEscapeIsPressed', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frame = captureFrame(output)
    const confirm = vi.fn()
    const cancel = vi.fn()
    render(
      createElement(WorkspaceReplacementConfirmation, {
        directory: info.root,
        replacement: 'New typescript agent · new-harness',
        onConfirm: confirm,
        onCancel: cancel,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('DELETE workspace and replace?'))
    input.write('\u001b')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('agent import from workspace Settings', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shouldOfferTheBaseCliAndOtherAgentsButNotTheCurrentAgent', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const savedConfig = CliConfigStore.memory().snapshot()
    const { binding, change, pickers, confirmations } = await importFromSettings(files, { savedConfig })
    const picker = pickers()[0]!

    expect(picker.cli).toEqual({ name: savedConfig.profile.name, path: savedConfig.path })
    expect(picker.folderFor).toBeUndefined()
    expect(picker.harnesses.map(({ entrypoint }) => entrypoint)).toEqual([files.other])
    expect(picker.warning).toBe(
      `When you select an agent, strands dev deletes your current agent (current) and the folder ${files.directory}. The project files in ${join(files.launch, 'current')} stay on disk.`
    )
    await picker.onSelect({ kind: 'discovered', harness: picker.harnesses[0]! })
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1))
    expect(confirmations()[0]!.replacement).toBe(`Agent · ${files.other}`)
    confirmations()[0]!.onConfirm()

    await expect(change).resolves.toEqual(
      expect.objectContaining({ apply: expect.any(Function), rollback: expect.any(Function) })
    )
    expect(await readFile(join(files.directory, '.config'), 'utf8')).toBe(binding)
  })

  it('shouldHideTheBaseCliWhenTheCurrentAgentCameFromIt', async () => {
    const files = await playground()
    await project(join(files.directory, 'agent'))
    await bindWorkspace(files.directory, {
      version: 1,
      name: 'CLI copy',
      agent: { path: 'agent', entrypoint: 'agent.ts', language: 'typescript' },
      origin: { kind: 'cli' },
    })
    const { change, pickers } = await importFromSettings(files)
    const picker = pickers()[0]!

    expect(picker.cli).toBeUndefined()
    expect(picker.harnesses.map(({ entrypoint }) => entrypoint)).toEqual([files.current, files.other])
    expect(picker.warning).toBe(
      `When you select an agent, strands dev deletes your current agent (CLI copy) and all files in ${files.directory}.`
    )
    await picker.onSelect(undefined)
    await expect(change).resolves.toBeUndefined()
  })

  it('shouldTellTheCreateFormWhichLanguageCannotLoadTheSavedModelModule', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const saved = CliConfigStore.memory().snapshot()
    const savedConfig: CliConfigSnapshot = {
      ...saved,
      profile: {
        ...saved.profile,
        model: 'bedrock/us.example.model',
        modelModule: { kind: 'model', module: './models/custom.mjs' },
      },
    }
    const { change, pickers } = await importFromSettings(files, { savedConfig })
    const picker = pickers()[0]!

    expect(picker.modelNotice?.('python')).toBe(
      'Python cannot load the model module custom.mjs. The new harness uses bedrock/us.example.model.'
    )
    expect(picker.modelNotice?.('typescript')).toBeUndefined()
    await picker.onSelect(undefined)
    await expect(change).resolves.toBeUndefined()
  })

  it('shouldHideProjectsThatContainOrSitInsideTheWorkspaceFolder', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    await project(join(files.directory, 'nested'))
    await writeFile(join(files.launch, 'package.json'), '{"type":"module"}')
    await writeFile(
      join(files.launch, 'agent.ts'),
      "import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ name: 'Root' })\n"
    )
    const { pickers } = await importFromSettings(files)

    expect(pickers()[0]!.harnesses.map(({ entrypoint }) => entrypoint)).toEqual([files.other])
  })

  it('shouldHideTheRunningAgentAndOfferTheSavedDefaultOnlyAsTheBaseCli', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const running = join(files.launch, 'current', 'second.ts')
    await writeFile(
      running,
      "import { createHarness } from '@strands-agents/harness'\nexport const agent = await createHarness({ name: 'Second' })\n"
    )
    const saved = await project(join(files.launch, 'default'))
    const { pickers } = await importFromSettings(files, { savedConfig: withAgentProject(saved), agent: running })
    const picker = pickers()[0]!

    expect(picker.cli?.path).toBe(saved)
    expect(picker.harnesses.map(({ entrypoint }) => entrypoint)).toEqual([files.other])
  })

  it.each([
    ['the running agent', (launch: string) => join(launch, 'current', 'agent.ts')],
    ['missing', (launch: string) => join(launch, 'missing', 'agent.ts')],
  ])('shouldHideTheBaseCliWhenTheSavedDefaultIs%s', async (_case, savedDefault) => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const { pickers } = await importFromSettings(files, { savedConfig: withAgentProject(savedDefault(files.launch)) })

    expect(pickers()[0]!.cli).toBeUndefined()
    expect(pickers()[0]!.harnesses.map(({ entrypoint }) => entrypoint)).toEqual([files.other])
  })

  it('shouldBindTheSavedCliDefaultWhenTheBaseCliReplacesTheWorkspace', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const saved = await project(join(files.launch, 'default'))
    vi.spyOn(preparation, 'executePreparation').mockResolvedValue(join(files.launch, 'setup.log'))
    vi.spyOn(initial, 'ensureInitialCandidate').mockResolvedValue('copy')
    vi.spyOn(process, 'chdir').mockReturnValue()
    const { args, change, select, pickers, confirmations } = await importFromSettings(files, {
      savedConfig: withAgentProject(saved),
    })
    await pickers()[0]!.onSelect({ kind: 'cli' })
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1))
    confirmations()[0]!.onConfirm()
    const replacement = await change

    await replacement!.apply()
    await replacement!.finish()

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ agent: saved, dev: expect.objectContaining({ workspace: args.dev!.workspace }) }),
      join(files.launch, 'default')
    )
    expect(JSON.parse(await readFile(join(files.directory, '.config'), 'utf8'))).toMatchObject({
      agent: { path: join(files.launch, 'default') },
      origin: { kind: 'cli' },
    })
  })

  it('shouldReturnToThePickerWhenTheDeleteConfirmationIsCancelled', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const { binding, change, pickers, confirmations } = await importFromSettings(files)
    await pickers()[0]!.onSelect({ kind: 'create', language: 'python', name: 'fresh' })
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1))
    expect(confirmations()[0]!.replacement).toBe('New python agent · fresh')

    confirmations()[0]!.onCancel()
    await vi.waitFor(() => expect(pickers()).toHaveLength(2))
    await pickers()[1]!.onSelect(undefined)

    await expect(change).resolves.toBeUndefined()
    expect(await readFile(join(files.directory, '.config'), 'utf8')).toBe(binding)
  })

  it('shouldLeaveTheWorkspaceUnchangedWhenTheSessionStopsDuringConfirmation', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const { abort, binding, change, pickers, confirmations } = await importFromSettings(files)
    await pickers()[0]!.onSelect({ kind: 'discovered', harness: pickers()[0]!.harnesses[0]! })
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1))

    abort.abort(new Error('closed'))

    await expect(change).resolves.toBeUndefined()
    expect(pickers()).toHaveLength(1)
    expect(await readFile(join(files.directory, '.config'), 'utf8')).toBe(binding)
  })
})
