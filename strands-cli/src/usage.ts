import {
  AfterModelCallEvent,
  AfterToolCallEvent,
  BeforeInvocationEvent,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  HookOrder,
  ModelStreamUpdateEvent,
  ToolStreamUpdateEvent,
  type Agent,
  type AgentResult,
  type AgentStreamEvent,
  type LocalAgent,
  type Model,
  type Usage,
} from '@strands-agents/sdk'

export interface NormalizedUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  /** Pending tool calls make this a partial snapshot, not a final spend total. */
  incomplete?: boolean
}

type UsageEvent =
  | BeforeInvocationEvent
  | BeforeModelCallEvent
  | ModelStreamUpdateEvent
  | AfterModelCallEvent
  | BeforeToolCallEvent
  | AfterToolCallEvent
  | ToolStreamUpdateEvent

const agentUsage = new WeakMap<LocalAgent, RunUsage>()
const invocationUsage = new WeakMap<object, RunUsage>()
const watchedAgents = new WeakSet<LocalAgent>()

// Shared callbacks retain no agents or runs; invocation state keeps late work with its originating run.
function observeUsage(event: UsageEvent): void {
  const usage =
    invocationUsage.get(event.invocationState) ??
    (event instanceof BeforeInvocationEvent ? agentUsage.get(event.agent) : undefined)
  usage?.observe(event)
}

function watchAgent(agent: LocalAgent): void {
  if (watchedAgents.has(agent)) {
    return
  }
  watchedAgents.add(agent)
  for (const eventType of [
    BeforeInvocationEvent,
    BeforeModelCallEvent,
    ModelStreamUpdateEvent,
    AfterModelCallEvent,
    BeforeToolCallEvent,
    AfterToolCallEvent,
    ToolStreamUpdateEvent,
  ]) {
    agent.addHook<UsageEvent>(eventType, observeUsage, {
      // Completion must see retry decisions before releasing a background tool.
      order: eventType === AfterToolCallEvent ? Infinity : HookOrder.SDK_FIRST,
    })
  }
}

/** Each agent's last metadata snapshot describes one model call, not a token delta. */
export class RunUsage {
  private readonly _pending = new WeakMap<object, Usage>()
  private readonly _seen = new WeakSet<object>()
  private readonly _tools = new WeakMap<LocalAgent, Set<string>>()
  private readonly _completionListeners = new Set<(usage: NormalizedUsage | undefined) => void>()
  private _pendingTools = 0
  private _total: NormalizedUsage | undefined

  static start(agent: Agent): RunUsage {
    const usage = new RunUsage()
    agentUsage.set(agent, usage)
    watchAgent(agent)
    return usage
  }

  observe(event: unknown): void {
    if (event instanceof ToolStreamUpdateEvent) {
      this.observe(event.event.data)
      return
    }
    if (
      !(
        event instanceof BeforeInvocationEvent ||
        event instanceof BeforeModelCallEvent ||
        event instanceof ModelStreamUpdateEvent ||
        event instanceof AfterModelCallEvent ||
        event instanceof BeforeToolCallEvent ||
        event instanceof AfterToolCallEvent
      ) ||
      this._seen.has(event)
    ) {
      return
    }
    this._seen.add(event)
    if (event instanceof BeforeInvocationEvent) {
      invocationUsage.set(event.invocationState, this)
      if (agentUsage.get(event.agent) === this) {
        agentUsage.delete(event.agent)
      }
      watchAgent(event.agent)
    } else if (event instanceof BeforeToolCallEvent) {
      let tools = this._tools.get(event.agent)
      if (!tools) {
        tools = new Set()
        this._tools.set(event.agent, tools)
      }
      if (!tools.has(event.toolUse.toolUseId)) {
        tools.add(event.toolUse.toolUseId)
        this._pendingTools++
      }
    } else if (event instanceof AfterToolCallEvent) {
      if (event.retry !== true && this._tools.get(event.agent)?.delete(event.toolUse.toolUseId)) {
        this._pendingTools--
        if (this._pendingTools === 0) {
          const listeners = [...this._completionListeners]
          this._completionListeners.clear()
          for (const listener of listeners) {
            listener(this.total())
          }
        }
      }
    } else if (event instanceof BeforeModelCallEvent) {
      this._pending.delete(event.agent)
    } else if (event instanceof ModelStreamUpdateEvent && event.event.type === 'modelMetadataEvent') {
      if (event.event.usage) {
        this._pending.set(event.agent, event.event.usage)
      }
    } else if (event instanceof AfterModelCallEvent) {
      const usage = event.stopData?.message.metadata?.usage ?? this._pending.get(event.agent)
      this._pending.delete(event.agent)
      if (usage) {
        const normalized = normalizeUsage(event.model, usage)
        const previous = this._total
        this._total = previous
          ? {
              totalTokens: previous.totalTokens + normalized.totalTokens,
              ...(previous.inputTokens !== undefined && normalized.inputTokens !== undefined
                ? { inputTokens: previous.inputTokens + normalized.inputTokens }
                : {}),
              ...(previous.outputTokens !== undefined && normalized.outputTokens !== undefined
                ? { outputTokens: previous.outputTokens + normalized.outputTokens }
                : {}),
              cacheReadInputTokens: (previous.cacheReadInputTokens ?? 0) + (normalized.cacheReadInputTokens ?? 0),
              cacheWriteInputTokens: (previous.cacheWriteInputTokens ?? 0) + (normalized.cacheWriteInputTokens ?? 0),
            }
          : normalized
      }
    }
  }

  total(): NormalizedUsage | undefined {
    if (this._pendingTools > 0) {
      return { totalTokens: 0, ...this._total, incomplete: true }
    }
    return this._total ? { ...this._total } : undefined
  }

  onComplete(listener: (usage: NormalizedUsage | undefined) => void): () => void {
    if (this._pendingTools === 0) {
      listener(this.total())
    } else {
      this._completionListeners.add(listener)
    }
    return () => {
      this._completionListeners.delete(listener)
    }
  }
}

export function latestRootModelUsage(agent: Agent, event: AgentStreamEvent): Usage | undefined {
  const rootEvent = !('agent' in event) || event.agent === agent
  if (!rootEvent || event.type !== 'modelStreamUpdateEvent' || event.event.type !== 'modelMetadataEvent') {
    return undefined
  }
  return event.event.usage
}

export function latestResultModelUsage(result: AgentResult): Usage | undefined {
  const usage = result.metrics?.latestAgentInvocation?.cycles?.at(-1)?.usage
  if (!usage) {
    return undefined
  }
  const hasUsage =
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.totalTokens > 0 ||
    (usage.cacheReadInputTokens ?? 0) > 0 ||
    (usage.cacheWriteInputTokens ?? 0) > 0
  return hasUsage ? usage : undefined
}

export function normalizeUsage(model: Model | undefined, usage: Usage): NormalizedUsage {
  const reportedInput = usage.inputTokens
  const outputTokens = usage.outputTokens
  const cacheReadInputTokens = usage.cacheReadInputTokens ?? 0
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0
  const reportedTotal = usage.totalTokens
  const inputFromTotal = Math.max(0, reportedTotal - outputTokens)
  const cacheInputTokens = cacheReadInputTokens + cacheWriteInputTokens

  const common = {
    totalTokens: Math.max(reportedTotal, reportedInput + outputTokens),
    ...(usage.cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
  }

  // The pinned SDK preserves Gemini's provider total but discards the raw buckets
  // needed to distinguish tool-use prompt tokens from generated output.
  const modelName = model?.constructor.name
  if (modelName === 'GoogleModel') {
    return common
  }

  let inputTokens = Math.max(reportedInput, inputFromTotal, cacheInputTokens)
  if (modelName === 'AnthropicModel' || modelName === 'BedrockModel') {
    inputTokens = Math.max(inputTokens, reportedInput + cacheInputTokens)
  }

  return {
    inputTokens,
    outputTokens,
    ...common,
    totalTokens: Math.max(common.totalTokens, inputTokens + outputTokens),
  }
}
