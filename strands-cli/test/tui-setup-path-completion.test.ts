import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { createElement } from 'react'
import { render } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CliConfigStore } from '../src/tui/config.js'
import { importPathCompletions } from '../src/tui/view/setup-wizard/path-completion.js'
import { SetupWizard } from '../src/tui/view/setup-wizard/index.js'
import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'
import { ttyInput, ttyOutput } from './fixtures/terminal.js'

vi.mock('../src/tui/provider/discovery.js', async (original) => ({
  ...(await original<typeof import('../src/tui/provider/discovery.js')>()),
  discoverAwsConfiguration: () => ({ profiles: [], regions: [] }),
  discoverAwsCredentials: async () => 'valid',
  discoverOllama: async () => ({ installed: false, running: false, models: [] }),
  discoverProviderModels: async () => ({ available: true, models: [] }),
}))

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

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
    } finally {
      instance.unmount()
      await instance.waitUntilExit()
    }
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'strands-path-completion-'))
  directories.push(directory)
  return directory
}

function mouseInputSequence(button: number, column: number, row: number, suffix: 'M' | 'm'): string {
  return `\u001b[<${button};${column + 1};${row + 1}${suffix}`
}
