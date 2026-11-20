import { createElement } from 'react'
import { type Instance } from 'ink'
import stringWidth from 'string-width'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../../src/config/store.js'
import { ChatController } from '../../src/ui/chat/controller.js'
import { runInkChat } from '../../src/ui/run.js'
import { DEFAULT_CHAT_SETTINGS } from '../../src/config/settings.js'
import { captureNpm } from '../../src/terminal/npm.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import { SetupWizard } from '../../src/ui/setup/wizard.js'
import { ThemeProvider } from '../../src/ui/theme.js'
import { UpdatePrompt } from '../../src/ui/update.js'
import { ChatRoot, type SetupBridge } from '../../src/ui/app.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import * as terminal from '../../src/terminal/terminal.js'
import { idleBackend } from '../fixtures/chat-backend.js'

const NOTICE = 'Strands CLI 0.1.3 is available! Run `strands update` to install it.'

vi.mock('../../src/package-version.js', async (original) => ({
  ...(await original<typeof import('../../src/package-version.js')>()),
  readCliVersion: () => '0.1.0',
}))

vi.mock('../../src/terminal/npm.js', async (original) => ({
  ...(await original<typeof import('../../src/terminal/npm.js')>()),
  captureNpm: vi.fn(async () => '"0.1.3"\n'),
}))

vi.mock('../../src/model/discovery.js', async (original) => ({
  ...(await original<typeof import('../../src/model/discovery.js')>()),
  discoverAwsConfiguration: vi.fn(() => ({ profiles: [], regions: [] })),
  discoverAwsCredentials: vi.fn(async () => 'valid'),
  discoverOllama: async () => ({ installed: false, running: false, models: [] }),
  discoverLiteLlm: vi.fn(async () => ({ reachable: false, authenticationRequired: false, models: [] })),
  discoverProviderModels: vi.fn(async () => ({ available: true, models: [] })),
}))

async function renderSetup(): Promise<{
  frame: () => string
  settle: () => Promise<void>
  close: () => Promise<void>
}> {
  const output = ttyOutput(120, 30)
  let frame = ''
  output.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('\n')) {
      frame = sanitizeTerminalText(chunk.toString())
    }
  })
  const instance = render(
    createElement(SetupWizard, {
      config: CliConfigStore.memory({}, { animations: false }),
      onComplete: () => {},
    }),
    {
      stdin: ttyInput(),
      stdout: output,
      stderr: output,
      interactive: true,
      debug: true,
      incrementalRendering: false,
      patchConsole: false,
      exitOnCtrlC: false,
    }
  )
  await instance.waitUntilRenderFlush()
  return {
    frame: () => frame,
    settle: async () => {
      await vi.waitFor(() => expect(captureNpm).toHaveBeenCalled())
      await instance.waitUntilRenderFlush()
    },
    close: async () => {
      instance.unmount()
      await instance.waitUntilExit()
    },
  }
}

describe('setup update notice', () => {
  beforeEach(() => {
    vi.mocked(captureNpm).mockClear()
    vi.mocked(captureNpm).mockImplementation(async () => '"0.1.3"\n')
  })

  it('asks npm for the latest release and announces it on the opening menu', async () => {
    const setup = await renderSetup()
    try {
      await vi.waitFor(() => expect(setup.frame()).toContain(NOTICE))
      expect(captureNpm).toHaveBeenCalledWith(['view', '@strands-agents/cli@latest', 'version', '--json'], {
        timeout: 3_000,
      })
      expect(setup.frame()).toContain('Quickstart')
    } finally {
      await setup.close()
    }
  })

  it('prompts once before setup and keeps the update notice after Ask next time', async () => {
    const input = ttyInput()
    const output = ttyOutput(120, 30)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      const rendered = sanitizeTerminalText(chunk.toString())
      if (rendered.includes('\n') && rendered.trim()) frame = rendered
    })
    const checkForUpdate = vi.fn(async () => '0.1.3')
    const setupBridge: SetupBridge = { request: () => {}, confirmMcp: async () => true }
    const instance = render(
      createElement(ChatRoot, {
        intro: false,
        setup: true,
        config: CliConfigStore.memory({}, { animations: false }),
        setupBridge,
        checkForUpdate,
        onSetupComplete: () => {},
        onExitSetup: () => {},
        onUpdateRequested: () => {},
      }),
      {
        stdin: input,
        stdout: output,
        stderr: output,
        interactive: true,
        debug: true,
        incrementalRendering: false,
        patchConsole: false,
        exitOnCtrlC: false,
      }
    )
    try {
      await vi.waitFor(() => expect(frame).toContain('Update available'))
      input.write('\u001b[B')
      await instance.waitUntilRenderFlush()
      input.write('\r')
      await vi.waitFor(() => expect(frame).toContain(NOTICE))
      expect(frame).toContain('Quickstart')
      expect(checkForUpdate).toHaveBeenCalledOnce()
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it.each([
    ['npm latest matches the running version', async (): Promise<string> => '"0.1.0"\n'],
    ['npm latest is older than the running version', async (): Promise<string> => '"0.0.9"\n'],
    [
      'npm is unreachable',
      async (): Promise<string> => {
        throw new Error('ETIMEDOUT')
      },
    ],
    ['npm returns malformed output', async (): Promise<string> => 'not json'],
  ])('shows no notice when %s', async (_case, resolve) => {
    vi.mocked(captureNpm).mockImplementation(resolve)
    const setup = await renderSetup()
    try {
      await setup.settle()
      expect(setup.frame()).toContain('Quickstart')
      expect(setup.frame()).not.toContain('is available')
    } finally {
      await setup.close()
    }
  })
})

describe('update prompt', () => {
  it.each([
    ['setup', '\u0003', 130],
    ['setup', '\u0004', 0],
    ['chat', '\u0003', 130],
    ['chat', '\u0004', 0],
  ] as const)('exits %s on %j with code %i while saving prompt preferences', async (context, key, exitCode) => {
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    const frame = captureFrame(output)
    const config = CliConfigStore.memory({}, { animations: false })
    let finishSave!: () => void
    const saving = new Promise<void>((resolve) => (finishSave = resolve))
    const save = vi.spyOn(config, 'setSettings').mockImplementation(() => saving)
    const controller = new ChatController(idleBackend(), {
      settings: { animations: false },
      setSettings: (settings) => config.setSettings(settings),
    })
    const source = vi.fn(async () => controller)
    let instance: Instance | undefined
    const running = runInkChat(context === 'setup' ? source : controller, {
      config,
      setup: context === 'setup',
      input,
      output,
      errorOutput: output,
      alternateScreen: false,
      intro: false,
      checkForUpdate: async () => '0.1.3',
      renderApp: (node, options) => {
        instance = render(node, { ...options, patchConsole: false, debug: true, incrementalRendering: false })
        return instance
      },
    })
    try {
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Update available'))
      await instance!.waitUntilRenderFlush()
      input.write('3')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Saving…'))
      expect(save).toHaveBeenCalledOnce()
      input.write(key)
      await expect(running).resolves.toBe(exitCode)
      expect(source).not.toHaveBeenCalled()
      expect(config.snapshot().settings.updatePrompts).toBe(true)
    } finally {
      finishSave()
      instance?.unmount()
      await running
      await controller.dispose()
    }
  })

  it.each([
    [40, 12],
    [40, 24],
    [80, 12],
    [80, 24],
  ])('fits all update choices at %ix%i', async (width, height) => {
    const output = ttyOutput(width, height)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      frame = sanitizeTerminalText(chunk.toString())
    })
    const instance = render(
      createElement(ThemeProvider, {
        settings: DEFAULT_CHAT_SETTINGS,
        children: createElement(UpdatePrompt, {
          version: '0.1.3',
          onExit: () => {},
          width,
          height,
          onUpdate: () => {},
          onLater: () => {},
          onDisable: async () => true,
        }),
      }),
      {
        stdin: ttyInput(),
        stdout: output,
        stderr: output,
        interactive: true,
        debug: true,
        incrementalRendering: false,
        patchConsole: false,
        exitOnCtrlC: false,
      }
    )
    try {
      await instance.waitUntilRenderFlush()
      for (const text of ['Update available', 'Update now', 'Ask next time', "Don't ask again"]) {
        expect(frame).toContain(text)
      }
      expect(frame).toContain('Strands CLI 0.1.3 is available!')
      expect(frame).toContain('┌')
      expect(frame).toContain('└')
      expect(frame.split('\n').every((line) => stringWidth(line) <= width)).toBe(true)
      expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(height)
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it('selects choices on hover and activates them on click', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    const onLater = vi.fn()
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      const rendered = sanitizeTerminalText(chunk.toString())
      if (rendered.includes('\n')) frame = rendered
    })
    const instance = render(
      createElement(ThemeProvider, {
        settings: DEFAULT_CHAT_SETTINGS,
        children: createElement(UpdatePrompt, {
          version: '0.1.3',
          onExit: () => {},
          width: 80,
          height: 24,
          manageMouseMotion: true,
          onUpdate: () => {},
          onLater,
          onDisable: async () => true,
        }),
      }),
      {
        stdin: input,
        stdout: output,
        stderr: output,
        interactive: true,
        debug: true,
        incrementalRendering: false,
        patchConsole: false,
        exitOnCtrlC: false,
      }
    )
    try {
      await instance.waitUntilRenderFlush()
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes('Ask next time'))
      const column = stringWidth(lines[row]!.slice(0, lines[row]!.indexOf('Ask next time'))) + 1
      const terminalRow = row + 1

      input.write(`\u001b[<32;${column};${terminalRow}M`)
      await instance.waitUntilRenderFlush()
      expect(frame.split('\n').find((line) => line.includes('Ask next time'))).toContain('▸ Ask next time')
      expect(frame).toContain('Dismiss this prompt for this launch.')

      input.write(`\u001b[<0;${column};${terminalRow}M`)
      input.write(`\u001b[<0;${column};${terminalRow}m`)
      await vi.waitFor(() => expect(onLater).toHaveBeenCalledOnce())
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it.each([
    ['Update now', 0],
    ['Ask next time', 1],
    ["Don't ask again", 2],
  ] as const)('runs the selected %s action', async (_label, expected) => {
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    const actions = [vi.fn(), vi.fn(), vi.fn(async () => true)] as const
    const instance = render(
      createElement(ThemeProvider, {
        settings: DEFAULT_CHAT_SETTINGS,
        children: createElement(UpdatePrompt, {
          version: '0.1.3',
          onExit: () => {},
          width: 80,
          height: 24,
          onUpdate: actions[0],
          onLater: actions[1],
          onDisable: actions[2],
        }),
      }),
      {
        stdin: input,
        stdout: output,
        stderr: output,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      }
    )
    try {
      for (let index = 0; index < expected; index++) {
        input.write('\u001b[C')
        await instance.waitUntilRenderFlush()
      }
      input.write('\r')
      await vi.waitFor(() => expect(actions[expected]).toHaveBeenCalledOnce())
      expect(actions.filter((action) => action.mock.calls.length > 0)).toHaveLength(1)
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it('shouldCopyTheWholeDisableFailureWhenControlYIsPressed', async () => {
    const copy = vi.spyOn(terminal, 'copyTerminalText').mockResolvedValue(true)
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    const frame = captureFrame(output)
    const failure = `EACCES: permission denied, open '${'/home/test/.strands/'.repeat(6)}cli.toml'`
    const instance = render(
      createElement(ThemeProvider, {
        settings: DEFAULT_CHAT_SETTINGS,
        children: createElement(UpdatePrompt, {
          version: '0.1.3',
          onExit: () => {},
          width: 80,
          height: 24,
          onUpdate: vi.fn(),
          onLater: vi.fn(),
          onDisable: vi.fn(async () => {
            throw new Error(failure)
          }),
        }),
      }),
      { stdin: input, stdout: output, stderr: output, interactive: true, patchConsole: false, exitOnCtrlC: false }
    )
    try {
      input.write('\u001b[C')
      await instance.waitUntilRenderFlush()
      input.write('\u001b[C')
      await instance.waitUntilRenderFlush()
      input.write('\r')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('· Ctrl+Y copy error'))

      input.write('\u0019')

      await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
      expect(copy.mock.calls[0]![0]).toBe(failure)
      expect(frame().every((line) => stringWidth(line) <= 80)).toBe(true)
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      copy.mockRestore()
    }
  })
})
