#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.argv[2] === '--editor') {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    throw new Error('Editor did not inherit the terminal')
  }
  if (process.argv[3] !== process.env.STRANDS_CLI_TEST_EDITOR_ROOT) {
    throw new Error(`Editor received the wrong project: ${process.argv[3]}`)
  }
  process.stdout.write('\u001b[?1049h\u001b[2J\u001b[H')
  process.stdout.write('EDITOR_READY\n')
  const input = await new Promise((resolve) => process.stdin.once('data', resolve))
  if (input.toString().trim() !== 'editor input') throw new Error('Editor did not receive input')
  process.stdout.write('\u001b[?1049l')
  process.stdout.write('EDITOR_INPUT_OK\n')
  process.exit(0)
}

await import('../../dist/src/terminal/ink.js')
const sourceRoot = process.env.STRANDS_CLI_TEST_DIST === 'true' ? '../../dist/src' : '../../src'
const [{ WorkspaceSandbox }, { ChatController }, { runInkChat }, { ConversationManager }] = await Promise.all([
  import(`${sourceRoot}/agent/sandbox.js`),
  import(`${sourceRoot}/ui/chat/controller.js`),
  import(`${sourceRoot}/ui/run.js`),
  import(`${sourceRoot}/ui/chat/conversations.js`),
])

const sandbox = new WorkspaceSandbox(process.cwd())
const scenario = process.env.STRANDS_CLI_TEST_SCENARIO ?? 'exit'
let editorDirectory
let editorProject
if (scenario === 'editor') {
  editorDirectory = await mkdtemp(join(tmpdir(), 'strands-editor-'))
  const root = join(editorDirectory, "a & O'Brien %PATH%")
  await mkdir(root)
  editorProject = { root, entrypoint: join(root, 'agent.ts') }
  process.env.STRANDS_CLI_TEST_EDITOR_ROOT = root
  const fixture = fileURLToPath(import.meta.url)
  if (process.platform === 'win32') {
    const shim = join(editorDirectory, 'editor.cmd')
    await writeFile(shim, `@"${process.execPath}" "${fixture}" --editor %*\r\n`)
    process.env.STRANDS_EDITOR = `"${shim}"`
  } else {
    process.env.STRANDS_EDITOR = `"${process.execPath}" "${fixture}" --editor`
  }
}
if (scenario.startsWith('exit-')) {
  process.stdin.on('data', (chunk) => {
    if (!chunk.toString().includes('\u0018')) return
    switch (scenario) {
      case 'exit-direct':
        process.exit(23)
        break
      case 'exit-exception':
        throw new Error('Fixture uncaught exception')
      case 'exit-rejection':
        void Promise.reject(new Error('Fixture unhandled rejection'))
        break
      case 'exit-sigterm':
        process.kill(process.pid, 'SIGTERM')
        break
      case 'exit-sigint':
        process.kill(process.pid, 'SIGINT')
        break
      case 'exit-sighup':
        process.kill(process.pid, 'SIGHUP')
        break
    }
  })
}
const followUpMode = scenario === 'follow-up'
const approvalMode = scenario === 'approval'
const shellMode = scenario === 'shell-command' || scenario === 'shell-interrupt'
let shellAbort
let approvalRelease
let queueRelease
let permissionMode = 'default'
let mcpState = 'failed'
let turn = 0
const backend = {
  id: 'lifecycle-fixture',
  name: 'Lifecycle Fixture',
  protocol: 'strands',
  ...(scenario === 'exit'
    ? {
        sessionIdentity: {
          sessionId: 'fixture-session',
          sessionDirectory: join(process.cwd(), '.agent', 'sessions'),
          workspace: process.cwd(),
          configured: { sessionId: null, sessionDir: '.agent/sessions' },
        },
      }
    : {}),
  info() {
    return { model: 'fixture/model-alpha', effort: 'Medium' }
  },
  async *stream(prompt) {
    turn += 1
    if (scenario === 'queue') {
      if (prompt === 'hold queue') {
        yield { type: 'textDelta', text: 'Queue gate waiting' }
        await new Promise((resolve) => {
          queueRelease = resolve
        })
      } else {
        yield { type: 'textDelta', text: `Executed: ${prompt}` }
      }
    } else if (approvalMode) {
      yield {
        type: 'permission',
        request: {
          id: 'approval-fixture',
          toolName: 'write',
          input: { path: 'approved.txt', content: 'approved' },
          options: [
            { id: 'allow', label: 'Allow once', kind: 'allow_once' },
            { id: 'reject', label: 'Reject', kind: 'reject_once' },
          ],
        },
      }
      await new Promise((resolve) => {
        approvalRelease = resolve
      })
      yield { type: 'textDelta', text: 'Approval accepted' }
    } else {
      yield { type: 'textDelta', text: followUpMode ? `Fixture turn ${turn}` : '' }
    }
    return { stopReason: 'endTurn' }
  },
  respondPermission(requestId, optionId) {
    if (requestId !== 'approval-fixture' || optionId !== 'allow') return false
    approvalRelease?.()
    return true
  },
  ...(scenario === 'panels'
    ? {
        permissionStatus() {
          return {
            mode: permissionMode,
            allowedTools: [],
            deniedTools: [],
            configPath: '/tmp/fixture-cli.toml',
          }
        },
        async setPermissionMode(mode) {
          permissionMode = mode
        },
        async allowPermission() {},
        async removeAllowedPermission() {},
        watchTasks(listener) {
          listener([
            {
              id: 'fixture-task',
              label: 'Fixture background task',
              status: 'completed',
              source: 'background',
              detail: 'reviewer | fixture-task',
            },
          ])
          return () => {}
        },
      }
    : {}),
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
    queueRelease?.()
  },
}

const controller = new ChatController(backend, {
  settings: { animations: false },
  ...(editorProject
    ? {
        configurationSource: () => ({
          preferredLanguage: 'typescript',
          documents: {
            typescript: { source: 'export const agent = {}', generated: false },
            python: { source: '', generated: false },
          },
          project: editorProject,
        }),
      }
    : {}),
  ...(scenario === 'panels'
    ? {
        mcp: {
          clients: [],
          paths: ['/tmp/fixture-mcp.json'],
          warnings: [],
          async list() {
            return [
              {
                name: 'fixture-mcp',
                transport: 'streamable-http',
                target: 'http://127.0.0.1:43123/mcp',
                source: '/tmp/fixture-mcp.json',
                state: mcpState,
                canRetry: true,
                ...(mcpState === 'failed' ? { error: 'connect ECONNREFUSED 127.0.0.1:43123' } : { toolCount: 1 }),
              },
            ]
          },
          async setEnabled(name, enabled) {
            if (name !== 'fixture-mcp') throw new Error(`Unexpected MCP server: ${name}`)
            mcpState = enabled ? 'connected' : 'disabled'
          },
          async dispose() {},
        },
      }
    : {}),
  sessions: {
    current: 'fixture-session',
    directory: 'integration fixture',
    async list() {
      return [
        {
          id: 'fixture-session',
          name: 'Fixture Session',
          active: true,
          directory: `${process.cwd()}/.agent/sessions`,
          workspace: process.cwd(),
          messageCount: 2,
          updatedAt: '2026-10-07T10:30:00.000Z',
          preview: 'Sessions composer fixture',
        },
        {
          id: 'earlier-session',
          name: 'Earlier Session',
          active: false,
          directory: '/tmp/other-workspace/.agent/sessions',
          workspace: '/tmp/other-workspace',
          messageCount: 7,
          updatedAt: '2026-10-06T09:15:00.000Z',
        },
      ]
    },
    async resolve() {
      return {
        sessionId: 'fixture-session',
        name: 'Fixture Session',
        sessionDirectory: process.cwd(),
        workspace: process.cwd(),
        active: true,
      }
    },
  },
  requestSetup: () => process.stderr.write('__SETUP_REQUESTED__\n'),
  exportAgentProject: async (_language, destination) => {
    const path = destination ?? process.env.STRANDS_CLI_TEST_EXPORT_PATH
    if (!path) return undefined
    await writeFile(path, 'integration export')
    return path
  },
})
let voiceSnapshot = {
  status: 'off',
  muted: false,
  inputLevel: 0,
  inputLevelDb: -60,
  endpointingSensitivity: 'LOW',
  provider: 'bedrock',
  voice: 'tiffany',
  model: 'amazon.nova-2-5-sonic',
}
const voiceListeners = new Set()
const voice = {
  subscribe: (listener) => {
    voiceListeners.add(listener)
    return () => voiceListeners.delete(listener)
  },
  onSupervisorRequest: () => () => {},
  getSnapshot: () => voiceSnapshot,
  start: async () => {
    voiceSnapshot = { ...voiceSnapshot, status: 'muted', muted: true }
    for (const listener of voiceListeners) listener()
  },
  stop: async () => {},
  narrate: () => false,
  resolveSupervisorRequest: () => false,
  toggleMuted: () => false,
  setMuted: () => false,
  setEndpointingSensitivity: async () => true,
  setProvider: async () => true,
  setModel: async () => true,
  setVoice: async () => true,
  dispose: async () => {},
}
const chatController =
  scenario === 'panels' || scenario === 'voice'
    ? new ConversationManager(controller, {
        fork: async () => controller,
        voice,
      })
    : controller
const idleMarker = shellMode ? '__SHELL_IDLE__' : followUpMode || approvalMode ? '__CHAT_IDLE__' : undefined
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
try {
  process.exitCode = await runInkChat(chatController, {
    intro: scenario === 'startup' || scenario === 'startup-typing',
  })
} finally {
  if (editorDirectory) await rm(editorDirectory, { recursive: true, force: true })
}
