import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Agent,
  FileStorage,
  Message,
  Model,
  SessionManager,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  tool,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk'

import { ChatController, type ChatBackend } from '../src/tui/chat/controller.js'
import { AgentModelRuntime } from '../src/tui/model/runtime.js'
import { FileSessionRuntime } from '../src/tui/session/sessions.js'
import { StrandsChatBackend } from '../src/tui/strands-backend.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class NamingModel extends Model {
  respond = vi.fn(async (_messages: Message[], _options?: StreamOptions) => 'Fix Session Naming')
  reasoning = ''
  getConfig() {
    return { modelId: 'naming-test', contextWindowLimit: 10_000 }
  }
  updateConfig() {}
  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const text = await this.respond(messages, options)
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    if (this.reasoning) {
      yield { type: 'modelContentBlockStartEvent' }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: this.reasoning } }
      yield { type: 'modelContentBlockStopEvent' }
    }
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
  }
}

function history() {
  return [new Message({ role: 'user', content: [new TextBlock('Fix automatic session naming.')] })]
}

function realBackend(model = new NamingModel(), messages = history()) {
  const agent = new Agent({ model, messages, printer: false })
  return { model, agent, backend: new StrandsChatBackend(new AgentModelRuntime(agent)) }
}

const controllers: ChatController[] = []
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
  vi.restoreAllMocks()
})

function controlled(overrides: Partial<ChatBackend> = {}) {
  const requests: Array<ReturnType<typeof deferred<string>> & { signal: AbortSignal }> = []
  const state = { current: 'session-1', name: 'Original name' }
  const renameCurrent = vi.fn(async (name: string) => {
    state.name = name
    return { sessionId: state.current, name }
  })
  const stream = vi.fn<ChatBackend['stream']>(async function* () {
    yield* []
    return { stopReason: 'endTurn' }
  })
  const backend: ChatBackend = {
    id: 'test',
    name: 'Test agent',
    protocol: 'strands',
    stream,
    cancel: vi.fn(),
    clear: vi.fn(async () => {}),
    generateSessionName: vi.fn((signal) => {
      const request = { ...deferred<string>(), signal }
      requests.push(request)
      return request.promise
    }),
    ...overrides,
  }
  const sessions = {
    get current() {
      return state.current
    },
    directory: '/tmp/sessions',
    list: vi.fn(async () => [{ id: state.current, name: state.name, active: true }]),
    resolve: async () => ({
      sessionId: state.current,
      sessionDirectory: '/tmp/sessions',
      workspace: '/tmp',
      active: true,
    }),
    renameCurrent,
  }
  const controller = new ChatController(backend, { sessions, runtime: { session: state.name } })
  controllers.push(controller)
  return { controller, backend, requests, state, sessions, renameCurrent }
}

async function settled(controller: ChatController) {
  await vi.waitFor(() =>
    expect(controller.getSnapshot().notices.some((notice) => notice.status === 'running')).toBe(false)
  )
}

describe('session naming backend', () => {
  it.each([
    ['  Fix\n\tSession   Naming  ', 'Fix Session Naming'],
    ['\u001b[31mFix\u001b[0m Session Naming', 'Fix Session Naming'],
    ['Réparer Session V2', 'Réparer Session V2'],
  ])('normalizes exactly three words: %j', async (response, expected) => {
    const { backend, model } = realBackend()
    model.reasoning = 'I should choose a concise name for this work.'
    model.respond.mockResolvedValue(response!)
    await expect(backend.generateSessionName(new AbortController().signal)).resolves.toBe(expected)
    expect(model.respond).toHaveBeenCalledOnce()
  })

  it.each(['', 'Two Words', 'These Are Four Words', 'Fix Session Naming.', '"Fix Session Naming"', '1 Fix Naming'])(
    'rejects invalid model output %j',
    async (response) => {
      const { backend, model } = realBackend()
      model.respond.mockResolvedValue(response)
      await expect(backend.generateSessionName(new AbortController().signal)).rejects.toThrow('three-word name')
    }
  )

  it.each([
    ['empty history', 'no conversation', () => realBackend(new NamingModel(), [])],
    [
      'a stateful model',
      'stateful model',
      () => {
        const model = new NamingModel()
        vi.spyOn(model, 'stateful', 'get').mockReturnValue(true)
        return realBackend(model)
      },
    ],
  ] as const)('rejects %s without calling the model', async (_case, message, setup) => {
    const { backend, model } = setup()
    await expect(backend.generateSessionName(new AbortController().signal)).rejects.toThrow(message)
    expect(model.respond).not.toHaveBeenCalled()
  })

  it('stops the model call on cancellation without changing history', async () => {
    const { backend, model, agent } = realBackend()
    const before = JSON.stringify(agent.messages)
    const caller = new AbortController()
    model.respond.mockImplementation(async (_messages, options) => {
      await new Promise<void>((resolve) =>
        options!.cancelSignal!.addEventListener('abort', () => resolve(), { once: true })
      )
      return 'Cancelled by user'
    })
    const result = backend.generateSessionName(caller.signal)
    const rejected = expect(result).rejects.toThrow()
    await vi.waitFor(() => expect(model.respond).toHaveBeenCalledOnce())
    caller.abort()
    await rejected
    expect(model.respond.mock.calls[0]![1]!.cancelSignal!.aborted).toBe(true)
    expect(JSON.stringify(agent.messages)).toBe(before)
  })

  it('writes a generated name through the controller without changing live or saved history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-auto-name-'))
    const sessionId = 'session-1'
    const sessionManager = new SessionManager({ sessionId, storage: { snapshot: new FileStorage(directory) } })
    const model = new NamingModel()
    const executeTool = vi.fn(() => 'done')
    const messages = [
      ...history(),
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'inspect', toolUseId: 'use-1', input: { path: 'README.md' } })],
      }),
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({ toolUseId: 'use-1', status: 'success', content: [new TextBlock('File inspected.')] }),
        ],
      }),
      new Message({ role: 'assistant', content: [new TextBlock('The naming fix is ready.')] }),
    ]
    const agent = new Agent({
      model,
      messages,
      sessionManager,
      printer: false,
      tools: [tool({ name: 'inspect', description: 'Inspect a file', callback: executeTool })],
    })
    const runtime = new AgentModelRuntime(agent, { sessionId, sessionDir: directory })
    const sessions = new FileSessionRuntime(runtime, directory, { workspace: directory })
    const controller = new ChatController(new StrandsChatBackend(runtime), {
      sessions,
      initialMessages: messages,
      runtime: { session: sessionId },
    })
    controllers.push(controller)
    try {
      await agent.initialize()
      await sessionManager.saveSnapshot({ target: agent, isLatest: true })
      const save = vi.spyOn(sessionManager, 'saveSnapshot')
      const restore = vi.spyOn(sessionManager, 'restoreSnapshot')
      const snapshotPath = join(directory, sessionId, 'scopes', 'agent', agent.id, 'snapshots', 'snapshot_latest.json')
      const saved = await readFile(snapshotPath, 'utf8')
      const before = JSON.stringify(agent.messages)
      const turns = controller.getSnapshot().completedTurns
      await controller.submit('/sessions rename')
      await settled(controller)
      expect(controller.getSnapshot()).toMatchObject({
        runtime: { session: 'Fix Session Naming' },
        notices: [{ status: 'success' }],
      })
      expect(JSON.parse(await readFile(join(directory, sessionId, 'cli-session.json'), 'utf8'))).toEqual({
        version: 1,
        name: 'Fix Session Naming',
      })
      expect(await sessions.resolve(sessionId)).toMatchObject({ sessionId, name: 'Fix Session Naming' })
      expect(await readFile(snapshotPath, 'utf8')).toBe(saved)
      expect(JSON.stringify(agent.messages)).toBe(before)
      expect(controller.getSnapshot().completedTurns).toEqual(turns)
      const [input, options] = model.respond.mock.calls[0]!
      expect(model.respond).toHaveBeenCalledOnce()
      expect(input.slice(0, messages.length)).toEqual(messages)
      messages.forEach((message, index) => {
        expect(input[index]).not.toBe(message)
        expect(input[index]!.content[0]).not.toBe(message.content[0])
      })
      expect(options?.systemPrompt).toContain('exactly three words')
      expect(options?.toolSpecs ?? []).toEqual([])
      expect(options?.agentMetadata?.sessionId).toBeUndefined()
      expect(executeTool).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      expect(restore).not.toHaveBeenCalled()
    } finally {
      await controller.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('session naming controller', () => {
  it('does not block a foreground turn while generating and does not take over another panel', async () => {
    const turn = deferred<void>()
    const { controller, requests, renameCurrent } = controlled({
      stream: async function* () {
        yield { type: 'textDelta', text: 'Working' }
        await turn.promise
        return { stopReason: 'endTurn' }
      },
    })
    await controller.submit('/sessions rename')
    expect(controller.busy).toBe(false)
    expect(controller.getSnapshot().notices).toMatchObject([{ status: 'running', text: 'Generating session name' }])
    const running = controller.submit('keep working')
    try {
      await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
      await controller.submit('/help')
      const panel = controller.getSnapshot().panel
      requests[0]!.resolve('Fix Session Naming')
      await settled(controller)
      expect(renameCurrent).toHaveBeenCalledWith('Fix Session Naming')
      expect(controller.getSnapshot().runtime.session).toBe('Fix Session Naming')
      expect(controller.getSnapshot().panel).toEqual(panel)
      expect(controller.getSnapshot().status).toBe('running')
    } finally {
      turn.resolve()
      await running
    }
  })

  it('refreshes an open sessions panel after saving the name', async () => {
    const { controller, requests, sessions } = controlled()
    await controller.submit('/sessions')
    await controller.submit('/sessions rename')
    requests[0]!.resolve('Fix Session Naming')
    await settled(controller)
    expect(sessions.list).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().panel).toMatchObject({ kind: 'sessions', rows: [{ label: 'Fix Session Naming' }] })
  })

  it.each(['explicit rename', 'second generation'])('%s supersedes a pending generated name', async (action) => {
    const { controller, requests, renameCurrent } = controlled()
    await controller.submit('/sessions rename')
    await controller.submit(action === 'explicit rename' ? '/sessions rename Chosen name' : '/sessions rename')
    expect(requests[0]!.signal.aborted).toBe(true)
    if (action === 'second generation') requests[1]!.resolve('Chosen Generated Name')
    requests[0]!.resolve('Stale Generated Name')
    await settled(controller)
    const name = action === 'explicit rename' ? 'Chosen name' : 'Chosen Generated Name'
    expect(renameCurrent).toHaveBeenCalledExactlyOnceWith(name)
    expect(controller.getSnapshot().runtime.session).toBe(name)
  })

  it.each(['clear', 'dispose', 'close'])('does not write a late result after %s', async (action) => {
    const { controller, requests, state, renameCurrent } = controlled()
    await controller.submit('/sessions rename')
    if (action === 'clear') await controller.submit('/clear')
    else if (action === 'dispose') await controller.dispose()
    else controller.close()
    expect(requests[0]!.signal.aborted).toBe(true)
    const name = controller.getSnapshot().runtime.session
    requests[0]!.resolve('Stale Generated Name')
    await requests[0]!.promise
    await settled(controller)
    expect(renameCurrent).not.toHaveBeenCalled()
    expect(controller.getSnapshot().runtime.session).toBe(name)
    expect(state.name).toBe('Original name')
  })

  it('applies a name that arrives while another command changes resources', async () => {
    const compact = deferred<undefined>()
    const { controller, requests, renameCurrent } = controlled({ compact: vi.fn(() => compact.promise) })
    await controller.submit('/sessions rename')
    const compacting = controller.submit('/compact')
    requests[0]!.resolve('Fix Session Naming')
    await settled(controller)
    compact.resolve(undefined)
    await compacting
    expect(renameCurrent).toHaveBeenCalledExactlyOnceWith('Fix Session Naming')
    expect(controller.getSnapshot().runtime.session).toBe('Fix Session Naming')
  })

  it.each(['generation', 'persistence'])(
    'leaves the existing name and panel untouched on %s failure',
    async (phase) => {
      const { controller, requests, renameCurrent, state } = controlled()
      await controller.submit('/help')
      const panel = controller.getSnapshot().panel
      await controller.submit('/sessions rename')
      if (phase === 'generation') requests[0]!.reject(new Error('provider unavailable'))
      else {
        renameCurrent.mockRejectedValueOnce(new Error('disk full'))
        requests[0]!.resolve('Fix Session Naming')
      }
      await settled(controller)
      expect(controller.getSnapshot()).toMatchObject({
        runtime: { session: 'Original name' },
        notices: [{ status: 'error', text: expect.stringContaining('Session rename failed:') }],
      })
      expect(controller.getSnapshot().panel).toEqual(panel)
      expect(state.name).toBe('Original name')
    }
  )

  it('lets an explicit rename issued during the generated write win', async () => {
    const { controller, requests, renameCurrent, state } = controlled()
    const write = deferred<void>()
    renameCurrent.mockImplementationOnce(async (name) => {
      await write.promise
      state.name = name
      return { sessionId: state.current, name }
    })
    await controller.submit('/sessions rename')
    requests[0]!.resolve('Fix Session Naming')
    await vi.waitFor(() => expect(renameCurrent).toHaveBeenCalledOnce())
    const manual = controller.submit('/sessions rename My choice')
    write.resolve()
    await manual
    await settled(controller)
    expect(renameCurrent.mock.calls.map(([name]) => name)).toEqual(['Fix Session Naming', 'My choice'])
    expect(state.name).toBe('My choice')
    expect(controller.getSnapshot().runtime.session).toBe('My choice')
  })
})
