import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'
import { describe, expect, it } from 'vitest'

import { agentConfig, parseArgs } from '../../src/cli/arguments.js'
import { sessionResumeCommand } from '../../src/session/sessions.js'

describe('session resume commands', () => {
  it('pins the saved directory even when it matches the workspace default', () => {
    expect(
      sessionResumeCommand(
        {
          sessionId: 'saved-session',
          sessionDirectory: '/workspace/.agent/sessions',
          workspace: '/workspace',
        },
        { cwd: '/workspace', platform: 'linux', command: 'strands' }
      )
    ).toBe(`strands --session-id saved-session --set 'session.dir="/workspace/.agent/sessions"'`)
  })

  it('includes the directory when resuming sessions stored under the home catalog', () => {
    expect(
      sessionResumeCommand(
        {
          sessionId: 'saved-session',
          sessionDirectory: '/home/user/.strands/sessions/workspace-0123456789ab',
          workspace: '/workspace',
        },
        { cwd: '/workspace', platform: 'linux', command: 'strands' }
      )
    ).toBe(
      `strands --session-id saved-session --set 'session.dir="/home/user/.strands/sessions/workspace-0123456789ab"'`
    )
  })

  it('pins the Harness default directory on Windows', () => {
    expect(
      sessionResumeCommand(
        {
          sessionId: 'saved-session',
          sessionDirectory: 'C:\\workspace\\.agent\\sessions',
          workspace: 'C:\\workspace',
        },
        { cwd: 'C:\\workspace', platform: 'win32', command: 'strands' }
      )
    ).toBe(`strands --session-id saved-session --set 'session.dir="C:\\\\workspace\\\\.agent\\\\sessions"'`)
  })

  it('quotes imported agents and custom directories as literal shell arguments', () => {
    const workspace = process.cwd()
    const sessionDirectory = join(workspace, "saved sessions'$(echo unexpected)`echo unexpected`")
    const agentProject = join(workspace, "agent's source.ts")
    const command = sessionResumeCommand(
      { sessionId: 'saved-session', sessionDirectory, workspace, agentProject },
      { platform: 'darwin', command: 'strands' }
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
        { cwd: '/current', platform: 'darwin', command: 'strands' }
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
        { cwd: 'C:\\current', platform: 'win32', command: 'strands' }
      )
    ).toBe(
      `Set-Location -LiteralPath 'C:\\work space\\it''s here' -ErrorAction Stop; strands --agent 'C:\\work space\\it''s here\\agent.py' --session-id saved-session --set 'session.dir="C:\\\\work space\\\\it''s here\\\\sessions"'`
    )
  })

  const devSession = {
    sessionId: '20261112t151606z-0e6184d8',
    sessionDirectory: '/play/desk/strands-dev/.strands/state/sessions',
    workspace: '/play/desk',
    devWorkspace: '/play/desk/strands-dev',
  }

  it('shouldResumeADevSessionInItsDevWorkspaceWithTheCommandThatStartedIt', () => {
    expect(
      sessionResumeCommand(devSession, { cwd: '/play/desk', platform: 'linux', command: 'strands-optimize' })
    ).toBe('strands-optimize dev --workspace /play/desk/strands-dev --session-id 20261112t151606z-0e6184d8')
  })

  it('shouldKeepTheAgentWhenTheDevSessionRanAnotherEntrypoint', () => {
    expect(
      sessionResumeCommand(
        { ...devSession, agentProject: '/play/desk/other.ts' },
        { cwd: '/play/desk', platform: 'linux', command: 'strands' }
      )
    ).toBe(
      'strands dev --workspace /play/desk/strands-dev --agent /play/desk/other.ts --session-id 20261112t151606z-0e6184d8'
    )
  })

  it('shouldParseTheDevResumeCommandBackToTheSameWorkspaceAgentAndSession', () => {
    const devWorkspace = join(process.cwd(), "dev space's/strands-dev")
    const agentProject = join(process.cwd(), "dev space's/agent.ts")
    const command = sessionResumeCommand(
      { ...devSession, devWorkspace, agentProject, workspace: process.cwd() },
      { platform: 'darwin', command: 'strands' }
    )
    if (process.platform === 'win32') return
    const args = execFileSync('sh', ['-c', `strands() { printf '%s\\n' "$@"; }\n${command}`], { encoding: 'utf8' })
      .trim()
      .split('\n')

    const parsed = parseArgs(args)

    expect(parsed.dev?.workspace).toBe(devWorkspace)
    expect(parsed.agent).toBe(agentProject)
    expect(parsed.sessionId).toBe(devSession.sessionId)
  })

  it.each([
    ['ALinkedCommand', '/usr/local/bin/strands-optimize', 'strands-optimize'],
    ['TheSourceCommand', '/usr/local/bin/strands-dev', 'strands-dev'],
    ['AScriptPath', '/usr/local/lib/node_modules/@strands-agents/cli/bin/strands.js', 'strands'],
    ['NoEntry', undefined, 'strands'],
  ])('shouldNameTheResumeCommandAfter%s', (_case, entry, name) => {
    const argv = [...process.argv]
    process.argv.splice(1, process.argv.length - 1, ...(entry === undefined ? [] : [entry]))
    try {
      expect(sessionResumeCommand(devSession, { cwd: '/play/desk', platform: 'linux' })).toBe(
        `${name} dev --workspace /play/desk/strands-dev --session-id 20261112t151606z-0e6184d8`
      )
    } finally {
      process.argv.splice(0, process.argv.length, ...argv)
    }
  })
})
