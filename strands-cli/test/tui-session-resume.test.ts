import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'
import { describe, expect, it } from 'vitest'

import { agentConfig, parseArgs } from '../src/cli/arguments.js'
import { workspaceSessionDirectory } from '../src/tui/session/catalog.js'
import { sessionResumeCommand } from '../src/tui/session/resume.js'

describe('session resume commands', () => {
  it('uses the session-id flag for a built-in session in the current workspace', () => {
    const workspace = process.cwd()
    expect(
      sessionResumeCommand({
        sessionId: 'saved-session',
        sessionDirectory: workspaceSessionDirectory(workspace),
        workspace,
      })
    ).toBe('strands --session-id saved-session')
  })

  it('quotes imported agents and custom directories as literal shell arguments', () => {
    const workspace = process.cwd()
    const sessionDirectory = join(workspace, "saved sessions'$(echo unexpected)`echo unexpected`")
    const agentProject = join(workspace, "agent's source.ts")
    const command = sessionResumeCommand(
      { sessionId: 'saved-session', sessionDirectory, workspace, agentProject },
      { platform: 'darwin' }
    )
    if (process.platform === 'win32') return
    const args = execFileSync('sh', ['-c', `strands() { printf '%s\\n' "$@"; }\n${command}`], { encoding: 'utf8' })
      .trim()
      .split('\n')
    expect(args).toEqual([
      '--agent',
      agentProject,
      '--session-id',
      'saved-session',
      '--set',
      `session.dir=${JSON.stringify(sessionDirectory)}`,
    ])
    const parsed = parseArgs(args)
    expect(parsed.agent).toBe(agentProject)
    expect(agentConfig(parsed, DEFAULT_HARNESS_AGENT_CONFIG).session).toEqual({
      id: 'saved-session',
      dir: sessionDirectory,
    })
  })

  it('switches to a saved session workspace before resuming', () => {
    expect(
      sessionResumeCommand(
        {
          sessionId: 'saved-session',
          sessionDirectory: '/other workspace/.agent/sessions',
          workspace: "/other workspace/it's here",
        },
        { cwd: '/current', platform: 'darwin' }
      )
    ).toBe(
      `cd '/other workspace/it'\\''s here' && strands --session-id saved-session --set 'session.dir="/other workspace/.agent/sessions"'`
    )
  })

  it('uses PowerShell quoting for Windows paths', () => {
    expect(
      sessionResumeCommand(
        {
          sessionId: 'saved-session',
          sessionDirectory: "C:\\work space\\it's here\\sessions",
          workspace: "C:\\work space\\it's here",
          agentProject: "C:\\work space\\it's here\\agent.py",
        },
        { cwd: 'C:\\current', platform: 'win32' }
      )
    ).toBe(
      `Set-Location -LiteralPath 'C:\\work space\\it''s here' -ErrorAction Stop; strands --agent 'C:\\work space\\it''s here\\agent.py' --session-id saved-session --set 'session.dir="C:\\\\work space\\\\it''s here\\\\sessions"'`
    )
  })
})
