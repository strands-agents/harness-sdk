import { createElement } from 'react'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectSetupPanel, projectSetupSession } from '../../src/dev/project-setup.js'
import { runInkChat } from '../../src/ui/run.js'
import { CliConfigStore } from '../../src/config/store.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'
import * as preparation from '../../src/project/preparation.js'
import * as terminal from '../../src/terminal/terminal.js'

afterEach(() => vi.restoreAllMocks())

type RenderApp = NonNullable<NonNullable<Parameters<typeof runInkChat>[1]>['renderApp']>

describe('project setup guidance', () => {
  it('shouldPrepareAutomaticallyWithoutAskingForConfirmation', async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, 'agent.ts')
    await writeFile(entrypoint, 'export const agent = {}')
    await writeFile(join(root, 'package.json'), '{}')
    const execute = vi.spyOn(preparation, 'executePreparation').mockResolvedValue('/tmp/setup.log')
    const screen = { signal: new AbortController().signal, show: vi.fn() }

    expect(await projectSetupSession().prepare({ root, entrypoint, language: 'typescript' }, screen)).toBe('ready')

    expect(execute).toHaveBeenCalledOnce()
    expect(screen.show.mock.calls.every(([content]) => content === undefined)).toBe(true)
  })

  it('shouldShowActionableDetailsOnlyWhenSetupFails', async () => {
    const input = ttyInput()
    const output = ttyOutput(140, 40)
    const frame = captureFrame(output)
    const action = vi.fn()
    render(
      createElement(ProjectSetupPanel, {
        plan: {
          project: { root: '/project', entrypoint: '/project/agent.ts', language: 'typescript' },
          runtime: 'Node 22',
          manager: 'npm',
          fingerprint: 'x',
          commands: [],
        },
        failure: {
          stage: 'build',
          summary: 'Project build failed',
          action: 'Fix the project, then Retry.',
          command: 'npm run build',
          logPath: '/tmp/setup.log',
          details: 'Build failed',
        },
        onAction: action,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Project build failed'))
    expect(frame().join('\n')).toContain('Root: /project')
    expect(frame().join('\n')).toContain('Runtime: Node 22')
    expect(frame().join('\n')).toContain('Log: /tmp/setup.log')
    input.write('v')
    await vi.waitFor(() => expect(action).toHaveBeenCalledWith('validate'))
  })

  it('shouldCopyTheFullSetupReportWhenControlYIsPressed', async () => {
    const copy = vi.spyOn(terminal, 'copyTerminalText').mockResolvedValue(true)
    const input = ttyInput()
    const output = ttyOutput(100, 40)
    const frame = captureFrame(output)
    const details = `error TS2307: ${'Cannot find module ./missing-dependency. '.repeat(10)}\nsecond log line`
    const command = `npm run build -- ${'--flag '.repeat(30)}`
    render(
      createElement(ProjectSetupPanel, {
        plan: {
          project: { root: '/project', entrypoint: '/project/agent.ts', language: 'typescript' },
          runtime: 'Node 22',
          manager: 'npm',
          fingerprint: 'x',
          commands: [],
        },
        failure: {
          stage: 'build',
          summary: 'Project build failed',
          action: 'Fix the project, then Retry.',
          command,
          logPath: '/tmp/setup.log',
          details,
        },
        onAction: vi.fn(),
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Ctrl+Y copy error'))

    input.write('\u0019')

    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    expect(copy.mock.calls[0]![0]).toBe(
      [
        'Project build failed',
        'Root: /project',
        'Entrypoint: /project/agent.ts',
        'Runtime: Node 22',
        details,
        'Fix the project, then Retry.',
        `Failed command: ${command}`,
        'Log: /tmp/setup.log',
      ].join('\n')
    )
  })

  it('shouldKeepImportFailuresInTheTuiAndAllowValidationRetry', async () => {
    const input = ttyInput()
    const output = ttyOutput(140, 40)
    const frame = captureFrame(output)
    const root = await temporaryDirectory()
    await writeFile(join(root, 'agent.py'), 'invalid source fixture')
    const project = { root, entrypoint: join(root, 'agent.py'), language: 'python' as const }
    const setup = projectSetupSession()
    vi.spyOn(preparation, 'executePreparation').mockResolvedValue('/tmp/setup.log')
    const controller = new ChatController(idleBackend())
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error("No module named 'refund_desk'"))
      .mockResolvedValueOnce(controller)
    const running = runInkChat(factory, {
      input,
      output,
      errorOutput: output,
      config: CliConfigStore.memory({}, { animations: false }),
      intro: false,
      renderApp: render as RenderApp,
      prepare: async (screen) => (await setup.prepare(project, screen)) === 'ready',
      recoverStartup: setup.recover,
    })
    try {
      await vi.waitFor(() => expect(frame().join('\n')).toContain('refund_desk'))
      expect(frame().join('\n')).toContain('editable install')
      input.write('d')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('hide details'))
      input.write('v')
      await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
      controller.close()
      expect(await running).toBe(0)
    } finally {
      input.write('b')
      controller.close()
      await controller.dispose()
    }
  })

  it('shouldRetryWithUpdatedCommandsWithoutAnotherConfirmation', async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, 'agent.ts')
    const manifest = join(root, 'package.json')
    await writeFile(entrypoint, 'export const agent = {}')
    await writeFile(manifest, '{}')
    const input = ttyInput()
    const output = ttyOutput(140, 40)
    const frame = captureFrame(output)
    const setup = projectSetupSession()
    const execute = vi
      .spyOn(preparation, 'executePreparation')
      .mockRejectedValueOnce(new Error('Install failed'))
      .mockResolvedValue('/tmp/setup.log')
    const running = runInkChat(
      async (): Promise<never> => {
        throw new Error('must not start')
      },
      {
        input,
        output,
        errorOutput: output,
        intro: false,
        config: CliConfigStore.memory({}, { animations: false }),
        renderApp: render as RenderApp,
        prepare: async (screen) => {
          await setup.prepare({ root, entrypoint, language: 'typescript' }, screen)
          return false
        },
      }
    )
    try {
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Install failed'))
      await writeFile(manifest, '{"scripts":{"build":"echo changed"}}')
      input.write('r')
      await running
      expect(execute).toHaveBeenCalledTimes(2)
      expect(execute.mock.calls[1]?.[0].commands).toContainEqual({
        stage: 'build',
        command: 'npm',
        args: ['--global=false', 'run', 'build'],
      })
    } finally {
      input.write('b')
      await running
    }
  })

  it('shouldReturnToSelectionWhenBackIsChosenAfterFailure', async () => {
    const input = ttyInput()
    const output = ttyOutput(140, 40)
    const frame = captureFrame(output)
    const setup = projectSetupSession()
    const prepare = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const running = runInkChat(
      async (): Promise<never> => {
        throw new Error('Build failed')
      },
      {
        input,
        output,
        errorOutput: output,
        config: CliConfigStore.memory({}, { animations: false }),
        intro: false,
        renderApp: render as RenderApp,
        prepare,
        recoverStartup: setup.recover,
      }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Project entrypoint failed'))
    input.write('b')
    expect(await running).toBe(0)
    expect(prepare).toHaveBeenCalledTimes(2)
  })
})
