import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../../src/config/store.js'
import { projectSetupSession } from '../../src/dev/project-setup.js'
import { discoverProviderModels } from '../../src/model/discovery.js'
import * as preparation from '../../src/project/preparation.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { runInkChat } from '../../src/ui/run.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { captureFrame, mouseInputSequence, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

vi.mock('../../src/model/discovery.js', async (original) => ({
  ...(await original<typeof import('../../src/model/discovery.js')>()),
  discoverAwsConfiguration: vi.fn(() => ({ profiles: [], regions: [] })),
  discoverAwsCredentials: vi.fn(async () => 'valid'),
  discoverOllama: async () => ({ installed: false, running: false, models: [] }),
  discoverLiteLlm: vi.fn(async () => ({ reachable: false, authenticationRequired: false, models: [] })),
  discoverProviderModels: vi.fn(async () => ({ available: true, models: [] })),
}))

type RenderApp = NonNullable<NonNullable<Parameters<typeof runInkChat>[1]>['renderApp']>

const MISSING_KEY =
  'Anthropic API key is required. Provide it via the apiKey option or set the ANTHROPIC_API_KEY environment variable.'

afterEach(() => vi.restoreAllMocks())

const startWithMissingKey = async () => {
  const input = ttyInput()
  const output = ttyOutput(180, 44)
  const frame = captureFrame(output)
  const root = await temporaryDirectory()
  await writeFile(join(root, 'agent.ts'), 'fixture')
  const project = { root, entrypoint: join(root, 'agent.ts'), language: 'typescript' as const }
  const setup = projectSetupSession()
  vi.spyOn(preparation, 'executePreparation').mockResolvedValue('/tmp/setup.log')
  const controller = new ChatController(idleBackend())
  const factory = vi.fn().mockRejectedValueOnce(new Error(MISSING_KEY)).mockResolvedValueOnce(controller)
  const running = runInkChat(factory, {
    input,
    output,
    errorOutput: output,
    config: CliConfigStore.memory({}, { animations: false }),
    intro: false,
    renderApp: render as RenderApp,
    prepare: async (screen) => (await setup.prepare(project, screen)) === 'ready',
    recoverStartup: setup.recover,
    providerSetup: { model: () => 'bedrock/model-alpha' },
  })
  const screenText = (): string => frame().join('\n')
  const click = (text: string): void => {
    const lines = frame()
    const row = lines.findIndex((line) => line.includes(text))
    expect(row).toBeGreaterThanOrEqual(0)
    const column = lines[row]!.indexOf(text)
    input.write(mouseInputSequence(0, column, row, 'M'))
    input.write(mouseInputSequence(3, column, row, 'm'))
  }
  return { input, screenText, click, factory, controller, running }
}

describe('model provider recovery at startup', () => {
  it('shouldRetryWithTheChosenModelWhenSetupSavesFromAMissingKeyFailure', async () => {
    vi.mocked(discoverProviderModels).mockResolvedValue({
      available: true,
      models: [
        { id: 'model-alpha', name: 'Model Alpha' },
        { id: 'model-beta', name: 'Model Beta' },
      ],
    })
    const { input, screenText, click, factory, controller, running } = await startWithMissingKey()
    try {
      await vi.waitFor(() => expect(screenText()).toContain('s set up a model'))
      expect(screenText()).not.toContain('f fix with Strands')

      input.write('s')
      await vi.waitFor(() => expect(screenText()).toContain('Model Beta'))
      click('Model Beta')
      await vi.waitFor(() => expect(screenText()).toContain('✓ Model Beta'))
      click('Save and Launch')

      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
      expect(factory.mock.calls[1]![3]).toMatchObject({ configuration: { profile: { model: 'bedrock/model-beta' } } })
      controller.close()
      expect(await running).toBe(0)
    } finally {
      controller.close()
      await controller.dispose()
      vi.mocked(discoverProviderModels).mockResolvedValue({ available: true, models: [] })
    }
  })

  it('shouldReturnToTheStartupErrorWithoutAChosenModelWhenSetupIsCancelled', async () => {
    const { input, screenText, factory, controller, running } = await startWithMissingKey()
    try {
      await vi.waitFor(() => expect(screenText()).toContain('s set up a model'))
      input.write('s')
      await vi.waitFor(() => expect(screenText()).toContain('Pick a model for your agent'))

      input.write('\u001b')

      await vi.waitFor(() => expect(screenText()).toContain('s set up a model'))
      expect(factory).toHaveBeenCalledOnce()
      input.write('r')
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
      expect(factory.mock.calls[1]![3]).toBeUndefined()
      controller.close()
      expect(await running).toBe(0)
    } finally {
      controller.close()
      await controller.dispose()
    }
  })
})
