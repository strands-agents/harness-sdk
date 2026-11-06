import { randomUUID } from 'node:crypto'
import { Agent } from '@strands-agents/sdk'
import type { AgentResult, AgentStreamEvent, ModelStreamEvent } from '@strands-agents/sdk'
import express, { type Request } from 'express'

// --8<-- [start:public_event_schema]
/** Public event schema, version 1. Your app owns this contract, not the SDK. */
export type PublicEvent =
  | { v: 1; type: 'text'; text: string }
  | { v: 1; type: 'redact'; text: string }
  | {
      v: 1
      type: 'tool'
      callId: number
      name: string
      status: 'started' | 'succeeded' | 'failed'
    }
  | {
      v: 1
      type: 'final'
      status: 'complete' | 'incomplete' | 'blocked' | 'cancelled' | 'error'
      stopReason?: string
      text: string
    }

/** What the browser receives: the event plus its position in the run. */
export type PublicEnvelope = PublicEvent & { id: number }
// --8<-- [end:public_event_schema]

// --8<-- [start:event_mapper]
/** Turns one Strands event into a public event, or drops it. */
export type EventMapper = (event: AgentStreamEvent) => PublicEvent | undefined

/**
 * Allowlist mapping. Every Strands event that is not listed here is dropped,
 * which covers reasoning, tool input, tool results, and lifecycle events.
 * Create one mapper per run: it numbers the run's tool calls.
 */
export function createEventMapper(): EventMapper {
  // Tools run concurrently, and a retried call repeats its toolUseId,
  // so each call gets a number of its own while it runs.
  const runningCalls = new Map<string, number>()
  let lastCallId = 0

  return (event) => {
    switch (event.type) {
      case 'modelStreamUpdateEvent':
        return fromModelEvent(event.event)
      case 'beforeToolCallEvent': {
        const callId = ++lastCallId
        runningCalls.set(event.toolUse.toolUseId, callId)
        return { v: 1, type: 'tool', callId, name: event.toolUse.name, status: 'started' }
      }
      case 'afterToolCallEvent': {
        const callId = runningCalls.get(event.toolUse.toolUseId) ?? ++lastCallId
        runningCalls.delete(event.toolUse.toolUseId)
        const status = event.result.status === 'success' ? 'succeeded' : 'failed'
        return { v: 1, type: 'tool', callId, name: event.toolUse.name, status }
      }
      default:
        return undefined
    }
  }
}

function fromModelEvent(event: ModelStreamEvent): PublicEvent | undefined {
  // A guardrail blocked the output: send the replacement, never the original.
  if (event.type === 'modelRedactionEvent') {
    const replacement = event.outputRedaction?.replaceContent
    if (replacement === undefined) return undefined
    return { v: 1, type: 'redact', text: replacement }
  }
  if (event.type !== 'modelContentBlockDeltaEvent') return undefined
  const { delta } = event
  if (delta.type === 'textDelta') return { v: 1, type: 'text', text: delta.text }
  // A cited answer arrives as citation deltas: keep the generated text, drop the sources.
  if (delta.type !== 'citationsDelta') return undefined
  const text = delta.content.map((content) => content.text).join('')
  return text ? { v: 1, type: 'text', text } : undefined
}

// The answer is done after these stop reasons, and blocked after these.
const COMPLETE_REASONS = new Set(['endTurn', 'stopSequence'])
const BLOCKED_REASONS = new Set(['guardrailIntervened', 'contentFiltered', 'refusal'])

/** The one authoritative final event, built from the agent result. */
export function toFinalEvent(result: AgentResult): PublicEvent {
  const { stopReason, lastMessage } = result
  if (stopReason === 'cancelled') {
    return { v: 1, type: 'final', status: 'cancelled', stopReason, text: '' }
  }
  // Read text and cited text only: toString() and toJSON() also include reasoning.
  const text = lastMessage.content
    .flatMap((block) => {
      if (block.type === 'textBlock') return [block.text]
      if (block.type === 'citationsBlock') return block.content.map((part) => part.text)
      return []
    })
    .join('')
  return { v: 1, type: 'final', status: finalStatus(stopReason), stopReason, text }
}

/** Limits, interrupts, and checkpoints stop a run before its answer is done. */
function finalStatus(stopReason: string): 'complete' | 'incomplete' | 'blocked' {
  if (COMPLETE_REASONS.has(stopReason)) return 'complete'
  if (BLOCKED_REASONS.has(stopReason)) return 'blocked'
  return 'incomplete'
}

/** Sent when the run throws. The error itself stays in the server log. */
export const errorFinalEvent: PublicEvent = {
  v: 1,
  type: 'final',
  status: 'error',
  text: '',
}
// --8<-- [end:event_mapper]

// --8<-- [start:agent_runs]
const BUFFER_SIZE = 500 // most recent events kept for replay
const GRACE_MS = 30_000 // cancel when nobody has listened for this long
const TTL_MS = 300_000 // forget the run this long after it ends

type Listener = (event: PublicEnvelope) => void

export class AgentRun {
  readonly id = randomUUID()
  finalEvent: PublicEnvelope | undefined
  private readonly buffer: PublicEnvelope[] = []
  private readonly listeners = new Set<Listener>()
  private readonly controller = new AbortController()
  private nextId = 1
  private graceTimer: NodeJS.Timeout | undefined

  constructor() {
    this.startGraceTimer()
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  push(event: PublicEvent): void {
    const envelope: PublicEnvelope = { id: this.nextId++, ...event }
    this.buffer.push(envelope)
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift()
    if (envelope.type === 'final') this.finalEvent = envelope
    for (const listener of this.listeners) listener(envelope)
  }

  /** Replays buffered events newer than `after`, then delivers live events. */
  subscribe(after: number, listener: Listener): () => void {
    clearTimeout(this.graceTimer)
    for (const event of this.buffer) {
      if (event.id > after) listener(event)
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && !this.finalEvent) this.startGraceTimer()
    }
  }

  cancel(): void {
    this.controller.abort()
  }

  private startGraceTimer(): void {
    clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(() => this.cancel(), GRACE_MS)
    this.graceTimer.unref()
  }
}

// globalThis keeps one registry across Next.js route bundles and dev reloads.
const registry = globalThis as typeof globalThis & { agentRuns?: Map<string, AgentRun> }
const runs = (registry.agentRuns ??= new Map<string, AgentRun>())

export function getRun(id: string): AgentRun | undefined {
  return runs.get(id)
}

export function startRun(prompt: string): AgentRun {
  const run = new AgentRun()
  runs.set(run.id, run)
  // One agent per run: an agent handles one invocation at a time.
  const agent = new Agent({
    systemPrompt: 'You are a helpful assistant.',
    printer: false,
  })
  void execute(run, agent, prompt).finally(() => {
    setTimeout(() => runs.delete(run.id), TTL_MS).unref()
  })
  return run
}

async function execute(run: AgentRun, agent: Agent, prompt: string): Promise<void> {
  const toPublicEvent = createEventMapper()
  let final = errorFinalEvent
  try {
    for await (const event of agent.stream(prompt, { cancelSignal: run.signal })) {
      if (event.type === 'agentResultEvent') {
        final = toFinalEvent(event.result)
        continue
      }
      const publicEvent = toPublicEvent(event)
      if (publicEvent) run.push(publicEvent)
    }
  } catch (error) {
    console.error(`run_id=<${run.id}>, error=<${String(error)}> | agent run failed`)
  }
  // Exactly one final event per run: on success, cancellation, and error.
  run.push(final)
}
// --8<-- [end:agent_runs]

function expressServer() {
  // --8<-- [start:express_sse]
  const app = express()
  app.use(express.json())
  // Serves public/index.html, the browser page of the complete example.
  app.use(express.static('public'))

  app.post('/runs', (req, res) => {
    const prompt = req.body?.prompt
    if (typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt must be a non-empty string' })
      return
    }
    res.status(201).json({ id: startRun(prompt).id })
  })

  // EventSource sends Last-Event-ID when it reconnects. A new connection sends ?after.
  function lastSeenId(req: Request): number {
    const id = Number(req.get('Last-Event-ID') ?? req.query.after ?? 0)
    return Number.isInteger(id) && id > 0 ? id : 0
  }

  // How far a client may fall behind before the server drops it.
  const MAX_PENDING_BYTES = 256 * 1024

  app.get('/runs/:id/events', (req, res) => {
    const run = getRun(req.params.id)
    if (!run) {
      res.sendStatus(404)
      return
    }
    const after = lastSeenId(req)
    if (run.finalEvent && after >= run.finalEvent.id) {
      // 204 tells EventSource to stop reconnecting.
      res.sendStatus(204)
      return
    }

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()
    res.write('retry: 3000\n\n')

    const open = () => !res.writableEnded && !res.destroyed
    const heartbeat = setInterval(() => {
      if (open()) res.write(': ping\n\n')
    }, 15_000)
    const unsubscribe = run.subscribe(after, (event) => {
      if (!open()) return
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)
      if (event.type === 'final') res.end()
      // Drop a client that stopped reading, so unsent events can't pile up.
      // EventSource reconnects with Last-Event-ID, and the buffer replays the rest.
      else if (res.writableLength > MAX_PENDING_BYTES) res.destroy()
    })
    // A dropped connection only unsubscribes. The run keeps going for a reconnect.
    res.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  app.listen(3000)
  // --8<-- [end:express_sse]

  // --8<-- [start:express_long_poll]
  app.get('/runs/:id/poll', (req, res) => {
    const run = getRun(req.params.id)
    if (!run) {
      res.sendStatus(404)
      return
    }
    const events: PublicEnvelope[] = []
    const stopWaiting = () => {
      clearTimeout(timeout)
      unsubscribe()
    }
    const respond = () => {
      stopWaiting()
      if (!res.headersSent) res.json({ events })
    }
    // Answer after the replayed batch or the first live event, or after 25 seconds.
    const unsubscribe = run.subscribe(lastSeenId(req), (event) => {
      if (events.push(event) === 1) queueMicrotask(respond)
    })
    const timeout = setTimeout(respond, 25_000)
    // The client went away: stop waiting, and write nothing to the closed connection.
    res.on('close', stopWaiting)
  })
  // --8<-- [end:express_long_poll]
}

function browserClient() {
  // --8<-- [start:browser_client]
  async function streamAnswer(prompt: string, answer: HTMLElement, status: HTMLElement) {
    const response = await fetch('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    const { id } = (await response.json()) as { id: string }

    let text = ''
    // Tools run concurrently, so track each running call by its callId.
    const runningTools = new Map<number, string>()
    const source = new EventSource(`/runs/${id}/events`)
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as PublicEnvelope
      // Skip schema versions and event types this client does not know.
      if (event.v !== 1) return
      switch (event.type) {
        case 'text':
          text += event.text
          answer.textContent = text
          break
        case 'redact':
          // A guardrail blocked the answer: replace everything shown so far.
          text = event.text
          answer.textContent = text
          break
        case 'tool': {
          if (event.status === 'started') runningTools.set(event.callId, event.name)
          else runningTools.delete(event.callId)
          const names = [...runningTools.values()].join(', ')
          status.textContent = names ? `Running ${names}` : ''
          break
        }
        case 'final':
          source.close()
          // The final event is authoritative: it replaces the streamed text.
          answer.textContent = event.text || `The run ended: ${event.status}.`
          status.textContent = ''
          break
      }
    }
  }
  // --8<-- [end:browser_client]
}
