#!/usr/bin/env node

await import('../../dist/src/tui/terminal/ink.js')
const tuiRoot = process.env.STRANDS_CLI_TEST_DIST === 'true' ? '../../dist/src/tui' : '../../src/tui'
const [{ WorkspaceSandbox }, { ChatController }, { runInkChat }] = await Promise.all([
  import(`${tuiRoot}/workspace/sandbox.js`),
  import(`${tuiRoot}/chat/controller.js`),
  import(`${tuiRoot}/run.js`),
])

const sandbox = new WorkspaceSandbox(process.cwd())
const scenario = process.env.STRANDS_CLI_TEST_SCENARIO ?? 'exit'
const chatMode = scenario === 'chat'
const shellMode = scenario === 'shell-command' || scenario === 'shell-interrupt'
let shellAbort
const backend = {
  id: 'lifecycle-fixture',
  name: 'Lifecycle Fixture',
  protocol: 'strands',
  info() {
    return { model: 'fixture/model-alpha', effort: 'Medium' }
  },
  async *stream() {
    yield { type: 'textDelta', text: chatMode ? 'Fixture reply' : '' }
    return { stopReason: 'endTurn' }
  },
  listModels() {
    return [
      {
        id: 'fixture/model-alpha',
        name: 'Fixture Model Alpha',
        description: 'Active integration-test model.',
        catalog: 'fixture',
        active: true,
      },
      {
        id: 'fixture/model-beta',
        name: 'Fixture Model Beta',
        description: 'Alternate integration-test model.',
        catalog: 'fixture',
      },
    ]
  },
  modelChangeMode() {
    return 'live'
  },
  async switchModel() {},
  listEfforts() {
    return [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium', active: true },
      { id: 'high', label: 'High' },
    ]
  },
  async setEffort() {},
  ...(shellMode
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
const idleMarker = shellMode ? '__SHELL_IDLE__' : chatMode ? '__CHAT_IDLE__' : undefined
if (idleMarker) {
  let observedActivity = false
  controller.subscribe(() => {
    const status = controller.getSnapshot().status
    if (status === 'running' || status === 'interrupting') {
      observedActivity = true
    } else if (observedActivity && status === 'idle') {
      observedActivity = false
      process.stderr.write(`${idleMarker}\n`)
    }
  })
}
process.exitCode = await runInkChat(controller, {
  intro: scenario === 'startup' || scenario === 'startup-typing',
})
