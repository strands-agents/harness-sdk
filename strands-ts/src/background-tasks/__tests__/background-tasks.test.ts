import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { Agent } from '../../agent/agent.js'
import { AfterToolCallEvent, BeforeToolCallEvent, InitializedEvent } from '../../hooks/events.js'
import { Interrupt } from '../../interrupt.js'
import { ExecuteToolStage, InvokeModelStage } from '../../middleware/index.js'
import { tool } from '../../tools/tool-factory.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import type { ToolUseBlock } from '../../types/messages.js'
import type { ToolSpec } from '../../tools/types.js'
import type { BackgroundTask } from '../types.js'

const BACKGROUND_TASKS_STATE_KEY = 'strands.backgroundTasks'

function deliveries(agent: Agent): ToolUseBlock[] {
  const blocks = agent.messages.flatMap((message) => message.content)
  return blocks.filter(
    (block): block is ToolUseBlock => block.type === 'toolUseBlock' && block.name === 'strands_background_task_result'
  )
}

function persistedTasks(agent: Agent): BackgroundTask[] | undefined {
  return agent.appState.get(BACKGROUND_TASKS_STATE_KEY) as unknown as BackgroundTask[] | undefined
}

describe('BackgroundTasks', () => {
  it('dispatches selected calls through the normal tool pipeline and delivers their results', async () => {
    const work = tool({
      name: 'work',
      description: 'Perform work.',
      inputSchema: z.object({ value: z.string() }),
      callback: ({ value }) => `done:${value}`,
    })
    const model = new MockMessageModel()
      .addTurn({
        type: 'toolUseBlock',
        name: 'work',
        toolUseId: 'work-use',
        input: { value: 'background', _background_execution: true },
      })
      .addTurn({ type: 'textBlock', text: 'Tasks admitted.' })
      .addTurn({ type: 'textBlock', text: 'Result received.' })
    const agent = new Agent({
      model,
      tools: [work],
      backgroundTasks: { agentic: [work] },
      printer: false,
    })
    let toolSpecs: readonly ToolSpec[] | undefined
    let middlewareCalls = 0
    let retried = false
    agent.addMiddleware(InvokeModelStage, async function* (context, next) {
      toolSpecs ??= context.toolSpecs
      return yield* next(context)
    })
    agent.addHook(AfterToolCallEvent, (event) => {
      if (!retried) {
        retried = true
        event.retry = true
      }
    })
    agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
      middlewareCalls++
      return yield* next(context)
    })

    await agent.invoke('Run work.')

    expect(middlewareCalls).toBe(2)
    expect(toolSpecs?.find((spec) => spec.name === 'work')?.inputSchema?.properties).toHaveProperty(
      '_background_execution'
    )
    const [delivery] = deliveries(agent)
    expect(delivery).toEqual({
      type: 'toolUseBlock',
      name: 'strands_background_task_result',
      toolUseId: expect.any(String),
      input: { toolName: 'work' },
    })
    expect(agent.messages.flatMap((message) => message.content)).toContainEqual({
      type: 'toolResultBlock',
      toolUseId: delivery!.toolUseId,
      status: 'success',
      content: [{ type: 'textBlock', text: 'done:background' }],
    })
  })

  it('applies always and never policies per tool', async () => {
    const executions: string[] = []
    const seenInputs: unknown[] = []
    const background = tool({
      name: 'background',
      description: 'Run in the background.',
      inputSchema: z.object({}).passthrough(),
      callback: (input) => {
        seenInputs.push(input)
        executions.push('background')
      },
    })
    const foreground = tool({
      name: 'foreground',
      description: 'Run in the foreground.',
      inputSchema: z.object({}).passthrough(),
      callback: (input) => {
        seenInputs.push(input)
        executions.push('foreground')
      },
    })
    const incompatible = tool({
      name: 'summarize_context',
      description: 'Cannot run in the background.',
      inputSchema: z.object({}),
      callback: () => executions.push('incompatible'),
    })
    const model = new MockMessageModel()
      .addTurn([
        {
          type: 'toolUseBlock',
          name: 'foreground',
          toolUseId: 'background-use',
          input: { _background_execution: false },
        },
        {
          type: 'toolUseBlock',
          name: 'foreground',
          toolUseId: 'foreground-use',
          input: { _background_execution: true },
        },
        { type: 'toolUseBlock', name: 'foreground', toolUseId: 'incompatible-use', input: {} },
      ])
      .addTurn({ type: 'textBlock', text: 'Task admitted.' })
      .addTurn({ type: 'textBlock', text: 'Result received.' })
    const agent = new Agent({
      model,
      tools: [background, foreground],
      backgroundTasks: { always: [background, incompatible], never: ['*'] },
      printer: false,
    })
    let toolSpecs: readonly ToolSpec[] | undefined
    agent.addMiddleware(InvokeModelStage, async function* (context, next) {
      toolSpecs ??= context.toolSpecs
      return yield* next(context)
    })
    agent.addHook(BeforeToolCallEvent, (event) => {
      if (event.toolUse.toolUseId === 'background-use') event.toolUse.name = 'background'
      if (event.toolUse.toolUseId === 'incompatible-use') event.selectedTool = incompatible
    })

    await agent.invoke('Run both.')

    expect(executions.sort()).toEqual(['background', 'foreground'])
    expect(seenInputs).toEqual([{}, {}])
    expect(executions).not.toContain('incompatible')
    expect(deliveries(agent)).toEqual([
      {
        type: 'toolUseBlock',
        name: 'strands_background_task_result',
        toolUseId: expect.any(String),
        input: { toolName: 'background' },
      },
    ])
    for (const name of ['background', 'foreground']) {
      expect(toolSpecs?.find((spec) => spec.name === name)?.inputSchema?.properties).not.toHaveProperty(
        '_background_execution'
      )
    }
  })

  it('rejects conflicting tool policies', () => {
    const work = tool({
      name: 'work',
      description: 'Perform work.',
      inputSchema: z.object({}),
      callback: () => 'done',
    })

    expect(
      () =>
        new Agent({
          model: new MockMessageModel(),
          tools: [work],
          backgroundTasks: { always: [work], never: [work] },
        })
    ).toThrow("Tool 'work' cannot be configured as both 'always' and 'never'")
  })

  it('delivers work that finishes between invocations', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const work = tool({
      name: 'work',
      description: 'Perform deferred work.',
      inputSchema: z.object({}),
      callback: async () => {
        await released
        return 'done'
      },
    })
    const model = new MockMessageModel()
      .addTurn({
        type: 'toolUseBlock',
        name: 'work',
        toolUseId: 'work-use',
        input: { _background_execution: true },
      })
      .addTurn({ type: 'textBlock', text: 'Task admitted.' })
    const agent = new Agent({
      model,
      tools: [work],
      backgroundTasks: { waitForCompletion: false },
      printer: false,
    })

    await agent.invoke('Run work.')
    expect(deliveries(agent)).toEqual([])
    expect(() => agent.loadSnapshot(agent.takeSnapshot({ include: ['state'] }))).toThrow(
      'Cannot load a snapshot while background tasks are still tracked'
    )

    release()
    await expect
      .poll(() => persistedTasks(agent))
      .toEqual([
        {
          taskId: expect.any(String),
          toolUseId: 'work-use',
          toolName: 'work',
          status: 'completed',
          createdAt: expect.any(String),
          lastUpdatedAt: expect.any(String),
          result: { content: [{ text: 'done' }] },
        },
      ])
    const snapshot = agent.takeSnapshot({ preset: 'session' })
    const restored = new Agent({
      model: new MockMessageModel().addTurn({ type: 'textBlock', text: 'Result received.' }),
      tools: [],
      backgroundTasks: {},
      printer: false,
    })
    restored.loadSnapshot(snapshot)
    await restored.invoke('Continue.')

    expect(deliveries(restored)).toHaveLength(1)
    expect(persistedTasks(restored)).toBeUndefined()
  })

  it('fails interrupted work restored from appState', async () => {
    const createdAt = '2026-08-27T12:00:00.000Z'
    const source = new Agent({ model: new MockMessageModel(), tools: [], printer: false })
    const interrupt = new Interrupt({
      id: 'tool:working:approve',
      name: 'approve',
      reason: 'Approve restored work?',
      source: 'tool',
    })
    source.appState.set(BACKGROUND_TASKS_STATE_KEY, [
      {
        taskId: 'working',
        toolUseId: 'working-use',
        toolName: 'working-work',
        status: 'input_required',
        createdAt,
        lastUpdatedAt: createdAt,
        interrupts: [interrupt],
      },
    ])
    source._interruptState.registerInterrupt(interrupt)
    source._interruptState.activate()
    const snapshot = source.takeSnapshot({ preset: 'session' })
    const agent = new Agent({
      model: new MockMessageModel().addTurn({ type: 'textBlock', text: 'Results received.' }),
      tools: [],
      backgroundTasks: {},
      printer: false,
    })
    agent.addHook(InitializedEvent, () => agent.loadSnapshot(snapshot))

    await agent.initialize()

    expect(persistedTasks(agent)?.find((task) => task.taskId === 'working')).toEqual({
      taskId: 'working',
      toolUseId: 'working-use',
      toolName: 'working-work',
      status: 'failed',
      createdAt,
      lastUpdatedAt: expect.any(String),
      error: { type: 'executionError', message: expect.any(String) },
    })
    await expect(
      agent.tool.strands_manage_background_task!.invoke(
        { mode: 'cancel', taskId: 'working' },
        { recordDirectToolCall: false }
      )
    ).resolves.toEqual({
      type: 'toolResultBlock',
      toolUseId: expect.any(String),
      status: 'success',
      content: [{ type: 'jsonBlock', json: { taskId: 'working', status: 'failed' } }],
    })

    await agent.invoke('Continue.')

    expect(deliveries(agent)).toEqual([
      {
        type: 'toolUseBlock',
        name: 'strands_background_task_result',
        toolUseId: 'working',
        // Recovered from a snapshot: the delivering invocation is not the one that
        // dispatched the task, so the delivery carries provenance.
        input: { toolName: 'working-work', startedBy: 'an earlier request in this conversation' },
      },
    ])
  })

  it('surfaces and resumes interrupts from detached tools', async () => {
    let blockedStarted!: () => void
    const blockedToolStarted = new Promise<void>((resolve) => {
      blockedStarted = resolve
    })
    const approval = tool({
      name: 'approval',
      description: 'Wait for approval.',
      inputSchema: z.object({}),
      callback: () => 'approved',
    })
    const blocked = tool({
      name: 'blocked',
      description: 'Wait for release.',
      inputSchema: z.object({}),
      callback: async (_input, context) => {
        blockedStarted()
        await new Promise<void>((resolve) => {
          context!.cancelSignal.addEventListener('abort', () => resolve(), { once: true })
        })
        return 'cancelled'
      },
    })
    const model = new MockMessageModel()
      .addTurn([
        {
          type: 'toolUseBlock',
          name: 'approval',
          toolUseId: 'approval-use',
          input: { _background_execution: true },
        },
        {
          type: 'toolUseBlock',
          name: 'blocked',
          toolUseId: 'blocked-use',
          input: { _background_execution: true },
        },
      ])
      .addTurn({ type: 'textBlock', text: 'Task admitted.' })
      .addTurn({ type: 'textBlock', text: 'Task resumed.' })
      .addTurn({ type: 'textBlock', text: 'Result received.' })
    const agent = new Agent({ model, tools: [approval, blocked], backgroundTasks: {}, printer: false })
    let toolSpecs: readonly ToolSpec[] | undefined
    let response: string | undefined
    agent.addMiddleware(InvokeModelStage, async function* (context, next) {
      toolSpecs ??= context.toolSpecs
      return yield* next(context)
    })
    agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
      if (context.toolUse.name === 'approval') {
        response = context.interrupt<string>({ name: 'approve', reason: 'Approve work?' }).response
      }
      return yield* next(context)
    })

    const interrupted = await agent.invoke('Run approval.')
    expect(interrupted.stopReason).toBe('interrupt')
    expect(interrupted.interrupts).toEqual([
      {
        id: expect.any(String),
        name: 'approve',
        reason: 'Approve work?',
        source: 'middleware',
      },
    ])

    await blockedToolStarted
    expect(
      toolSpecs?.find((spec) => spec.name === 'strands_manage_background_task')?.inputSchema?.properties
    ).not.toHaveProperty('_background_execution')
    const blockedTask = persistedTasks(agent)?.find((task) => task.toolName === 'blocked')
    expect(blockedTask).toBeDefined()
    await expect(
      agent.tool.strands_manage_background_task!.invoke(
        { mode: 'get', taskId: blockedTask!.taskId },
        { recordDirectToolCall: false }
      )
    ).resolves.toEqual({
      type: 'toolResultBlock',
      toolUseId: expect.any(String),
      status: 'success',
      content: [
        {
          type: 'jsonBlock',
          json: {
            taskId: blockedTask!.taskId,
            toolUseId: 'blocked-use',
            toolName: 'blocked',
            status: 'working',
            createdAt: expect.any(String),
            lastUpdatedAt: expect.any(String),
          },
        },
      ],
    })
    await expect(
      agent.tool.strands_manage_background_task!.invoke(
        { mode: 'cancel', taskId: blockedTask!.taskId },
        { recordDirectToolCall: false }
      )
    ).resolves.toEqual({
      type: 'toolResultBlock',
      toolUseId: expect.any(String),
      status: 'success',
      content: [{ type: 'jsonBlock', json: { taskId: blockedTask!.taskId, status: 'cancelled' } }],
    })

    await agent.invoke([
      new InterruptResponseContent({
        interruptId: interrupted.interrupts![0]!.id,
        response: 'yes',
      }),
    ])

    expect(response).toBe('yes')
    expect(deliveries(agent)).toHaveLength(2)
  })
})
