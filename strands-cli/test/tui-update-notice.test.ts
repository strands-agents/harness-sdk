import { createElement } from 'react'
import { render } from 'ink'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../src/tui/config.js'
import { captureNpm } from '../src/tui/npm.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { SetupWizard } from '../src/tui/view/setup-wizard/index.js'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'

const NOTICE = 'Strands CLI 0.1.3 is available. Run `strands update` to install it.'

vi.mock('../src/tui/package-version.js', async (original) => ({
  ...(await original<typeof import('../src/tui/package-version.js')>()),
  readCliVersion: () => '0.1.0',
}))

vi.mock('../src/tui/npm.js', async (original) => ({
  ...(await original<typeof import('../src/tui/npm.js')>()),
  captureNpm: vi.fn(async () => '"0.1.3"\n'),
}))

vi.mock('../src/tui/provider/discovery.js', async (original) => ({
  ...(await original<typeof import('../src/tui/provider/discovery.js')>()),
  discoverAwsConfiguration: vi.fn(() => ({ profiles: [], regions: [] })),
  discoverAwsCredentials: vi.fn(async () => 'valid'),
  discoverOllama: async () => ({ installed: false, running: false, models: [] }),
  discoverLiteLlm: vi.fn(async () => ({ reachable: false, authenticationRequired: false, models: [] })),
  discoverProviderModels: vi.fn(async () => ({ available: true, models: [] })),
}))

async function renderSetup(props: { appearanceOnly?: boolean } = {}): Promise<{
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
      ...props,
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
      expect(setup.frame()).toContain('Resume')
    } finally {
      await setup.close()
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
      expect(setup.frame()).toContain('Resume')
      expect(setup.frame()).not.toContain('is available')
    } finally {
      await setup.close()
    }
  })

  it('skips the check when setup only opens appearance settings', async () => {
    const setup = await renderSetup({ appearanceOnly: true })
    try {
      expect(captureNpm).not.toHaveBeenCalled()
    } finally {
      await setup.close()
    }
  })
})
