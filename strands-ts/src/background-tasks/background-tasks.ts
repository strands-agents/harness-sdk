import { z } from 'zod'

import { continuations } from '../agent/continuation.js'
import { AgentAsTool } from '../agent/agent-as-tool.js'
import { AfterInvocationEvent, BeforeModelCallEvent, InitializedEvent } from '../hooks/events.js'
import { HookOrder } from '../hooks/types.js'
import { InterruptError } from '../interrupt.js'
import { logger } from '../logging/logger.js'
import { InvokeModelStage, type ExecuteToolContext } from '../middleware/index.js'
import type { Plugin } from '../plugins/plugin.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../tools/structured-output-tool.js'
import { tool } from '../tools/tool-factory.js'
import type { Tool, ToolContext } from '../tools/tool.js'
import type { ToolSpec } from '../tools/types.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock, toolResultContentFromData } from '../types/messages.js'

import { BackgroundTaskNotFoundError } from './errors.js'
import { InProcessTaskManager } from './in-process/manager.js'

import type { Agent } from '../agent/agent.js'
import type { ToolUseData } from '../hooks/events.js'
import type { InvocationState, LocalAgent } from '../types/agent.js'
import type { BackgroundTaskManager } from './manager.js'
import { isTaskStatusTerminal, type BackgroundTask, type BackgroundTasksConfig } from './types.js'

const BACKGROUND_TASKS_STATE_KEY = 'strands.backgroundTasks'
const BACKGROUND_PROPERTY = '_background_execution'
const MANAGE_TOOL_NAME = 'strands_manage_background_task'
const COMPOSITE_SCHEMA_KEYS = ['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'] as const
const FOREGROUND_TOOL_NAMES = new Set([
  MANAGE_TOOL_NAME,
  STRUCTURED_OUTPUT_TOOL_NAME,
  'summarize_context',
  'truncate_context',
  'pin_context',
])

/** @internal */
export class BackgroundTasks implements Plugin {
  readonly name = 'strands:background-tasks'

  private readonly _config: BackgroundTasksConfig
  private readonly _executeTool
  private readonly _policy: ReturnType<typeof resolvePolicy>
  private readonly _manageTool: Tool
  private readonly _tasks = new Map<string, BackgroundTask>()
  private _agent!: Agent
  private _manager!: BackgroundTaskManager

  constructor(
    config: BackgroundTasksConfig,
    executeTool: (
      tool: Tool,
      context: ToolContext,
      middlewareInterrupt: ExecuteToolContext['interrupt']
    ) => Promise<ToolResultBlock>
  ) {
    this._config = config
    this._executeTool = executeTool
    this._policy = resolvePolicy(config)
    this._manageTool = tool({
      name: MANAGE_TOOL_NAME,
      description:
        'List, inspect, or cancel background tasks. Completed results are delivered automatically; do not poll with this tool.',
      inputSchema: z.object({
        mode: z.enum(['list', 'get', 'cancel']).describe('Whether to list, inspect, or cancel background tasks.'),
        taskId: z
          .string()
          .min(1)
          .optional()
          .describe('The background task ID returned when the task was dispatched. Required for get and cancel.'),
      }),
      callback: async ({ mode, taskId }) => {
        if (mode === 'list') {
          return {
            tasks: [...this._tasks.values()].map(({ taskId, toolName, status }) => ({ taskId, toolName, status })),
          }
        }
        if (!taskId) throw new TypeError(`Task ID is required for mode '${mode}'`)
        const task = this._tasks.get(taskId)
        if (!task) throw new BackgroundTaskNotFoundError(taskId)
        if (mode === 'get') return task
        const cancelled = isTaskStatusTerminal(task.status) ? task : await this._manager.cancel(taskId)
        return { taskId: cancelled.taskId, status: cancelled.status }
      },
    })
  }

  getTools(): Tool[] {
    return [this._manageTool]
  }

  initAgent(agent: LocalAgent): void {
    this._agent = agent as Agent
    for (const tool of agent.toolRegistry.list()) {
      const policy = this._policyFor(tool)
      if (!policy?.exact || policy.mode === 'never') continue
      const toolName = tool.name
      if (!canExecuteInBackground(tool)) throw new TypeError(`Tool '${toolName}' cannot run in the background`)
      if (policy.mode === 'agentic' && !canSelectBackground(tool)) {
        throw new TypeError(`Tool '${toolName}' cannot use agentic background selection`)
      }
    }
    this._manager = new InProcessTaskManager(this._agent, this._executeTool, {
      ...(this._config.maxConcurrency !== undefined && { maxConcurrency: this._config.maxConcurrency }),
      ...(this._config.timeout !== undefined && { timeout: this._config.timeout }),
      onTaskUpdated: (task): void => {
        this._tasks.set(task.taskId, task)
        this._persistTasks()
      },
    })

    agent.addMiddleware(InvokeModelStage.Input, async (context) => ({
      ...context,
      toolSpecs: context.toolSpecs.map((spec) => {
        const tool = agent.toolRegistry.get(spec.name)
        const policy = this._policyFor(tool)
        if (policy?.mode !== 'agentic') return spec
        if (!canExecuteInBackground(tool)) {
          if (policy.exact) throw new TypeError(`Tool '${spec.name}' cannot use agentic background selection`)
          return spec
        }
        const transformed = addBackgroundSelection(spec)
        if (!transformed && policy.exact) {
          throw new TypeError(`Tool '${spec.name}' cannot use agentic background selection`)
        }
        return transformed ?? spec
      }),
    }))

    agent.addHook(BeforeModelCallEvent, (event) => this._beforeModelCall(event))
    agent.addHook(AfterInvocationEvent, (event) => this._afterInvocation(event))
    agent.addHook(InitializedEvent, () => this._loadAppState(), { order: HookOrder.SDK_LAST })
  }

  /**
   * Decides foreground vs background. Strips `_background_execution` from
   * `toolUse.input` so the real tool never sees the selection flag.
   *
   * @returns `true` to submit as background, a `ToolResultBlock` admission
   *   error, or `undefined` to run in the foreground.
   */
  routeToolCall(
    toolUse: ToolUseData,
    requestedTool: Tool | undefined,
    effectiveTool: Tool | undefined
  ): true | ToolResultBlock | undefined {
    let selected = false
    if (
      toolUse.input !== null &&
      typeof toolUse.input === 'object' &&
      !Array.isArray(toolUse.input) &&
      BACKGROUND_PROPERTY in toolUse.input
    ) {
      const { [BACKGROUND_PROPERTY]: value, ...input } = toolUse.input
      if (typeof value !== 'boolean') {
        return toolError(toolUse.toolUseId, `'${BACKGROUND_PROPERTY}' must be a boolean`)
      }
      if (this._policyFor(requestedTool)?.mode === 'agentic') selected = value
      toolUse.input = input
    }

    const policy = this._policyFor(effectiveTool)
    if (!policy || policy.mode === 'never') return
    if (!canExecuteInBackground(effectiveTool)) {
      return policy.exact
        ? toolError(toolUse.toolUseId, `Tool '${toolUse.name}' cannot run in the background`)
        : undefined
    }
    if (policy.mode === 'agentic' && !canSelectBackground(effectiveTool)) {
      return policy.exact
        ? toolError(toolUse.toolUseId, `Tool '${toolUse.name}' cannot use agentic background selection`)
        : undefined
    }
    return policy.mode === 'always' || selected ? true : undefined
  }

  async submitToolCall(
    toolUse: ToolUseData,
    invocationState: InvocationState,
    passId: string,
    tool: Tool
  ): Promise<ToolResultBlock> {
    if (this._agent.cancelSignal.aborted) return toolError(toolUse.toolUseId, 'Tool execution cancelled')

    try {
      const task = await this._manager.submit(toolUse, invocationState, passId, tool)
      return new ToolResultBlock({
        toolUseId: toolUse.toolUseId,
        status: 'success',
        content: [
          new TextBlock(
            [
              'Background task dispatched.',
              '',
              `Task ID: ${task.taskId}`,
              `Tool: ${task.toolName}`,
              `Status: ${task.status}`,
              '',
              'The task is running in the background. Continue without waiting or polling.',
              'The final result will be delivered automatically when the task completes.',
            ].join('\n')
          ),
        ],
      })
    } catch (error) {
      logger.warn(`error=<${error}> | background task admission failed`)
      return toolError(toolUse.toolUseId, 'Background task admission failed')
    }
  }

  assertToolCanRun(tool: Tool | undefined): void {
    const policy = this._policyFor(tool)
    if (!canExecuteInBackground(tool) || !policy || policy.mode === 'never') {
      throw new Error('Tool cannot run in the background')
    }
  }

  assertCanLoadSnapshot(): void {
    if (this._manager.hasTasks()) {
      throw new Error('Cannot load a snapshot while background tasks are still tracked')
    }
  }

  private async _beforeModelCall(event: BeforeModelCallEvent): Promise<void> {
    const interruptState = this._agent._interruptState
    const responses = interruptState.resumeResponses
    if (responses) {
      const inputTasks = (await this._manager.list()).filter((task) => task.status === 'input_required')
      const taskInterruptIds = new Set(
        inputTasks.flatMap((task) => task.interrupts?.map((interrupt) => interrupt.id) ?? [])
      )
      for (const task of inputTasks) {
        const interruptIds = new Set(task.interrupts?.map((interrupt) => interrupt.id))
        const taskResponses = responses
          .map((content) => content.interruptResponse)
          .filter((response) => interruptIds.has(response.interruptId))
        if (taskResponses.length > 0) await this._manager.resume(task.taskId, taskResponses)
      }
      if (Object.keys(interruptState.interrupts).every((id) => taskInterruptIds.has(id))) {
        interruptState.deactivate()
      }
    }

    const tasks = [...this._tasks.values()]
    const interrupts = tasks.flatMap((task) => (task.status === 'input_required' ? (task.interrupts ?? []) : []))
    if (interrupts.length > 0) throw new InterruptError([...interrupts])
    this._deliverReady(event, tasks)
  }

  private async _afterInvocation(event: AfterInvocationEvent): Promise<void> {
    const agent = event.agent as Agent
    if (agent._interruptState.activated) return
    let tasks = [...this._tasks.values()]
    while (
      this._config.waitForCompletion !== false &&
      !agent.cancelSignal.aborted &&
      !tasks.some((task) => task.status === 'input_required') &&
      tasks.some((task) => !isTaskStatusTerminal(task.status))
    ) {
      await this._awaitNextSettlement(tasks, agent.cancelSignal)
      tasks = [...this._tasks.values()]
    }
    if (tasks.some((task) => task.status === 'input_required')) {
      event.resume ??= []
      return
    }
    this._deliverReady(event, tasks)
  }

  /** Races pending-task settlement against invocation cancellation. */
  private async _awaitNextSettlement(tasks: readonly BackgroundTask[], cancelSignal: AbortSignal): Promise<void> {
    let abort: () => void
    const cancelled = new Promise<void>((resolve) => {
      abort = resolve
      if (cancelSignal.aborted) {
        resolve()
      } else {
        cancelSignal.addEventListener('abort', abort, { once: true })
      }
    })
    try {
      await Promise.race([
        cancelled,
        ...tasks.filter((task) => !isTaskStatusTerminal(task.status)).map((task) => this._manager.wait(task.taskId)),
      ])
    } finally {
      cancelSignal.removeEventListener('abort', abort!)
    }
  }

  private _deliverReady(event: BeforeModelCallEvent | AfterInvocationEvent, tasks: readonly BackgroundTask[]): void {
    const terminalTasks = tasks.filter((task) => isTaskStatusTerminal(task.status))
    if (terminalTasks.length === 0) return

    const taskIds = terminalTasks.map((task) => task.taskId)
    continuations.addInput(event, {
      args: terminalTasks.flatMap((task) => {
        const content = task.result?.content.map(toolResultContentFromData) ?? [
          new TextBlock(task.error?.message ?? 'Background task cancelled'),
        ]
        return [
          new Message({
            role: 'assistant',
            content: [
              new ToolUseBlock({
                name: 'strands_background_task_result',
                toolUseId: task.taskId,
                input: { toolName: task.toolName },
              }),
            ],
          }),
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: task.taskId,
                status: task.status === 'completed' ? 'success' : 'error',
                content,
              }),
            ],
          }),
        ]
      }),
      onAppended: async () => {
        const liveTaskIds = new Set((await this._manager.list()).map((task) => task.taskId))
        const managerTaskIds = taskIds.filter((taskId) => liveTaskIds.has(taskId))
        await this._manager.remove(managerTaskIds)
        for (const taskId of taskIds) this._tasks.delete(taskId)
        this._persistTasks()
      },
    })
  }

  _loadAppState(): void {
    this._tasks.clear()
    const storedTasks =
      (this._agent.appState.get(BACKGROUND_TASKS_STATE_KEY) as unknown as BackgroundTask[] | undefined) ?? []
    const recoveredInterruptIds = new Set<string>()
    for (const task of storedTasks) {
      if (!isTaskStatusTerminal(task.status)) {
        for (const interrupt of task.interrupts ?? []) recoveredInterruptIds.add(interrupt.id)
      }
      this._tasks.set(task.taskId, recoverTask(task))
    }
    for (const interruptId of recoveredInterruptIds) delete this._agent._interruptState.interrupts[interruptId]
    if (this._agent._interruptState.activated && this._agent._interruptState.getInterruptsList().length === 0) {
      this._agent._interruptState.deactivate()
    }
    this._persistTasks()
  }

  private _persistTasks(): void {
    if (this._tasks.size === 0) {
      this._agent.appState.delete(BACKGROUND_TASKS_STATE_KEY)
      return
    }
    this._agent.appState.set(BACKGROUND_TASKS_STATE_KEY, [...this._tasks.values()])
  }

  private _policyFor(
    tool: Tool | undefined
  ): { readonly mode: 'never' | 'agentic' | 'always'; readonly exact: boolean } | undefined {
    if (!tool) return undefined
    const exact = this._policy.get(tool.name)
    if (exact) return { mode: exact, exact: true }
    const wildcard = this._policy.get('*')
    return wildcard ? { mode: wildcard, exact: false } : undefined
  }
}

function toolError(toolUseId: string, message: string): ToolResultBlock {
  return new ToolResultBlock({
    toolUseId,
    status: 'error',
    content: [new TextBlock(message)],
    error: new Error(message),
  })
}

function canExecuteInBackground(tool: Tool | undefined): tool is Tool {
  return tool !== undefined && !FOREGROUND_TOOL_NAMES.has(tool.name) && !(tool instanceof AgentAsTool && tool.delegate)
}

function canSelectBackground(tool: Tool): boolean {
  return addBackgroundSelection(tool.toolSpec) !== undefined
}

function addBackgroundSelection(toolSpec: ToolSpec): ToolSpec | undefined {
  const schema = toolSpec.inputSchema ?? {}
  if (
    COMPOSITE_SCHEMA_KEYS.some((key) => schema[key] !== undefined) ||
    (schema.type !== undefined && schema.type !== 'object') ||
    (schema.properties !== undefined && (typeof schema.properties !== 'object' || Array.isArray(schema.properties))) ||
    schema.properties?.[BACKGROUND_PROPERTY] !== undefined ||
    schema.required?.includes(BACKGROUND_PROPERTY)
  ) {
    return
  }
  return {
    ...toolSpec,
    inputSchema: {
      ...schema,
      type: 'object',
      properties: {
        ...schema.properties,
        [BACKGROUND_PROPERTY]: {
          type: 'boolean',
          description: 'Run this tool in the background and continue without waiting for its result.',
        },
      },
    },
  }
}

function resolvePolicy(config: BackgroundTasksConfig): ReadonlyMap<string, 'never' | 'agentic' | 'always'> {
  const hasExplicitWildcard = config.always?.includes('*') || config.never?.includes('*')
  const assignments = [
    ['agentic', config.agentic ?? (hasExplicitWildcard ? [] : ['*'])],
    ['always', config.always ?? []],
    ['never', config.never ?? []],
  ] as const
  const policy = new Map<string, 'never' | 'agentic' | 'always'>()

  for (const [mode, selectors] of assignments) {
    for (const selector of selectors) {
      const name = typeof selector === 'string' ? selector : selector.name
      const existing = policy.get(name)
      if (existing && existing !== mode) {
        throw new TypeError(`Tool '${name}' cannot be configured as both '${existing}' and '${mode}'`)
      }
      policy.set(name, mode)
    }
  }

  return policy
}

function recoverTask(task: BackgroundTask): BackgroundTask {
  if (!isTaskStatusTerminal(task.status)) {
    const { interrupts: _interrupts, ...persisted } = task
    return {
      ...persisted,
      status: 'failed',
      lastUpdatedAt: new Date().toISOString(),
      error: { type: 'executionError', message: 'Background task cannot resume after restoring persisted state' },
    }
  }
  return task
}
