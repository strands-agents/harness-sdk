import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../../src/config/store.js'
import { AgentOptionConflict, AgentOptionsNotEditable } from '../../src/dev/agent-options.js'
import {
  BASE_CLI_LOOK,
  editBaseCliProfile,
  isProfileBaseCli,
  profileBaseCliChat,
  promoteBaseCliLook,
  refreshBaseCliView,
  saveBaseCliChoices,
} from '../../src/dev/base-cli.js'
import { readWorkspaceBinding, updateWorkspaceCli } from '../../src/dev/workspace.js'
import { createDevWorkspace } from '../../src/dev/create.js'
import * as installer from '../../src/project/archive.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const MODEL = 'bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0'

const profileToml = (instructions: string, extra = ''): string =>
  [
    '[onboarding]',
    'version = 1',
    '',
    '[providers]',
    'enabled = ["bedrock"]',
    '',
    '[profile]',
    'name = "Base"',
    `instructions = "${instructions}"`,
    `model = "${MODEL}"`,
    'builtinTools = ["shell", "read", "write"]',
    'skills = false',
    'session = false',
    'memory = false',
    extra,
    '',
    '[profile.mcpServers.local]',
    'command = "local"',
    '',
  ].join('\n')

const snapshotOf = async (path: string) => (await CliConfigStore.load(path, { persist: false })).snapshot()

const baseCli = async (toml = profileToml('Answer briefly.')) => {
  const home = await temporaryDirectory()
  const path = join(home, 'cli.toml')
  await writeFile(path, toml)
  const install = vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
  const workspace = await createDevWorkspace({
    cwd: home,
    destination: join(home, 'strands-dev'),
    kind: 'cli',
    snapshot: await snapshotOf(path),
  })
  install.mockClear()
  return { path, workspace, install, view: (): Promise<string> => readFile(workspace.entrypoint, 'utf8') }
}

afterEach(() => vi.restoreAllMocks())

describe('isProfileBaseCli', () => {
  it('shouldNotTreatAnOlderBaseCliLayoutAsAViewWhenItsSourceIsNotTheGeneratedFile', async () => {
    const { path, workspace } = await baseCli()

    expect(await isProfileBaseCli({ ...workspace, entrypoint: join(workspace.root, 'src', 'agent.ts') }, path)).toBe(
      false
    )
  })

  it('shouldTreatTheBaseCliWorkspaceAsTheProfileWhenCliTomlHasNoAgentProject', async () => {
    const { path, workspace } = await baseCli()

    expect(await isProfileBaseCli(workspace, path)).toBe(true)
  })

  it('shouldNotTreatTheWorkspaceAsTheProfileWhenCliTomlPointsAtAnAgentProject', async () => {
    const { path, workspace } = await baseCli()
    await writeFile(path, `agentProject = "/agents/base/agent.ts"\n${profileToml('Answer briefly.')}`)

    expect(await isProfileBaseCli(workspace, path)).toBe(false)
  })
})

describe('refreshBaseCliView', () => {
  it('shouldWriteTheProfileIntoTheViewWhenTheProfileChanged', async () => {
    const { path, workspace, view } = await baseCli()
    await writeFile(path, profileToml('Answer in full sentences.'))

    expect(await refreshBaseCliView(workspace, await snapshotOf(path))).toBe(true)

    expect(await view()).toContain("instructions: 'Answer in full sentences.'")
  })

  it('shouldLeaveTheViewAloneWhenTheProfileIsUnchanged', async () => {
    const { path, workspace } = await baseCli()
    const before = (await stat(workspace.entrypoint)).mtimeMs

    expect(await refreshBaseCliView(workspace, await snapshotOf(path))).toBe(false)

    expect((await stat(workspace.entrypoint)).mtimeMs).toBe(before)
  })

  it('shouldRemoveOnlyTheFilesThatItWroteBeforeWhenTheProfileDropsThem', async () => {
    const skill = join(await temporaryDirectory(), 'review')
    await mkdir(skill)
    await writeFile(join(skill, 'SKILL.md'), '---\nname: review\ndescription: Review code.\n---\nReview.\n')
    const { path, workspace } = await baseCli(
      profileToml('Answer briefly.').replace('skills = false', `skills = [${JSON.stringify(skill)}]`)
    )
    await refreshBaseCliView(workspace, await snapshotOf(path))
    const packaged = join(workspace.root, 'agent', 'skills', 'review', 'SKILL.md')
    expect(await readFile(packaged, 'utf8')).toContain('Review.')
    await mkdir(join(workspace.root, 'node_modules', 'kept'), { recursive: true })
    await writeFile(join(workspace.root, 'node_modules', 'kept', 'index.js'), 'export {}\n')
    await writeFile(join(workspace.root, 'notes.txt'), 'mine\n')
    await writeFile(path, profileToml('Answer briefly.'))

    expect(await refreshBaseCliView(workspace, await snapshotOf(path))).toBe(true)

    await expect(stat(packaged)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(workspace.root, 'notes.txt'), 'utf8')).toBe('mine\n')
    expect(await readFile(join(workspace.root, 'node_modules', 'kept', 'index.js'), 'utf8')).toBe('export {}\n')
  })

  it('shouldInstallDependenciesWhenThePackageFileChanges', async () => {
    const { path, workspace, install } = await baseCli()
    const before = await readFile(join(workspace.root, 'package.json'), 'utf8')
    await writeFile(path, profileToml('Answer briefly.').replace(MODEL, 'openai/gpt-5.4'))

    await refreshBaseCliView(workspace, await snapshotOf(path))

    expect(await readFile(join(workspace.root, 'package.json'), 'utf8')).not.toBe(before)
    expect(install).toHaveBeenCalledExactlyOnceWith(workspace.root, 'typescript')
  })
})

describe('saveBaseCliChoices', () => {
  it('shouldWriteTheEffortIntoCliTomlAndTheViewWhenDevChangesIt', async () => {
    const { path, workspace, view } = await baseCli()

    await saveBaseCliChoices(workspace, { effort: 'low' }, path)

    expect((await snapshotOf(path)).profile.effort).toBe('low')
    expect(await view()).toContain("effort: 'low'")
  })

  it('shouldDropAModelModuleWhenDevPicksAnotherModel', async () => {
    const { path, workspace } = await baseCli()

    await saveBaseCliChoices(workspace, { model: 'bedrock/next-model' }, path)

    const { profile } = await snapshotOf(path)
    expect([profile.model, profile.modelModule]).toEqual(['bedrock/next-model', null])
  })
})

describe('editBaseCliProfile', () => {
  it('shouldWriteTheWinningInstructionsIntoCliTomlWhenApplyRuns', async () => {
    const { path, workspace, view } = await baseCli()

    await editBaseCliProfile(
      workspace,
      [{ option: 'instructions', value: 'Answer briefly and exactly.', expected: 'Answer briefly.' }],
      path
    )

    expect((await snapshotOf(path)).profile.instructions).toBe('Answer briefly and exactly.')
    expect(await view()).toContain("instructions: 'Answer briefly and exactly.'")
  })

  it('shouldRefuseTheEditAndKeepCliTomlWhenTheValueChangedAfterTheRun', async () => {
    const { path, workspace, view } = await baseCli()
    await writeFile(path, profileToml('Answer in full sentences.'))

    await expect(
      editBaseCliProfile(
        workspace,
        [{ option: 'instructions', value: 'Answer briefly and exactly.', expected: 'Answer briefly.' }],
        path
      )
    ).rejects.toBeInstanceOf(AgentOptionConflict)

    expect((await snapshotOf(path)).profile.instructions).toBe('Answer in full sentences.')
    expect(await view()).toContain("instructions: 'Answer in full sentences.'")
  })

  it('shouldRemoveTheSwitchedOffToolsAndServersFromTheProfileWhenApplyRuns', async () => {
    const { path, workspace, view } = await baseCli()

    await editBaseCliProfile(
      workspace,
      [
        { option: 'builtinTools', removeItems: [1], expectedItems: ["'shell'", "'read'", "'write'"] },
        { option: 'mcpServers', removeKeys: ['local'] },
      ],
      path
    )

    const { profile } = await snapshotOf(path)
    expect(profile.builtinTools).toEqual(['shell', 'write'])
    expect(profile.mcpServers).toEqual({})
    expect(await view()).toContain("builtinTools: ['shell', 'write']")
  })

  it('shouldRefuseAnOptionThatTheProfileCannotHoldBeforeItWritesAnything', async () => {
    const { path, workspace } = await baseCli()
    const before = await readFile(path, 'utf8')

    await expect(
      editBaseCliProfile(workspace, [{ option: 'tools', removeItems: [0], expectedItems: ['lookup'] }], path)
    ).rejects.toBeInstanceOf(AgentOptionsNotEditable)

    expect(await readFile(path, 'utf8')).toBe(before)
  })
})

describe('profileBaseCliChat', () => {
  it('shouldGiveNoProfileHooksWhenCliTomlPointsAtAnAgentProject', async () => {
    const { path, workspace } = await baseCli()
    await writeFile(path, `agentProject = "/agents/base/agent.ts"\n${profileToml('Answer briefly.')}`)

    expect(await profileBaseCliChat(workspace, path)).toBeUndefined()
  })

  it('shouldHotReloadTheChatWhenCliTomlChangesOnDisk', async () => {
    const { path, workspace, view } = await baseCli()
    const chat = await profileBaseCliChat(workspace, path)
    await writeFile(path, profileToml('Answer in full sentences.'))

    expect(await chat!.configWatch.changed()).toBe(true)

    expect(chat!.configWatch.path).toBe(path)
    expect(await view()).toContain("instructions: 'Answer in full sentences.'")
  })

  it('shouldNotReloadTheChatAgainWhenTheViewAlreadyMatches', async () => {
    const { path, workspace } = await baseCli()
    const chat = await profileBaseCliChat(workspace, path)
    await writeFile(path, profileToml('Answer in full sentences.'))
    await chat!.configWatch.changed()

    expect(await chat!.configWatch.changed()).toBe(false)
  })
})

describe('the look of the Base CLI', () => {
  const withSettings = (settings: string): string => `${profileToml('Answer briefly.')}\n[settings]\n${settings}\n`

  const savedSettings = async (path: string) => (await snapshotOf(path)).settings

  const workspaceCli = async (directory: string) => (await readWorkspaceBinding(directory))?.binding.cli

  /** The settings of a dev chat: cli.toml as dev reads it, what dev switches off, and the workspace on top. */
  const devSettings = async (path: string, directory: string) => {
    const config = await CliConfigStore.load(path, { persist: false })
    await config.setSettings({ telemetry: false, updatePrompts: false })
    await config.useLayer({
      source: join(directory, '.config'),
      read: () => workspaceCli(directory),
      write: (sections) => updateWorkspaceCli(directory, sections),
    })
    return config
  }

  const opened = async (settings = 'frogTheme = "spectre"', held?: Record<string, unknown>) => {
    const { path, workspace } = await baseCli(withSettings(settings))
    const directory = workspace.directory!
    if (held) await updateWorkspaceCli(directory, held)
    return { path, workspace, directory }
  }

  it('shouldBeTheAppearanceSettings', () => {
    expect(BASE_CLI_LOOK).toEqual(['frogTheme', 'transcriptSpacing', 'animations', 'showReasoning', 'toolOutput'])
  })

  it('shouldSaveAThemePickedInDevToCliTomlAndNotToTheWorkspace', async () => {
    const { path, workspace, directory } = await opened()
    const config = await devSettings(path, directory)
    const chat = await profileBaseCliChat(workspace, path)

    await chat!.saveSettings(config, { frogTheme: 'green' })

    expect((await savedSettings(path)).frogTheme).toBe('green')
    expect(config.snapshot().settings.frogTheme).toBe('green')
    expect(await workspaceCli(directory)).toBeUndefined()
  })

  it('shouldKeepWhatIsNotTheLookInTheWorkspaceAndSaveNothingElseToCliToml', async () => {
    const { path, workspace, directory } = await opened()
    const config = await devSettings(path, directory)
    const chat = await profileBaseCliChat(workspace, path)

    await chat!.saveSettings(config, { autoAcceptOptimizationResults: true, toolOutput: 'full' })

    // Dev switched telemetry off for its own session, and that is not a choice to save for plain strands.
    expect(await savedSettings(path)).toMatchObject({ toolOutput: 'full', telemetry: true })
    expect(await savedSettings(path)).not.toHaveProperty('autoAcceptOptimizationResults')
    expect(config.snapshot().settings).toMatchObject({
      toolOutput: 'full',
      autoAcceptOptimizationResults: true,
      telemetry: false,
    })
    expect(await workspaceCli(directory)).toEqual({ settings: { autoAcceptOptimizationResults: true } })
  })

  it('shouldTakeAThemeThatPlainStrandsSavedIntoTheOpenDevChatWithoutReloadingTheAgent', async () => {
    const { path, workspace, directory } = await opened()
    const config = await devSettings(path, directory)
    const chat = await profileBaseCliChat(workspace, path)
    await writeFile(path, withSettings('frogTheme = "scarlet"\ntelemetry = true'))

    const reload = await chat!.configWatch.changed(config)

    expect(reload).toBe(false)
    expect(config.snapshot().settings).toMatchObject({ frogTheme: 'scarlet', telemetry: false })
    expect(await workspaceCli(directory)).toBeUndefined()
  })

  it('shouldMoveAThemeThatTheWorkspaceStillHoldsIntoCliTomlWhenDevOpensIt', async () => {
    const { path, directory } = await opened('frogTheme = "spectre"', {
      settings: { frogTheme: 'green', autoAcceptOptimizationResults: true },
    })
    const config = await devSettings(path, directory)
    const shownBefore = config.snapshot().settings.frogTheme

    await promoteBaseCliLook(config, await workspaceCli(directory), path)

    expect(shownBefore).toBe('green')
    expect((await savedSettings(path)).frogTheme).toBe('green')
    expect(config.snapshot().settings).toMatchObject({ frogTheme: 'green', autoAcceptOptimizationResults: true })
    expect(await workspaceCli(directory)).toEqual({ settings: { autoAcceptOptimizationResults: true } })
  })
})
