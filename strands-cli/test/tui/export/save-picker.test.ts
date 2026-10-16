import { afterEach, expect, it, vi } from 'vitest'

const execute = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execute }))

import {
  canUseNativePicker,
  chooseAgentProject,
  chooseDirectory,
  chooseFiles,
  chooseSaveFile,
} from '../../../src/tui/terminal/directory-picker.js'

afterEach(() => {
  execute.mockReset()
  vi.restoreAllMocks()
})

it('offers native pickers on macOS and Windows only', () => {
  expect(['darwin', 'win32', 'linux'].map((platform) => canUseNativePicker(platform as NodeJS.Platform))).toEqual([
    true,
    true,
    false,
  ])
})

it('opens the Windows save dialog through PowerShell without shell interpolation', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  execute.mockImplementation((command, args, options, callback) => {
    expect(command).toBe('powershell.exe')
    expect(args).toContain('-STA')
    expect(args).toContain('-Command')
    expect(options.shell).toBeUndefined()
    expect(options.env).toMatchObject({
      STRANDS_PICKER_PROMPT: 'Export agent',
      STRANDS_PICKER_DEFAULT_NAME: 'agent.zip',
    })
    callback(null, 'C:\\Users\\Jane Doe\\Downloads\\agent.zip', '')
  })

  await expect(chooseSaveFile('Export agent', 'agent.zip')).resolves.toBe('C:\\Users\\Jane Doe\\Downloads\\agent.zip')
})

it('opens the Windows directory dialog through PowerShell', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  execute.mockImplementation((command, args, options, callback) => {
    expect(command).toBe('powershell.exe')
    expect(args).toContain('-STA')
    expect(options.env).toMatchObject({ STRANDS_PICKER_PROMPT: 'Export agent' })
    callback(null, 'C:\\Users\\Jane Doe\\Documents', '')
  })

  await expect(chooseDirectory('Export agent')).resolves.toBe('C:\\Users\\Jane Doe\\Documents')
})

it('opens a multi-select Windows file dialog for attachments', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  execute.mockImplementation((command, args, options, callback) => {
    expect(command).toBe('powershell.exe')
    expect(args.join(' ')).toContain('OpenFileDialog')
    expect(args.join(' ')).toContain('Multiselect = $true')
    expect(options.shell).toBeUndefined()
    expect(options.env).toMatchObject({ STRANDS_PICKER_PROMPT: 'Attach files' })
    callback(null, 'C:\\Users\\Jane Doe\\frog.png\r\nC:\\Users\\Jane Doe\\notes.md', '')
  })

  await expect(chooseFiles()).resolves.toEqual(['C:\\Users\\Jane Doe\\frog.png', 'C:\\Users\\Jane Doe\\notes.md'])
})

it('opens a multi-select macOS file dialog for attachments', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  execute.mockImplementation((command, args, options, callback) => {
    expect(command).toBe('/usr/bin/osascript')
    expect(args).toContain('JavaScript')
    expect(args.join(' ')).toContain('allowsMultipleSelection = true')
    expect(options.shell).toBeUndefined()
    callback(null, '/Users/jane/frog.png\n/Users/jane/notes.md', '')
  })

  await expect(chooseFiles()).resolves.toEqual(['/Users/jane/frog.png', '/Users/jane/notes.md'])
})

it('opens a Windows agent project file dialog', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  execute.mockImplementation((command, args, options, callback) => {
    expect(command).toBe('powershell.exe')
    expect(args.join(' ')).toContain('OpenFileDialog')
    expect(args.join(' ')).toContain('Import an agent')
    expect(options.shell).toBeUndefined()
    callback(null, 'C:\\Users\\Jane Doe\\agent.zip', '')
  })

  await expect(chooseAgentProject()).resolves.toBe('C:\\Users\\Jane Doe\\agent.zip')
})
