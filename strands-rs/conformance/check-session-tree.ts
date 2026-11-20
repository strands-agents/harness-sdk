/**
 * Restores a session tree written by Rust with the TS `SessionManager` and prints what it restored.
 *
 * Run from the repo root: `npx tsx strands-rs/conformance/check-session-tree.ts <dir> <sessionId> <agentId>`.
 * `<dir>` is the `LocalFileStorage` root the Rust `SessionManager` wrote to. The output is one JSON
 * object: the restored `messages`, `appState`, `modelState` and `systemPrompt`, the immutable
 * `snapshotIds`, and the `messages` of the oldest immutable snapshot (`historyMessages`).
 * `strands/tests/session_interop.rs` runs it when `STRANDS_CONFORMANCE_TS=1`.
 */

import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const MODEL_INFO = join(REPO, 'strands-ts', 'src', 'models', 'model-info.json')
if (!existsSync(MODEL_INFO)) {
  copyFileSync(join(REPO, 'shared', 'model-info.json'), MODEL_INFO)
}

const { Agent } = await import('../../strands-ts/src/agent/agent.js')
const { MockMessageModel } = await import('../../strands-ts/src/__fixtures__/mock-message-model.js')
const { LocalFileStorage } = await import('../../strands-ts/src/storage/local-file-storage.js')
const { SessionManager } = await import('../../strands-ts/src/session/session-manager.js')

const [dir, sessionId, agentId] = process.argv.slice(2)
if (!dir || !sessionId || !agentId) {
  throw new Error('usage: check-session-tree.ts <dir> <sessionId> <agentId>')
}

function restoredAgent(): { agent: InstanceType<typeof Agent>; sessionManager: InstanceType<typeof SessionManager> } {
  const sessionManager = new SessionManager({ storage: new LocalFileStorage(dir!), sessionId: sessionId! })
  const agent = new Agent({ id: agentId!, model: new MockMessageModel(), printer: false, sessionManager })
  return { agent, sessionManager }
}

const { agent, sessionManager } = restoredAgent()
await agent.initialize()
const snapshotIds = await sessionManager.listSnapshotIds({ target: agent })

const history = restoredAgent()
const restoredHistory =
  snapshotIds.length > 0 && (await history.sessionManager.restoreSnapshot({ target: history.agent, snapshotId: snapshotIds[0]! }))

process.stdout.write(
  JSON.stringify({
    messages: agent.messages,
    appState: agent.appState.getAll(),
    modelState: agent.modelState.getAll(),
    systemPrompt: agent.systemPrompt ?? null,
    snapshotIds,
    historyMessages: restoredHistory ? history.agent.messages : null,
  })
)
