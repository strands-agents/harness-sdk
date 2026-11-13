import { describe, expectTypeOf, it } from 'vitest'
import { SessionManager } from '../../index.js'
import type { SnapshotAppDataContext, SnapshotAppDataProvider } from '../../index.js'
import type { SnapshotAppDataContext as SessionContext } from '../index.js'
import type { LocalAgent } from '../../types/agent.js'
import type { Graph } from '../../multiagent/graph.js'
import type { Swarm } from '../../multiagent/swarm.js'

describe('SnapshotAppDataProvider', () => {
  it('narrows target by scope and requires a synchronous record', () => {
    expectTypeOf<SnapshotAppDataContext>().toEqualTypeOf<SessionContext>()
    const provider: SnapshotAppDataProvider = (context) => {
      if (context.scope === 'agent') expectTypeOf(context.target).toEqualTypeOf<LocalAgent>()
      else expectTypeOf(context.target).toEqualTypeOf<Graph | Swarm>()
      return { sessionId: context.sessionId, round: 1 }
    }
    new SessionManager({ snapshotAppData: provider })
    // @ts-expect-error App-data providers cannot be asynchronous.
    new SessionManager({ snapshotAppData: async () => ({ round: 1 }) })
    // @ts-expect-error App data must be a record, not an array.
    new SessionManager({ snapshotAppData: () => [] })
  })
})
