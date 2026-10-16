import { createElement } from 'react'
import { render, renderToString } from 'ink'
import chalk from 'chalk'
import stringWidth from 'string-width'
import { describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../src/tui/config.js'
import { discoverProviderModels } from '../src/tui/provider/discovery.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { renderFrogStartupLockup } from '../src/tui/view/frog-intro-renderer.js'
import { COMPACT_LOCKUP_TOP_PADDING, FULL_LOCKUP_TOP_PADDING, startupLockupLeft } from '../src/tui/view/interaction.js'
import { setupBrandFrame } from '../src/tui/view/setup-wizard/brand.js'
import { SetupWizard } from '../src/tui/view/setup-wizard/index.js'
import { SetupProgress } from '../src/tui/view/setup-wizard/progress.js'
import { PROVIDERS } from '../src/tui/view/setup-wizard/providers.js'
import { mouseInputSequence, ttyInput, ttyOutput } from './fixtures/terminal.js'

vi.mock('../src/tui/provider/discovery.js', async (original) => ({
  ...(await original<typeof import('../src/tui/provider/discovery.js')>()),
  discoverAwsConfiguration: () => ({ profiles: ['default'], regions: ['us-west-2'] }),
  discoverAwsCredentials: async () => 'valid',
  discoverOllama: async () => ({ installed: false, running: false, models: [] }),
  discoverLiteLlm: async () => ({ reachable: false, authenticationRequired: false, models: [] }),
  discoverProviderModels: vi.fn(async () => ({ available: true, models: [] })),
}))

function brandRows(width: number, terminalHeight: number): string[] {
  const frame = setupBrandFrame(width, terminalHeight)
  return renderFrogStartupLockup(frame.width, false, 0, 'green', false, {}, frame.height)
    .split('\n')
    .map((row) => row.trimEnd())
}

describe('setup resize layout', () => {
  it('keeps model selection and actions usable while resizing the outlined setup panel', async () => {
    const model = PROVIDERS.bedrock.model({})
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
        expect(frame).toContain('Back')
        expect(frame).toContain('Launch')
        expect(frame).toMatch(/[┌╭]/)
        expect(frame).toMatch(/[┘╯]/)
        const providerRow = lines.findIndex((line) => line.includes('Providers'))
        const panelAnsi = rawFrame.split('\n').slice(providerRow).join('\n')
        expect(panelAnsi).toContain('\u001b[38;2;')
        expect(panelAnsi).not.toContain('\u001b[48;2;')
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
      const model = PROVIDERS.bedrock.model({})
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

  it('places the setup lockup at the same top offset as the chat startup view', () => {
    expect(setupBrandFrame(120, 42)).toMatchObject({ height: 12, top: FULL_LOCKUP_TOP_PADDING })
    expect(setupBrandFrame(120, 41)).toMatchObject({ height: 8, top: COMPACT_LOCKUP_TOP_PADDING })
  })

  it('retains the exact six-row wordmark when widening from 87 to 88 columns at height 37', () => {
    expect(setupBrandFrame(87, 37).height).toBe(6)
    expect(setupBrandFrame(88, 37).height).toBe(8)
    const before = brandRows(87, 37).filter(Boolean)
    const after = brandRows(88, 37).filter(Boolean)
    expect(before).toHaveLength(6)
    expect(after).toEqual(before)
  })

  it.each([
    [90, 31, 2],
    [87, 34, 6],
    [91, 27, 1],
    [91, 28, 2],
    [91, 33, 2],
    [91, 36, 8],
    [91, 37, 8],
    [91, 38, 8],
    [91, 42, 12],
    [120, 37, 8],
    [120, 41, 8],
    [120, 42, 12],
  ])('uses only the available art rows at %s×%s', (width, terminalHeight, expectedHeight) => {
    const frame = setupBrandFrame(width, terminalHeight)
    expect(frame.height).toBe(expectedHeight)
    if (frame.height > 1) {
      expect(frame.height + frame.top + 24).toBeLessThanOrEqual(terminalHeight)
    }
    expect(frame.left).toBe(startupLockupLeft(width, frame.width))
    expect(brandRows(width, terminalHeight)).toHaveLength(expectedHeight)
  })

  it.each([
    [48, `${'█'.repeat(20)}${'░'.repeat(20)}  3 of 6`],
    [10, '█░  3 of 6'],
    [9, '▌  3 of 6'],
    [8, '▌ 3 of 6'],
    [7, ' 3 of 6'],
    [6, '3 of 6'],
    [5, '3 of…'],
    [1, '…'],
  ])('keeps progress and its label within %s columns', (width, expected) => {
    const frame = sanitizeTerminalText(
      renderToString(createElement(SetupProgress, { current: 3, total: 6, width, animate: false }), {
        columns: width,
      })
    )
    expect(frame).toBe(expected)
  })

  it.each([
    [0, '░ 0 of 6'],
    [1, '▏ 1 of 6'],
    [6, '█ 6 of 6'],
  ])('retains the progress endpoint for step %s in eight columns', (current, expected) => {
    expect(
      sanitizeTerminalText(
        renderToString(createElement(SetupProgress, { current, total: 6, width: 8, animate: false }), {
          columns: 8,
        })
      )
    ).toBe(expected)
  })

  it('measures progress labels in terminal cells', () => {
    const frame = sanitizeTerminalText(
      renderToString(createElement(SetupProgress, { current: 1, total: 2, label: '確認', width: 6, animate: false }), {
        columns: 6,
      })
    )
    expect(frame).toBe('▌ 確認')
  })
})
