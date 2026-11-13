import { mkdir, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { createElement } from 'react'

import { describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../../src/config/store.js'
import { importPathCompletions } from '../../src/project/import.js'
import { SetupWizard } from '../../src/ui/setup/wizard.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import { chooseAgentProject } from '../../src/terminal/directory-picker.js'
import { render, mouseInputSequence, ttyInput, ttyOutput } from '../fixtures/terminal.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

vi.mock('../../src/model/discovery.js', async (original) => ({
  ...(await original<typeof import('../../src/model/discovery.js')>()),
  discoverAwsConfiguration: () => ({ profiles: [], regions: [] }),
  discoverAwsCredentials: async () => 'valid',
  discoverOllama: async () => ({ installed: false, running: false, models: [] }),
  discoverProviderModels: async () => ({ available: true, models: [] }),
}))

vi.mock('../../src/terminal/directory-picker.js', async (original) => ({
  ...(await original<typeof import('../../src/terminal/directory-picker.js')>()),
  canUseNativePicker: () => true,
  chooseAgentProject: vi.fn(async () => undefined),
}))

describe('setup import path completion', () => {
  it('suggests folders and supported agent files in a stable order', async () => {
    const directory = await temporaryDirectory()
    await Promise.all([
      mkdir(join(directory, 'agent-beta')),
      mkdir(join(directory, 'agent-alpha')),
      writeFile(join(directory, 'agent.ts'), ''),
      writeFile(join(directory, 'agent.txt'), ''),
    ])

    expect(importPathCompletions(`${directory}${sep}ag`)).toEqual([
      { value: `${directory}${sep}agent-alpha${sep}`, label: `agent-alpha${sep}`, directory: true },
      { value: `${directory}${sep}agent-beta${sep}`, label: `agent-beta${sep}`, directory: true },
      { value: `${directory}${sep}agent.ts`, label: 'agent.ts', directory: false },
    ])
  })

  it('preserves home-relative paths and fails quietly for missing directories', async () => {
    const directory = await temporaryDirectory()
    await mkdir(join(directory, 'project'))

    expect(importPathCompletions(`~${sep}pro`, directory, directory)).toEqual([
      { value: `~${sep}project${sep}`, label: `project${sep}`, directory: true },
    ])
    expect(importPathCompletions(`${directory}${sep}missing${sep}`)).toEqual([])
  })

  it('keeps the empty input clean and completes a selected path from the dropdown', async () => {
    const directory = await temporaryDirectory()
    await mkdir(join(directory, 'agent-project'))
    const input = ttyInput()
    const output = ttyOutput(180, 32)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) {
        frame = chunk.toString()
      }
    })
    const config = CliConfigStore.memory({}, { animations: false })
    const instance = render(createElement(SetupWizard, { config, onComplete: () => {} }), {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    const press = async (key: string): Promise<void> => {
      input.push(key)
      await instance.waitUntilRenderFlush()
    }

    try {
      await instance.waitUntilRenderFlush()
      await press('\u001b[B')
      await press('\u001b[C')
      await press('\r')

      const placeholderFrame = sanitizeTerminalText(frame)
      expect(placeholderFrame).toContain('Click to enter text')
      expect(placeholderFrame).not.toContain('▌')
      const placeholderLines = placeholderFrame.split('\n')
      const placeholderRow = placeholderLines.findIndex((line) => line.includes('Click to enter text'))
      const placeholderColumn = placeholderLines[placeholderRow]!.indexOf('Click to enter text')

      await press(mouseInputSequence(0, placeholderColumn, placeholderRow, 'M'))
      await press(mouseInputSequence(3, placeholderColumn, placeholderRow, 'm'))

      const emptyFrame = sanitizeTerminalText(frame)
      expect(emptyFrame).toContain('Path to ZIP, file, or folder')
      expect(emptyFrame).toContain('▌')
      expect(emptyFrame).not.toContain('Click to enter text')

      await press(`${directory}${sep}agent-p`)
      const editingFrame = sanitizeTerminalText(frame)
      expect(editingFrame).toContain('Suggestions · ↑↓ choose · Tab complete')
      expect(editingFrame).toContain(`agent-project${sep}  folder`)

      await press('\u001b[B')
      await press('\t')
      expect(sanitizeTerminalText(frame)).toContain(`${sep}agent-project`)
      await press('\u001b[Z')
      expect(sanitizeTerminalText(frame)).not.toContain('Suggestions ·')
      await press('\r')
      expect(sanitizeTerminalText(frame)).toContain('Quickstart')
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })

  it('tabs between the import section and actions while arrows and clicks reach Browse', async () => {
    vi.mocked(chooseAgentProject).mockClear()
    const input = ttyInput()
    const output = ttyOutput(120, 32)
    let frame = ''
    output.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('\n')) frame = sanitizeTerminalText(chunk.toString())
    })
    const instance = render(
      createElement(SetupWizard, { config: CliConfigStore.memory({}, { animations: false }), onComplete: () => {} }),
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
    try {
      await instance.waitUntilRenderFlush()
      await press('\u001b[B', '\u001b[C', '\r', '\t', '\r')
      expect(frame).toContain('Quickstart')
      expect(chooseAgentProject).not.toHaveBeenCalled()
      await press('\u001b[B', '\u001b[C', '\r', '\u001b[B', '\r')
      await vi.waitFor(() => expect(chooseAgentProject).toHaveBeenCalledOnce())
      await instance.waitUntilRenderFlush()
      const lines = frame.split('\n')
      const row = lines.findIndex((line) => line.includes('Browse'))
      const column = lines[row]!.indexOf('Browse')
      await press(mouseInputSequence(0, column, row, 'M'), mouseInputSequence(3, column, row, 'm'))
      await vi.waitFor(() => expect(chooseAgentProject).toHaveBeenCalledTimes(2))
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })
})
