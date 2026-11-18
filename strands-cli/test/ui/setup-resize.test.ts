import { createElement } from 'react'
import { renderToString } from 'ink'
import chalk from 'chalk'
import stringWidth from 'string-width'
import { describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../../src/config/store.js'
import { discoverProviderModels } from '../../src/model/discovery.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import { SetupWizard } from '../../src/ui/setup/wizard.js'
import { SetupProgress } from '../../src/ui/setup/menu.js'
import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'
import { render, mouseInputSequence, ttyInput, ttyOutput } from '../fixtures/terminal.js'

vi.mock('../../src/model/discovery.js', async (original) => ({
  ...(await original<typeof import('../../src/model/discovery.js')>()),
  discoverAwsConfiguration: () => ({ profiles: ['default'], regions: ['us-west-2'] }),
  discoverAwsCredentials: async () => 'valid',
  discoverOllama: async () => ({ installed: false, running: false, models: [] }),
  discoverLiteLlm: async () => ({ reachable: false, authenticationRequired: false, models: [] }),
  discoverProviderModels: vi.fn(async () => ({ available: true, models: [] })),
}))

describe('setup resize layout', () => {
  it('keeps model selection and actions usable while resizing the outlined setup panel', async () => {
    const model = DEFAULT_HARNESS_AGENT_CONFIG.model
    vi.mocked(discoverProviderModels).mockResolvedValue({
      available: true,
      models: [
        { id: model.slice(model.indexOf('/') + 1), name: 'Claude Sonnet' },
        { id: 'another-model', name: 'A model with an intentionally long display name that must fit its column' },
      ],
    })
    const config = CliConfigStore.memory({}, { animations: false }, { profile: { model } })
    vi.spyOn(config, 'providerEnvironment').mockReturnValue({
      AWS_REGION: { value: 'us-west-2', source: 'process' },
      AWS_PROFILE: { value: 'work', source: 'process' },
    })
    const input = ttyInput()
    const output = ttyOutput(140, 40)
    const completed = vi.fn()
    let frame = ''
    let rawFrame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        rawFrame = chunk.toString()
        frame = sanitizeTerminalText(rawFrame)
      }
    })
    const colorLevel = chalk.level
    chalk.level = 3
    const instance = render(
      createElement(SetupWizard, {
        config,
        onComplete: completed,
        checkForUpdate: async () => undefined,
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
      await vi.waitFor(() => expect(frame).toContain('Claude Sonnet'))
      for (const [columns, rows] of [
        [140, 40],
        [80, 24],
        [60, 20],
        [40, 24],
        [80, 16],
        [140, 40],
      ] as const) {
        output.columns = columns
        output.rows = rows
        output.emit('resize')
        await instance.waitUntilRenderFlush()
        const lines = frame.trimEnd().split('\n')
        expect(lines.length).toBeLessThanOrEqual(rows)
        expect(lines.every((line) => stringWidth(line) <= columns)).toBe(true)
        expect(frame).toContain('Providers')
        expect(frame).toContain('Models')
        const profileLabel = columns === 40 ? 'Profile' : 'AWS profile'
        expect(frame).toContain(profileLabel)
        expect(frame).toContain('work')
        const profileColumn = lines.find((line) => line.includes(profileLabel))!.indexOf(profileLabel)
        expect(profileColumn).toBeGreaterThan(lines.find((line) => line.includes('●'))!.indexOf('●'))
        expect(profileColumn).toBeLessThan(lines.find((line) => line.includes('Models'))!.indexOf('Models'))
        expect(frame).toContain('Back')
        expect(frame).toContain('Launch')
        if (columns === 80 && rows === 24) {
          for (const label of ['Bedrock', 'Mantle', 'Anthropic', 'OpenAI', 'Gemini', 'Ollama', 'LiteLLM']) {
            expect(frame).toContain(`● ${label}`)
          }
          expect(frame).toContain('Refresh')
          expect(lines.findIndex((line) => line.includes('AWS profile'))).toBeLessThan(
            lines.findIndex((line) => line.includes('● LiteLLM'))
          )
        }
        expect(frame).toMatch(/[┌╭]/)
        expect(frame).toMatch(/[┘╯]/)
        const providerRow = lines.findIndex((line) => line.includes('Providers'))
        const panelAnsi = rawFrame.split('\n').slice(providerRow).join('\n')
        expect(panelAnsi).toContain('\u001b[38;2;')
        expect(panelAnsi).toContain('\u001b[48;2;')
        expect(panelAnsi).not.toContain('\u001b[48;5;')
        if (columns === 140) {
          expect(frame).toContain('Model options')
          expect(frame).toContain('Claude Sonnet')
        }
      }
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes('Launch'))
      const column = lines[row]!.indexOf('Launch')
      input.push(mouseInputSequence(0, column, row, 'M'))
      input.push(mouseInputSequence(3, column, row, 'm'))
      await instance.waitUntilRenderFlush()
      await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce())
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
      chalk.level = colorLevel
      output.destroy()
      input.destroy()
    }
  })

  it.each(['customize', 'import', 'settings'] as const)(
    'keeps %s screens outlined and usable at wide and compact sizes',
    async (flow) => {
      const model = DEFAULT_HARNESS_AGENT_CONFIG.model
      vi.mocked(discoverProviderModels).mockResolvedValue({
        available: true,
        models: [{ id: model.slice(model.indexOf('/') + 1), name: 'Default model' }],
      })
      const config = CliConfigStore.memory({}, { animations: false }, { profile: { model } })
      vi.spyOn(config, 'providerEnvironment').mockReturnValue({
        AWS_REGION: { value: 'us-west-2', source: 'process' },
      })
      const input = ttyInput()
      const output = ttyOutput(120, 36)
      const completed = vi.fn()
      let rawFrame = ''
      const frame = (): string => sanitizeTerminalText(rawFrame)
      output.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('\n')) rawFrame = chunk.toString()
      })
      const colorLevel = chalk.level
      chalk.level = 3
      const instance = render(
        createElement(SetupWizard, { config, onComplete: completed, checkForUpdate: async () => undefined }),
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
      const click = async (label: string): Promise<void> => {
        const lines = frame().split('\n')
        const row = lines.findIndex((line) => line.includes(label))
        expect(row, label).toBeGreaterThanOrEqual(0)
        const column = lines[row]!.indexOf(label)
        input.push(mouseInputSequence(0, column, row, 'M'))
        input.push(mouseInputSequence(3, column, row, 'm'))
        await instance.waitUntilRenderFlush()
      }
      const checkSizes = async (title: string, action: string): Promise<void> => {
        for (const [columns, rows] of [
          [150, 50],
          [120, 36],
          [80, 24],
          [40, 24],
          [80, 16],
        ] as const) {
          output.columns = columns
          output.rows = rows
          output.emit('resize')
          await instance.waitUntilRenderFlush()
          const lines = frame().trimEnd().split('\n')
          expect(frame()).toContain(title)
          expect(frame()).toContain('Back')
          expect(frame()).toContain(action)
          expect(lines.length, title).toBeLessThanOrEqual(rows)
          expect(
            lines.every((line) => stringWidth(line) <= columns),
            title
          ).toBe(true)
          if (title === "Choose your agent's tools") expect(frame()).toMatch(/\b(?:On|Off)\s+shell\b/)
          if (title === 'Choose plugins and features') expect(frame()).toMatch(/\b(?:On|Off)\s+Todos\b/)
          if (title === 'Review your agent') {
            expect(frame()).toContain('Providers')
            const editRows = lines.filter((line) => line.includes('Edit'))
            expect(editRows.length).toBeGreaterThan(0)
            expect(editRows.every((line) => line.indexOf('Edit') === editRows[0]!.indexOf('Edit'))).toBe(true)
            if (columns === 150) expect(editRows).toHaveLength(7)
          }
          if (title === 'Configure context and memory') {
            const context = lines.find((line) => line.includes('Context strategy'))!
            const caching = lines.find((line) => line.includes('Prompt caching'))!
            const memory = lines.find((line) => line.includes('Long-term memory'))!
            expect(caching).toBeDefined()
            expect(memory).toBeDefined()
            expect(caching.indexOf('Prompt caching')).toBe(context.indexOf('Context strategy'))
            expect(memory.indexOf('Long-term memory')).toBe(context.indexOf('Context strategy'))
            expect(caching).toContain('On')
            expect(memory.indexOf('On')).toBe(caching.indexOf('On'))
          }
          const panelStart = lines.findIndex((line) => /[┌╭]/.test(line))
          expect(panelStart, title).toBeGreaterThanOrEqual(0)
          expect(frame()).toMatch(/[┘╯]/)
          const panelAnsi = rawFrame.split('\n').slice(panelStart).join('\n')
          expect(panelAnsi).toContain('\u001b[38;2;')
          expect(panelAnsi, title).not.toContain('\u001b[48;2;')
          expect(panelAnsi, title).not.toContain('\u001b[48;5;')
        }
        if (title === 'Review your agent') {
          output.columns = 40
          output.rows = 24
          output.emit('resize')
          await instance.waitUntilRenderFlush()
          input.push('\u001b[F')
          await instance.waitUntilRenderFlush()
          expect(frame()).toContain('Approvals')
          output.columns = 150
          output.rows = 50
          output.emit('resize')
          await instance.waitUntilRenderFlush()
          expect(frame()).toContain('Providers')
          expect(frame().match(/Edit/g)).toHaveLength(7)
        }
      }
      try {
        await instance.waitUntilRenderFlush()
        if (flow === 'settings') {
          input.push('\u0013')
          await instance.waitUntilRenderFlush()
          await vi.waitFor(() => expect(frame()).toContain('Appearance'))
          await checkSizes('Appearance', 'Back')
          return
        }
        await click(flow === 'customize' ? 'Customize' : 'Import')
        if (flow === 'import') {
          await vi.waitFor(() => expect(frame()).toContain('Import an agent'))
          await checkSizes('Import an agent', 'Launch')
          return
        }
        await vi.waitFor(() => expect(frame()).toContain('Default model'))
        for (const [instruction, action] of [
          ['Name and instruct your agent', 'Continue'],
          ["Choose your agent's tools", 'Continue'],
          ['Choose plugins and features', 'Continue'],
          ['Configure context and memory', 'Continue'],
          ['Set tool permissions', 'Continue'],
          ['Review your agent', 'Launch'],
        ] as const) {
          await click('Continue')
          await vi.waitFor(() => expect(frame()).toContain(instruction))
          await checkSizes(instruction, action)
        }
        await click('Save and Launch')
        await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce())
      } finally {
        instance.unmount()
        await instance.waitUntilExit()
        chalk.level = colorLevel
        output.destroy()
        input.destroy()
      }
    }
  )

  it.each([48, 10, 9, 8, 7, 6, 5, 1])('keeps progress and its label within %s columns', (width) => {
    const frame = sanitizeTerminalText(
      renderToString(createElement(SetupProgress, { current: 3, total: 6, width, animate: false }), {
        columns: width,
      })
    )
    expect(stringWidth(frame)).toBeLessThanOrEqual(width)
    if (width >= 6) expect(frame).toContain('3 of 6')
  })
})
