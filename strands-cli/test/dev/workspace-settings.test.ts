import { createElement, type ComponentProps, type ReactElement } from 'react'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { parseArgs, type ParsedArgs } from '../../src/cli/arguments.js'
import { CliConfigStore, type CliConfigSnapshot } from '../../src/config/store.js'
import { bindWorkspace } from '../../src/dev/binding.js'
import { bindExistingAgent } from '../../src/dev/create.js'
import * as initial from '../../src/dev/initialize.js'
import { prepareWorkspaceChange } from '../../src/dev/manage.js'
import { HarnessPicker } from '../../src/dev/picker.js'
import { WorkspaceReplacementConfirmation } from '../../src/dev/settings.js'
import { strandsUserPath } from '../../src/paths.js'
import { runInkChat } from '../../src/ui/run.js'
import * as preparation from '../../src/project/preparation.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import * as terminal from '../../src/terminal/terminal.js'

const info = {
  root: '/workspace/strands-dev',
  entrypoint: '/agents/main/agent.ts',
  boundEntrypoint: '/agents/main/agent.ts',
  origin: 'discovered',
}

type PickerProps = ComponentProps<typeof HarnessPicker>

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
  overrides: {
    savedConfig?: CliConfigSnapshot
    agent?: string
    select?: (args: ParsedArgs, directory: string) => Promise<void>
  } = {}
) => {
  const abort = new AbortController()
  const screen = { signal: abort.signal, show: vi.fn() }
  const select = vi.fn(overrides.select ?? (async () => undefined))
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
  await vi.waitFor(() => expect(pickers()).toHaveLength(1))
  return { abort, args, binding, change, select, picker: pickers()[0]! }
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
          await new Promise<void>((resolve) => {
            screen.show(
              createElement(WorkspaceReplacementConfirmation, {
                directory: info.root,
                replacement: 'Other agent · /agents/other/agent.ts',
                onConfirm: resolve,
                onCancel: resolve,
              }),
              'Strands dev workspace'
            )
          })
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
  const testDirectory = process.cwd()

  beforeEach(async () => {
    const home = await realpath(await temporaryDirectory())
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
  })

  afterEach(() => {
    process.chdir(testDirectory)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const prepared = (files: { launch: string }): void => {
    vi.spyOn(preparation, 'executePreparation').mockResolvedValue(join(files.launch, 'setup.log'))
    vi.spyOn(initial, 'ensureInitialCandidate').mockResolvedValue('copy')
  }

  const discovered = (picker: PickerProps, entrypoint: string) =>
    ({ kind: 'discovered', harness: picker.harnesses.find((harness) => harness.entrypoint === entrypoint)! }) as const

  it('shouldOfferTheBaseCliAndOtherAgentsButNotTheCurrentAgent', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const savedConfig = CliConfigStore.memory().snapshot()
    const { change, picker } = await importFromSettings(files, { savedConfig })

    expect(picker.cli).toEqual({ name: savedConfig.profile.name, path: savedConfig.path })
    expect(picker.harnesses.map(({ entrypoint }) => entrypoint)).toEqual([files.other])
    expect(picker.warning).toBeUndefined()
    await picker.onSelect(undefined)
    await expect(change).resolves.toBeUndefined()
  })

  it('shouldHideTheBaseCliWhenTheCurrentWorkspaceIsTheBaseCliWorkspace', async () => {
    const files = await playground()
    await project(join(files.directory, 'agent'))
    await bindWorkspace(files.directory, {
      version: 1,
      name: 'CLI copy',
      agent: { path: 'agent', entrypoint: 'agent.ts', language: 'typescript' },
      origin: { kind: 'cli' },
    })
    const { change, picker } = await importFromSettings(files)

    expect(picker.cli).toBeUndefined()
    expect(picker.harnesses.map(({ entrypoint }) => entrypoint)).toEqual([files.current, files.other])
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
    const { change, picker } = await importFromSettings(files, { savedConfig })

    expect(picker.modelNotice?.('python')).toBe(
      'Python cannot load the model module custom.mjs. The new harness uses bedrock/us.example.model.'
    )
    expect(picker.modelNotice?.('typescript')).toBeUndefined()
    await picker.onSelect(undefined)
    await expect(change).resolves.toBeUndefined()
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
    const { change, picker } = await importFromSettings(files, { savedConfig: withAgentProject(saved), agent: running })

    expect(picker.cli?.path).toBe(saved)
    expect(picker.harnesses.map(({ entrypoint }) => entrypoint)).toEqual([files.other])
    await picker.onSelect(undefined)
    await expect(change).resolves.toBeUndefined()
  })

  it('shouldHideTheBaseCliWhenItsSavedDefaultIsTheRunningAgent', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const { change, picker } = await importFromSettings(files, { savedConfig: withAgentProject(files.current) })

    expect(picker.cli).toBeUndefined()
    expect(picker.harnesses.map(({ entrypoint }) => entrypoint)).toEqual([files.other])
    await picker.onSelect(undefined)
    await expect(change).resolves.toBeUndefined()
  })

  it('shouldCreateAWorkspaceNextToTheSelectedAgentAndKeepTheCurrentWorkspace', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    prepared(files)
    const { binding, change, select, picker } = await importFromSettings(files)
    const choice = discovered(picker, files.other)
    const folder = picker.folderFor?.(choice)
    expect(folder).toEqual({ path: join(files.launch, 'other', 'strands-dev'), detected: false })

    await picker.onSelect(choice, folder!.path)
    const opened = await change
    await opened!.apply()

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: files.other,
        dev: expect.objectContaining({ workspace: folder!.path, prepared: true }),
      }),
      join(files.launch, 'other')
    )
    expect(JSON.parse(await readFile(join(folder!.path, '.config'), 'utf8'))).toMatchObject({
      agent: { path: join(files.launch, 'other') },
      origin: { kind: 'discovered' },
    })
    expect(await readFile(join(files.directory, '.config'), 'utf8')).toBe(binding)
  })

  it('shouldOpenTheWorkspaceThatTheSelectedAgentAlreadyHas', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const existing = join(files.launch, 'other', 'strands-dev')
    await mkdir(existing)
    await bindExistingAgent(existing, files.other)
    const before = await readFile(join(existing, '.config'), 'utf8')
    prepared(files)
    const { change, select, picker } = await importFromSettings(files)
    const choice = discovered(picker, files.other)
    expect(picker.folderFor?.(choice)).toEqual({ path: existing, detected: true })

    await picker.onSelect(choice, existing)
    await (await change)!.apply()

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ agent: files.other, dev: expect.objectContaining({ workspace: existing }) }),
      join(files.launch, 'other')
    )
    expect(await readFile(join(existing, '.config'), 'utf8')).toBe(before)
  })

  it('shouldCreateTheBaseCliWorkspaceFromTheSavedDefault', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const saved = await project(join(files.launch, 'default'))
    prepared(files)
    const { change, select, picker } = await importFromSettings(files, { savedConfig: withAgentProject(saved) })
    const folder = picker.folderFor?.({ kind: 'cli' })
    expect(folder).toEqual({ path: strandsUserPath('strands-dev'), detected: false })

    await picker.onSelect({ kind: 'cli' }, folder!.path)
    await (await change)!.apply()

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ agent: saved, dev: expect.objectContaining({ workspace: folder!.path }) }),
      join(files.launch, 'default')
    )
    expect(JSON.parse(await readFile(join(folder!.path, '.config'), 'utf8'))).toMatchObject({
      agent: { path: join(files.launch, 'default') },
      origin: { kind: 'cli' },
    })
  })

  it('shouldRefuseToReplaceTheOpenWorkspace', async () => {
    const files = await playground()
    const open = strandsUserPath('strands-dev')
    await mkdir(open, { recursive: true })
    await bindExistingAgent(open, files.current)
    const { binding, change, picker } = await importFromSettings({ ...files, directory: open })
    expect(picker.folderFor?.({ kind: 'cli' })).toEqual({ path: open, detected: false, open: true })

    await expect(picker.onSelect({ kind: 'cli' }, open)).rejects.toThrow('It holds the open workspace.')
    await picker.onSelect(undefined)

    await expect(change).resolves.toBeUndefined()
    expect(await readFile(join(open, '.config'), 'utf8')).toBe(binding)
  })

  it('shouldDeleteTheNewWorkspaceAndSelectTheOldOneWhenTheChangeIsRolledBack', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    prepared(files)
    const before = process.cwd()
    const { args, change, select, picker } = await importFromSettings(files)
    const choice = discovered(picker, files.other)
    const folder = picker.folderFor!(choice)!.path

    await picker.onSelect(choice, folder)
    const opened = await change
    await opened!.apply()
    await opened!.rollback()

    await expect(lstat(folder)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(select).toHaveBeenLastCalledWith(args, before)
    expect(process.cwd()).toBe(before)
  })

  it('shouldLeaveTheNewWorkspaceBeforeTheRollbackDeletesIt', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    prepared(files)
    const before = process.cwd()
    const created = strandsUserPath('strands-dev')
    const visits: { directory: string; createdExists: boolean }[] = []
    const { change, picker } = await importFromSettings(files, {
      select: async (_args, directory) => {
        visits.push({ directory, createdExists: existsSync(created) })
        process.chdir(directory)
      },
    })

    await picker.onSelect({ kind: 'cli' }, created)
    const opened = await change
    await opened!.apply()
    expect(process.cwd()).toBe(join(created, 'agent'))
    await opened!.rollback()

    expect(visits.at(-1)).toEqual({ directory: before, createdExists: true })
    expect(existsSync(created)).toBe(false)
    expect(process.cwd()).toBe(before)
  })

  it('shouldHideTheBaseCliWhenItsSavedDefaultIsMissing', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const missing = join(files.launch, 'missing', 'agent.ts')
    const { change, picker } = await importFromSettings(files, { savedConfig: withAgentProject(missing) })

    expect(picker.cli).toBeUndefined()
    expect(picker.harnesses.map(({ entrypoint }) => entrypoint)).toEqual([files.other])
    await picker.onSelect(undefined)
    await expect(change).resolves.toBeUndefined()
  })

  it('shouldLeaveTheWorkspaceUnchangedWhenTheSessionStopsDuringSelection', async () => {
    const files = await playground()
    await bindExistingAgent(files.directory, files.current)
    const { abort, binding, change } = await importFromSettings(files)

    abort.abort(new Error('closed'))

    await expect(change).rejects.toThrow('closed')
    expect(await readFile(join(files.directory, '.config'), 'utf8')).toBe(binding)
  })
})
