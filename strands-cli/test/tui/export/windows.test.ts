import { expect, it } from 'vitest'

import { agentLaunchCommand } from '../../../src/tui/project/import.js'
import { unquote } from '../../../src/tui/session/conversation-helpers.js'

it('preserves backslashes in a double-quoted Windows export path', () => {
  expect(unquote('"C:\\temp\\new agent.zip"')).toBe('C:\\temp\\new agent.zip')
})

it('copies a PowerShell-safe Windows launch command', () => {
  expect(agentLaunchCommand("C:\\Users\\O'Brien\\agent.zip", 'win32')).toBe(
    "strands --agent 'C:\\Users\\O''Brien\\agent.zip'"
  )
})
