#!/usr/bin/env node

import { ChatController } from '../../src/tui/chat/controller.js'
import { runInkChat } from '../../src/tui/run.js'
import { WorkspaceSandbox } from '../../src/tui/workspace/sandbox.js'

const sandbox = new WorkspaceSandbox(process.cwd())
let shellAbort
const backend = {
  id: 'lifecycle-fixture',
  name: 'Lifecycle Fixture',
  protocol: 'strands',
  info() {
    return { model: 'test' }
  },
  async *stream() {
    yield { type: 'textDelta', text: '' }
    return { stopReason: 'endTurn' }
  },
  ...(process.env.STRANDS_CLI_TEST_SHELL_MODE
    ? {
        async *streamShell(command) {
          const toolUseId = 'shell-fixture'
          const abort = new globalThis.AbortController()
          shellAbort?.abort()
          shellAbort = abort
          let output = ''
          let result
          yield { type: 'toolStart', toolUseId, name: 'shell', input: { command } }
          try {
            for await (const event of sandbox.executeStreaming(command, { signal: abort.signal })) {
              if (event.type === 'streamChunk') {
                output += event.data
                yield {
                  type: 'toolOutputDelta',
                  toolUseId,
                  stream: event.streamType,
                  text: event.data,
                }
              } else {
                result = event
              }
            }
          } finally {
            if (shellAbort === abort) {
              shellAbort = undefined
            }
          }
          if (!result) {
            throw new Error('Shell fixture ended without a result.')
          }
          yield {
            type: 'toolResult',
            toolUseId,
            status: result.exitCode === 0 ? 'success' : 'error',
            content: output ? [{ type: 'text', text: output }] : [],
            ...(result.exitCode === 0 ? {} : { error: `Shell command exited with status ${result.exitCode}.` }),
          }
          return { stopReason: 'endTurn' }
        },
      }
    : {}),
  cancel() {
    shellAbort?.abort()
  },
}

const controller = new ChatController(backend, { settings: { animations: false } })
if (process.env.STRANDS_CLI_TEST_SHELL_MODE) {
  let observedShellActivity = false
  controller.subscribe(() => {
    const status = controller.getSnapshot().status
    if (status === 'running' || status === 'interrupting') {
      observedShellActivity = true
    } else if (observedShellActivity && status === 'idle') {
      observedShellActivity = false
      process.stderr.write('__SHELL_IDLE__\n')
    }
  })
}
process.exitCode = await runInkChat(controller, {
  intro: process.env.STRANDS_CLI_TEST_INTRO === 'true',
})
