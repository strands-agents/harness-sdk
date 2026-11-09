import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliConfigStore } from '../../src/config/store.js'
import { initializeDevWorkspace } from '../../src/dev/workspace.js'
import { bindExistingAgent } from '../../src/dev/create.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import * as projectSetup from '../../src/dev/project-setup.js'
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
})
