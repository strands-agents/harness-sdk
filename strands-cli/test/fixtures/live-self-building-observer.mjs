import { writeFileSync } from 'node:fs'

import { ChatController } from '../../dist/src/tui/chat/controller.js'

// Observe the same snapshots the TUI renders, without replacing the model, tools, or command handlers.
const createSnapshot = ChatController.prototype._createSnapshot
const generations = new WeakMap()
let generation = 0
let lastIdle = ''
let configuration

ChatController.prototype._createSnapshot = function () {
  const snapshot = createSnapshot.call(this)
  if (!generations.has(this)) generations.set(this, ++generation)
  if (snapshot.panel?.kind === 'config') configuration = snapshot.panel.configuration
  if (snapshot.status === 'idle' && !this.busy && (!snapshot.mcpStartup || snapshot.mcpStartup.settled)) {
    writeFileSync(process.env.STRANDS_CLI_TEST_STATE_PATH, JSON.stringify({ snapshot, configuration }))
    const idle = `__LIVE_IDLE_${generations.get(this)}_${snapshot.completedTurns.length}__`
    if (idle !== lastIdle) {
      lastIdle = idle
      process.stderr.write(idle)
    }
  }
  return snapshot
}
