import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createElement } from 'react'
import { render } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../src/tui/config.js'
import type { SetupChange } from '../src/tui/agent-configuration.js'
import { DEFAULT_CHAT_SETTINGS } from '../src/tui/chat/types.js'
import { settingsRows } from '../src/tui/chat/panels.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { SetupWizard } from '../src/tui/view/setup-wizard/index.js'
import { APPEARANCE_STEP, setupStepProgress, wizardSettingsRows } from '../src/tui/view/setup-wizard/steps.js'
import { discoverAwsConfiguration, discoverAwsCredentials, discoverLiteLlm } from '../src/tui/provider/discovery.js'
import { discoverAwsConfiguration as readAwsConfiguration } from '../src/tui/provider/aws-config.js'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'

vi.mock('../src/tui/provider/discovery.js', async (original) => ({
  ...(await original<typeof import('../src/tui/provider/discovery.js')>()),
  discoverAwsConfiguration: vi.fn(() => ({ profiles: [], regions: [] })),
  discoverAwsCredentials: vi.fn(async () => 'valid'),
  discoverOllama: async () => ({ installed: false, running: false, models: [] }),
  discoverLiteLlm: vi.fn(async () => ({ reachable: false, authenticationRequired: false, models: [] })),
  discoverProviderModels: vi.fn(async () => ({ available: true, models: [] })),
}))

describe('setup presentation', () => {
  it('reports progress through the quickstart flow', () => {
    expect([
      setupStepProgress('quickstart', 1),
      setupStepProgress('quickstart', 2),
      setupStepProgress('quickstart', 3),
      setupStepProgress('quickstart', APPEARANCE_STEP),
    ]).toEqual([
      { current: 1, total: 4, instruction: 'Pick a model for your agent' },
      { current: 2, total: 4, instruction: "Choose your agent's tools" },
      { current: 3, total: 4, instruction: 'Choose plugins and features' },
      { current: 4, total: 4, instruction: 'Choose how Strands looks' },
    ])
  })

  it.each([
    [80, 24],
    [30, 18],
    [120, 30],
  ])('fits model setup and responsive actions/footer at %s×%s', async (columns, terminalRows) => {
    const input = ttyInput()
    const output = ttyOutput(columns, terminalRows)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        frame = sanitizeTerminalText(chunk.toString())
      }
    })
    const instance = render(
      createElement(SetupWizard, {
        config: CliConfigStore.memory({}, {}, { animations: false }),
        onComplete: () => {},
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
      input.push('\r')
      await instance.waitUntilRenderFlush()
      await vi.waitFor(() => expect(frame).toContain('1 of 4'))
      expect(frame).not.toContain('Step 1:')
      expect(frame).toContain('Pick a model for your agent')
      expect(frame).toContain('Back')
      expect(frame).not.toContain('Reset')
      expect(frame).toContain('Continue')
      expect(frame).toContain(columns < 32 ? 'Click/Enter · ↑↓' : 'Click or Enter to choose')
      if (columns >= 38) {
        expect(frame).toContain('Providers')
        expect(frame).toContain('Models')
      }
      if (columns >= 100) {
        expect(frame).not.toContain('Reasoning')
      }
      const lines = frame.trimEnd().split('\n')
      expect(lines.length).toBeLessThanOrEqual(terminalRows)
      expect(lines.every((line) => stringWidth(line) <= columns)).toBe(true)
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it('clears the model-search placeholder and starts input at the left edge when clicked', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 30)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        frame = sanitizeTerminalText(chunk.toString())
      }
    })
    const instance = render(
      createElement(SetupWizard, {
        config: CliConfigStore.memory({}, {}, { animations: false }),
        onComplete: () => {},
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
      input.push('\r')
      await instance.waitUntilRenderFlush()
      await vi.waitFor(() => expect(frame).toContain('Search models'))
      const lines = frame.split('\n')
      const searchRow = lines.findIndex((line) => line.includes('Search models'))
      const searchColumn = lines[searchRow]!.indexOf('/')

      input.push(mouseInputSequence(0, searchColumn, searchRow, 'M'))
      input.push(mouseInputSequence(3, searchColumn, searchRow, 'm'))
      await instance.waitUntilRenderFlush()

      expect(frame).not.toContain('Search models')
      expect(frame.split('\n')[searchRow]!.includes('/')).toBe(false)
      input.push('c')
      await instance.waitUntilRenderFlush()
      expect(frame.split('\n')[searchRow]!.indexOf('c')).toBe(searchColumn)
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it('cancels an empty import path on click-away and validates it only on Enter', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        frame = sanitizeTerminalText(chunk.toString())
      }
    })
    const instance = render(
      createElement(SetupWizard, {
        config: CliConfigStore.memory({}, {}, { animations: false }),
        onComplete: () => {},
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
    const press = async (key: string): Promise<void> => {
      input.push(key)
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      for (let index = 0; index < 3; index++) await press('\u001b[B')
      await press('\r')
      await press('\r')
      await press(mouseInputSequence(0, 0, 0, 'M'))
      await press(mouseInputSequence(3, 0, 0, 'm'))

      expect(frame).not.toContain('This field cannot be empty.')

      await press('\r')
      await press('\r')
      expect(frame).toContain('This field cannot be empty.')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it('detects local providers without asking for endpoint URLs', async () => {
    vi.stubEnv('OLLAMA_HOST', undefined)
    vi.stubEnv('LITELLM_BASE_URL', undefined)
    const input = ttyInput()
    const output = ttyOutput(100, 30)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        frame = sanitizeTerminalText(chunk.toString())
      }
    })
    const instance = render(
      createElement(SetupWizard, {
        config: CliConfigStore.memory({}, {}, { animations: false }),
        onComplete: () => {},
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
    const press = async (key: string): Promise<void> => {
      input.push(key)
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      await press('\r')
      for (let index = 0; index < 5; index++) await press('\u001b[B')
      await vi.waitFor(() => expect(frame).toContain('Ollama: Not found'))
      expect(frame).toContain('Models: Not checked')
      expect(frame).toContain('Install Ollama from https://ollama.com/download')
      expect(frame).not.toContain('Host')
      expect(frame).not.toContain('11434')

      await press('\u001b[B')
      await vi.waitFor(() => expect(frame).toContain('LiteLLM: Not found'))
      expect(frame).toContain('Models: Not checked')
      expect(frame).toContain('Start the LiteLLM proxy on localhost:4000')
      expect(frame).not.toContain('Base URL')
      expect(frame).not.toContain('Enter API key')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      vi.unstubAllEnvs()
    }
  })

  it('asks for a LiteLLM key only when the detected proxy requires one', async () => {
    vi.stubEnv('LITELLM_API_KEY', undefined)
    vi.mocked(discoverLiteLlm).mockResolvedValue({
      reachable: true,
      authenticationRequired: true,
      models: [],
      status: 401,
    })
    const input = ttyInput()
    const output = ttyOutput(100, 30)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        frame = sanitizeTerminalText(chunk.toString())
      }
    })
    const instance = render(
      createElement(SetupWizard, {
        config: CliConfigStore.memory({}, {}, { animations: false }),
        onComplete: () => {},
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
    const press = async (key: string): Promise<void> => {
      input.push(key)
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      await press('\r')
      for (let index = 0; index < 6; index++) await press('\u001b[B')
      await vi.waitFor(() => expect(frame).toContain('Models: Authentication required'))
      expect(frame).toContain('Enter LITELLM_API_KEY below, then choose Refresh.')
      expect(frame).toContain('Click to enter text')
      expect(frame).not.toContain('Base URL')

      await press('\r')
      await press('proxy-secret')
      expect(frame).not.toContain('proxy-secret')
      expect(frame).toContain('••••••••••••')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      vi.mocked(discoverLiteLlm)
        .mockReset()
        .mockResolvedValue({ reachable: false, authenticationRequired: false, models: [] })
      vi.unstubAllEnvs()
    }
  })

  it('ignores input while fading between setup panels', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 30)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        frame = sanitizeTerminalText(chunk.toString())
      }
    })
    const instance = render(
      createElement(SetupWizard, {
        config: CliConfigStore.memory({}, {}, { animations: true }),
        onComplete: () => {},
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
      input.push('\r')
      input.push('\u001b[B')
      input.push('\r')
      await instance.waitUntilRenderFlush()
      await delay(180)
      await vi.waitFor(() => expect(frame).toContain('1 of 4'))
      expect(frame).not.toContain('Name and instruct your agent')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })
})

describe('setup refresh', () => {
  it.each([
    [40, 24],
    [80, 24],
  ])('refreshes env-file credentials in the mounted wizard at %s×%s', async (columns, terminalRows) => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-setup-refresh-'))
    const path = join(directory, 'provider.env')
    const firstConfig = join(directory, 'first-config')
    const secondConfig = join(directory, 'second-config')
    const credentials = join(directory, 'credentials')
    await writeFile(firstConfig, '[profile review]\nregion=us-east-1\n')
    await writeFile(secondConfig, '[profile review]\nregion=us-east-2\n')
    await writeFile(credentials, '')
    const selectors = (configFile: string): string =>
      `AWS_CONFIG_FILE=${configFile}\nAWS_SHARED_CREDENTIALS_FILE=${credentials}\nAWS_PROFILE=review\n`
    await writeFile(path, selectors(firstConfig))
    for (const key of [
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
      'AWS_PROFILE',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_CONFIG_FILE',
      'AWS_SHARED_CREDENTIALS_FILE',
    ]) {
      vi.stubEnv(key, undefined)
    }
    vi.mocked(discoverAwsConfiguration).mockImplementation(readAwsConfiguration)
    vi.mocked(discoverAwsCredentials).mockImplementation(async (environment) =>
      environment.AWS_BEARER_TOKEN_BEDROCK?.value === 'refreshed-token' ? 'valid' : 'expired'
    )
    const config = CliConfigStore.memory({}, {}, { animations: false })
    config.useEnvironmentFiles([path])
    const input = ttyInput()
    const output = ttyOutput(columns, terminalRows)
    const writes: string[] = []
    output.on('data', (chunk: Buffer) => writes.push(chunk.toString()))
    const instance = render(createElement(SetupWizard, { config, onComplete: () => {} }), {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const text = (): string => sanitizeTerminalText(writes.join(''))
    const press = async (key: string): Promise<void> => {
      input.push(key)
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      await press('\r')
      await vi.waitFor(() => {
        expect(text()).toContain('AWS credentials')
        expect(text()).toContain('xpired.')
      })
      writes.length = 0
      // Backward tabbing reaches the universal provider refresh action.
      for (let index = 0; index < 2; index++) await press('\u001b[Z')
      await writeFile(path, `${selectors(secondConfig)}AWS_BEARER_TOKEN_BEDROCK=refreshed-token`)
      writes.length = 0
      await press('\r')
      await vi.waitFor(() =>
        expect(discoverAwsCredentials).toHaveBeenLastCalledWith(
          expect.objectContaining({
            AWS_CONFIG_FILE: { value: secondConfig, source: 'env-file' },
            AWS_SHARED_CREDENTIALS_FILE: { value: credentials, source: 'env-file' },
            AWS_REGION: { value: 'us-east-2', source: 'aws-profile' },
            AWS_BEARER_TOKEN_BEDROCK: { value: 'refreshed-token', source: 'env-file' },
          })
        )
      )
      await vi.waitFor(() => expect(text()).toContain('Models'))
      expect(discoverAwsConfiguration).toHaveBeenLastCalledWith({
        AWS_CONFIG_FILE: secondConfig,
        AWS_SHARED_CREDENTIALS_FILE: credentials,
      })
      expect(text()).not.toContain('refreshed-token')
      expect(text()).toContain('Models')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      vi.mocked(discoverAwsCredentials).mockReset().mockResolvedValue('valid')
      vi.mocked(discoverAwsConfiguration).mockReset().mockReturnValue({ profiles: [], regions: [] })
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sets a masked API key for the running session from the provider panel', async () => {
    vi.stubEnv('OPENAI_API_KEY', undefined)
    const config = CliConfigStore.memory({}, {}, { animations: false })
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        frame = sanitizeTerminalText(chunk.toString())
      }
    })
    const instance = render(createElement(SetupWizard, { config, onComplete: () => {} }), {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      debug: true,
      incrementalRendering: false,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const press = async (key: string): Promise<void> => {
      input.push(key)
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      await press('\r')
      for (let index = 0; index < 3; index++) await press('\u001b[B')
      await vi.waitFor(() => expect(frame).toContain('OPENAI_API_KEY was not detected.'))
      expect(frame).not.toContain('Set up OpenAI')
      expect(frame).toContain('Click to enter text')
      expect(frame).toContain('Session only · Add to')
      expect(frame).toContain('Refresh')
      expect(frame.match(/Refresh/gu)).toHaveLength(1)
      const refreshLine = frame.split('\n').find((line) => line.includes('Refresh'))!
      expect(refreshLine.indexOf('Refresh')).toBeLessThan(30)
      await press('\r')
      expect(frame).not.toContain('Click to enter text')
      expect(frame).toContain('▌')
      await press(mouseInputSequence(0, 0, 0, 'M'))
      await press(mouseInputSequence(3, 0, 0, 'm'))
      expect(frame).not.toContain('API key cannot be empty.')
      expect(frame).toContain('Click to enter text')
      await press('\r')

      await press('sk-session-secret')
      expect(frame).not.toContain('sk-session-secret')
      expect(frame).toContain('•••••••••••••••••')
      await press('\r')

      await vi.waitFor(() => expect(frame).toContain('Models'))
      expect(config.providerEnvironment().OPENAI_API_KEY).toEqual({
        value: 'sk-session-secret',
        source: 'session',
      })
      expect(config.configuredProviderEnvironment()).not.toHaveProperty('OPENAI_API_KEY')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      vi.unstubAllEnvs()
    }
  })
})

describe('setup theme', () => {
  it('uses the same complete settings list as the regular settings panel', () => {
    const update = vi.fn()
    const openThemePicker = vi.fn()
    const setupRows = wizardSettingsRows(DEFAULT_CHAT_SETTINGS, update, openThemePicker, 'all')
    const regularRows = settingsRows(DEFAULT_CHAT_SETTINGS)
    const theme = setupRows[1]!
    const regularTheme = regularRows[1]!.control

    expect(setupRows.map(({ label }) => label)).toEqual(regularRows.map(({ label }) => label))
    expect(regularTheme?.kind).toBe('segmented')
    expect(theme.choices?.map(({ label }) => label)).toEqual(
      regularTheme?.kind === 'segmented' ? regularTheme.options.map(({ label }) => label) : []
    )
    theme.choices?.at(-1)?.activate()
    expect(openThemePicker).toHaveBeenCalledOnce()
    expect(update).not.toHaveBeenCalled()
  })

  it('shows and persists non-visual settings from the setup panel', async () => {
    const config = CliConfigStore.memory({}, {}, { animations: false })
    const input = ttyInput()
    const output = ttyOutput(120, 44)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      frame = sanitizeTerminalText(chunk.toString())
    })
    const instance = render(createElement(SetupWizard, { config, onComplete: () => {} }), {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      debug: true,
      incrementalRendering: false,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const press = async (key: string): Promise<void> => {
      input.push(key)
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      await press('\u0013')
      await vi.waitFor(() => expect(frame).toContain('Auto-Discovery'))
      expect(frame).toContain('Color mode')
      expect(frame).toContain('Transcript spacing')
      expect(frame).not.toContain('Presentation')
      await press('\t')
      expect(frame).toContain('Skills')
      expect(frame).toContain('Agents (peer-to-peer messaging)')
      expect(frame).toMatch(/Agents \(peer-to-peer messaging\).*On/u)
      await press('\u001b[C')
      await vi.waitFor(() => expect(config.snapshot().settings.mcpDiscovery).toBe(true))
      await press('\t')
      expect(frame).toContain('Usage ping (telemetry)')
      await press('\u001b[B')
      await press('\u001b[C')
      await vi.waitFor(() => expect(config.snapshot().settings.telemetry).toBe(false))
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it('persists a custom theme applied from setup settings', async () => {
    const config = CliConfigStore.memory({}, {}, { animations: false })
    const input = ttyInput()
    const output = ttyOutput(120, 24)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      frame = sanitizeTerminalText(chunk.toString())
    })
    const instance = render(createElement(SetupWizard, { config, onComplete: () => {} }), {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      debug: true,
      incrementalRendering: false,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const press = async (key: string): Promise<void> => {
      input.push(key)
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      await press('\u0013')
      await press('\r')
      await vi.waitFor(() => expect(frame).toContain('Custom'))
      const themeLines = frame.split('\n')
      const colorModeLine = themeLines.find((line) => /Auto.*Light.*Dark/u.test(line))
      const firstThemeLine = themeLines.find((line) => line.includes('Classic'))
      expect(firstThemeLine).toMatch(/Classic.*Minimal.*Homeland/u)
      expect(themeLines.find((line) => line.includes('Merlin'))).toMatch(/Merlin.*Kikker.*Cyborg/u)
      expect(themeLines.find((line) => line.includes('Spectre'))).toMatch(/Spectre.*Custom/u)
      expect(colorModeLine).toBeDefined()
      expect(themeLines.every((line) => stringWidth(line) <= 120)).toBe(true)
      await press('\u001b[B')
      await press('\u001b[D')
      await press('\t')
      await press('\t')
      await press('\t')
      await press('\r')
      await vi.waitFor(() => expect(config.snapshot().settings.frogTheme).toBe('custom'))
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it.each([
    { name: 'retains the saved theme', fresh: false, expected: 'merlin' },
    { name: 'uses the default for fresh setup', fresh: true, expected: DEFAULT_CHAT_SETTINGS.frogTheme },
  ])('$name', async ({ fresh, expected }) => {
    const config = CliConfigStore.memory(
      {},
      {},
      fresh ? { animations: false } : { frogTheme: 'merlin', animations: false },
      {
        onboardingVersion: fresh ? 0 : 1,
      }
    )
    const input = ttyInput()
    const output = ttyOutput(100, 30)
    const writes: string[] = []
    output.on('data', (chunk: Buffer) => writes.push(chunk.toString()))
    const onComplete = vi.fn<(change?: SetupChange) => void>()
    const instance = render(createElement(SetupWizard, { config, onComplete }), {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const press = async (key: string): Promise<void> => {
      input.push(key)
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      await press('\r')
      for (const destination of ['Tools', 'Plugins & features', 'Appearance']) {
        await press('\u001b[Z')
        await press('\r')
        await vi.waitFor(() => expect(sanitizeTerminalText(writes.join(''))).toContain(destination))
      }
      await press('\u001b[Z')
      await press('\r')
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
      const change = onComplete.mock.calls[0]?.[0]
      expect(change?.newConversation).not.toBe(true)
      expect(config.snapshot().settings.frogTheme).toBe(expected)
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it('preserves pending guided setup settings through appearance', async () => {
    const config = CliConfigStore.memory({}, {}, { animations: false, mcpDiscovery: false, agentMessaging: true })
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    const onComplete = vi.fn<(change?: SetupChange) => void>()
    const instance = render(
      createElement(SetupWizard, {
        config,
        appearanceOnly: true,
        deferred: true,
        initialSettings: { mcpDiscovery: true, agentMessaging: false },
        onComplete,
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
      await instance.waitUntilRenderFlush()
      input.push('\u001b[Z')
      await instance.waitUntilRenderFlush()
      input.push('\r')
      await instance.waitUntilRenderFlush()
      expect(onComplete).toHaveBeenCalledOnce()
      expect(onComplete.mock.calls[0]?.[0]?.configuration?.settings).toMatchObject({
        mcpDiscovery: true,
        agentMessaging: false,
      })
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })
})

function mouseInputSequence(button: number, column: number, row: number, suffix: 'M' | 'm'): string {
  return `\u001b[<${button};${column + 1};${row + 1}${suffix}`
}
