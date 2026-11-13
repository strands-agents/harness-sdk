#!/usr/bin/env node

import { Agent } from '@strands-agents/sdk'
import { AcpService } from '../../src/cli/acp.js'

let markStarted
const started = new Promise((resolve) => {
  markStarted = resolve
})
const agent = {
  addHook() {},
  cancel() {},
  shutdown: Agent.prototype.shutdown,
  async initialize() {},
  messages: [],
  model: { modelInfo: {}, getConfig: () => ({}) },
  memoryManager: {
    flush() {
      process.stderr.write('Memory flushed before the active prompt settled.\n')
    },
  },
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
