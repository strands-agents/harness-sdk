#!/usr/bin/env node

import { AcpService } from '../../src/tui/acp/server.js'

let markStarted
const started = new Promise((resolve) => {
  markStarted = resolve
})
const agent = {
  addHook() {},
  cancel() {},
  async initialize() {},
  messages: [],
  model: { getConfig: () => ({}) },
  async *stream() {
    markStarted()
    await new Promise(() => {})
    yield { type: 'beforeInvocationEvent' }
  },
}

const service = new AcpService({}, { buildAgent: async () => agent })
const session = await service.newSession({ cwd: process.cwd(), mcpServers: [] })
void service.prompt(
  {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'never settle' }],
  },
  { notify: async () => {} }
)
await started
await service.dispose()
process.stdout.write('__DISPOSED__\n')
