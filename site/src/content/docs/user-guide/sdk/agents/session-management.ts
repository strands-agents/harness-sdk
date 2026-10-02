import { Agent, SessionManager } from '@strands-agents/sdk'
import { InMemoryStorage } from '@strands-agents/sdk/storage'

async function snapshotAppDataExample() {
  // --8<-- [start:app_data]
  const experiment = { round: 0, seed: 42 }
  const session = new SessionManager({
    sessionId: 'experiment',
    storage: new InMemoryStorage(),
    snapshotAppData: ({ scope, target, sessionId }) => ({
      ...experiment,
      scope,
      targetId: target.id,
      sessionId,
    }),
  })
  const agent = new Agent({ sessionManager: session })

  experiment.round = 1
  await session.saveSnapshot({ target: agent, isLatest: true })
  // --8<-- [end:app_data]
}
