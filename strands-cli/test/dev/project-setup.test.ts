import { createElement } from 'react'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ProjectSetupPanel, projectSetupSession } from '../../src/dev/project-setup.js'
import { runInkChat } from '../../src/ui/run.js'
import { CliConfigStore } from '../../src/config/store.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

type RenderApp = NonNullable<NonNullable<Parameters<typeof runInkChat>[1]>['renderApp']>

describe('project setup guidance', () => {
  it('shouldShowRootRuntimeCommandsAndTrustNoticeBeforePreparing', async () => {
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
          commands: [{ stage: 'build', command: 'npm', args: ['run', 'build'] }],
        },
        onAction: action,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('npm run build'))
    expect(frame().join('\n')).toContain('Root: /project')
    expect(frame().join('\n')).toContain('Runtime: Node 22')
    expect(frame().join('\n')).toContain('execute project code')
    input.write('v')
    await vi.waitFor(() => expect(action).toHaveBeenCalledWith('validate'))
  })

  it('shouldKeepImportFailuresInTheTuiAndAllowValidationRetry', async () => {
    const input = ttyInput()
    const output = ttyOutput(140, 40)
    const frame = captureFrame(output)
    const root = await temporaryDirectory()
    await writeFile(join(root, 'agent.py'), 'invalid source fixture')
    const project = { root, entrypoint: join(root, 'agent.py'), language: 'python' as const }
    const setup = projectSetupSession()
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
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Prepare selected project'))
      expect(factory).not.toHaveBeenCalled()
      input.write('v')
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
