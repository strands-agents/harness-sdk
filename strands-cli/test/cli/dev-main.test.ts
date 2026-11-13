import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliConfigStore } from '../../src/config/store.js'
import { initializeDevWorkspace } from '../../src/dev/workspace.js'
import * as installer from '../../src/project/archive.js'
import { bindExistingAgent } from '../../src/dev/create.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import * as projectSetup from '../../src/dev/project-setup.js'
import * as picker from '../../src/dev/picker.js'
import * as search from '../../src/dev/search.js'
import type { runInkChat } from '../../src/ui/run.js'

const ui = vi.hoisted(() => ({ run: vi.fn(), typescript: vi.fn() }))
vi.mock('../../src/terminal/ink.js', () => ({}))
vi.mock('../../src/ui/run.js', () => ({ runInkChat: ui.run }))
vi.mock('../../src/ui/chat/runtime.js', () => ({ createTypescriptChat: ui.typescript }))
const { main } = await import('../../src/cli/run.js')
const inputTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const outputTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

const terminal = (enabled: boolean): void => {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: enabled })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: enabled })
}

beforeEach(() => {
  vi.spyOn(installer, 'prepareWorkspaceDependencies').mockResolvedValue()
})

afterEach(() => {
  vi.restoreAllMocks()
  ui.run.mockReset()
  ui.typescript.mockReset()
  process.exitCode = undefined
  if (inputTty) Object.defineProperty(process.stdin, 'isTTY', inputTty)
  else Reflect.deleteProperty(process.stdin, 'isTTY')
  if (outputTty) Object.defineProperty(process.stdout, 'isTTY', outputTty)
  else Reflect.deleteProperty(process.stdout, 'isTTY')
})

const workspaceFixture = async (): Promise<string> => {
  const root = await temporaryDirectory()
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'src/agent.ts'), 'throw new Error("the mocked UI must not execute this")')
  await initializeDevWorkspace(root, {
    version: 1,
    name: 'Selected local harness',
    language: 'typescript',
    entrypoint: 'src/agent.ts',
    origin: { kind: 'discovered' },
  })
  return root
}

describe('dev ingress', () => {
  it.each(['legacy', 'binding'] as const)(
    'shouldRouteTheDevSessionToItsPersistentAgentWith%sMetadata',
    async (format) => {
      const root = await workspaceFixture()
      const workspacePath = format === 'binding' ? join(await temporaryDirectory(), 'strands-dev') : root
      if (format === 'binding') await bindExistingAgent(workspacePath, join(root, 'src/agent.ts'))
      const configPath = join(await temporaryDirectory(), 'cli.toml')
      const original = 'agentProject = "/old/default.ts"\n[profile]\nname = "Original"\n'
      await writeFile(configPath, original)
      vi.spyOn(projectSetup, 'projectSetupSession').mockReturnValue({
        prepare: vi.fn().mockResolvedValue('ready'),
        recover: vi.fn().mockResolvedValue('exit'),
      })
      const config = await CliConfigStore.load(configPath, { persist: false })
      const load = vi.spyOn(CliConfigStore, 'load').mockResolvedValue(config)
      vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      terminal(true)
      const cwd = process.cwd()
      const controller = new ChatController(idleBackend())
      ui.typescript.mockResolvedValue(controller)
      ui.run.mockImplementation(
        async (factory: Parameters<typeof runInkChat>[0], options: Parameters<typeof runInkChat>[1]) => {
          expect(typeof factory).toBe('function')
          if (typeof factory !== 'function') throw new Error('expected a controller factory')
          expect(process.cwd()).toBe(cwd)
          expect(options?.prepare).toBeDefined()
          const ready = await options?.prepare?.({ signal: new AbortController().signal, show: vi.fn() })
          expect(ready).toBe(true)
          expect(process.cwd()).toBe(root)
          await factory(
            new AbortController().signal,
            () => undefined,
            undefined,
            undefined,
            async () => false
          )
          await options?.config?.setSettings({ animations: false })
          return 0
        }
      )
      try {
        await main(['dev', '--workspace', workspacePath])

        expect(ui.typescript.mock.calls[0]?.[0]).toBe(join(root, 'src/agent.ts'))
        expect(ui.typescript.mock.calls[0]?.[2].args).toMatchObject({
          agent: join(root, 'src/agent.ts'),
          dev: { workspace: workspacePath },
        })
        expect(load).toHaveBeenCalledOnce()
        expect(await readFile(configPath, 'utf8')).toBe(original)
        expect(process.cwd()).toBe(cwd)
        expect(process.exitCode).toBe(0)
      } finally {
        await controller.dispose()
      }
    }
  )

  it.each([true, false])('shouldPlayTheIntroOnlyWhenAnimationsAre%s', async (animations) => {
    const root = await workspaceFixture()
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(CliConfigStore.memory({}, { animations }))
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    terminal(true)
    ui.run.mockResolvedValue(0)

    await main(['dev', '--workspace', root])

    expect(ui.run.mock.calls[0]?.[1]).toMatchObject({ intro: animations, setup: false })
  })

  it('shouldStopAfterInitializationWhenDevInitIsRequested', async () => {
    const root = await workspaceFixture()
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(CliConfigStore.memory())
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    terminal(false)

    await main(['dev', 'init', '--workspace', root])

    expect(ui.run).not.toHaveBeenCalled()
    expect(ui.typescript).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('shouldExitNonzeroWithoutLaunchingTheGlobalHarnessWhenTheWorkspaceIsInvalid', async () => {
    const root = await temporaryDirectory()
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(CliConfigStore.memory())
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    terminal(false)

    await main(['dev', '--workspace', root])

    expect(process.exitCode).toBe(1)
    expect(output.mock.calls.flat().join('')).toContain('Run strands dev init')
    expect(ui.run).not.toHaveBeenCalled()
  })

  it.each(['Setup', 'EntrypointLoad'] as const)(
    'shouldOfferTheSavedBaseCliAndDeleteTheFailedWorkspaceWhenTheUserGoesBackFrom%s',
    async (failure) => {
      const failed = await temporaryDirectory()
      await writeFile(join(failed, 'package.json'), '{"type":"module"}')
      await writeFile(join(failed, 'agent.ts'), 'export const agent = {}')
      const harness = {
        name: 'Failed',
        entrypoint: join(failed, 'agent.ts'),
        root: failed,
        language: 'typescript' as const,
      }
      const configPath = join(await temporaryDirectory(), 'cli.toml')
      await writeFile(configPath, '[profile]\nname = "Saved"\n')
      vi.spyOn(CliConfigStore, 'load').mockResolvedValue(await CliConfigStore.load(configPath, { persist: false }))
      vi.spyOn(projectSetup, 'projectSetupSession').mockReturnValue({
        prepare: vi.fn().mockResolvedValue(failure === 'Setup' ? 'back' : 'ready'),
        recover: vi.fn().mockResolvedValue('back'),
      })
      vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [harness], warnings: [] })
      const choose = vi
        .spyOn(picker, 'chooseHarness')
        .mockImplementationOnce(async (_options, screen, open) => open({ kind: 'discovered', harness }, screen.signal))
        .mockResolvedValueOnce(undefined)
      ui.run.mockImplementation(async (_factory: unknown, options: Parameters<typeof runInkChat>[1]) => {
        const screen = { signal: new AbortController().signal, show: vi.fn() }
        await options?.prepare?.(screen)
        if (failure === 'EntrypointLoad') {
          await options?.recoverStartup?.(new Error("No module named 'failed'"), screen)
          await options?.prepare?.(screen)
        }
        return 0
      })
      const home = await temporaryDirectory()
      vi.stubEnv('HOME', home)
      vi.stubEnv('USERPROFILE', home)
      terminal(true)
      const cwd = process.cwd()
      process.chdir(await temporaryDirectory())
      try {
        await main(['dev'])
      } finally {
        process.chdir(cwd)
        vi.unstubAllEnvs()
      }

      expect(choose).toHaveBeenCalledTimes(2)
      expect(choose.mock.calls[1]?.[0].cli).toEqual({ name: 'Saved', path: configPath })
      expect((await readdir(failed)).sort()).toEqual(['agent.ts', 'package.json'])
    }
  )

  it.each(['Back', 'Cancel'] as const)('shouldRestoreAReplacedWorkspaceWhenTheUser%s', async (action) => {
    const failed = await temporaryDirectory()
    await writeFile(join(failed, 'package.json'), '{"type":"module"}')
    await writeFile(join(failed, 'agent.ts'), 'export const agent = {}')
    const other = await temporaryDirectory()
    await writeFile(join(other, 'package.json'), '{"type":"module"}')
    await writeFile(join(other, 'agent.ts'), 'export const agent = {}')
    await bindExistingAgent(join(failed, 'strands-dev'), join(other, 'agent.ts'))
    const before = await readFile(join(failed, 'strands-dev/.config'), 'utf8')
    const harness = {
      name: 'Failed',
      entrypoint: join(failed, 'agent.ts'),
      root: failed,
      language: 'typescript' as const,
    }
    const configPath = join(await temporaryDirectory(), 'cli.toml')
    await writeFile(configPath, '[profile]\nname = "Saved"\n')
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(await CliConfigStore.load(configPath, { persist: false }))
    const setup = vi.fn(async () => {
      replaced = await readFile(join(failed, 'strands-dev/.config'), 'utf8')
      return action === 'Back' ? ('ready' as const) : ('cancel' as const)
    })
    vi.spyOn(projectSetup, 'projectSetupSession').mockReturnValue({
      prepare: setup,
      recover: vi.fn().mockResolvedValue('back'),
    })
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [harness], warnings: [] })
    vi.spyOn(picker, 'chooseHarness')
      .mockImplementationOnce(async (_options, screen, open) =>
        open({ kind: 'discovered', harness }, screen.signal, undefined, true)
      )
      .mockResolvedValueOnce(undefined)
    let replaced = ''
    ui.run.mockImplementation(async (_factory: unknown, options: Parameters<typeof runInkChat>[1]) => {
      const screen = { signal: new AbortController().signal, show: vi.fn() }
      if (!(await options?.prepare?.(screen))) return 0
      await options?.recoverStartup?.(new Error("No module named 'failed'"), screen)
      await options?.prepare?.(screen)
      return 0
    })
    const home = await temporaryDirectory()
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    terminal(true)
    const cwd = process.cwd()
    process.chdir(await temporaryDirectory())
    try {
      await main(['dev'])
    } finally {
      process.chdir(cwd)
      vi.unstubAllEnvs()
    }

    expect(replaced).not.toBe(before)
    expect(await readFile(join(failed, 'strands-dev/.config'), 'utf8')).toBe(before)
    expect((await readdir(failed)).sort()).toEqual(['agent.ts', 'package.json', 'strands-dev'])
  })

  it.each(['Starts', 'FailsToLoad'] as const)('shouldDeleteTheReplacedWorkspaceOnlyAfterTheChat%s', async (outcome) => {
    const parent = await temporaryDirectory()
    const project = join(parent, 'project')
    await mkdir(project)
    await writeFile(join(project, 'package.json'), '{"type":"module"}')
    await writeFile(join(project, 'agent.ts'), 'export const agent = {}')
    const other = await temporaryDirectory()
    await writeFile(join(other, 'package.json'), '{"type":"module"}')
    await writeFile(join(other, 'agent.ts'), 'export const agent = {}')
    await bindExistingAgent(join(project, 'strands-dev'), join(other, 'agent.ts'))
    const before = await readFile(join(project, 'strands-dev/.config'), 'utf8')
    const harness = {
      name: 'Desk',
      entrypoint: join(project, 'agent.ts'),
      root: project,
      language: 'typescript' as const,
    }
    const configPath = join(await temporaryDirectory(), 'cli.toml')
    await writeFile(configPath, '[profile]\nname = "Saved"\n')
    vi.spyOn(CliConfigStore, 'load').mockResolvedValue(await CliConfigStore.load(configPath, { persist: false }))
    vi.spyOn(projectSetup, 'projectSetupSession').mockReturnValue({
      prepare: vi.fn().mockResolvedValue('ready'),
      recover: vi.fn().mockResolvedValue('back'),
    })
    vi.spyOn(search, 'discoverHarnesses').mockResolvedValue({ harnesses: [harness], warnings: [] })
    vi.spyOn(picker, 'chooseHarness')
      .mockImplementationOnce(async (_options, screen, open) =>
        open({ kind: 'discovered', harness }, screen.signal, undefined, true)
      )
      .mockResolvedValueOnce(undefined)
    const controller = new ChatController(idleBackend())
    if (outcome === 'Starts') ui.typescript.mockResolvedValueOnce(controller)
    else ui.typescript.mockRejectedValueOnce(new Error('load failed'))
    const backups = async (): Promise<string[]> =>
      (await readdir(parent)).filter((name) => name.startsWith('.strands-dev-'))
    let beforeChat: string[] = []
    let afterChat: string[] = []
    ui.run.mockImplementation(
      async (factory: Parameters<typeof runInkChat>[0], options: Parameters<typeof runInkChat>[1]) => {
        if (typeof factory !== 'function') throw new Error('expected a controller factory')
        const screen = { signal: new AbortController().signal, show: vi.fn() }
        await options?.prepare?.(screen)
        beforeChat = await backups()
        try {
          await factory(
            new AbortController().signal,
            () => undefined,
            undefined,
            undefined,
            async () => false
          )
        } catch (error) {
          await options?.recoverStartup?.(error, screen)
          await options?.prepare?.(screen)
        }
        await vi.waitFor(async () => expect(await backups()).toEqual([]))
        afterChat = await backups()
        return 0
      }
    )
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    terminal(true)
    const cwd = process.cwd()
    process.chdir(await temporaryDirectory())
    try {
      await main(['dev'])
    } finally {
      process.chdir(cwd)
      await controller.dispose()
    }

    expect(beforeChat).toHaveLength(1)
    expect(afterChat).toEqual([])
    const after = await readFile(join(project, 'strands-dev/.config'), 'utf8')
    if (outcome === 'Starts') expect(after).not.toBe(before)
    else expect(after).toBe(before)
  })
})
