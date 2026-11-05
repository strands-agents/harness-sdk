import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const execute = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execute }))

import {
  chooseAgentProject,
  chooseDirectory,
  chooseFiles,
  chooseSaveFile,
} from '../../src/terminal/directory-picker.js'
import { loadAttachments } from '../../src/ui/chat/attachments.js'

afterEach(() => {
  execute.mockReset()
  vi.restoreAllMocks()
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
    expect(args.join(' ')).toContain('ConvertTo-Json -InputObject @($dialog.FileNames) -Compress')
    callback(null, JSON.stringify(['C:\\Users\\Jane Doe\\frog.png', 'C:\\Users\\Jane Doe\\notes.md']), '')
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
    expect(args.join(' ')).toContain('JSON.stringify(paths)')
    callback(null, JSON.stringify(['/Users/jane/frog.png', '/Users/jane/notes.md']) + '\n', '')
  })

  await expect(chooseFiles()).resolves.toEqual(['/Users/jane/frog.png', '/Users/jane/notes.md'])
})

it.runIf(process.platform === 'darwin')('preserves selected filesystem paths with whitespace', async () => {
  const root = await temporaryDirectory()
  const folder = join(root, 'workspace \n')
  const paths = [join(folder, 'notes\npart.txt'), join(folder, 'notes.txt ')]
  await mkdir(folder)
  await Promise.all(paths.map((path) => writeFile(path, 'picker fixture')))
  execute.mockImplementationOnce((_command, _args, _options, callback) => callback(null, `${folder}\n`, ''))

  await expect(chooseDirectory()).resolves.toBe(folder)

  execute.mockImplementationOnce((_command, _args, _options, callback) =>
    callback(null, `${JSON.stringify(paths)}\n`, '')
  )
  const selected = await chooseFiles()
  expect(selected).toEqual(paths)
  const attachments = await loadAttachments(selected, root)
  expect(attachments.map((attachment) => attachment.path)).toEqual(paths)
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
