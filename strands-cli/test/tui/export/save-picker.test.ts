import { afterEach, expect, it, vi } from 'vitest'

const execute = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execute }))

import { canChooseDirectory, canChooseSaveFile, chooseSaveFile } from '../../../src/tui/terminal/directory-picker.js'

afterEach(() => {
  execute.mockReset()
  vi.restoreAllMocks()
})

it('offers save browsing on Windows without claiming directory browsing support', () => {
  expect(canChooseSaveFile('win32')).toBe(true)
  expect(canChooseDirectory('win32')).toBe(false)
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
