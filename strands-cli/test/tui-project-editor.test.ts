import { describe, expect, it } from 'vitest'

import { agentProjectEditorCommand } from '../src/tui/project/editor.js'

const project = {
  root: '/work/agent',
  entrypoint: '/work/agent/agent.ts',
}

describe('agent project editor', () => {
  it('opens the project with the configured editor and arguments', () => {
    expect(
      agentProjectEditorCommand(project, 'darwin', {
        STRANDS_EDITOR: 'cursor --reuse-window',
        EDITOR: 'ignored',
      })
    ).toEqual({
      command: 'cursor',
      args: ['--reuse-window', project.root],
    })
  })

  it('opens the entrypoint with the system file association when no editor is configured', () => {
    expect(agentProjectEditorCommand(project, 'linux', {})).toEqual({ command: 'xdg-open', args: [project.entrypoint] })
  })
})
