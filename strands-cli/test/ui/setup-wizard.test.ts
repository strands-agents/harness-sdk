import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import chalk from 'chalk'
import { createElement } from 'react'
import stringWidth from 'string-width'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'

import { CliConfigStore } from '../../src/config/store.js'
import type { SetupChange } from '../../src/agent/configuration.js'
import { DEFAULT_CHAT_SETTINGS } from '../../src/ui/chat/types.js'
import { enabledProfileTools } from '../../src/agent/tools.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import * as directoryPicker from '../../src/terminal/directory-picker.js'
import * as terminal from '../../src/terminal/terminal.js'
import { SetupWizard } from '../../src/ui/setup/wizard.js'
import { ChatRoot } from '../../src/ui/app.js'
import { getTheme } from '../../src/ui/theme.js'
import {
  discoverAwsConfiguration,
  discoverAwsCredentials,
  discoverLiteLlm,
  discoverProviderModels,
} from '../../src/model/discovery.js'
import { discoverAwsConfiguration as readAwsConfiguration } from '../../src/model/aws-config.js'
import { render, mouseInputSequence, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

vi.mock('../../src/model/discovery.js', async (original) => ({
  ...(await original<typeof import('../../src/model/discovery.js')>()),
  discoverAwsConfiguration: vi.fn(() => ({ profiles: [], regions: [] })),
  discoverAwsCredentials: vi.fn(async () => 'valid'),
  discoverOllama: async () => ({ installed: false, running: false, models: [] }),
  discoverLiteLlm: vi.fn(async () => ({ reachable: false, authenticationRequired: false, models: [] })),
  discoverProviderModels: vi.fn(async () => ({ available: true, models: [] })),
}))

function setupPanelText(frame: string, title: string): string {
  const lines = frame.split('\n')
  const header = lines.find((line) => line.includes(title))
  if (!header) throw new Error(`Missing setup panel: ${title}`)
  const titleColumn = header.indexOf(title)
  const left = header.lastIndexOf('│', titleColumn)
  const right = header.indexOf('│', titleColumn)
  return lines
    .map((line) => line.slice(left + 1, right))
    .join('')
    .replace(/\s/gu, '')
}

function setupSwitch(frame: string, label: string): { row: number; column: number; state: string } {
  const lines = frame.split('\n')
  const row = lines.findIndex((line) => line.includes(label) && /\b(?:On|Off)\b/u.test(line))
  if (row < 0) throw new Error(`Missing setup switch: ${label}`)
  const state = /\b(?:On|Off)\b/u.exec(lines[row]!)!
  return { row, column: state.index, state: state[0] }
}

describe('setup presentation', () => {
  it('renders a saved agent name safely in launch guidance, editing and review without changing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-setup-name-'))
    const name = 'Agent\u001b[31mRed'
    const path = join(directory, 'cli.toml')
    await writeFile(
      path,
      `[profile]\nname = ${JSON.stringify(name)}\n[settings]\nanimations = false\n[onboarding]\nversion = 1\n`
    )
    const config = await CliConfigStore.load(path)
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const onSetupComplete = vi.fn()
    let rawFrame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.includes('\n')) rawFrame = chunk.toString()
    })
    const instance = render(
      createElement(ChatRoot, {
        config,
        setup: true,
        intro: false,
        setupBridge: { request: () => {}, confirmMcp: async () => false },
        onSetupComplete,
        onExitSetup: () => {},
        checkForUpdate: async () => undefined,
      }),
      { stdin: input, stdout: output, stderr: output }
    )
    const click = async (text: string): Promise<void> => {
      const lines = sanitizeTerminalText(rawFrame).split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      const column = lines[row]!.indexOf(text)
      input.push(mouseInputSequence(0, column, row, 'M'))
      input.push(mouseInputSequence(3, column, row, 'm'))
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      expect(rawFrame).toContain('Esc to launch AgentRed')
      expect(rawFrame).not.toContain('\u001b[31m')
      await click('Customize')
      await click('Continue')
      expect(rawFrame).toContain('Agent�[31mRed')
      expect(rawFrame).not.toContain('\u001b[31m')
      for (let step = 0; step < 5; step++) await click('Continue')
      expect(rawFrame).toContain('Review your agent')
      expect(rawFrame).toContain('AgentRed')
      expect(rawFrame).not.toContain('\u001b[31m')
      await click('Save and Launch')
      expect(onSetupComplete).toHaveBeenCalledWith(
        0,
        true,
        expect.objectContaining({
          configuration: expect.objectContaining({ profile: expect.objectContaining({ name }) }),
        })
      )
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'renders filesystem errors safely in import and the opening menu',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'strands-import-'))
      const source = join(directory, 'agent\u001b[31m.ts')
      await writeFile(source, 'export const agent = {}')
      const input = ttyInput()
      const output = ttyOutput(180, 36)
      const onComplete = vi.fn()
      const config = CliConfigStore.memory({}, { animations: false })
      let frame = ''
      output.on('data', (chunk: Buffer) => {
        if (chunk.includes('\n')) frame = chunk.toString()
      })
      const instance = render(createElement(SetupWizard, { config, onComplete }), {
        stdin: input,
        stdout: output,
        stderr: output,
      })
      const press = async (key: string): Promise<void> => {
        input.push(key)
        await instance.waitUntilRenderFlush()
      }
      const click = async (text: string): Promise<void> => {
        const lines = sanitizeTerminalText(frame).split('\n')
        const row = lines.findIndex((line) => line.includes(text))
        expect(row).toBeGreaterThanOrEqual(0)
        const column = lines[row]!.indexOf(text)
        await press(mouseInputSequence(0, column, row, 'M'))
        await press(mouseInputSequence(3, column, row, 'm'))
      }
      try {
        await instance.waitUntilRenderFlush()
        await click('Import')
        for (const key of ['\r', join(directory, 'ag'), '\t', '\r']) await press(key)
        expect(frame).toContain('agent�[31m.ts')
        expect(frame).not.toContain('\u001b[31m')
        await rm(source)
        await click('Save and Launch')
        expect(frame).toContain('ENOENT')
        expect(frame).not.toContain('\u001b[31m')
        expect(onComplete).not.toHaveBeenCalled()

        await click('Back')
        let rejectSave!: (cause: unknown) => void
        const save = vi.spyOn(config, 'setSettings').mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              rejectSave = reject
            })
        )
        await press('\u0013')
        await press('\u001b[C')
        expect(save).toHaveBeenCalledOnce()
        await press('\u001b')
        await vi.waitFor(() => expect(frame).toContain('Quickstart'))
        rejectSave(await readFile(source).catch((cause: unknown) => cause))
        await instance.waitUntilRenderFlush()
        await vi.waitFor(() => expect(frame).toContain('ENOENT'))
        expect(frame).toContain('Quickstart')
        expect(frame).toContain('agent.ts')
        expect(frame).not.toContain('\u001b[31m')
      } finally {
        instance.unmount()
        await instance.waitUntilExit()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('renders AWS profile labels and warnings safely while selecting the raw profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-aws-profile-'))
    const credentials = join(directory, 'credentials')
    const configFile = join(directory, 'config')
    const profile = 'review\u001b[31m-red'
    await writeFile(credentials, `[${profile}]\nregion=us-west-2\n`)
    await writeFile(configFile, '')
    for (const key of ['AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION', 'AWS_DEFAULT_REGION']) {
      vi.stubEnv(key, undefined)
    }
    vi.mocked(discoverAwsConfiguration).mockImplementation(readAwsConfiguration)
    vi.mocked(discoverAwsCredentials).mockResolvedValue('missing')
    const config = CliConfigStore.memory(
      {},
      { animations: false },
      { providerEnvironment: { AWS_CONFIG_FILE: configFile, AWS_SHARED_CREDENTIALS_FILE: credentials } }
    )
    const input = ttyInput()
    const output = ttyOutput(180, 40)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.includes('\n')) frame = chunk.toString()
    })
    const instance = render(createElement(SetupWizard, { config, onComplete: () => {} }), {
      stdin: input,
      stdout: output,
      stderr: output,
    })
    const click = async (text: string): Promise<void> => {
      const lines = sanitizeTerminalText(frame).split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      const column = lines[row]!.indexOf(text)
      input.push(mouseInputSequence(0, column, row, 'M'))
      input.push(mouseInputSequence(3, column, row, 'm'))
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      await click('Quickstart')
      await vi.waitFor(() => expect(frame).toContain('AWS profile'))
      await click('AWS profile')
      expect(frame).toContain('review-red')
      expect(frame).not.toContain('\u001b[31m')
      await click('review-red')
      await vi.waitFor(() =>
        expect(vi.mocked(discoverAwsCredentials).mock.lastCall![0]!.AWS_PROFILE?.value).toBe(profile)
      )
      expect(frame).toContain('review-red')
      expect(frame).toContain('--profile review-red')
      expect(frame).not.toContain('\u001b[31m')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      vi.mocked(discoverAwsCredentials).mockResolvedValue('valid')
      vi.mocked(discoverAwsConfiguration).mockReturnValue({ profiles: [], regions: [] })
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(['bedrock', 'bedrock-mantle'] as const)(
    'selects local AWS profiles for ready %s while a token is present',
    async (provider) => {
      const directory = await mkdtemp(join(tmpdir(), 'strands-setup-profiles-'))
      const credentials = join(directory, 'credentials')
      const configFile = join(directory, 'config')
      await writeFile(credentials, '[default]\n[work]\n[shell]\n')
      await writeFile(
        configFile,
        '[default]\nregion=us-east-1\n[profile shell]\nregion=us-east-1\n[profile work]\nregion=eu-west-1\n'
      )
      vi.stubEnv('AWS_PROFILE', 'shell')
      vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'test-token')
      vi.stubEnv('AWS_CONFIG_FILE', configFile)
      vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentials)
      for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION']) vi.stubEnv(key, undefined)
      vi.mocked(discoverAwsConfiguration).mockImplementation(readAwsConfiguration)
      const model = `${provider}/profile-test-model`
      vi.mocked(discoverProviderModels).mockResolvedValue({
        available: true,
        models: [{ id: model.slice(model.indexOf('/') + 1), name: 'Profile test model' }],
      })
      const config = CliConfigStore.memory({}, { animations: false }, { profile: { model } })
      const input = ttyInput()
      const output = ttyOutput(80, 24)
      const onComplete = vi.fn()
      let frame = ''
      output.on('data', (chunk: Buffer) => {
        if (chunk.includes('\n')) frame = sanitizeTerminalText(chunk.toString())
      })
      const instance = render(createElement(SetupWizard, { config, deferred: true, onComplete }), {
        stdin: input,
        stdout: output,
        stderr: output,
      })
      const click = async (text: string): Promise<void> => {
        const lines = frame.split('\n')
        const row = lines.findIndex((line) => line.includes(text))
        expect(row, text).toBeGreaterThanOrEqual(0)
        const column = lines[row]!.indexOf(text)
        input.push(mouseInputSequence(0, column, row, 'M'))
        input.push(mouseInputSequence(3, column, row, 'm'))
        await instance.waitUntilRenderFlush()
      }
      try {
        await instance.waitUntilRenderFlush()
        await click('Quickstart')
        await vi.waitFor(() => expect(frame).toContain('Profile test model'))
        expect(vi.mocked(discoverProviderModels).mock.lastCall![1]!.AWS_BEARER_TOKEN_BEDROCK?.value).toBe('test-token')
        expect(config.configuredProviderEnvironment()).toEqual({})
        expect(frame).not.toContain('AWS region')
        for (const label of ['Bedrock', 'Mantle', 'Anthropic', 'OpenAI', 'Gemini', 'Ollama', 'LiteLLM']) {
          expect(frame).toContain(`● ${label}`)
        }
        await click('AWS profile')
        expect(frame).toContain('› Default')
        const popupLines = frame.split('\n')
        const popupColumn = popupLines.find((line) => line.includes('› Default'))!.indexOf('› Default')
        expect(popupColumn).toBeGreaterThan(popupLines.find((line) => line.includes('● Bedrock'))!.indexOf('●'))
        expect(popupColumn).toBeLessThan(popupLines.find((line) => line.includes('Models'))!.indexOf('Models'))
        for (const label of ['Bedrock', 'Mantle', 'Anthropic', 'OpenAI', 'Gemini', 'Ollama', 'LiteLLM']) {
          expect(frame).toContain(`● ${label}`)
        }
        await click(provider === 'bedrock' ? 'Mantle' : 'Bedrock')
        await vi.waitFor(() =>
          expect(vi.mocked(discoverProviderModels).mock.lastCall![0]).toBe(
            provider === 'bedrock' ? 'bedrock-mantle' : 'bedrock'
          )
        )
        expect(frame).not.toContain('Enter profile name')
        await click(provider === 'bedrock' ? 'Bedrock' : 'Mantle')
        await vi.waitFor(() => expect(vi.mocked(discoverProviderModels).mock.lastCall![0]).toBe(provider))
        await click('AWS profile')
        await click('default')
        await vi.waitFor(() =>
          expect(vi.mocked(discoverAwsCredentials).mock.lastCall![0]!.AWS_PROFILE?.value).toBe('default')
        )
        expect(vi.mocked(discoverAwsCredentials).mock.lastCall![0]!.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined()
        await click('AWS profile')
        await click('work')
        await vi.waitFor(() =>
          expect(discoverProviderModels).toHaveBeenLastCalledWith(
            provider,
            expect.objectContaining({
              AWS_PROFILE: { value: 'work', source: 'config' },
              AWS_REGION: { value: 'eu-west-1', source: 'aws-profile' },
            }),
            expect.anything()
          )
        )
        expect(config.configuredProviderEnvironment()).toEqual({})
        expect(process.env.AWS_PROFILE).toBe('shell')
        expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe('test-token')

        await click('AWS profile')
        expect(frame).toContain('› work')
        await click('Default')
        await vi.waitFor(() =>
          expect(vi.mocked(discoverProviderModels).mock.lastCall![1]!.AWS_BEARER_TOKEN_BEDROCK?.value).toBe(
            'test-token'
          )
        )
        await click('AWS profile')
        await click('work')
        await vi.waitFor(() => expect(frame).toContain('Profile test model'))
        await click('Save and Launch')
        expect(onComplete).toHaveBeenCalledWith(
          expect.objectContaining({
            configuration: expect.objectContaining({ providerEnvironment: { AWS_PROFILE: 'work' } }),
          })
        )
      } finally {
        instance.unmount()
        await instance.waitUntilExit()
        vi.mocked(discoverAwsConfiguration).mockReturnValue({ profiles: [], regions: [] })
        vi.mocked(discoverProviderModels).mockResolvedValue({ available: true, models: [] })
        vi.unstubAllEnvs()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

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
        config: CliConfigStore.memory({}, { animations: false }),
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
      await vi.waitFor(() => expect(frame).toContain('1 of 1'))
      expect(frame).not.toContain('Step 1:')
      expect(frame).toContain('Pick a model for your agent')
      expect(frame).toContain('Back')
      expect(frame).not.toContain('Reset')
      expect(frame).toContain('Launch')
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

  it('clears the model-search placeholder and edits whole characters from the left edge', async () => {
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
        config: CliConfigStore.memory({}, { animations: false }),
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
      expect(frame.split('\n')[searchRow]!.indexOf('c', searchColumn)).toBe(searchColumn)
      for (const character of ['e\u0301', '👩🏽‍💻']) {
        input.push(character)
        await instance.waitUntilRenderFlush()
        expect(frame).toContain(`c${character}▌`)
        input.push('\u007f')
        await instance.waitUntilRenderFlush()
        expect(frame).toContain('c▌')
      }
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it.each([
    ['quickstart', 80],
    ['quickstart', 140],
    ['customize', 80],
    ['customize', 140],
  ] as const)(
    'moves between %s provider sections at %s columns and remembers the model cursor',
    async (flow, columns) => {
      const defaultModel = DEFAULT_HARNESS_AGENT_CONFIG.model
      const alternateModel = 'anthropic.claude-opus-4-8'
      const discovery = vi.mocked(discoverProviderModels)
      discovery.mockResolvedValue({
        available: true,
        models: [
          { id: defaultModel.slice(defaultModel.indexOf('/') + 1), name: 'Default model' },
          { id: alternateModel, name: 'Alternate model' },
        ],
      })
      const config = CliConfigStore.memory({}, { animations: false })
      const input = ttyInput()
      const output = ttyOutput(columns, 36)
      const onComplete = vi.fn()
      let frame = ''
      output.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('\n')) frame = sanitizeTerminalText(chunk.toString())
      })
      const instance = render(createElement(SetupWizard, { config, onComplete }), {
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
      const alternate = (): string | undefined => frame.split('\n').find((line) => line.includes('Alternate model'))
      try {
        await instance.waitUntilRenderFlush()
        if (flow === 'customize') await press('\u001b[B')
        await press('\r')
        await vi.waitFor(() => expect(frame).toContain('Default model'))

        await press('\t')
        await press('\u001b[B')
        await press('\r')
        expect(alternate()).toContain('✓')
        expect(discovery.mock.calls.at(-1)?.[0]).toBe('bedrock')

        await press('\t')
        await press('\u001b[D')
        await press('\t')
        await press('\u001b[C')
        await press('\u001b[Z')
        await press('\u001b[Z')
        await press('\r')
        expect(alternate()).not.toContain('✓')
        await press('\r')
        expect(alternate()).toContain('✓')

        await press('\u001b[Z')
        await press('\t')
        expect(discovery.mock.calls.at(-1)?.[0]).toBe('bedrock')
        await press('\t')
        await press('\u001b[D')
        await press('\t')
        await press('\r')
        if (flow === 'quickstart') {
          await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
          expect(config.snapshot().profile).toMatchObject({ model: `bedrock/${alternateModel}`, effort: 'medium' })
        } else {
          await vi.waitFor(() => expect(frame).toContain('Name and instruct your agent'))
        }
      } finally {
        instance.unmount()
        await instance.waitUntilExit()
        discovery.mockResolvedValue({ available: true, models: [] })
      }
    }
  )

  it.each([
    [80, 24],
    [140, 20],
  ])('keeps model options clickable and scrollable at %s×%s', async (columns, terminalRows) => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', undefined)
    const model = DEFAULT_HARNESS_AGENT_CONFIG.model
    const discovery = vi.mocked(discoverProviderModels)
    discovery.mockResolvedValue({
      available: true,
      models: [{ id: model.slice(model.indexOf('/') + 1), name: 'Validation model' }],
    })
    const config = CliConfigStore.memory({}, { animations: false })
    const input = ttyInput()
    const output = ttyOutput(columns, terminalRows)
    const onComplete = vi.fn()
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) frame = sanitizeTerminalText(chunk.toString())
    })
    const instance = render(createElement(SetupWizard, { config, onComplete }), {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      debug: true,
      incrementalRendering: false,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const point = (text: string): { column: number; row: number } => {
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      return { column: lines[row]!.indexOf(text), row }
    }
    const click = async (text: string): Promise<void> => {
      const { column, row } = point(text)
      input.push(mouseInputSequence(0, column, row, 'M'))
      input.push(mouseInputSequence(3, column, row, 'm'))
      await instance.waitUntilRenderFlush()
    }
    const scroll = async (text: string, button: 64 | 65): Promise<void> => {
      const { column, row } = point(text)
      input.push(mouseInputSequence(button, column, row, 'M'))
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      input.push('\r')
      await instance.waitUntilRenderFlush()
      await vi.waitFor(() => expect(frame).toContain('Validation model'))
      if (columns === 80) {
        await click('Options')
        expect(frame).not.toContain('Search models')
      }
      expect(frame).toContain('AWS profile')
      expect(frame).toContain('Reasoning')
      await scroll('Reasoning', 65)
      expect(frame).toContain('Web search')
      await click('Exa')
      expect(frame).toContain('Third-party search via Exa')
      await scroll('Web search', 64)
      expect(frame).toContain('Reasoning')
      if (columns === 80) {
        await click('Models')
        expect(frame).toContain('Search models')
        expect(frame).toContain('Validation model')
      }
      await click('Save and Launch')
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
      expect(config.snapshot().profile.builtinTools).toMatchObject({ web_search: 'exa' })
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      discovery.mockResolvedValue({ available: true, models: [] })
      vi.unstubAllEnvs()
    }
  })

  it.each(['quickstart', 'customize'] as const)(
    'reveals hidden providers with arrows and mouse scrolling in %s',
    async (flow) => {
      vi.stubEnv('LITELLM_API_KEY', undefined)
      vi.mocked(discoverLiteLlm).mockResolvedValue({
        reachable: true,
        authenticationRequired: true,
        models: [],
        status: 401,
      })
      const input = ttyInput()
      const output = ttyOutput(60, 20)
      let frame = ''
      output.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('\n')) frame = sanitizeTerminalText(chunk.toString())
      })
      const instance = render(
        createElement(SetupWizard, {
          config: CliConfigStore.memory({}, { animations: false }),
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
        if (flow === 'customize') await press('\u001b[B')
        await press('\r')
        await vi.waitFor(() => expect(frame).toContain('Bedrock'))
        expect(frame).toContain('Mantle')
        expect(frame).toContain('AWS profile')
        expect(frame).not.toContain('● LiteLLM')
        const lines = frame.split('\n')
        const providerRow = lines.findIndex((line) => line.includes('Bedrock'))
        const providerColumn = lines[providerRow]!.indexOf('Bedrock')
        for (let index = 0; index < 6; index += 1) await press('\u001b[B')
        expect(frame).toContain('LiteLLM')
        await press('\u001b[H')
        expect(frame).toContain('Bedrock')
        for (let index = 0; index < 6; index += 1) {
          await press(mouseInputSequence(65, providerColumn, providerRow, 'M'))
        }
        expect(frame).toContain('LiteLLM')
        await press('\t')
        expect(frame).toContain('LiteLLM')
        expect(frame).toContain('API Key')
        expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(20)
      } finally {
        instance.unmount()
        await instance.waitUntilExit()
        vi.mocked(discoverLiteLlm).mockResolvedValue({
          reachable: false,
          authenticationRequired: false,
          models: [],
        })
        vi.unstubAllEnvs()
      }
    }
  )

  // Narrow enough that the model options panel stays hidden and identifiers render inline.
  it('requires selecting a discovered model for first launch and shows its fully qualified identifier', async () => {
    const modelDiscovery = vi.mocked(discoverProviderModels)
    modelDiscovery.mockResolvedValue({
      available: true,
      models: [
        { id: 'model-alpha', name: 'Model Alpha' },
        { id: 'model-beta', name: 'Model Beta' },
        { id: 'model-gamma', name: 'Model Gamma' },
      ],
    })
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const config = CliConfigStore.memory({}, { animations: false }, { onboardingVersion: 0 })
    const onComplete = vi.fn()
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        frame = sanitizeTerminalText(chunk.toString())
      }
    })
    const instance = render(
      createElement(SetupWizard, {
        config,
        onComplete,
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
    const clickModel = async (text: string): Promise<void> => {
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      const column = lines[row]!.indexOf(text)
      input.push(mouseInputSequence(0, column, row, 'M'))
      input.push(mouseInputSequence(3, column, row, 'm'))
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      input.push('\r')
      await instance.waitUntilRenderFlush()
      await vi.waitFor(() => expect(frame).toContain('bedrock/model-gamma'))

      expect(frame.split('\n').find((line) => line.includes('Model Alpha'))).toContain('bedrock/model-alpha')
      expect(frame.split('\n').find((line) => line.includes('Model Beta'))).toContain('bedrock/model-beta')
      expect(frame).not.toContain(' · bedrock/')
      expect(frame).not.toContain('○')
      await clickModel('Launch Strands harness')
      expect(onComplete).not.toHaveBeenCalled()

      await clickModel('Model Alpha')
      await vi.waitFor(() => expect(frame).toContain('✓ Model Alpha'))
      for (const key of ['\t', '\u001b[Z', '\r']) {
        input.push(key)
        await instance.waitUntilRenderFlush()
      }
      expect(frame).not.toContain('✓ Model Alpha')
      input.push('\r')
      await instance.waitUntilRenderFlush()
      await vi.waitFor(() => expect(frame).toContain('✓ Model Alpha'))
      await clickModel('Model Alpha')
      await vi.waitFor(() => expect(frame).not.toContain('✓ Model Alpha'))
      await clickModel('Launch Strands harness')
      expect(onComplete).not.toHaveBeenCalled()
      await clickModel('Model Alpha')
      await clickModel('Launch Strands harness')
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
      expect(config.snapshot().profile.model).toBe('bedrock/model-alpha')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      modelDiscovery.mockResolvedValue({ available: true, models: [] })
    }
  })

  it('hides identifiers in the options layout and moves mouse focus from search to reasoning', async () => {
    const modelDiscovery = vi.mocked(discoverProviderModels)
    const modelSpecifier = DEFAULT_HARNESS_AGENT_CONFIG.model
    const modelId = modelSpecifier.slice(modelSpecifier.indexOf('/') + 1)
    modelDiscovery.mockResolvedValue({
      available: true,
      models: [{ id: modelId, name: 'Default reasoning model' }],
    })
    const input = ttyInput()
    const output = ttyOutput(140, 50)
    const config = CliConfigStore.memory({}, { animations: false })
    const onComplete = vi.fn()
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        frame = sanitizeTerminalText(chunk.toString())
      }
    })
    const instance = render(
      createElement(SetupWizard, {
        config,
        onComplete,
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
      await vi.waitFor(() => expect(frame).toContain('Reasoning'))

      const modelLine = frame.split('\n').find((line) => line.includes('Default reasoning model'))
      expect(modelLine).toBeDefined()
      expect(modelLine).not.toContain(modelSpecifier)
      const lines = frame.split('\n')
      expect(lines.findIndex((line) => line.includes('Web search'))).toBeGreaterThan(
        lines.findIndex((line) => line.includes('Reasoning'))
      )
      const click = async (column: number, row: number): Promise<void> => {
        input.push(mouseInputSequence(0, column, row, 'M'))
        input.push(mouseInputSequence(3, column, row, 'm'))
        await instance.waitUntilRenderFlush()
      }
      const searchRow = lines.findIndex((line) => line.includes('Search models'))
      await click(lines[searchRow]!.indexOf('/'), searchRow)
      expect(frame).not.toContain('Search models')
      const sliderRow = frame.split('\n').findIndex((line) => /─+█+─+/u.test(line))
      const slider = /─+█+─+/u.exec(frame.split('\n')[sliderRow]!)!
      await click(slider.index + slider[0].length - 1, sliderRow)
      input.push('\u001b[D')
      await instance.waitUntilRenderFlush()
      expect(frame).toContain('Search models')
      const actionLines = frame.split('\n')
      const launchRow = actionLines.findIndex((line) => line.includes('Save and Launch'))
      await click(actionLines[launchRow]!.indexOf('Save and Launch'), launchRow)
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
      expect(config.snapshot().profile.effort).toBe('xhigh')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      modelDiscovery.mockResolvedValue({ available: true, models: [] })
    }
  })

  it('pages through the model list when the next and previous controls are clicked', async () => {
    const modelDiscovery = vi.mocked(discoverProviderModels)
    modelDiscovery.mockResolvedValue({
      available: true,
      models: Array.from({ length: 24 }, (_, index) => ({
        id: `model-${String(index).padStart(2, '0')}`,
        name: index === 1 ? 'A much longer model name' : `Model ${String(index).padStart(2, '0')}`,
      })),
    })
    const input = ttyInput()
    const output = ttyOutput(112, 30)
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
    const click = async (text: string): Promise<void> => {
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      const column = lines[row]!.indexOf(text)
      input.push(mouseInputSequence(0, column, row, 'M'))
      input.push(mouseInputSequence(3, column, row, 'm'))
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      input.push('\r')
      await instance.waitUntilRenderFlush()
      await vi.waitFor(() => expect(frame).toContain('↓ Next ·'))

      expect(frame.split('\n').find((line) => line.includes('Model 00'))).toContain('bedrock/model-00')
      expect(frame).toContain('↑ Previous')
      const initialLines = frame.split('\n')
      const modelIdColumns = initialLines
        .filter((line) => line.includes('bedrock/model-'))
        .map((line) => line.indexOf('bedrock/model-'))
      expect(new Set(modelIdColumns).size).toBe(1)
      expect(initialLines.every((line) => stringWidth(line) <= 112)).toBe(true)
      const nextRow = initialLines.findIndex((line) => line.includes('↓ Next ·'))
      expect(initialLines[nextRow - 1]!.trim()).not.toBe('')
      await click('↓ Next ·')
      await vi.waitFor(() => expect(frame).not.toContain('bedrock/model-00'))
      expect(frame).toContain('↑ Previous ·')

      await click('↑ Previous ·')
      await vi.waitFor(() => expect(frame).toContain('bedrock/model-00'))
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      modelDiscovery.mockResolvedValue({ available: true, models: [] })
    }
  })

  it.each([
    ['quickstart', 0],
    ['customize', 1],
  ])('keeps a clicked AWS region visible in %s setup', async (_flow, openingMoves) => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', undefined)
    vi.stubEnv('AWS_PROFILE', undefined)
    vi.mocked(discoverAwsCredentials).mockResolvedValue('missing')
    const input = ttyInput()
    const output = ttyOutput(100, 50)
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
    const click = async (text: string): Promise<void> => {
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      const column = lines[row]!.indexOf(text)
      input.push(mouseInputSequence(0, column, row, 'M'))
      input.push(mouseInputSequence(3, column, row, 'm'))
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      for (let index = 0; index < openingMoves; index++) {
        input.push('\u001b[C')
        await instance.waitUntilRenderFlush()
      }
      input.push('\r')
      await instance.waitUntilRenderFlush()
      await vi.waitFor(() => expect(frame).toContain('AWS region'))

      await click('AWS region')
      await vi.waitFor(() => expect(frame).toContain('us-east-1'))
      expect(frame).toContain('AWS profile')
      await click('us-east-1')

      expect(frame).toContain('us-east-1  ▾')
      input.push('\r')
      await instance.waitUntilRenderFlush()
      expect(frame).toContain('AWS profile')
      expect(frame).toContain('Default credential chain')
      input.push('\t')
      await instance.waitUntilRenderFlush()
      input.push('\t')
      await instance.waitUntilRenderFlush()
      input.push('\r')
      await instance.waitUntilRenderFlush()
      expect(frame).toContain('Quickstart')
      expect(frame).toContain('Customize')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      vi.mocked(discoverAwsCredentials).mockResolvedValue('valid')
      vi.unstubAllEnvs()
    }
  })

  it('scrolls through compact AWS connection fields with the mouse', async () => {
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', undefined)
    vi.mocked(discoverAwsCredentials).mockResolvedValue('missing')
    const input = ttyInput()
    const output = ttyOutput(80, 24)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) frame = sanitizeTerminalText(chunk.toString())
    })
    const instance = render(
      createElement(SetupWizard, {
        config: CliConfigStore.memory({}, { animations: false }),
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
    const mouseAt = async (text: string, button: 0 | 64 | 65): Promise<void> => {
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      const column = lines[row]!.indexOf(text)
      input.push(mouseInputSequence(button, column, row, 'M'))
      if (button === 0) input.push(mouseInputSequence(3, column, row, 'm'))
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      input.push('\r')
      await instance.waitUntilRenderFlush()
      await vi.waitFor(() => expect(frame).toContain('AWS region'))
      await mouseAt('AWS region', 65)
      expect(frame).toContain('AWS profile')
      await mouseAt('AWS profile', 65)
      expect(frame).toContain('Bedrock API token')
      await mouseAt('Click to enter text', 0)
      input.push('temporary-secret')
      await instance.waitUntilRenderFlush()
      expect(frame).not.toContain('temporary-secret')
      expect(frame).toContain('••••••••••••••••')
      await mouseAt('Bedrock API token', 64)
      expect(frame).toContain('AWS profile')
      await mouseAt('AWS profile', 64)
      expect(frame).toContain('AWS region')
      expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(24)
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      vi.mocked(discoverAwsCredentials).mockResolvedValue('valid')
      vi.unstubAllEnvs()
    }
  })

  it.each([
    [120, 40],
    [80, 24],
  ])('navigates Customize sections and saves keyboard edits at %s×%s', async (columns, terminalRows) => {
    const modelModule = { kind: 'model' as const, module: './custom.mjs', export: 'model' }
    const config = CliConfigStore.memory({}, { animations: false, mcpDiscovery: false }, { profile: { modelModule } })
    const input = ttyInput()
    const output = ttyOutput(columns, terminalRows)
    const onComplete = vi.fn()
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) frame = sanitizeTerminalText(chunk.toString())
    })
    const instance = render(createElement(SetupWizard, { config, onComplete }), {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      debug: true,
      incrementalRendering: false,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const press = async (...keys: string[]): Promise<void> => {
      for (const key of keys) {
        input.push(key)
        await instance.waitUntilRenderFlush()
      }
    }
    const continueFromContent = async (): Promise<void> => press('\t', '\u001b[C', '\r')
    const nameRow = (): number => frame.split('\n').findIndex((line) => line.replace(/[│›]/gu, '').trim() === 'Name')
    const nameField = (): string =>
      frame
        .split('\n')
        .slice(nameRow() + 1, nameRow() + 5)
        .join('\n')
    const clickName = async (): Promise<void> => {
      const row = nameRow()
      expect(row).toBeGreaterThanOrEqual(0)
      const column = frame.split('\n')[row]!.indexOf('Name')
      await press(mouseInputSequence(0, column, row, 'M'), mouseInputSequence(3, column, row, 'm'))
    }
    const clickSwitch = async (label: string): Promise<void> => {
      const { row, column } = setupSwitch(frame, label)
      await press(mouseInputSequence(0, column, row, 'M'), mouseInputSequence(3, column, row, 'm'))
    }
    const clickText = async (text: string): Promise<void> => {
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      const column = lines[row]!.indexOf(text)
      await press(mouseInputSequence(0, column, row, 'M'), mouseInputSequence(3, column, row, 'm'))
    }
    try {
      await instance.waitUntilRenderFlush()
      await press('\u001b[B', '\r')
      await vi.waitFor(() => expect(frame).toContain('Pick a model for your agent'))
      await press('\u001b[Z', '\r')
      expect(frame).toContain('Name and instruct your agent')
      expect(nameField()).toContain(DEFAULT_HARNESS_AGENT_CONFIG.name)
      await clickName()
      expect(nameField()).toContain('▌')
      expect(nameField()).not.toContain(DEFAULT_HARNESS_AGENT_CONFIG.name)
      await press('Custom draft', '\r')
      await clickName()
      expect(nameField()).toContain('Custom draft')
      await press('\u0015', '\r')
      expect(nameField()).toContain(DEFAULT_HARNESS_AGENT_CONFIG.name)
      await press('\r')
      expect(nameField()).not.toContain(DEFAULT_HARNESS_AGENT_CONFIG.name)
      await press('\u001b')
      await vi.waitFor(() => expect(nameField()).toContain(DEFAULT_HARNESS_AGENT_CONFIG.name))
      await press('\r', '\t')
      expect(nameField()).toContain(DEFAULT_HARNESS_AGENT_CONFIG.name)
      await press('\u001b[Z', 'Navigator', '\u001b[D', '!', '\r')
      expect(frame).toContain('Navigato!r')
      await press('\u001b[B', '\r', '\u0015', 'Track tasks.', '\r')
      await continueFromContent()

      expect(frame).toContain("Choose your agent's tools")
      expect(setupSwitch(frame, 'shell').state).toBe('On')
      await press('\t', '\r')
      expect(setupSwitch(frame, 'shell').state).toBe('Off')
      await press('\u001b[C', '\u001b[C')
      expect(setupSwitch(frame, 'shell').state).toBe('On')
      await press('\u001b[D', '\u001b[D')
      expect(setupSwitch(frame, 'shell').state).toBe('Off')
      await clickSwitch('shell')
      expect(setupSwitch(frame, 'shell').state).toBe('On')
      await press(' ', '\u001b[B')
      await press('\t', '\u001b[C', '\u001b[Z', '\r')
      expect(setupSwitch(frame, 'read').state).toBe('Off')
      await press('\t', '\r')
      expect(frame).toContain('Choose plugins and features')
      await press('\t', '\r')
      expect(setupSwitch(frame, 'Todos').state).toBe('Off')
      await clickSwitch('Todos')
      expect(setupSwitch(frame, 'Todos').state).toBe('On')
      await press(' ', '\u001b[B', '\u001b[B', '\u001b[B', '\r')
      expect(setupSwitch(frame, 'MCP servers').state).toBe('On')
      await clickSwitch('MCP servers')
      expect(setupSwitch(frame, 'MCP servers').state).toBe('Off')
      await press(' ')
      await continueFromContent()

      expect(frame).toContain('Configure context and memory')
      await press('\u001b[C', '\u001b[F')
      expect(frame).toContain('Skill sources')
      const cachingSwitch = setupSwitch(frame, 'Prompt caching')
      expect(cachingSwitch.state).toBe('On')
      await press(mouseInputSequence(0, cachingSwitch.column, cachingSwitch.row, 'M'))
      expect(setupSwitch(frame, 'Prompt caching')).toEqual(cachingSwitch)
      await press(mouseInputSequence(3, cachingSwitch.column, cachingSwitch.row, 'm'))
      expect(setupSwitch(frame, 'Prompt caching').state).toBe('Off')
      await press('\u001b[C')
      expect(setupSwitch(frame, 'Prompt caching').state).toBe('On')
      await press('\u001b[F')
      await press('\u001b[C', '\u001b[D', '\u001b[H')
      await continueFromContent()

      expect(frame).toContain('Set tool permissions')
      await press('\u001b[C', '\u001b[C', '\r')
      expect(frame).toContain('Per-tool behavior')
      await press('\t', '\r')
      await continueFromContent()

      expect(frame).toContain('Review your agent')
      await press('\u001b[B', '\r')
      expect(frame).toContain('Name and instruct your agent')
      expect(nameField()).toContain('Navigato!r')
      await clickName()
      await press('\u0015', 'Reviewed navigator', '\r')
      for (const instruction of [
        "Choose your agent's tools",
        'Choose plugins and features',
        'Configure context and memory',
        'Set tool permissions',
        'Review your agent',
      ]) {
        await clickText('Continue')
        await vi.waitFor(() => expect(frame).toContain(instruction))
      }
      expect(frame).toContain('Reviewed navigator')
      await press('\u001b[F')
      await clickText('Data')
      expect(frame).toContain('Configure context and memory')
      expect(setupSwitch(frame, 'Long-term memory').state).toBe('On')
      await clickSwitch('Long-term memory')
      expect(setupSwitch(frame, 'Long-term memory').state).toBe('Off')
      await clickText('Continue')
      expect(frame).toContain('Set tool permissions')
      await clickText('Continue')
      expect(frame).toContain('Review your agent')
      expect(frame).toContain('Reviewed navigator')
      await press('\u001b[F')
      expect(frame).toContain('Memory off')
      expect(onComplete).not.toHaveBeenCalled()
      await continueFromContent()
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
      const saved = config.snapshot()
      expect(saved.profile).toMatchObject({
        name: 'Reviewed navigator',
        instructions: 'Track tasks.',
        contextManager: 'agentic',
        caching: true,
        memory: false,
        modelModule,
      })
      expect(enabledProfileTools(saved.profile.builtinTools)).not.toContain('shell')
      expect(enabledProfileTools(saved.profile.builtinTools)).not.toContain('read')
      expect(saved.profile.builtinPlugins).not.toContain('todos')
      expect(saved.settings.mcpDiscovery).toBe(true)
      expect(saved.permissions).toMatchObject({ mode: 'default', allow: ['edit'] })
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it.each((['typed', 'native'] as const).filter((mode) => mode === 'typed' || process.platform !== 'win32'))(
    'persists a %s memory directory after leaving and returning to the data step',
    async (mode) => {
      const memoryDirectory = mode === 'typed' ? '/tmp/custom-memory' : join(await temporaryDirectory(), 'memory \n')
      if (mode === 'native') await mkdir(memoryDirectory)
      const nativePicker = vi.spyOn(directoryPicker, 'canUseNativePicker').mockReturnValue(true)
      const chooseDirectory = vi.spyOn(directoryPicker, 'chooseDirectory').mockResolvedValue(memoryDirectory)
      const config = CliConfigStore.memory({}, { animations: false })
      const onComplete = vi.fn()
      const input = ttyInput()
      const output = ttyOutput(100, 36)
      let frame = ''
      output.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('\n')) {
          frame = sanitizeTerminalText(chunk.toString())
        }
      })
      const instance = render(
        createElement(SetupWizard, {
          config,
          onComplete,
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
      const click = async (text: string): Promise<void> => {
        const lines = frame.split('\n')
        const row = lines.findIndex((line) => line.includes(text))
        const column = lines[row]!.indexOf(text)
        input.push(mouseInputSequence(0, column, row, 'M'))
        input.push(mouseInputSequence(3, column, row, 'm'))
        await instance.waitUntilRenderFlush()
      }
      try {
        await instance.waitUntilRenderFlush()
        input.push('\u001b[C')
        await instance.waitUntilRenderFlush()
        input.push('\r')
        await instance.waitUntilRenderFlush()
        await vi.waitFor(() => expect(frame).toContain('Pick a model for your agent'))

        for (const instruction of [
          'Name and instruct your agent',
          "Choose your agent's tools",
          'Choose plugins and features',
          'Configure context and memory',
        ]) {
          await click('Continue')
          await vi.waitFor(() => expect(frame).toContain(instruction))
        }

        for (const label of [
          'Context strategy',
          'Prompt caching',
          'Long-term memory',
          'Memory directory',
          'Agent Skills',
          'Skill sources',
        ]) {
          expect(frame).toContain(label)
          input.push('\u001b[B')
          await instance.waitUntilRenderFlush()
        }
        input.push('\u001b[H')
        await instance.waitUntilRenderFlush()
        await click('Agentic')
        for (let index = 0; index < 2; index++) {
          input.push('\u001b[B')
          await instance.waitUntilRenderFlush()
        }
        expect(setupSwitch(frame, 'Long-term memory').state).toBe('On')
        const memorySwitch = setupSwitch(frame, 'Long-term memory')
        input.push(mouseInputSequence(0, memorySwitch.column, memorySwitch.row, 'M'))
        input.push(mouseInputSequence(3, memorySwitch.column, memorySwitch.row, 'm'))
        await instance.waitUntilRenderFlush()
        expect(setupSwitch(frame, 'Long-term memory').state).toBe('Off')
        for (const key of ['\u001b[C', '\u001b[C']) {
          input.push(key)
          await instance.waitUntilRenderFlush()
        }
        expect(setupSwitch(frame, 'Long-term memory').state).toBe('On')
        for (const key of ['\u001b[D', '\u001b[D']) {
          input.push(key)
          await instance.waitUntilRenderFlush()
        }
        expect(setupSwitch(frame, 'Long-term memory').state).toBe('Off')
        input.push(' ')
        await instance.waitUntilRenderFlush()
        expect(setupSwitch(frame, 'Long-term memory').state).toBe('On')
        input.push('\u001b[B')
        await instance.waitUntilRenderFlush()

        await click('Memory directory')
        input.push('\u0015')
        await instance.waitUntilRenderFlush()
        input.push('/tmp/custom-memory')
        await instance.waitUntilRenderFlush()
        input.push('\r')
        await instance.waitUntilRenderFlush()
        await vi.waitFor(() => expect(frame).toContain('/tmp/custom-memory'))
        if (mode === 'native') {
          await click('Browse')
          await vi.waitFor(() => expect(chooseDirectory).toHaveBeenCalledOnce())
          await instance.waitUntilRenderFlush()
        }

        await click('Continue')
        await vi.waitFor(() => expect(frame).toContain('Set tool permissions'))
        await click('Back')
        await vi.waitFor(() => expect(frame).toContain('Configure context and memory'))
        for (let index = 0; index < 3; index++) {
          input.push('\u001b[B')
          await instance.waitUntilRenderFlush()
        }
        expect(frame).toContain(mode === 'typed' ? '/tmp/custom-memory' : 'memory')
        await click('Continue')
        await vi.waitFor(() => expect(frame).toContain('Set tool permissions'))
        await click('Continue')
        await vi.waitFor(() => expect(frame).toContain('Review your agent'))
        await click('Save and Launch')
        await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
        expect(config.snapshot().profile).toMatchObject({
          contextManager: 'agentic',
          memory: { dir: memoryDirectory },
        })
      } finally {
        instance.unmount()
        await instance.waitUntilExit()
        nativePicker.mockRestore()
        chooseDirectory.mockRestore()
      }
    }
  )

  it('shows how many customize setup options remain outside a compact viewport', async () => {
    const input = ttyInput()
    const output = ttyOutput(80, 20)
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
    const click = async (text: string): Promise<void> => {
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      const column = lines[row]!.indexOf(text)
      input.push(mouseInputSequence(0, column, row, 'M'))
      input.push(mouseInputSequence(3, column, row, 'm'))
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      input.push('\u001b[C')
      await instance.waitUntilRenderFlush()
      input.push('\r')
      await instance.waitUntilRenderFlush()
      await vi.waitFor(() => expect(frame).toContain('Pick a model for your agent'))

      for (const instruction of [
        'Name and instruct your agent',
        "Choose your agent's tools",
        'Choose plugins and features',
        'Configure context and memory',
      ]) {
        await click('Continue')
        await vi.waitFor(() => expect(frame).toContain(instruction))
      }

      expect(frame).toMatch(/↓ \d+ more/)
      for (let index = 0; index < 5; index++) {
        input.push('\u001b[B')
        await instance.waitUntilRenderFlush()
      }
      expect(frame).toMatch(/↑ \d+ previous/)
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
        config: CliConfigStore.memory({}, { animations: false }),
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
      await press('\u001b[B')
      await press('\u001b[C')
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

  it('shouldCopyAStepErrorWhenControlYIsPressed', async () => {
    const copy = vi.spyOn(terminal, 'copyTerminalText').mockResolvedValue(true)
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
        config: CliConfigStore.memory({}, { animations: false }),
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
      await press('\u001b[B')
      await press('\u001b[C')
      await press('\r')
      await press('\r')
      await press('\r')
      expect(frame).toContain('This field cannot be empty. · Ctrl+Y copy error')

      await press('\u0019')

      await vi.waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith('This field cannot be empty.', output))
      expect(frame.split('\n').every((line) => stringWidth(line) <= 80)).toBe(true)
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      copy.mockRestore()
    }
  })

  it('cycles opening focus and activates Esc through onCancel', async () => {
    const colorLevel = chalk.level
    chalk.level = 3
    const config = CliConfigStore.memory({}, { animations: false })
    const accentCode = chalk.hex(getTheme(config.snapshot().settings).accent)('x').split('x')[0]!
    const input = ttyInput()
    const output = ttyOutput(120, 30)
    let frame = ''
    let rawFrame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        rawFrame = chunk.toString()
        frame = sanitizeTerminalText(rawFrame)
      }
    })
    const onCancel = vi.fn()
    const instance = render(
      createElement(SetupWizard, {
        config,
        onComplete: () => {},
        onCancel,
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
    const press = async (...keys: string[]): Promise<void> => {
      for (const key of keys) {
        input.push(key)
        await instance.waitUntilRenderFlush()
      }
    }
    const gridHasSelection = (): boolean =>
      rawFrame.split('\n').some((line) => /[┌└│]/u.test(sanitizeTerminalText(line)) && line.includes(accentCode))
    try {
      await instance.waitUntilRenderFlush()
      for (const title of ['Quickstart', 'Customize', 'Import']) {
        expect(frame).toContain(title)
      }
      expect(frame).not.toContain('Resume')
      expect(frame).toContain('Esc to open chat')
      await press('\u001b[B', '\u001b[C')
      expect(gridHasSelection()).toBe(true)
      await press('\t')
      expect(gridHasSelection()).toBe(false)
      await press('\t')
      expect(gridHasSelection()).toBe(false)
      await press('\t')
      expect(gridHasSelection()).toBe(true)
      await press('\u001b[Z')
      expect(gridHasSelection()).toBe(false)
      await press('\r')
      expect(frame).toContain('Transcript spacing')
      await press('\u001b')
      await vi.waitFor(() => expect(frame).toContain('Quickstart'))
      await press('\r')
      expect(frame).toContain('Import an agent')
      await press('\u001b')
      await vi.waitFor(() => expect(frame).toContain('Quickstart'))
      await press('\t', '\r')
      await vi.waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1))
      await press('\u001b[Z', '\u001b[Z', ' ')
      await vi.waitFor(() => expect(onCancel).toHaveBeenCalledTimes(2))
      await press('\u001b')
      await vi.waitFor(() => expect(onCancel).toHaveBeenCalledTimes(3))
      expect(onCancel.mock.calls).toEqual([[0], [0], [0]])
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      chalk.level = colorLevel
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
        config: CliConfigStore.memory({}, { animations: false }),
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
      expect(setupPanelText(frame, 'Connection status')).toContain('InstallOllamafromhttps://ollama.com/download')
      expect(frame).not.toContain('Host')
      expect(frame).not.toContain('11434')

      await press('\u001b[B')
      await vi.waitFor(() => expect(frame).toContain('LiteLLM: Not found'))
      expect(frame).toContain('Models: Not checked')
      expect(setupPanelText(frame, 'Connection status')).toContain('StarttheLiteLLMproxyonlocalhost:4000')
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
        config: CliConfigStore.memory({}, { animations: false }),
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
      await vi.waitFor(() =>
        expect(setupPanelText(frame, 'Connection status')).toContain('Models:Authenticationrequired')
      )
      expect(setupPanelText(frame, 'Connection status')).toContain('EnterLITELLM_API_KEYbelow,thenchooseRefresh.')
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
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
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
        config: CliConfigStore.memory({}, { animations: true }),
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
      await vi.advanceTimersByTimeAsync(200)
      await vi.waitFor(() => expect(frame).toContain('1 of 1'))
      expect(frame).not.toContain('Name and instruct your agent')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      vi.useRealTimers()
    }
  })
})

describe('setup refresh', () => {
  it.each(['selected', 'first-run selection'])('clears the custom model module for a %s model', async (mode) => {
    vi.mocked(discoverProviderModels).mockResolvedValue({
      available: true,
      models: [{ id: 'anthropic.claude-opus-4-8', name: 'New selected model' }],
    })
    const config = CliConfigStore.memory(
      {},
      { animations: false },
      {
        ...(mode === 'first-run selection' ? { onboardingVersion: 0 } : {}),
        profile: {
          model: mode === 'selected' ? 'bedrock/old' : 'openai/old',
          modelModule: { kind: 'model', module: './custom.mjs', export: 'model' },
        },
      }
    )
    const input = ttyInput()
    const output = ttyOutput(120, 50)
    const onComplete = vi.fn()
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) frame = sanitizeTerminalText(chunk.toString())
    })
    const instance = render(createElement(SetupWizard, { config, onComplete, deferred: true }), {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      debug: true,
      incrementalRendering: false,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const click = async (text: string): Promise<void> => {
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      const column = lines[row]!.indexOf(text)
      input.push(mouseInputSequence(0, column, row, 'M'))
      input.push(mouseInputSequence(3, column, row, 'm'))
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      await click('Customize')
      if (mode === 'first-run selection') {
        await vi.waitFor(() => expect(frame).toContain('Credentials detected'))
        await click('Amazon Bedrock')
      }
      await vi.waitFor(() => expect(frame).toContain('New selected model'))
      await click('New selected model')
      for (let step = 0; step < 6; step++) await click('Continue')
      await click('Save and Launch')
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
      expect(onComplete.mock.calls[0]![0].configuration.profile).toMatchObject({
        model: 'bedrock/anthropic.claude-opus-4-8',
        modelModule: null,
      })
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      vi.mocked(discoverProviderModels).mockResolvedValue({ available: true, models: [] })
    }
  })

  it.each([false, true])('clears the stored AWS profile with env-file fallback=%s', async (fallback) => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-setup-profile-'))
    const path = join(directory, 'provider.env')
    const configFile = join(directory, 'config')
    const credentials = join(directory, 'credentials')
    await writeFile(configFile, '[default]\nregion=us-east-1\n[profile fallback]\nregion=eu-west-1\n')
    await writeFile(credentials, '')
    await writeFile(path, fallback ? 'AWS_PROFILE=fallback\n' : '')
    for (const key of [
      'AWS_PROFILE',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_CONFIG_FILE',
      'AWS_SHARED_CREDENTIALS_FILE',
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
    ]) {
      vi.stubEnv(key, undefined)
    }
    vi.mocked(discoverAwsConfiguration).mockImplementation(readAwsConfiguration)
    vi.mocked(discoverAwsCredentials).mockResolvedValue('missing')
    const config = CliConfigStore.memory(
      {},
      { animations: false },
      {
        providerEnvironment: {
          AWS_PROFILE: 'obsolete',
          AWS_CONFIG_FILE: configFile,
          AWS_SHARED_CREDENTIALS_FILE: credentials,
        },
      }
    )
    config.useEnvironmentFiles([path])
    const input = ttyInput()
    const output = ttyOutput(120, 50)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) frame = sanitizeTerminalText(chunk.toString())
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
    const click = async (text: string): Promise<void> => {
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      const column = lines[row]!.indexOf(text)
      input.push(mouseInputSequence(0, column, row, 'M'))
      input.push(mouseInputSequence(3, column, row, 'm'))
      await instance.waitUntilRenderFlush()
    }
    try {
      await instance.waitUntilRenderFlush()
      await click('Customize')
      await vi.waitFor(() => expect(frame).toContain('AWS profile'))
      await click('AWS profile')
      await click('Default credential chain')
      await vi.waitFor(() => {
        const environment = vi.mocked(discoverAwsCredentials).mock.lastCall![0]!
        expect(environment.AWS_PROFILE?.value).toBe(fallback ? 'fallback' : undefined)
        expect(environment.AWS_REGION?.value).toBe(fallback ? 'eu-west-1' : 'us-east-1')
        expect(environment.AWS_CONFIG_FILE?.value).toBe(configFile)
      })
      expect(frame).not.toContain('obsolete')
      await click('Refresh')
      expect(discoverAwsConfiguration).toHaveBeenLastCalledWith({
        AWS_CONFIG_FILE: configFile,
        AWS_SHARED_CREDENTIALS_FILE: credentials,
      })
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      vi.mocked(discoverAwsCredentials).mockResolvedValue('valid')
      vi.mocked(discoverAwsConfiguration).mockReturnValue({ profiles: [], regions: [] })
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refreshes env-file credentials in the mounted wizard', async () => {
    const columns = 40
    const terminalRows = 24
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
    const config = CliConfigStore.memory({}, { animations: false })
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
        expect(text()).toMatch(/ex[\s\S]*pired\./u)
      })
      writes.length = 0
      await press('\u001b[F')
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
    const config = CliConfigStore.memory({}, { animations: false })
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
      await vi.waitFor(() => expect(frame).toContain('Session only · Add to'))
      expect(frame).not.toContain('Set up OpenAI')
      expect(frame).toContain('Click to enter text')
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
      output.columns = 35
      output.emit('resize')
      await instance.waitUntilRenderFlush()
      expect(frame).not.toContain('sk-session-secret')
      expect(frame).toContain('•••••••••••••••••')
      output.columns = 80
      output.emit('resize')
      await instance.waitUntilRenderFlush()
      await press('\r')

      await vi.waitFor(() => expect(frame).toContain('Models'))
      expect(vi.mocked(discoverProviderModels).mock.calls).toContainEqual([
        'openai',
        expect.objectContaining({
          OPENAI_API_KEY: { value: 'sk-session-secret', source: 'session' },
        }),
        expect.anything(),
      ])
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
  it('moves between settings sections and persists choices within a category', async () => {
    const config = CliConfigStore.memory({}, { animations: false })
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
      expect(frame).not.toContain('Color mode')
      expect(frame).toContain('Transcript spacing')
      expect(frame).not.toContain('Presentation')
      await press('\t')
      expect(frame).toContain('Transcript spacing')
      await press('\u001b[B')
      expect(frame).toMatch(/Tool result offloading[\s\S]*threshold/u)
      await press('\u001b[B')
      expect(frame).toContain('Skills')
      expect(frame).toContain('Agents (peer-to-peer messaging)')
      expect(frame).toMatch(/Agents \(peer-to-peer messaging\).*On/u)
      await press('\t')
      await press('\u001b[C')
      await vi.waitFor(() => expect(config.snapshot().settings.mcpDiscovery).toBe(true))
      await press('\t')
      await press('\u001b[B')
      expect(frame).toContain('Startup update prompts')
      await press('\u001b[B')
      expect(frame).toContain('Send anonymous usage data')
      await press('\t')
      await press('\u001b[C')
      await vi.waitFor(() => expect(config.snapshot().settings.telemetry).toBe(false))
      await press('\u001b[B')
      expect(frame).toContain('Send anonymous usage data')
      const categoryLines = frame.split('\n')
      const categoryRow = categoryLines.findIndex((line) => line.includes('Appearance'))
      const categoryColumn = categoryLines[categoryRow]!.indexOf('Appearance')
      await press(mouseInputSequence(0, categoryColumn, categoryRow, 'M'))
      await press(mouseInputSequence(3, categoryColumn, categoryRow, 'm'))
      expect(frame).toContain('Transcript spacing')
      const blankCategoryRow = frame.split('\n').findIndex((line) => line.includes('Telemetry')) + 2
      await press(mouseInputSequence(65, categoryColumn, blankCategoryRow, 'M'))
      expect(frame).toMatch(/Tool result offloading[\s\S]*threshold/u)
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it('persists a theme applied from setup settings', async () => {
    const config = CliConfigStore.memory({}, { animations: false })
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
      for (let index = 0; index < 8 && !frame.includes('Scarlet'); index++) {
        const lines = frame.split('\n')
        const row = lines.findIndex((line) => line.includes('Theme') && line.includes('›'))
        expect(row).toBeGreaterThanOrEqual(0)
        const column = lines[row]!.lastIndexOf('›')
        await press(mouseInputSequence(0, column, row, 'M'))
        await press(mouseInputSequence(3, column, row, 'm'))
      }
      await vi.waitFor(() => expect(frame).toContain('Scarlet'))
      const themeLines = frame.split('\n')
      expect(themeLines.find((line) => line.includes('Scarlet'))).toContain('Theme')
      expect(themeLines.every((line) => stringWidth(line) <= 120)).toBe(true)
      const scarletRow = themeLines.findIndex((line) => line.includes('Scarlet'))
      const scarletColumn = stringWidth(themeLines[scarletRow]!.slice(0, themeLines[scarletRow]!.indexOf('Scarlet')))
      await press(mouseInputSequence(0, scarletColumn, scarletRow, 'M'))
      await press(mouseInputSequence(3, scarletColumn, scarletRow, 'm'))
      await vi.waitFor(() => expect(config.snapshot().settings.frogTheme).toBe('scarlet'))
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it.each([
    { name: 'retains the saved theme', fresh: false, expected: 'merlin' },
    { name: 'uses the default for fresh setup', fresh: true, expected: DEFAULT_CHAT_SETTINGS.frogTheme },
  ])('$name', async ({ fresh, expected }) => {
    if (fresh) {
      vi.mocked(discoverProviderModels).mockResolvedValue({
        available: true,
        models: [{ id: DEFAULT_HARNESS_AGENT_CONFIG.model.split('/')[1]!, name: 'Default model' }],
      })
    }
    const config = CliConfigStore.memory(
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
      if (fresh) await vi.waitFor(() => expect(writes.join('')).toContain('Default model'))
      expect(sanitizeTerminalText(writes.join(''))).toMatch(/Save and Launch|Launch Strands harness/)
      await press('\u001b[Z')
      await press('\r')
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
      expect(sanitizeTerminalText(writes.join(''))).not.toContain('Appearance')
      expect(config.snapshot().settings.frogTheme).toBe(expected)
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      vi.mocked(discoverProviderModels).mockResolvedValue({ available: true, models: [] })
    }
  })
})
