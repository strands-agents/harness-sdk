import { describe, expect, it, vi } from 'vitest'

import {
  ChatController,
  type ChatBackend,
  type ChatEvent,
  type ChatPermissionRequest,
  type ChatRunResult,
  type ChatTask,
} from '../src/tui/chat/controller.js'
import type { BackgroundAgentActivity } from '../src/tui/background/activity.js'
import { ModelControlError, resolveModelTarget } from '../src/tui/model/selection.js'

function backend(
  run: (prompt: string) => AsyncGenerator<ChatEvent, ChatRunResult, undefined> = async function* () {
    yield* []
    return { stopReason: 'endTurn' }
  }
): ChatBackend & { cancel: ReturnType<typeof vi.fn<() => void>> } {
  const cancel = vi.fn<() => void>()
  return {
    id: 'test',
    name: 'Test',
    protocol: 'strands',
    stream: run,
    cancel,
  }
}

describe('ChatController', () => {
  it('sanitizes runtime metadata exposed through snapshots', () => {
    const target = backend()
    Object.assign(target, {
      id: 'test\u0007',
      name: 'Te\u001b[31mst',
      info: () => ({
        model: 'model\u009b31m',
        tools: [{ name: 're\u001b[2Jad', description: 'line\tone\nline\u0007two' }],
      }),
    })
    const controller = new ChatController(target, {
      runtime: {
        session: 'saved\u001b]52;c;x\u0007',
        cwd: '/tmp/\u009b31mproject',
        configuration: [{ label: 'source\u0007', value: 'local\u001b[2J' }],
      },
    })

    expect(controller.getSnapshot().runtime).toMatchObject({
      agent: 'Test',
      backendId: 'test',
      model: 'model',
      session: 'saved',
      cwd: '/tmp/project',
      tools: [{ name: 'read', description: 'line\tone\nlinetwo' }],
      configuration: [{ label: 'source', value: 'local' }],
    })
  })

  it.each(['synchronous', 'late'] as const)(
    'refreshes latest context spend on %s completion without retaining unavailable token splits',
    async (timing) => {
      const occupancy = { currentTokens: 5, projectedTokens: 8, contextWindow: 1000 }
      const total = { totalTokens: 116, cacheReadInputTokens: 10, cacheWriteInputTokens: 2 }
      let publish!: (usage: ChatRunResult['usage']) => void
      const unsubscribe = vi.fn()
      const controller = new ChatController(
        backend(async function* () {
          yield { type: 'textDelta', text: 'done' }
          return {
            stopReason: 'endTurn',
            context: { ...occupancy, inputTokens: 5, outputTokens: 3, totalTokens: 8 },
            watchUsage: (listener) => {
              publish = listener
              if (timing === 'synchronous') {
                listener(total)
              }
              return unsubscribe
            },
          }
        })
      )
      await controller.submit('work')
      await controller.submit('/context')
      if (timing === 'late') {
        expect(controller.getSnapshot().context.inputTokens).toBe(5)
        publish(total)
      }
      expect(controller.getSnapshot().panel?.kind).toBe('context')
      expect(controller.getSnapshot().context).toEqual({ ...occupancy, ...total })
      expect(controller.getSnapshot().completedTurns[0]?.usage).toEqual(total)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      await controller.dispose()
    }
  )

  it.each(['active', 'completed'] as const)(
    'preserves a newer %s turn context when an older turn finishes spending',
    async (state) => {
      let publish!: (usage: ChatRunResult['usage']) => void
      let finish!: () => void
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const context = { currentTokens: 20, projectedTokens: 28, inputTokens: 20, outputTokens: 8, totalTokens: 28 }
      const controller = new ChatController(
        backend(async function* (prompt) {
          if (prompt === 'first') {
            yield { type: 'textDelta', text: 'done' }
            return {
              stopReason: 'endTurn',
              watchUsage: (listener) => {
                publish = listener
                return (): void => {}
              },
            }
          }
          yield { type: 'context', usage: context }
          await pending
          return { stopReason: 'endTurn', context }
        })
      )
      await controller.submit('first')
      const submitting = controller.submit('second')
      await vi.waitFor(() => expect(controller.getSnapshot().context).toEqual(context))
      if (state === 'completed') {
        finish()
        await submitting
      }
      publish({ totalTokens: 116, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 })
      expect(controller.getSnapshot().completedTurns[0]?.usage?.totalTokens).toBe(116)
      expect(controller.getSnapshot().context).toEqual(context)
      finish()
      await submitting
      await controller.dispose()
    }
  )

  it.each(['clear', 'close', 'dispose'] as const)('removes pending usage subscriptions on %s', async (action) => {
    let publish: ((usage: ChatRunResult['usage']) => void) | undefined
    const unsubscribe = vi.fn()
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'done' }
      return {
        stopReason: 'endTurn',
        watchUsage: (listener) => {
          publish = listener
          return unsubscribe
        },
      }
    })
    target.clear = vi.fn(async () => {})
    const controller = new ChatController(target)
    await controller.submit('work')
    const publishStaleUsage = publish
    expect(unsubscribe).not.toHaveBeenCalled()
    if (action === 'clear') {
      await controller.submit('/clear')
      await controller.submit('new conversation')
    } else {
      await controller[action]()
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    publishStaleUsage?.({ totalTokens: 116, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 })
    expect(controller.getSnapshot().completedTurns[0]?.usage).toBeUndefined()
    await controller.dispose()
  })

  it('does not register late usage subscriptions after disposal during a stream', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const watchUsage = vi.fn()
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'working' }
      await pending
      return { stopReason: 'endTurn', watchUsage }
    })
    const controller = new ChatController(target)
    const submitting = controller.submit('work')
    await controller.dispose()
    finish()
    await submitting
    expect(watchUsage).not.toHaveBeenCalled()
  })

  it('reports unknown slash commands without starting a turn', async () => {
    const command = 'loop'
    const controller = new ChatController(backend())

    expect(controller.actionableCommandToken(`/${command}`)).toBeUndefined()

    await controller.submit(`/${command}`)

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      title: 'unknown command',
      rows: [{ label: `/${command}`, description: 'Type / to browse commands or use /skills to list skills.' }],
    })
    expect(controller.getSnapshot().completedTurns).toEqual([])
  })

  it('toggles MCP and skill discovery from settings and persists them', async () => {
    const setSettings = vi.fn(async () => {})
    const controller = new ChatController(backend(), { setSettings })

    await controller.submit('/settings')
    await controller.activatePanelRow({ label: '', description: '', value: 'settings:Auto-Discovery' })
    const rows = controller.getSnapshot().panel!.rows
    const mcpRow = rows.find((row) => row.value === 'mcpDiscovery')!
    const skillRow = rows.find((row) => row.value === 'skillDiscovery')!
    expect(mcpRow).toMatchObject({
      description: 'off · only explicit --mcp-config sources load · applies at next launch',
      control: { kind: 'toggle', checked: false },
    })
    expect(skillRow).toMatchObject({
      description: 'off · only configured skills directories load · applies at next launch',
      control: { kind: 'toggle', checked: false },
    })

    expect(await controller.activatePanelRow(mcpRow)).toBe(true)
    expect(setSettings).toHaveBeenNthCalledWith(1, { mcpDiscovery: true })
    expect(controller.getSnapshot().settings.mcpDiscovery).toBe(true)
    expect(controller.getSnapshot().panel!.rows.find((row) => row.value === 'mcpDiscovery')).toMatchObject({
      description: 'on · adds conventional Claude, Kiro, Gemini, Codex, and Strands sources · applies at next launch',
      control: { kind: 'toggle', checked: true },
    })

    expect(await controller.activatePanelRow(skillRow)).toBe(true)
    expect(setSettings).toHaveBeenNthCalledWith(2, { skillDiscovery: true })
    expect(controller.getSnapshot().settings.skillDiscovery).toBe(true)
    expect(controller.getSnapshot().panel!.rows.find((row) => row.value === 'skillDiscovery')).toMatchObject({
      description: 'on · adds conventional user and workspace sources · applies at next launch',
      control: { kind: 'toggle', checked: true },
    })
  })

  it('runs bang commands through the active backend shell stream', async () => {
    const modelPrompts: string[] = []
    const shellCommands: string[] = []
    const target = backend(async function* (prompt) {
      modelPrompts.push(prompt)
      yield { type: 'textDelta', text: 'model response' }
      return { stopReason: 'endTurn' }
    })
    target.streamShell = async function* (command) {
      shellCommands.push(command)
      yield { type: 'toolStart', toolUseId: 'shell-1', name: 'shell', input: { command } }
      yield {
        type: 'toolOutputDelta',
        toolUseId: 'shell-1',
        stream: 'stdout',
        text: '/workspace\n',
      }
      yield {
        type: 'toolResult',
        toolUseId: 'shell-1',
        status: 'success',
        content: [{ type: 'text', text: '/workspace\n' }],
      }
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target)

    expect(controller.actionableCommandToken('!pwd')).toBe('!')
    const turn = await controller.submit('!  pwd ')

    expect(shellCommands).toEqual(['pwd'])
    expect(modelPrompts).toEqual([])
    expect(turn).toMatchObject({
      prompt: '!  pwd',
      status: 'complete',
      entries: [
        {
          type: 'tool',
          name: 'shell',
          input: { command: 'pwd' },
          status: 'success',
          result: [{ type: 'text', text: '/workspace\n' }],
        },
      ],
    })
  })

  it('reports bang commands as unavailable when the backend has no sandbox execution capability', async () => {
    const controller = new ChatController(backend())

    await controller.submit('!pwd')

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      title: 'shell unavailable',
      rows: [
        {
          label: '!pwd',
          description: expect.stringContaining('built-in Strands connection'),
        },
      ],
    })
  })

  it('queues a bang command behind a running turn instead of injecting it as steering', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const shellCommands: string[] = []
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'Working.' }
      await gate
      return { stopReason: 'endTurn' }
    })
    target.queueSteering = vi.fn(() => true)
    target.streamShell = async function* (command) {
      shellCommands.push(command)
      yield { type: 'toolStart', toolUseId: 'shell-1', name: 'shell', input: { command } }
      yield { type: 'toolResult', toolUseId: 'shell-1', status: 'success', content: [] }
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target)

    const running = controller.submit('work')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    const queued = controller.steer('!pwd')

    expect(target.queueSteering).not.toHaveBeenCalled()
    expect(controller.getSnapshot().queuedPrompts).toEqual([{ id: 'queued-1', prompt: '!pwd' }])
    expect(controller.steerQueued()).toBe(true)
    expect(target.queueSteering).not.toHaveBeenCalled()
    expect(target.cancel).toHaveBeenCalledOnce()

    release()
    await running
    await queued
    expect(shellCommands).toEqual(['pwd'])
  })

  it('publishes backend-owned tasks and exact context metrics', async () => {
    const controller = new ChatController(
      backend(async function* () {
        yield {
          type: 'tasks',
          tasks: [{ id: 'todo-1', label: 'Do work', status: 'in_progress', source: 'todo' }],
        }
        yield { type: 'context', usage: { currentTokens: 120, projectedTokens: 145, contextWindow: 1_000 } }
        yield { type: 'textDelta', text: 'done' }
        return {
          stopReason: 'endTurn',
          context: { inputTokens: 100, outputTokens: 25 },
        }
      })
    )

    await controller.submit('work')

    expect(controller.getSnapshot()).toMatchObject({
      status: 'idle',
      tasks: [{ id: 'todo-1', label: 'Do work', status: 'in_progress', source: 'todo' }],
      context: {
        currentTokens: 120,
        projectedTokens: 145,
        contextWindow: 1_000,
        inputTokens: 100,
        outputTokens: 25,
      },
      completedTurns: [{ status: 'complete', entries: [{ type: 'assistant', text: 'done' }] }],
    })
  })

  it('keeps an open tasks panel synchronized with idle backend updates', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    const stopWatching = vi.fn()
    const target = backend()
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return stopWatching
    }
    const controller = new ChatController(target)

    await controller.submit('/tasks')
    taskListener?.([
      {
        id: 'task-1',
        label: 'Review authentication',
        status: 'working',
        source: 'background',
        detail: 'subagent | task-1',
      },
    ])

    expect(controller.getSnapshot()).toMatchObject({
      tasks: [{ id: 'task-1', status: 'working' }],
      panel: {
        kind: 'tasks',
        title: 'tasks (1)',
        rows: [
          {
            label: 'Review authentication',
            description: 'working | subagent | task-1',
            section: 'Background tasks',
          },
        ],
      },
    })

    await controller.dispose()
    expect(stopWatching).toHaveBeenCalledOnce()
  })

  it('shows and toggles the native wait-for-completion control', async () => {
    let waitForCompletion = false
    const setWaitForCompletion = vi.fn(async (value: boolean) => {
      waitForCompletion = value
    })
    const target = backend(async function* () {
      yield* []
      return { stopReason: 'endTurn', context: { currentTokens: 800, projectedTokens: 850, contextWindow: 200_000 } }
    })
    target.backgroundTasksWaitForCompletion = () => waitForCompletion
    target.setBackgroundTasksWaitForCompletion = setWaitForCompletion
    const controller = new ChatController(target)

    await controller.submit('seed context')
    expect(controller.getSnapshot().context.projectedTokens).toBe(850)
    await controller.submit('/tasks')
    expect(controller.getSnapshot().panel?.rows[0]).toMatchObject({
      label: 'Wait for completion',
      badge: { text: 'off', tone: 'warning' },
    })

    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)

    expect(setWaitForCompletion).toHaveBeenCalledWith(true)
    expect(controller.getSnapshot().panel?.rows[0]).toMatchObject({
      label: 'Wait for completion',
      badge: { text: 'on', tone: 'success' },
    })
    expect(controller.getSnapshot().context).toEqual({})
  })

  it('blocks wait-mode changes while background work is unresolved', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    const setWaitForCompletion = vi.fn(async () => {})
    const target = backend()
    target.backgroundTasksWaitForCompletion = () => false
    target.setBackgroundTasksWaitForCompletion = setWaitForCompletion
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    const controller = new ChatController(target)
    taskListener?.([
      {
        id: 'task-1',
        label: 'background bash',
        status: 'working',
        source: 'background',
        deliveryState: 'pending',
      },
    ])

    await controller.submit('/tasks')
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      title: 'task mode change blocked',
    })
    expect(setWaitForCompletion).not.toHaveBeenCalled()
  })

  it('opens a live background task detail panel and releases its subscription on close', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    let activityListener: ((activity: BackgroundAgentActivity | undefined) => void) | undefined
    const stopActivity = vi.fn()
    let activity: BackgroundAgentActivity = {
      toolUseId: 'dispatch-1',
      taskId: 'task-1',
      name: 'reviewer',
      task: 'Review authentication.',
      status: 'working',
      entries: [{ type: 'reasoning', text: 'Inspecting routes.' }],
    }
    const target = backend()
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    target.getTaskActivity = () => activity
    target.watchTaskActivity = (_taskId, listener) => {
      activityListener = listener
      listener(activity)
      return stopActivity
    }
    const controller = new ChatController(target)

    taskListener?.([
      {
        id: 'task-1',
        label: 'reviewer: Review authentication.',
        status: 'working',
        source: 'background',
        toolUseId: 'dispatch-1',
      },
    ])
    await controller.submit('/tasks')
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'detail',
      title: 'agent reviewer | working',
      activity: expect.objectContaining({
        name: 'reviewer',
        status: 'working',
        entries: expect.arrayContaining([{ type: 'reasoning', text: 'Inspecting routes.' }]),
      }),
    })

    activity = {
      ...activity,
      status: 'completed',
      entries: [
        ...activity.entries,
        {
          type: 'tool',
          toolUseId: 'child-tool-1',
          name: 'read',
          input: { path: 'auth.ts' },
          status: 'success',
          result: 'source',
        },
        { type: 'assistant', text: 'Authentication is sound.' },
      ],
    }
    const detailUpdates = vi.fn()
    controller.subscribe(detailUpdates)
    activityListener?.(activity)
    activityListener?.(activity)

    await vi.waitFor(() =>
      expect(controller.getSnapshot().panel).toMatchObject({
        title: 'agent reviewer | completed',
        activity: expect.objectContaining({
          status: 'completed',
          entries: expect.arrayContaining([{ type: 'assistant', text: 'Authentication is sound.' }]),
        }),
      })
    )
    expect(detailUpdates).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().panel?.activity?.entries).toContainEqual(
      expect.objectContaining({ type: 'tool', name: 'read', status: 'success' })
    )

    expect(controller.dismissPanel()).toBe(true)
    expect(stopActivity).toHaveBeenCalledOnce()
  })

  it('shows one completion notice until the result is delivered', () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    const target = backend()
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    const controller = new ChatController(target)
    const task = {
      id: 'task-1',
      label: 'reviewer',
      source: 'background' as const,
      toolUseId: 'dispatch-1',
    }

    taskListener?.([{ ...task, status: 'working', deliveryState: 'pending' }])
    taskListener?.([{ ...task, status: 'completed', deliveryState: 'ready', result: 'No issue found.' }])

    expect(controller.getSnapshot().notices).toMatchObject([
      { status: 'success', text: 'Background task completed (reviewer)', taskId: 'task-1' },
    ])

    taskListener?.([])

    expect(controller.getSnapshot().notices).toEqual([])
  })

  it('stays interactive while background work runs and wakes the agent when a result is ready', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    let resultReady = false
    const prompts: string[] = []
    const target = backend(async function* (prompt) {
      prompts.push(prompt)
      yield { type: 'textDelta', text: `reply to ${prompt}` }
      return { stopReason: 'endTurn' }
    })
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    target.hasReadyBackgroundResults = () => resultReady
    target.streamBackgroundResults = async function* () {
      resultReady = false
      yield { type: 'reasoningDelta', text: 'Considering the completed review.' }
      yield { type: 'textDelta', text: 'The background review found no issues.' }
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target)
    const task = {
      id: 'task-1',
      label: 'reviewer: Review authentication.',
      status: 'working' as const,
      source: 'background' as const,
      deliveryState: 'pending' as const,
    }

    taskListener?.([task])
    expect(controller.getSnapshot().status).toBe('idle')
    await controller.submit('Can we discuss something else?')
    expect(prompts).toEqual(['Can we discuss something else?'])

    resultReady = true
    taskListener?.([{ ...task, status: 'completed', deliveryState: 'ready' }])
    await vi.waitFor(() => expect(controller.getSnapshot().completedTurns).toHaveLength(2))

    expect(controller.getSnapshot().completedTurns[1]).toMatchObject({
      prompt: '',
      source: 'background',
      status: 'complete',
      entries: [
        { type: 'reasoning', text: 'Considering the completed review.' },
        { type: 'assistant', text: 'The background review found no issues.' },
      ],
    })
  })

  it('queues an automatic result continuation behind an active user turn', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    let releaseUserTurn!: () => void
    let resultReady = false
    let backgroundRuns = 0
    const userTurn = new Promise<void>((resolve) => {
      releaseUserTurn = resolve
    })
    const target = backend(async function* () {
      await userTurn
      yield { type: 'textDelta', text: 'Foreground response.' }
      return { stopReason: 'endTurn' }
    })
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    target.hasReadyBackgroundResults = () => resultReady
    target.streamBackgroundResults = async function* () {
      backgroundRuns += 1
      resultReady = false
      yield { type: 'textDelta', text: 'Background result received.' }
      return { stopReason: 'endTurn' }
    }
    target.streamPeer = async function* () {
      yield { type: 'textDelta', text: 'Peer message received.' }
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target)
    const running = controller.submit('Keep chatting.')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))

    resultReady = true
    taskListener?.([
      {
        id: 'task-1',
        label: 'reviewer',
        status: 'completed',
        source: 'background',
        deliveryState: 'ready',
      },
    ])
    controller.enqueuePeerMessage({
      from: { id: 'agent-2', name: 'Reviewer' },
      body: 'One more thing.',
    })
    await Promise.resolve()
    expect(backgroundRuns).toBe(0)

    releaseUserTurn()
    await running
    await vi.waitFor(() => expect(controller.getSnapshot().completedTurns).toHaveLength(3))
    expect(backgroundRuns).toBe(1)
    expect(controller.getSnapshot().completedTurns.map((turn) => turn.source ?? 'user')).toEqual([
      'user',
      'background',
      'peer',
    ])
  })

  it('attempts each ready background-task generation only once after delivery failure', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    let attempts = 0
    const target = backend()
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    target.hasReadyBackgroundResults = () => true
    target.streamBackgroundResults = async function* () {
      attempts += 1
      yield* []
      throw new Error('provider unavailable')
    }
    const controller = new ChatController(target)
    const ready = {
      id: 'task-1',
      label: 'reviewer',
      status: 'completed' as const,
      source: 'background' as const,
      deliveryState: 'ready' as const,
      result: 'done',
    }

    taskListener?.([ready])
    await vi.waitFor(() => expect(controller.getSnapshot().completedTurns).toHaveLength(1))
    taskListener?.([ready])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attempts).toBe(1)

    taskListener?.([{ ...ready, id: 'task-2' }])
    await vi.waitFor(() => expect(attempts).toBe(2))
  })

  it('shows unknown context values before the first model response', async () => {
    const controller = new ChatController(backend())

    await controller.submit('/context')

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'context',
      rows: [],
    })
    expect(controller.getSnapshot().context).toEqual({})
  })

  it('replaces final context instead of retaining unavailable fields from the prior turn', async () => {
    let turn = 0
    const controller = new ChatController(
      backend(async function* () {
        yield* []
        turn++
        return turn === 1
          ? {
              stopReason: 'endTurn',
              context: {
                currentTokens: 100,
                projectedTokens: 125,
                contextWindow: 1_000,
                inputTokens: 100,
                outputTokens: 25,
                totalTokens: 125,
              },
            }
          : {
              stopReason: 'endTurn',
              context: {
                projectedTokens: 155,
                contextWindow: 1_000,
                totalTokens: 155,
              },
            }
      })
    )

    await controller.submit('first')
    await controller.submit('second')

    expect(controller.getSnapshot().context).toEqual({
      projectedTokens: 155,
      contextWindow: 1_000,
      totalTokens: 155,
    })
  })

  it('restores the prior context when a turn fails after a partial update', async () => {
    let turn = 0
    const controller = new ChatController(
      backend(async function* () {
        turn++
        if (turn === 1) {
          return {
            stopReason: 'endTurn',
            context: {
              currentTokens: 100,
              projectedTokens: 125,
              contextWindow: 1_000,
            },
          }
        }
        yield { type: 'context', usage: { currentTokens: 200, projectedTokens: 250, contextWindow: 1_000 } }
        throw new Error('model failed')
      })
    )

    await controller.submit('first')
    const expected = { currentTokens: 100, projectedTokens: 125, contextWindow: 1_000 }
    expect(controller.getSnapshot().context).toEqual(expected)

    await controller.submit('second')

    expect(controller.getSnapshot().context).toEqual(expected)
  })

  it('returns control immediately, forwards repeated cancellation, and queues the next turn behind the SDK lock', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: string[] = []
    const target = backend(async function* (prompt) {
      prompts.push(prompt)
      if (prompt === 'long task') {
        yield { type: 'toolStart', toolUseId: 'tool-1', name: 'bash', input: { command: 'sleep 10' } }
        await gate
        return { stopReason: 'cancelled' }
      }
      yield { type: 'textDelta', text: 'Ready again.' }
      return { stopReason: 'endTurn' }
    })
    const controller = new ChatController(target)
    const running = controller.submit('long task')
    await vi.waitFor(() => expect(controller.getSnapshot().activeTurn?.entries).toHaveLength(1))

    expect(controller.cancel()).toBe(true)
    expect(target.cancel).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'interrupting',
      completedTurns: [{ status: 'cancelled' }],
    })
    expect(controller.getSnapshot().activeTurn).toBeUndefined()
    expect(controller.getSnapshot().completedTurns[0]?.entries[0]).toMatchObject({
      type: 'tool',
      status: 'cancelled',
    })
    expect(controller.cancel()).toBe(true)
    expect(target.cancel).toHaveBeenCalledTimes(2)
    const queued = controller.submit('next task')
    await Promise.resolve()
    expect(prompts).toEqual(['long task'])

    release()
    await Promise.all([running, queued])
    expect(prompts).toEqual(['long task', 'next task'])
    expect(controller.getSnapshot().completedTurns.map((turn) => turn.status)).toEqual(['cancelled', 'complete'])
  })

  it('accepts and runs queued prompts in order while the active turn continues', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: string[] = []
    const target = backend(async function* (prompt) {
      prompts.push(prompt)
      if (prompt === 'first') {
        yield { type: 'textDelta', text: 'Working.' }
        await gate
      }
      return { stopReason: 'endTurn' }
    })
    const controller = new ChatController(target)
    const idle = vi.fn()
    controller.subscribe(() => {
      if (!controller.busy) idle()
    })

    const first = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    const second = controller.submit('second')
    const third = controller.submit('third')

    expect(prompts).toEqual(['first'])
    expect(controller.getSnapshot().queuedPrompts).toEqual([
      { id: 'queued-1', prompt: 'second' },
      { id: 'queued-2', prompt: 'third' },
    ])

    release()
    await Promise.all([first, second, third])

    expect(prompts).toEqual(['first', 'second', 'third'])
    expect(controller.getSnapshot().queuedPrompts).toEqual([])
    expect(controller.getSnapshot().completedTurns.map((turn) => turn.prompt)).toEqual(['first', 'second', 'third'])
    await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce())
  })

  it('queues peer messages at the turn boundary without interpreting them as local commands', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: string[] = []
    const peerMessages: string[] = []
    const target = backend(async function* (prompt) {
      prompts.push(prompt)
      if (prompt === 'first') {
        yield { type: 'textDelta', text: 'Working.' }
        await gate
      }
      return { stopReason: 'endTurn' }
    })
    target.streamPeer = async function* (message) {
      peerMessages.push(message.body)
      yield { type: 'textDelta', text: 'Peer message handled.' }
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target)
    const message = {
      from: { id: 'agent-2', name: 'Reviewer' },
      body: '/exit',
    }

    const first = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    expect(controller.enqueuePeerMessage(message)).toBe(true)
    const human = controller.submit('human follow-up')

    expect(controller.getSnapshot().queuedPrompts).toEqual([
      { id: 'queued-1', prompt: '/exit', source: 'peer', from: 'Reviewer' },
      { id: 'queued-2', prompt: 'human follow-up' },
    ])

    release()
    await Promise.all([first, human])
    await vi.waitFor(() => expect(controller.getSnapshot().completedTurns).toHaveLength(3))

    expect(prompts).toEqual(['first', 'human follow-up'])
    expect(peerMessages).toEqual(['/exit'])
    expect(controller.getSnapshot()).toMatchObject({
      status: 'idle',
      completedTurns: [
        { prompt: 'first' },
        {
          prompt: '/exit',
          source: 'peer',
          peer: { id: 'agent-2', name: 'Reviewer' },
          entries: [{ type: 'assistant', text: 'Peer message handled.' }],
        },
        { prompt: 'human follow-up' },
      ],
    })
  })

  it('caps the pending peer inbox while a turn is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'Working.' }
      await gate
      return { stopReason: 'endTurn' }
    })
    target.streamPeer = async function* () {
      yield* []
      return { stopReason: 'endTurn' }
    }
    const controller = new ChatController(target)
    const running = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))

    for (let index = 0; index < 32; index += 1) {
      expect(
        controller.enqueuePeerMessage({
          from: { id: 'agent-2', name: 'Reviewer' },
          body: `Message ${index}.`,
        })
      ).toBe(true)
    }
    expect(
      controller.enqueuePeerMessage({
        from: { id: 'agent-2', name: 'Reviewer' },
        body: 'Overflow.',
      })
    ).toBe(false)

    controller.close()
    release()
    await running
  })

  it('interrupts for steering and runs that prompt ahead of queued follow-ups', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: string[] = []
    const target = backend(async function* (prompt) {
      prompts.push(prompt)
      if (prompt === 'first') {
        yield { type: 'textDelta', text: 'Initial direction.' }
        await gate
      }
      return { stopReason: 'endTurn' }
    })
    const controller = new ChatController(target)

    const first = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    const queued = controller.submit('ordinary follow-up')
    const steering = controller.steer('change direction now')

    expect(target.cancel).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().queuedPrompts.map((prompt) => prompt.prompt)).toEqual([
      'change direction now',
      'ordinary follow-up',
    ])

    release()
    await Promise.all([first, steering, queued])

    expect(prompts).toEqual(['first', 'change direction now', 'ordinary follow-up'])
    expect(controller.getSnapshot().completedTurns.map((turn) => turn.status)).toEqual([
      'cancelled',
      'complete',
      'complete',
    ])
  })

  it('injects steering into a running turn without cancelling it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'Working.' }
      await gate
      return { stopReason: 'endTurn' }
    })
    target.queueSteering = vi.fn(() => true)
    const controller = new ChatController(target)

    const running = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    await controller.steer('change direction now')

    expect(target.queueSteering).toHaveBeenCalledWith('change direction now')
    expect(target.cancel).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      notices: [],
      queuedPrompts: [],
    })

    release()
    await running
  })

  it('turns a queued prompt into live steering without cancelling the turn', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'Working.' }
      await gate
      return { stopReason: 'endTurn' }
    })
    target.queueSteering = vi.fn(() => true)
    const controller = new ChatController(target)

    const running = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    const queued = controller.submit('change direction now')
    const queuedId = controller.getSnapshot().queuedPrompts[0]!.id

    expect(controller.steerQueued(queuedId)).toBe(true)
    expect(target.queueSteering).toHaveBeenCalledWith('change direction now')
    expect(target.cancel).not.toHaveBeenCalled()
    expect(controller.getSnapshot().queuedPrompts).toEqual([])
    await expect(queued).resolves.toBeUndefined()

    release()
    await running
  })

  it('promotes an existing queued prompt for steering without duplicating it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const prompts: string[] = []
    const target = backend(async function* (prompt) {
      prompts.push(prompt)
      if (prompt === 'first') {
        yield { type: 'textDelta', text: 'Initial direction.' }
        await gate
      }
      return { stopReason: 'endTurn' }
    })
    const controller = new ChatController(target)

    const first = controller.submit('first')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))
    const second = controller.submit('ordinary follow-up')
    const third = controller.submit('steer with this')
    const steeringId = controller.getSnapshot().queuedPrompts[1]!.id

    expect(controller.steerQueued(steeringId)).toBe(true)
    expect(target.cancel).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'interrupting',
      queuedPrompts: [{ id: steeringId, prompt: 'steer with this' }, { prompt: 'ordinary follow-up' }],
    })

    release()
    await Promise.all([first, second, third])

    expect(prompts).toEqual(['first', 'steer with this', 'ordinary follow-up'])
  })

  it('closes on exit words and converts backend failures into turn errors', async () => {
    const target = backend(async function* () {
      yield* []
      throw new Error('provider unavailable')
    })
    const controller = new ChatController(target)

    await controller.submit('hello')
    expect(controller.getSnapshot().completedTurns[0]).toMatchObject({
      status: 'error',
      error: 'provider unavailable',
    })

    await controller.submit('QUIT')
    expect(controller.getSnapshot()).toMatchObject({ status: 'closed', exitCode: 0 })
  })

  it.each([true, false])('shows all built-in provider filters when discovery returns models: %s', async (hasModels) => {
    const target = backend()
    target.info = () => ({ model: 'bedrock/anthropic.claude-current' })
    target.listModels = vi.fn(() =>
      hasModels
        ? [
            {
              id: 'anthropic.claude-current',
              name: 'Current model',
              description: '',
              value: 'bedrock/anthropic.claude-current',
              catalog: 'bedrock',
              active: true,
            },
          ]
        : []
    )
    const controller = new ChatController(target)

    await controller.openModelPanel()

    const panel = controller.getSnapshot().panel!
    expect(panel.filters).toEqual([
      { id: 'all', label: 'All' },
      { id: 'bedrock', label: 'Amazon Bedrock' },
      { id: 'bedrock-mantle', label: 'Amazon Bedrock (Mantle)' },
      { id: 'anthropic', label: 'Anthropic' },
      { id: 'openai', label: 'OpenAI' },
      { id: 'google', label: 'Google Gemini' },
      { id: 'ollama', label: 'Ollama' },
      { id: 'litellm', label: 'LiteLLM' },
    ])
    expect(panel.rows).toHaveLength(1)
    expect(panel.rows.flatMap((row) => (row.value ? [row.value] : []))).toEqual(
      hasModels ? ['bedrock/anthropic.claude-current'] : []
    )
    expect(target.listModels).toHaveBeenCalledOnce()
  })

  it.each([undefined, 'openai', 'remote-catalog'])(
    'keeps ACP provider filters limited to its reported catalog: %s',
    async (catalog) => {
      const target = backend()
      target.listModels = () => [
        { id: 'remote-model', name: 'Remote model', description: '', ...(catalog ? { catalog } : {}) },
        { id: 'other-model', name: 'Other model', description: '', ...(catalog ? { catalog } : {}) },
      ]
      const controller = new ChatController({ ...target, protocol: 'acp' })

      await controller.openModelPanel()

      expect(controller.getSnapshot().panel?.filters).toEqual([
        { id: 'all', label: 'All' },
        ...(catalog ? [{ id: catalog, label: catalog === 'openai' ? 'OpenAI' : catalog }] : []),
      ])
      expect(controller.getSnapshot().panel?.rows).toHaveLength(2)
    }
  )

  it('rebuilds immediately for a model change that requires restart', async () => {
    const target = backend(async function* () {
      yield* []
      return {
        stopReason: 'endTurn',
        context: { currentTokens: 800, projectedTokens: 850, contextWindow: 200_000 },
      }
    })
    const currentId = 'global.anthropic.claude-opus-4-8'
    const nextId = 'bedrock/anthropic.claude-sonnet-5'
    let currentModel = currentId
    target.info = () => ({ model: currentModel })
    target.listModels = () => [
      { id: currentId, name: 'Claude Opus 4.8', description: 'current', active: true },
      { id: nextId, name: 'Claude Sonnet 5', description: 'other family' },
    ]
    target.modelChangeMode = () => 'restart'
    target.switchModel = vi.fn()
    target.restartModel = vi.fn(async () => {
      currentModel = nextId
      return currentModel
    })
    const controller = new ChatController(target)

    await controller.submit('seed context')
    expect(controller.getSnapshot().context.projectedTokens).toBe(850)
    await controller.submit('/model')
    expect(controller.getSnapshot().panel?.kind).toBe('models')
    expect(controller.getSnapshot().panel?.rows[0]).toMatchObject({
      label: 'Claude Opus 4.8',
      badge: { text: 'current', tone: 'success' },
    })
    expect(controller.getSnapshot().panel?.rows[1]).toMatchObject({
      label: 'Claude Sonnet 5',
    })
    expect(controller.getSnapshot().panel?.rows[1]?.badge).toBeUndefined()
    expect(controller.getSnapshot().panel?.rows[1]?.tone).toBeUndefined()
    expect(controller.getSnapshot().panel?.body).toBe('Claude Opus 4.8\nglobal.anthropic.claude-opus-4-8')
    const nextIndex = controller.getSnapshot().panel?.rows.findIndex((row) => row.value === nextId) ?? -1
    expect(nextIndex).toBeGreaterThanOrEqual(0)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[nextIndex]!)
    expect(target.restartModel).toHaveBeenCalledWith(nextId)
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'models',
      body: `Claude Sonnet 5\n${nextId}`,
      rows: [{ label: 'Claude Opus 4.8' }, { label: 'Claude Sonnet 5', badge: { text: 'current', tone: 'success' } }],
    })
    expect(controller.getSnapshot().runtime.model).toBe(nextId)
    expect(controller.getSnapshot().context).toEqual({})
  })

  it('changes effort from the model panel without invoking model selection', async () => {
    const target = backend()
    let effort = 'high'
    target.info = () => ({
      model: 'global.anthropic.claude-opus-4-8',
      effort: effort === 'off' ? 'Model default' : 'High',
    })
    target.listModels = vi.fn(() => [
      {
        id: 'global.anthropic.claude-opus-4-8',
        name: 'Claude Opus 4.8',
        description: '',
        active: true,
      },
    ])
    target.listEfforts = () => [
      {
        id: 'off',
        label: 'Model default',
        ...(effort === 'off' ? { active: true } : {}),
      },
      { id: 'high', label: 'High', ...(effort === 'high' ? { active: true } : {}) },
    ]
    target.switchModel = vi.fn()
    target.restartModel = vi.fn()
    target.setEffort = vi.fn(async (selected) => {
      effort = selected
      return selected
    })
    const controller = new ChatController(target)

    await controller.submit('/model')
    const panelId = controller.getSnapshot().panel?.id

    expect(controller.getSnapshot().panel).toMatchObject({
      body: 'Claude Opus 4.8\nglobal.anthropic.claude-opus-4-8',
      slider: {
        label: 'Effort',
        options: [
          { id: 'off', label: 'Model default' },
          { id: 'high', label: 'High', active: true },
        ],
      },
    })
    expect(controller.getSnapshot().panel?.rows).toHaveLength(1)
    await controller.activatePanelRow({
      label: 'Effort',
      description: 'Model default',
      value: 'effort:off',
    })

    expect(target.setEffort).toHaveBeenCalledWith('off')
    expect(target.listModels).toHaveBeenCalledOnce()
    expect(target.switchModel).not.toHaveBeenCalled()
    expect(target.restartModel).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      panel: {
        id: panelId,
        slider: {
          options: [{ id: 'off', active: true }, { id: 'high' }],
        },
      },
      runtime: { effort: 'Model default' },
    })
  })

  it('sets effort from /effort and opens the model panel focused on the slider without an argument', async () => {
    const target = backend()
    let effort = 'high'
    target.info = () => ({ model: 'global.anthropic.claude-opus-4-8', effort: effort === 'low' ? 'Low' : 'High' })
    target.listModels = vi.fn(() => [
      { id: 'global.anthropic.claude-opus-4-8', name: 'Claude Opus 4.8', description: '', active: true },
    ])
    target.listEfforts = () => [
      { id: 'low', label: 'Low', ...(effort === 'low' ? { active: true } : {}) },
      { id: 'high', label: 'High', ...(effort === 'high' ? { active: true } : {}) },
    ]
    target.setEffort = vi.fn(async (selected) => {
      effort = selected
      return selected
    })
    const controller = new ChatController(target)

    await controller.submit('/effort LOW')
    expect(target.setEffort).toHaveBeenCalledWith('low')
    expect(target.listModels).not.toHaveBeenCalled()
    expect(controller.getSnapshot().panel).toBeUndefined()
    expect(controller.getSnapshot().runtime.effort).toBe('Low')

    await controller.submit('/effort')
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'models',
      slider: { focused: true, options: [{ id: 'low', active: true }, { id: 'high' }] },
    })

    await controller.submit('/model')
    expect(controller.getSnapshot().panel?.slider?.focused).toBeUndefined()
  })

  it('reports an unsupported /effort level as an error', async () => {
    const target = backend()
    target.info = () => ({ model: 'bedrock/model', effort: 'High' })
    target.setEffort = vi.fn(async () => {
      throw new ModelControlError('Reasoning effort "turbo" is not supported. Choose: low, high, auto.')
    })
    const controller = new ChatController(target)

    await controller.submit('/effort turbo')
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      title: 'effort change failed',
      rows: [{ description: 'Reasoning effort "turbo" is not supported. Choose: low, high, auto.' }],
    })
    expect(controller.getSnapshot().runtime).toMatchObject({ model: 'bedrock/model', effort: 'High' })
  })

  it('catches invalid model arguments before backend mode selection can escape the TUI', async () => {
    const target = backend()
    target.info = () => ({ model: 'ollama/qwen3:8b', effort: 'Auto' })
    target.modelChangeMode = (model) => {
      resolveModelTarget(model)
      return 'restart'
    }
    target.restartModel = vi.fn()
    const controller = new ChatController(target)

    await expect(controller.submit('/model unknown/invalid-id')).resolves.toBeUndefined()
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      rows: [{ description: 'Unsupported model provider "unknown". Use /model to choose a model.' }],
    })
    expect(controller.getSnapshot().runtime).toMatchObject({ model: 'ollama/qwen3:8b', effort: 'Auto' })
    expect(target.restartModel).not.toHaveBeenCalled()
  })

  it.each(['model', 'effort'] as const)('keeps raw provider failures out of /%s errors', async (command) => {
    const target = backend()
    target.info = () => ({ model: 'ollama/qwen3:8b', effort: 'Auto' })
    const failure = vi.fn(async () => {
      throw new Error('HTTP 400 {"provider":"raw response"}\n    at provider.request (sdk.js:12)')
    })
    target.restartModel = failure
    target.setEffort = failure
    const controller = new ChatController(target)

    await controller.submit(`/${command} invalid`)
    expect(failure).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      rows: [{ description: `Could not change ${command}. Check your provider connection and try again.` }],
    })
    expect(controller.getSnapshot().runtime).toMatchObject({ model: 'ollama/qwen3:8b', effort: 'Auto' })
  })

  it('disables effort in the model panel when the model has no effort choices', async () => {
    const target = backend()
    target.listModels = () => [{ id: 'openai.gpt-5', name: 'GPT-5', description: '', active: true }]
    target.listEfforts = () => [{ id: 'off', label: 'Model default', active: true }]
    const controller = new ChatController(target)

    await controller.submit('/model')

    expect(controller.getSnapshot().panel?.slider).toEqual({
      label: 'Effort',
      options: [{ id: 'off', label: 'Model default', active: true }],
      disabled: true,
    })
  })

  it('defers the latest model change and settles a superseded notice', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const currentId = 'global.anthropic.claude-opus-4-8'
    const nextId = 'bedrock/anthropic.claude-sonnet-5'
    const latestId = 'bedrock/anthropic.claude-opus-5'
    let currentModel = currentId
    const target = backend(async function* () {
      yield { type: 'textDelta', text: 'Working.' }
      await gate
      return { stopReason: 'endTurn' }
    })
    target.info = () => ({ model: currentModel })
    target.listModels = () => [
      { id: currentId, name: 'Claude Opus 4.8', description: 'current', active: true },
      { id: nextId, name: 'Claude Sonnet 5', description: 'other family' },
      { id: latestId, name: 'Claude Opus 5', description: 'latest choice' },
    ]
    target.modelChangeMode = () => 'restart'
    target.switchModel = vi.fn()
    target.restartModel = vi.fn(async (modelId) => {
      currentModel = modelId
      return currentModel
    })
    const controller = new ChatController(target)

    const running = controller.submit('long task')
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('running'))

    controller.openContextPanel()
    expect(controller.getSnapshot().panel?.kind).toBe('context')
    await controller.openModelPanel()
    expect(controller.getSnapshot().panel?.kind).toBe('models')
    expect(controller.getSnapshot().queuedPrompts).toEqual([])
    expect(target.cancel).not.toHaveBeenCalled()

    const nextIndex = controller.getSnapshot().panel?.rows.findIndex((row) => row.value === nextId) ?? -1
    expect(nextIndex).toBeGreaterThanOrEqual(0)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[nextIndex]!)
    expect(target.restartModel).not.toHaveBeenCalled()
    expect(controller.getSnapshot().notices).toEqual([
      expect.objectContaining({
        status: 'running',
        text: 'Model change queued for after the current turn: Claude Sonnet 5',
      }),
    ])

    await controller.openModelPanel()
    const latestIndex = controller.getSnapshot().panel?.rows.findIndex((row) => row.value === latestId) ?? -1
    expect(latestIndex).toBeGreaterThanOrEqual(0)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[latestIndex]!)
    expect(controller.getSnapshot().notices).toEqual([
      expect.objectContaining({
        status: 'delivered',
        text: 'Model change to Claude Sonnet 5 superseded by Claude Opus 5',
      }),
      expect.objectContaining({
        status: 'running',
        text: 'Model change queued for after the current turn: Claude Opus 5',
      }),
    ])

    release()
    await running

    expect(target.restartModel).toHaveBeenCalledOnce()
    expect(target.restartModel).toHaveBeenCalledWith(latestId)
    expect(controller.getSnapshot().runtime.model).toBe(latestId)
    expect(controller.getSnapshot().notices[1]).toMatchObject({
      status: 'delivered',
      text: 'Model changed to Claude Opus 5',
    })
  })

  it('blocks agent replacement while background work is unresolved', async () => {
    let taskListener: ((tasks: readonly ChatTask[]) => void) | undefined
    const target = backend()
    target.watchTasks = (listener) => {
      taskListener = listener
      listener([])
      return () => {}
    }
    target.listModels = () => [
      { id: 'old', name: 'old', description: 'current', active: true },
      { id: 'new', name: 'new', description: 'other family' },
    ]
    target.modelChangeMode = () => 'restart'
    target.switchModel = vi.fn()
    target.restartModel = vi.fn()
    const controller = new ChatController(target)
    taskListener?.([
      {
        id: 'task-1',
        label: 'reviewer',
        status: 'working',
        source: 'background',
        deliveryState: 'pending',
      },
    ])

    await controller.submit('/model')
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[1]!)

    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'error',
      title: 'model change blocked',
    })
    expect(target.restartModel).not.toHaveBeenCalled()
  })

  it('shows cached sessions immediately while refreshing them in the background', async () => {
    let resolveRefresh!: (sessions: { id: string; name?: string; active: boolean }[]) => void
    const refresh = new Promise<{ id: string; name?: string; active: boolean }[]>((resolve) => {
      resolveRefresh = resolve
    })
    let listing = 0
    const list = vi.fn(() => {
      listing++
      return listing === 1 ? Promise.resolve([{ id: 'session-1', name: 'Initial name', active: true }]) : refresh
    })
    const controller = new ChatController(backend(), {
      sessions: {
        current: 'session-1',
        directory: '/tmp/sessions',
        list,
        resolve: async (reference) => ({
          reference,
          sessionId: 'session-1',
          sessionDirectory: '/tmp/sessions',
          workspace: '/tmp',
          active: true,
        }),
      },
    })

    await controller.submit('/sessions')
    controller.dismissPanel()
    await controller.submit('/sessions')

    const cachedPanelId = controller.getSnapshot().panel?.id
    expect(list).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'sessions',
      title: 'sessions (1)',
      rows: [{ label: 'Initial name' }],
    })

    resolveRefresh([
      { id: 'session-1', name: 'Updated name', active: true },
      { id: 'session-2', active: false },
    ])
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.title).toBe('sessions (2)'))
    expect(controller.getSnapshot().panel).toMatchObject({
      id: cachedPanelId,
      rows: [{ label: 'Updated name' }, { label: 'session-2' }],
    })
  })

  it('renames the current saved session and refreshes the sessions panel', async () => {
    let name: string | undefined
    const renameCurrent = vi.fn(async (nextName: string) => {
      name = nextName
      return { sessionId: 'session-1', name: nextName }
    })
    const controller = new ChatController(backend(), {
      runtime: { session: 'session-1' },
      sessions: {
        current: 'session-1',
        directory: '/tmp/sessions',
        list: vi.fn(async () => [{ id: 'session-1', ...(name ? { name } : {}), active: true }]),
        resolve: async (reference) => ({
          reference,
          sessionId: 'session-1',
          sessionDirectory: '/tmp/sessions',
          workspace: '/tmp',
          active: true,
        }),
        renameCurrent,
      },
    })

    await controller.submit('/sessions')
    controller.dismissPanel()
    await controller.submit('/sessions rename Release planning')

    expect(renameCurrent).toHaveBeenCalledWith('Release planning')
    expect(controller.getSnapshot()).toMatchObject({
      runtime: { session: 'Release planning' },
      panel: {
        kind: 'sessions',
        rows: [
          {
            label: 'Release planning',
            description: 'unknown workspace · not saved yet',
            current: true,
          },
        ],
      },
    })
  })

  it('holds a permission panel until the backend receives a response', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = backend(async function* () {
      yield {
        type: 'permission',
        request: {
          id: 'permission-1',
          toolName: 'bash',
          input: { command: 'rm file' },
          options: [
            { id: 'allow', label: 'Allow once', kind: 'allow_once' },
            { id: 'reject', label: 'Reject', kind: 'reject_once' },
          ],
        },
      }
      await gate
      return { stopReason: 'endTurn' }
    })
    target.respondPermission = vi.fn(() => true)
    const controller = new ChatController(target)
    const running = controller.submit('do it')
    await vi.waitFor(() => expect(controller.getSnapshot().panel?.kind).toBe('permission'))
    expect(controller.getSnapshot().panel?.body).toBe('Tool: bash\nInputs:\n{\n  "command": "rm file"\n}')
    expect(target.cancel).not.toHaveBeenCalled()
    expect(controller.dismissPanel()).toBe(false)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[0]!)
    expect(target.respondPermission).toHaveBeenCalledWith('permission-1', 'allow')
    expect(controller.getSnapshot().panel).toBeUndefined()

    release()
    await running
  })

  it('handles detached permissions while idle and restores the interrupted panel', async () => {
    let permissionListener: ((request: ChatPermissionRequest | undefined) => void) | undefined
    const stopWatching = vi.fn()
    const target = backend()
    target.watchPermissions = (listener) => {
      permissionListener = listener
      return stopWatching
    }
    target.respondPermission = vi.fn((requestId, optionId) => {
      permissionListener?.(undefined)
      return Boolean(requestId && optionId)
    })
    const controller = new ChatController(target)

    await controller.submit('/tasks')
    const request: ChatPermissionRequest = {
      id: 'permission-1',
      toolName: 'bash',
      input: { command: 'git status' },
      options: [
        { id: 'allow-once', label: 'Allow once', kind: 'allow_once' },
        {
          id: 'allow-tool-always',
          label: 'Always allow tool',
          description: 'Save this tool to config.json',
          kind: 'allow_always',
        },
        { id: 'deny', label: 'Deny', kind: 'reject_once' },
      ],
    }
    permissionListener?.(request)

    expect(controller.getSnapshot()).toMatchObject({
      status: 'idle',
      panel: {
        kind: 'permission',
        rows: [
          { label: 'Allow once' },
          { label: 'Always allow tool', description: 'Save this tool to config.json' },
          { label: 'Deny', tone: 'danger' },
        ],
      },
    })
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[1]!)
    expect(target.respondPermission).toHaveBeenCalledWith('permission-1', 'allow-tool-always')
    expect(controller.getSnapshot().panel?.kind).toBe('tasks')

    permissionListener?.({
      ...request,
      id: 'permission-2',
      toolName: 'write',
      input: { command: 'replace file' },
    })
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[2]!)
    expect(target.respondPermission).toHaveBeenCalledWith('permission-2', 'deny')
    expect(controller.getSnapshot().panel?.kind).toBe('tasks')

    await controller.dispose()
    expect(stopWatching).toHaveBeenCalledOnce()
  })

  it('persists permission modes and toggles always-allowed tools through /permissions', async () => {
    let mode: 'default' | 'bypassPermissions' = 'default'
    let allowedTools = ['bash']
    const target = backend()
    target.info = () => ({
      model: 'test',
      tools: [
        { name: 'bash', description: 'Run commands' },
        { name: 'write', description: 'Write files' },
      ],
    })
    target.permissionStatus = () => ({
      mode,
      allowedTools: [...allowedTools],
      configPath: '/Users/test/.strands/cli/config.json',
    })
    target.setPermissionMode = vi.fn(async (nextMode) => {
      mode = nextMode
    })
    target.allowPermission = vi.fn(async (toolName) => {
      allowedTools = [...allowedTools, toolName]
    })
    target.removeAllowedPermission = vi.fn(async (toolName) => {
      allowedTools = allowedTools.filter((candidate) => candidate !== toolName)
    })
    const controller = new ChatController(target)

    await controller.submit('/permissions')
    expect(controller.getSnapshot()).toMatchObject({
      panel: {
        kind: 'permissions',
        title: 'permissions',
        rows: [
          { label: 'Default (HITL)', badge: { text: 'Active' } },
          { label: 'Bypass', tone: 'danger' },
          { label: 'bash', control: { kind: 'toggle', checked: true } },
          { label: 'write', control: { kind: 'toggle', checked: false } },
          { label: 'config', description: '/Users/test/.strands/cli/config.json' },
        ],
      },
    })
    expect(controller.getSnapshot().panel?.body).toBeUndefined()

    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[1]!)
    expect(target.setPermissionMode).toHaveBeenCalledWith('bypassPermissions')
    expect(controller.getSnapshot().panel?.body).toContain('WARNING')

    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[3]!)
    expect(target.allowPermission).toHaveBeenCalledWith('write')
    expect(controller.getSnapshot().panel?.rows.find((row) => row.label === 'write')?.control).toEqual({
      kind: 'toggle',
      checked: true,
    })

    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[2]!)
    expect(target.removeAllowedPermission).toHaveBeenCalledWith('bash')
    expect(controller.getSnapshot().panel?.rows.find((row) => row.label === 'bash')?.control).toEqual({
      kind: 'toggle',
      checked: false,
    })

    await controller.submit('/permissions default')
    expect(target.setPermissionMode).toHaveBeenLastCalledWith('default')
  })

  it('toggles reasoning visibility through terminal settings', async () => {
    const controller = new ChatController(backend())

    await controller.submit('/settings')
    const reasoningIndex = controller.getSnapshot().panel?.rows.findIndex((row) => row.value === 'showReasoning')
    expect(reasoningIndex).toBeGreaterThanOrEqual(0)
    await controller.activatePanelRow(controller.getSnapshot().panel!.rows[reasoningIndex!]!)

    expect(controller.getSnapshot()).toMatchObject({
      settings: { showReasoning: false },
      panel: {
        kind: 'settings',
        rows: expect.arrayContaining([
          expect.objectContaining({
            value: 'showReasoning',
            control: { kind: 'toggle', checked: false },
          }),
        ]),
      },
    })
  })

  it('opens setup through /setup and settings after appearance updates', async () => {
    const requestSetup = vi.fn()
    const controller = new ChatController(backend(), { requestSetup })

    await controller.submit('/setup')

    expect(requestSetup).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().completedTurns).toEqual([])
    requestSetup.mockClear()
    await controller.submit('/settings')
    await controller.activatePanelRow({ label: '', description: '', value: 'colorMode=light' })
    await controller.activatePanelRow({ label: '', description: '', value: 'settings:General' })
    const rows = controller.getSnapshot().panel?.rows ?? []
    const setupIndex = rows.findIndex((row) => row.value === 'setup')
    const setup = rows[setupIndex]
    expect(setup).toMatchObject({ label: 'Setup', description: 'Providers and agent ›' })
    expect(rows.map(({ value }) => value)).toEqual(['setupOnLaunch', 'setup', 'telemetry'])
    expect(await controller.activatePanelRow(setup!)).toBe(true)
    expect(requestSetup).toHaveBeenCalledOnce()
  })

  it('compacts context and clears both the conversation and visible transcript', async () => {
    const target = backend(async function* (prompt) {
      yield { type: 'textDelta', text: `reply to ${prompt}` }
      return { stopReason: 'endTurn', context: { currentTokens: 120 } }
    })
    let compacted = false
    target.compact = vi.fn(async () => compacted)
    target.clear = vi.fn(async () => {})
    const controller = new ChatController(target, { runtime: { session: 'saved: active' } })

    await controller.submit('Remember this')
    await controller.submit('/compact')

    expect(target.compact).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      completedTurns: [{ prompt: 'Remember this' }],
      context: { currentTokens: 120 },
    })

    compacted = true
    await controller.submit('/compact')

    expect(target.compact).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toMatchObject({
      completedTurns: [{ prompt: 'Remember this' }],
      context: {},
    })
    expect(controller.getSnapshot().composerStatus).toBeUndefined()
    expect(controller.getSnapshot().panel).toBeUndefined()
    await controller.submit('/clear')

    expect(target.clear).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      completedTurns: [],
      notices: [],
      tasks: [],
      context: {},
      runtime: { session: 'in-memory' },
    })
    expect(controller.getSnapshot().panel).toBeUndefined()
  })

  it('shows compaction in the composer while work is active without opening a panel', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = backend()
    target.compact = vi.fn(async () => {
      await gate
      return true
    })
    const controller = new ChatController(target)

    const compacting = controller.submit('/compact')
    await vi.waitFor(() => expect(controller.getSnapshot().composerStatus).toBe('Compacting context...'))

    expect(controller.getSnapshot().panel).toBeUndefined()
    await expect(controller.submit('do not queue')).resolves.toBeUndefined()
    release()
    await compacting

    expect(controller.getSnapshot().composerStatus).toBeUndefined()
    expect(controller.getSnapshot().queuedPrompts).toEqual([])
  })

  it('activates direct slash and dollar skills through the skills runtime before running their prompts', async () => {
    const prompts: string[] = []
    const activate = vi.fn(async (name: string) =>
      name.toLowerCase() === 'review'
        ? {
            name: 'review',
            description: 'Review code',
            instructions: 'Inspect carefully.',
            active: true,
          }
        : undefined
    )
    const controller = new ChatController(
      backend(async function* (prompt) {
        prompts.push(prompt)
        yield { type: 'textDelta', text: 'done' }
        return { stopReason: 'endTurn' }
      }),
      {
        skills: { list: async () => [], activate },
        skillNames: ['review'],
      }
    )

    expect(controller.actionableCommandToken('/review this change')).toBe('/review')
    expect(controller.actionableCommandToken('$review that change')).toBe('$review')
    expect(controller.actionableCommandToken('/not-a-command')).toBeUndefined()

    await controller.submit('/review this change')
    await controller.submit('$review that change')

    expect(activate).toHaveBeenNthCalledWith(1, 'review')
    expect(activate).toHaveBeenNthCalledWith(2, 'review')
    expect(prompts).toEqual(['this change', 'that change'])
  })

  it('represents an empty MCP configuration as zero servers with its checked path', async () => {
    const list = vi.fn(async () => [])
    const controller = new ChatController(backend(), {
      mcp: {
        clients: [],
        paths: ['/Users/test/.strands/cli/mcp.json'],
        list,
        dispose: async () => undefined,
        warnings: [],
      },
    })

    await controller.submit('/mcp')

    expect(list).toHaveBeenCalledWith(true)
    expect(controller.getSnapshot().panel).toMatchObject({
      kind: 'mcp',
      title: 'MCP servers (0)',
      rows: [],
      body: expect.stringContaining('Checked: /Users/test/.strands/cli/mcp.json'),
    })
    expect(controller.getSnapshot().panel?.searchable).toBeUndefined()
  })
})
