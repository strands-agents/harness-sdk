import {
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
  type SummarizeOptions,
  type SummarizeResult,
} from '@strands-agents/sdk'

export type ToolUse = [name: string, input: object]

export interface Reply {
  text?: string
  toolUses?: ToolUse[]
  reasoning?: string
  signature?: string
  /** Marks the reply to an auxiliary request the harness makes on this model: a context-manager summary. */
  summary?: boolean
}

type FixedStep = string | ToolUse[] | Reply

/** A text reply, tool uses, a full reply, or a function of the request's messages returning one of those. */
export type Step = FixedStep | ((messages: Message[]) => FixedStep)

/**
 * A real `Model` that replies with `steps` in order, one per request, and fails on a request the
 * script does not expect. A summary request must meet a `summary` step.
 */
export class ScriptedModel extends Model {
  private _config: BaseModelConfig
  private readonly _steps: Step[]
  private _next = 0
  private _previousInput = 0
  private _summarizing = false

  constructor(steps: Step[], { modelId = 'scripted' }: { modelId?: string } = {}) {
    super()
    this._steps = steps
    this._config = { modelId, contextWindowLimit: 200_000 }
  }

  updateConfig(modelConfig: BaseModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  getConfig(): BaseModelConfig {
    return this._config
  }

  assertExhausted(): void {
    if (this._next !== this._steps.length) {
      throw new Error(`${this.modelId}: only ${this._next} of the script's ${this._steps.length} steps were requested`)
    }
  }

  override async summarize(messages: Message[], options?: SummarizeOptions): Promise<SummarizeResult> {
    this._summarizing = true
    try {
      return await super.summarize(messages, options)
    } finally {
      this._summarizing = false
    }
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    const reply = this._nextReply(messages, this._summarizing)
    const offered = new Set(options?.toolSpecs?.map((spec) => spec.name))
    const unoffered = (reply.toolUses ?? []).map(([name]) => name).filter((name) => !offered.has(name))
    if (unoffered.length > 0) {
      throw new Error(`${this.modelId}: the script uses ${unoffered.join(', ')}, which the request does not offer`)
    }

    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    if (reply.reasoning !== undefined) {
      const signature = reply.signature ?? 'scripted-signature'
      yield { type: 'modelContentBlockStartEvent' }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: reply.reasoning } }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', signature } }
      yield { type: 'modelContentBlockStopEvent' }
    }
    if (reply.text !== undefined) {
      yield { type: 'modelContentBlockStartEvent' }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: reply.text } }
      yield { type: 'modelContentBlockStopEvent' }
    }
    for (const [index, [name, input]] of (reply.toolUses ?? []).entries()) {
      const toolUseId = `${this.modelId}-${this._next}-${index}`
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId } }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } }
      yield { type: 'modelContentBlockStopEvent' }
    }
    yield { type: 'modelMessageStopEvent', stopReason: reply.toolUses?.length ? 'toolUse' : 'endTurn' }

    // Usage is a pure function of the requests: the whole request counts as input, and whatever the
    // previous agent-loop request covered counts as read from cache.
    const inputTokens = await this.countTokens(messages, options)
    const outputTokens = Math.ceil(JSON.stringify(reply).length / 4)
    const cacheReadInputTokens = reply.summary ? 0 : Math.min(this._previousInput, inputTokens)
    if (!reply.summary) {
      this._previousInput = inputTokens
    }
    yield {
      type: 'modelMetadataEvent',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadInputTokens,
        cacheWriteInputTokens: inputTokens - cacheReadInputTokens,
      },
      metrics: { latencyMs: 0 },
    }
  }

  private _nextReply(messages: Message[], summarizing: boolean): Reply {
    const kind = summarizing ? 'summary request' : 'request'
    let step = this._steps[this._next]
    if (step === undefined) {
      throw new Error(`${this.modelId}: unexpected ${kind} after the script's ${this._steps.length} steps`)
    }
    this._next++
    if (typeof step === 'function') {
      step = step(messages)
    }
    const reply = typeof step === 'string' ? { text: step } : Array.isArray(step) ? { toolUses: step } : step
    if (Boolean(reply.summary) !== summarizing) {
      throw new Error(
        `${this.modelId}: step ${this._next} ${reply.summary ? 'is' : 'is not'} a summary, but got a ${kind}`
      )
    }
    return reply
  }
}
