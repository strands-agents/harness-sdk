import { describe, expect, it } from 'vitest'
import { ChatController } from '../../src/ui/chat/controller.js'
import { idleBackend } from '../fixtures/chat-backend.js'

const session = {
  sessionId: 'saved-session',
  sessionDirectory: '/play/desk/strands-dev/.strands/state/sessions',
  workspace: '/play/desk',
  configured: { sessionId: 'saved-session', sessionDir: '/play/desk/strands-dev/.strands/state/sessions' },
}
const project = { root: '/play/desk', entrypoint: '/play/desk/desk.ts', language: 'typescript' as const }
const controller = (devWorkspace?: { entrypoint: string; boundEntrypoint: string }) =>
  new ChatController(idleBackend({ sessionIdentity: session }), {
    project,
    runtime: devWorkspace
      ? { devWorkspace: { root: '/play/desk/strands-dev', origin: 'discovered', ...devWorkspace } }
      : {},
  })

describe('dev session resume', () => {
  it('shouldResumeInTheDevWorkspaceWithoutAnAgentWhenTheSessionRanTheBoundEntrypoint', () => {
    expect(controller({ entrypoint: project.entrypoint, boundEntrypoint: project.entrypoint }).resumeSession).toEqual({
      sessionId: 'saved-session',
      sessionDirectory: session.sessionDirectory,
      workspace: '/play/desk',
      devWorkspace: '/play/desk/strands-dev',
    })
  })

  it('shouldKeepTheAgentWhenTheDevSessionRanAnotherEntrypoint', () => {
    expect(
      controller({ entrypoint: project.entrypoint, boundEntrypoint: '/play/desk/agent.ts' }).resumeSession
    ).toEqual({
      sessionId: 'saved-session',
      sessionDirectory: session.sessionDirectory,
      workspace: '/play/desk',
      devWorkspace: '/play/desk/strands-dev',
      agentProject: project.entrypoint,
    })
  })

  it('shouldResumeWithTheAgentAndNoDevWorkspaceOutsideDev', () => {
    expect(controller().resumeSession).toEqual({
      sessionId: 'saved-session',
      sessionDirectory: session.sessionDirectory,
      workspace: '/play/desk',
      agentProject: project.entrypoint,
    })
  })
})
