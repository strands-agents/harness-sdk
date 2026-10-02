import {
  AfterInvocationEvent,
  InterventionActions,
  InterventionHandler,
  Message,
  TextBlock,
  type AfterModelCallEvent,
  type BeforeModelCallEvent,
  type LocalAgent,
} from '@strands-agents/sdk'

export class LiveSteering extends InterventionHandler {
  readonly name = 'strands:user-message'

  private readonly _updates = new WeakMap<object, string[]>()
  private readonly _observed = new WeakSet<object>()
  constructor(private readonly _onAgentObserved?: (agent: LocalAgent) => (() => void) | undefined) {
    super()
  }

  enqueue(agent: LocalAgent, prompt: string): boolean {
    const normalized = prompt.trim()
    if (!normalized) {
      return false
    }
    const updates = this._updates.get(agent) ?? []
    updates.push(normalized)
    this._updates.set(agent, updates)
    return true
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
        event.resume = updates.join('\n\n')
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

  override afterModelCall(
    event: AfterModelCallEvent
  ): ReturnType<typeof InterventionActions.transform | typeof InterventionActions.proceed> {
    return this._consume(event)
  }

  private _consume(
    event: BeforeModelCallEvent | AfterModelCallEvent
  ): ReturnType<typeof InterventionActions.transform | typeof InterventionActions.proceed> {
    const updates = this._take(event.agent)
    if (updates.length === 0) {
      return InterventionActions.proceed()
    }
    const message = new Message({
      role: 'user',
      content: [new TextBlock(updates.join('\n\n'))],
    })
    return InterventionActions.transform(
      () => {
        event.agent.messages.push(message)
        if (event.type === 'afterModelCallEvent') {
          event.retry = true
        }
      },
      { reason: 'Additional user message' }
    )
  }

  private _take(agent: LocalAgent): string[] {
    const updates = this._updates.get(agent) ?? []
    this._updates.delete(agent)
    return updates
  }
}
