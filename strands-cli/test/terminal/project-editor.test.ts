import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentProjectEditorCommand, openAgentProject } from '../../src/terminal/open-editor.js'

afterEach(() => vi.unstubAllEnvs())

const project = {
  root: '/work/agent',
  entrypoint: '/work/agent/agent.ts',
}

describe('agent project editor', () => {
  it('waits for the configured editor and reports a failed exit', async () => {
    vi.stubEnv('STRANDS_EDITOR', `"${process.execPath}" -e "process.exit(17)"`)
    await expect(openAgentProject(project)).rejects.toThrow('Editor exited with status 17')
  })

  it('opens the project with the configured editor and arguments', () => {
    expect(
      agentProjectEditorCommand(project, 'darwin', {
        STRANDS_EDITOR: 'cursor --reuse-window',
        EDITOR: 'ignored',
      })
    ).toEqual({
      command: 'cursor',
      args: ['--reuse-window', project.root],
      interactive: true,
    })
    expect(
      agentProjectEditorCommand(project, 'darwin', {
        STRANDS_EDITOR: `sh -c 'exec cursor "$@"' ''`,
      })
    ).toEqual({
      command: 'sh',
      args: ['-c', 'exec cursor "$@"', '', project.root],
      interactive: true,
    })
  })

  it('opens the entrypoint with the system file association when no editor is configured', () => {
    expect(agentProjectEditorCommand(project, 'linux', {})).toEqual({ command: 'xdg-open', args: [project.entrypoint] })
  })

  it('passes Windows shell characters as path data to the system file association', () => {
    const entrypoint = "C:\\agents\\a&calc\\O'Brien\\agent.ts"
    const command = agentProjectEditorCommand({ root: 'C:\\agents', entrypoint }, 'win32', {})
    expect(command.command).toBe('powershell.exe')
    expect(command.args).not.toContain(entrypoint)
    expect(command.env).toEqual({ STRANDS_CLI_OPEN_TARGET: entrypoint })
    expect(command.args.at(-1)).toBe('Start-Process -FilePath $env:STRANDS_CLI_OPEN_TARGET')
  })
})
