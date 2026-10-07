import {
  AfterInvocationEvent,
  InterventionActions,
  InterventionHandler,
  Message,
  TextBlock,
  type BeforeModelCallEvent,
  type LocalAgent,
} from '@strands-agents/sdk'

export class LiveSteering extends InterventionHandler {
  readonly name = 'strands:user-message'

  private readonly _updates = new WeakMap<object, Array<{ prompt: string; onConsumed?: () => void }>>()
  private readonly _observed = new WeakSet<object>()
  constructor(private readonly _onAgentObserved?: (agent: LocalAgent) => (() => void) | undefined) {
    super()
  }

  enqueue(agent: LocalAgent, prompt: string, onConsumed?: () => void): boolean {
    const normalized = prompt.trim()
    if (!normalized) {
      return false
    }
    const updates = this._updates.get(agent) ?? []
    updates.push({ prompt: normalized, ...(onConsumed ? { onConsumed } : {}) })
    this._updates.set(agent, updates)
    return true
  }

  drain(agent: LocalAgent): string[] {
    const updates = this._take(agent)
    return updates.map((update) => update.prompt)
  }

  observeAgent(agent: LocalAgent): void {
    if (this._observed.has(agent)) {
      return
    }
    this._observed.add(agent)
    const closeObservedAgent = this._onAgentObserved?.(agent)
    agent.addHook(AfterInvocationEvent, (event) => {
      const updates = this._take(event.agent)
      if (updates.length > 0) {
        event.resume = updates.map((update) => update.prompt).join('\n\n')
        this._markConsumed(updates)
      }
      void Promise.resolve().then(() => {
        if (event.resume === undefined) {
          closeObservedAgent?.()
        }
      })
    })
  }

  override beforeModelCall(
    event: BeforeModelCallEvent
  ): ReturnType<typeof InterventionActions.transform | typeof InterventionActions.proceed> {
    return this._consume(event)
  }

  private _consume(
    event: BeforeModelCallEvent
  ): ReturnType<typeof InterventionActions.transform | typeof InterventionActions.proceed> {
    const updates = this._take(event.agent)
    if (updates.length === 0) {
      return InterventionActions.proceed()
    }
    const message = new Message({
      role: 'user',
      content: [new TextBlock(updates.map((update) => update.prompt).join('\n\n'))],
    })
    return InterventionActions.transform(
      () => {
        event.agent.messages.push(message)
        this._markConsumed(updates)
      },
      { reason: 'Additional user message' }
    )
  }

  private _take(agent: LocalAgent): Array<{ prompt: string; onConsumed?: () => void }> {
    const updates = this._updates.get(agent) ?? []
    this._updates.delete(agent)
    return updates
  }

  private _markConsumed(updates: Array<{ prompt: string; onConsumed?: () => void }>): void {
    for (const update of updates) {
      update.onConsumed?.()
    }
  }
}
