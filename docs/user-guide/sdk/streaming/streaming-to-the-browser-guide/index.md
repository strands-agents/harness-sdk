Show your users the agent’s answer while the model is still generating it. A model produces its response token by token, and each tool call adds a pause before the next token. If your app waits for the final response, users stare at an empty screen and can’t tell whether the agent is working. Streaming each token, plus a status for each tool call, shows progress from the first moment. Users read along instead of waiting, and they can see the agent working.

This guide builds that stream with [server-sent events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events), from Express or the Next.js App Router. Each prompt starts a run, one agent invocation that the server tracks by ID. You define a public event schema that never carries reasoning or tool input. Every event in a run gets an ID the browser can resume from. Every run ends with one authoritative final message. The examples are TypeScript, but the pattern carries over to a Python server: a public schema, an allowlist, event IDs, and one final event.

Writing the agent’s events straight into the HTTP response breaks in two ways. A dropped connection loses the rest of the answer, and the browser receives every Strands event, reasoning and tool input included. Here the run outlives the connection, and the browser only receives the events you publish.

A run moves through five steps:

1.  The browser sends the prompt with `POST /runs`, and the server answers with the run ID.
2.  The browser opens an `EventSource` on `GET /runs/<id>/events`.
3.  The server turns each allowed Strands event into a numbered public event and sends it.
4.  If the connection drops, `EventSource` reconnects and reports the last ID it received. The server resends the events the browser missed.
5.  The run ends with one final event. The browser shows its text and closes the stream.

The complete example has four files. The sections below build them in order, and [Running the complete example](#running-the-complete-example) runs them:

-   `public-events.ts`: the event schema and the mapping from Strands events.
-   `agent-runs.ts`: runs, event IDs, and the replay buffer.
-   `server.ts`: the Express routes. In Next.js, two route handlers take its place.
-   `public/index.html`: a page that renders the stream in the browser.

You need:

-   Node.js 22 or later
-   An Express 5 app or a Next.js App Router project
-   Credentials for a [model provider](/docs/user-guide/sdk/model-providers/index.md). The default is Amazon Bedrock.

This page covers the transport and the wire format. To read stream events in your own server code, see [Async Iterators](/docs/user-guide/sdk/streaming/async-iterators/index.md). For every event the stream emits, see [Stream event types](/docs/user-guide/sdk/streaming/events/index.md).

## Choosing a transport for your use case

Choose by the direction your data flows, then by what the network between your server and the browser allows.

| Transport | Use it when | Trade-off |
| --- | --- | --- |
| SSE | The browser only listens | Data flows one way |
| WebSocket | The browser sends messages during a run | You write the reconnect logic |
| Long polling | A proxy buffers streaming responses | More requests, more latency |

Start with SSE. It runs over plain HTTP, works in Next.js route handlers, and the browser’s `EventSource` reconnects on its own and reports the last event it received. All three transports on this page carry the same events and IDs. A fallback changes how events travel, not how the client handles them.

## Defining the events the browser receives

Treat the events your browser receives as a contract your app owns. Forwarding Strands events as they are ties your UI to SDK internals and sends data the browser must never see.

Caution

Serializing Strands events with `JSON.stringify(event)` sends the model’s reasoning and the tool input to the browser. Model stream updates carry reasoning and tool input deltas, and tool call events carry the tool input. The agent result includes the full last message, reasoning blocks included. `AgentResult.toString()` includes reasoning text too.

This schema has four event types:

```typescript
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
```

Each type has one job:

-   `text` carries a piece of the model response.
-   `redact` replaces everything the browser shows, after a guardrail blocks the response.
-   `tool` reports one tool call by number, name, and status. It never carries the tool’s input or result. `callId` tells concurrent calls apart, even calls to the same tool.
-   `final` closes every run exactly once, with the status, the stop reason, and the full answer. The browser replaces the streamed text with it.

The final status says how the run ended:

-   `complete`: the model finished its answer.
-   `incomplete`: an [invocation limit](/docs/user-guide/sdk/agents/agent-loop/index.md#invocation-limits), an interrupt, or a checkpoint stopped the run early.
-   `blocked`: a guardrail blocked the response, or the model refused.
-   `cancelled`: the run was cancelled. A run that the [stop tool](/docs/user-guide/sdk/tools/vended-tools/stop/index.md) ends is `cancelled` too, and its text is the tool’s final message.
-   `error`: the run failed. A model that reaches its output token limit makes the SDK throw, so that run ends with `error`.

`stopReason` carries the exact Strands stop reason, such as `limitTurns` or `guardrailIntervened`.

Every event has `v: 1` and an `id` that counts up from 1 within the run. Clients ignore event types and fields they don’t recognize, so adding a field keeps the schema at version 1. A breaking change, such as renaming `text`, ships as `v: 2` alongside version 1 until no client depends on the old version.

A typical run of an agent with a weather tool streams events like these:

```text
id: 1
data: {"id":1,"v":1,"type":"text","text":"Let "}

...

id: 8
data: {"id":8,"v":1,"type":"tool","callId":1,"name":"get_weather","status":"started"}

id: 9
data: {"id":9,"v":1,"type":"tool","callId":1,"name":"get_weather","status":"succeeded"}

...

id: 52
data: {"id":52,"v":1,"type":"final","status":"complete","stopReason":"endTurn",
       "text":"It is 21 degrees and sunny in Lisbon right now."}
```

This example wraps the last event for readability. On the wire, each `data:` line holds one complete JSON object.

## Mapping Strands events to the schema

Map events with an allowlist: name the few Strands events the browser needs and drop everything else. New SDK events then never reach the browser by accident. Put the schema and the mapping in one module, `public-events.ts`:

```typescript
import type { AgentResult, AgentStreamEvent, ModelStreamEvent } from '@strands-agents/sdk'

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
  // Read text and cited text only: toString() and toJSON() also include reasoning.
  // A cancelled run keeps its text, such as the message of agent.cancel({ message }).
  const text = lastMessage.content
    .flatMap((block) => {
      if (block.type === 'textBlock') return [block.text]
      if (block.type === 'citationsBlock') return block.content.map((part) => part.text)
      return []
    })
    .join('')
  const status = stopReason === 'cancelled' ? 'cancelled' : finalStatus(stopReason)
  return { v: 1, type: 'final', status, stopReason, text }
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
```

| Strands event | Public event |
| --- | --- |
| `modelStreamUpdateEvent` with a `textDelta` | `text` |
| `modelStreamUpdateEvent` with a `citationsDelta` | `text`, without the sources |
| `modelStreamUpdateEvent` with an output `modelRedactionEvent` | `redact` |
| `modelStreamUpdateEvent` with any other event or delta | dropped |
| `beforeToolCallEvent` | `tool` with status `started` |
| `afterToolCallEvent` | `tool` with status `succeeded` or `failed` |
| `agentResultEvent` | `final`, built by `toFinalEvent()` |
| Any other event | dropped |

Create one mapper per run with `createEventMapper()`. It numbers the run’s tool calls itself: a provider’s `toolUseId` is not guaranteed to be unique within a run, and a retried call repeats it.

The final event reads the text and the cited text of the last message, which is the answer the agent keeps in `agent.messages`. Text the model streamed before calling a tool, such as “Let me check the weather”, is not part of it. A cancelled run keeps its last message too: the message passed to `agent.cancel({ message })`, such as the stop tool’s final message. When a cancel signal stops the run, as the grace period and the cancel route below do, the SDK sets that message to `Cancelled by user`.

Caution

Text events reach the browser as the model generates them, before an output guardrail assesses the whole response. When the guardrail blocks it, the `redact` event and the final event replace the text on screen, but the user may already have read it. If blocked output must never reach the browser, don’t publish `text` events for those runs, and show the answer from the final event only.

## Keeping a run alive across reconnects

Run the agent apart from any single HTTP request, so a browser that reconnects picks up the same run. `EventSource` only sends `GET` requests without a body, which fits a two-step flow: a `POST` starts the run, and a `GET` subscribes to its events. Put the run registry in `agent-runs.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import { Agent } from '@strands-agents/sdk'
import { createEventMapper, errorFinalEvent, toFinalEvent } from './public-events'
import type { PublicEnvelope, PublicEvent } from './public-events'

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
```

Each run creates its own agent, because an agent handles one invocation at a time. The run numbers every public event and keeps the latest 500 in a buffer. A subscriber passes the last ID it saw, receives everything newer from the buffer, and then gets live events.

The registry also decides what happens when the connection breaks:

-   A dropped connection only unsubscribes. After 30 seconds with no subscriber, the run requests cancellation through `cancelSignal`, and it ends with a final event with status `cancelled`. Cancellation is cooperative: the agent stops at its next check, and a running tool stops early only if it observes `context.cancelSignal`. See [Cancellation](/docs/user-guide/sdk/agents/agent-loop/index.md#cancellation) for where the agent checks.
-   `execute()` pushes the final event once, after the loop: from the agent result, or `errorFinalEvent` when the stream throws. Error details stay in the server log, because a model provider error can include account IDs and resource names.
-   A finished run stays for five minutes, so a late reconnect still gets the final event.
-   A subscriber that asks for an ID older than the buffer receives what the buffer still holds. IDs are sequential, so the client can spot the gap, and the final event still carries the complete answer.

Size the buffer for the longest disconnect you expect: about one event per streamed text chunk, plus two per tool call. To let the browser stop a run, add a route that calls `run.cancel()`; the final event then arrives with status `cancelled`.

## Streaming a run with server-sent events

Serve two routes: one that starts a run and returns its ID, and one that streams the run’s events in the SSE format. Both frameworks use the same `public-events.ts` and `agent-runs.ts`.

(( tab "Express" ))
Create `server.ts` with both routes:

```typescript
import express, { type Request } from 'express'
import { getRun, startRun } from './agent-runs'

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
```
(( /tab "Express" ))

(( tab "Next.js" ))
Put `public-events.ts` and `agent-runs.ts` in `lib/`. Create `app/api/runs/route.ts` to start runs:

```typescript
import { startRun } from '@/lib/agent-runs'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { prompt?: unknown } | null
  const prompt = body?.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) {
    const error = 'prompt must be a non-empty string'
    return Response.json({ error }, { status: 400 })
  }
  return Response.json({ id: startRun(prompt).id }, { status: 201 })
}
```

Create `app/api/runs/events/route.ts` to stream a run. The run ID travels as `?id=`:

```typescript
import { getRun } from '@/lib/agent-runs'
import type { AgentRun } from '@/lib/agent-runs'

export const runtime = 'nodejs'

const encoder = new TextEncoder()
// How far a client may fall behind before the route drops it.
const MAX_PENDING_BYTES = 256 * 1024

// EventSource sends Last-Event-ID when it reconnects. A new connection sends ?after.
function lastSeenId(req: Request, url: URL): number {
  const header = req.headers.get('last-event-id')
  const id = Number(header ?? url.searchParams.get('after') ?? 0)
  return Number.isInteger(id) && id > 0 ? id : 0
}

function eventStream(run: AgentRun, after: number): ReadableStream<Uint8Array> {
  let stop = () => {}
  const source: UnderlyingDefaultSource<Uint8Array> = {
    start(controller) {
      let unsubscribe = () => {}
      let stopped = false
      let closing = false
      // Close on the next microtask, once subscribe() has returned.
      const close = () => {
        closing = true
        queueMicrotask(() => {
          if (stopped) return
          stop()
          controller.close()
        })
      }
      const send = (chunk: string) => {
        if (closing) return
        controller.enqueue(encoder.encode(chunk))
        // Drop a client that stopped reading, so unsent events can't pile up.
        // EventSource reconnects with Last-Event-ID, and the buffer replays the rest.
        if ((controller.desiredSize ?? 0) <= 0) close()
      }
      const heartbeat = setInterval(() => send(': ping\n\n'), 15_000)
      stop = () => {
        stopped = true
        clearInterval(heartbeat)
        unsubscribe()
      }
      send('retry: 3000\n\n')
      unsubscribe = run.subscribe(after, (event) => {
        send(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)
        if (event.type === 'final') close()
      })
    },
    // The client went away: unsubscribe and keep the run going for a reconnect.
    cancel() {
      stop()
    },
  }
  // The queue counts unsent bytes, so desiredSize falls as the client falls behind.
  const queue = new ByteLengthQueuingStrategy({ highWaterMark: MAX_PENDING_BYTES })
  return new ReadableStream(source, queue)
}

export function GET(req: Request) {
  const url = new URL(req.url)
  const run = getRun(url.searchParams.get('id') ?? '')
  if (!run) return new Response(null, { status: 404 })
  const after = lastSeenId(req, url)
  if (run.finalEvent && after >= run.finalEvent.id) {
    // 204 tells EventSource to stop reconnecting.
    return new Response(null, { status: 204 })
  }
  return new Response(eventStream(run, after), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
```

Both handlers run on the Node.js runtime, because the SDK does not target the Edge runtime. The registry lives on `globalThis`, so both route handlers share it, including across reloads in `next dev`.

These handlers assume one long-lived Node.js process, such as `next start` on a server or in a container: `startRun()` keeps the agent running after the POST response, and both handlers read the same registry. For serverless deployments, see [Preparing for production](#preparing-for-production).
(( /tab "Next.js" ))

The events route follows the SSE format, plus a few rules that keep streams healthy:

-   Each message is an `id:` line and a `data:` line with the JSON event, then a blank line. `EventSource` sends the `id:` value back as `Last-Event-ID` when it reconnects.
-   `retry: 3000` sets the reconnect delay to three seconds.
-   A `: ping` comment every 15 seconds keeps proxies from closing an idle connection.
-   `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` stop caches and NGINX from buffering the stream.
-   A client that stops reading is dropped once 256 KiB of events wait for it, so a slow connection can’t pile up memory. `EventSource` reconnects with `Last-Event-ID`, and the buffer replays what it missed.
-   The server ends the response after the final event. If the browser reconnects anyway, a 204 response tells `EventSource` to stop.

Check the stream from a terminal before you build the UI:

```bash
RUN_ID=$(curl -s -X POST localhost:3000/runs -H 'Content-Type: application/json' \
  -d '{"prompt": "Tell me about agents in one sentence."}' \
  | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).id')

curl -N "localhost:3000/runs/${RUN_ID}/events"
curl -N -H 'Last-Event-ID: 5' "localhost:3000/runs/${RUN_ID}/events"
```

The first command keeps the run ID in `RUN_ID`. The last one replays the run from event 6. In Next.js, the paths are `/api/runs` and `/api/runs/events?id=${RUN_ID}`, quoted the same way.

## Reading the stream in the browser

Open an `EventSource` on the events route and handle each event by type. This function streams one answer into the page:

```typescript
import type { PublicEnvelope } from './public-events'

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
```

A few details keep the client correct and accessible:

-   Close the `EventSource` when the final event arrives. Otherwise it reconnects once and stops at the 204 response.
-   Track tool calls by `callId`. Tools run concurrently by default, so several calls can run at once, including two calls to the same tool.
-   Write the model response with `textContent`, not `innerHTML`, because the model response is untrusted input. If you render Markdown, sanitize the resulting HTML.
-   Make the status element an `aria-live="polite"` region, so screen readers announce tool activity.
-   `EventSource` sends `Last-Event-ID` only on its own reconnects. To resume after a page reload, keep the run ID, for example in `sessionStorage`, and open `/runs/<id>/events?after=0` to replay the buffer.

## Running the complete example

Put the four files in one Express project, start the server, and open the page in a browser.

Create the project and install the dependencies:

```bash
mkdir strands-sse && cd strands-sse
npm init -y && npm pkg set type=module
npm install @strands-agents/sdk express
npm install --save-dev tsx @types/express
```

Save the code from the sections above as `public-events.ts`, `agent-runs.ts`, and `server.ts`. Then create `public/index.html`. It runs the logic of `streamAnswer()` as plain JavaScript, so the page works without a build step:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Strands SSE example</title>
  </head>
  <body>
    <form id="ask">
      <label for="prompt">Ask the agent</label>
      <input id="prompt" required />
      <button>Send</button>
    </form>
    <p id="status" aria-live="polite"></p>
    <div id="answer"></div>
    <script type="module">
      const answer = document.querySelector('#answer')
      const status = document.querySelector('#status')

      document.querySelector('#ask').addEventListener('submit', async (submit) => {
        submit.preventDefault()
        const prompt = document.querySelector('#prompt').value
        const response = await fetch('/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        })
        const { id } = await response.json()

        let text = ''
        const runningTools = new Map()
        answer.textContent = ''
        const source = new EventSource(`/runs/${id}/events`)
        source.onmessage = (message) => {
          const event = JSON.parse(message.data)
          if (event.v !== 1) return
          if (event.type === 'text') {
            text += event.text
            answer.textContent = text
          } else if (event.type === 'redact') {
            text = event.text
            answer.textContent = text
          } else if (event.type === 'tool') {
            if (event.status === 'started') runningTools.set(event.callId, event.name)
            else runningTools.delete(event.callId)
            const names = [...runningTools.values()].join(', ')
            status.textContent = names ? `Running ${names}` : ''
          } else if (event.type === 'final') {
            source.close()
            answer.textContent = event.text || `The run ended: ${event.status}.`
            status.textContent = ''
          }
        }
      })
    </script>
  </body>
</html>
```

Start the server, then open `http://localhost:3000`:

```bash
npx tsx server.ts
```

Ask a question. The answer streams into the page, and the status line names each tool while it runs. When the run ends, the final event replaces the streamed text. To test a reconnect, take the run ID from the browser’s network panel and use the `curl` commands from the SSE section.

To run the example in Next.js, adapt it in an App Router project with `@strands-agents/sdk` installed, served by one long-lived Node.js process such as `next start`. Put `public-events.ts` and `agent-runs.ts` in `lib/`, and use the two route handlers from [Streaming a run with server-sent events](#streaming-a-run-with-server-sent-events) in place of `server.ts`. Render the page from a client component that runs the logic of `streamAnswer()`, with its URLs changed to `/api/runs` and `/api/runs/events?id=${id}`.

## Switching to a WebSocket for two-way messages

Switch to a WebSocket when the browser sends the server messages during a run, or when your app already keeps a socket open. For one-way streaming, SSE does the same job with less code.

Keep the same event schema and the same run registry. A WebSocket has no built-in reconnect, so after a drop the client opens a new socket and sends the last ID it saw. Three client messages cover a run:

```json
{ "type": "start", "prompt": "What is the weather in Lisbon?" }
{ "type": "reconnect", "runId": "3f2c9a1e", "after": 41 }
{ "type": "cancel", "runId": "3f2c9a1e" }
```

The server answers `start` and `reconnect` with the run’s events, tagged with the run ID:

```json
{ "runId": "3f2c9a1e", "id": 42, "v": 1, "type": "text", "text": "sunny" }
```

On the server, handle both messages with `run.subscribe(after, send)` from `agent-runs.ts`, where `send` writes each event to the socket. Apply the same limit as the SSE routes: close a socket whose `bufferedAmount` grows past it. Node.js has no built-in WebSocket server, so add a library such as `ws`. Next.js route handlers have no stable support for WebSocket upgrades, so run the WebSocket endpoint on a separate Node.js server, such as the Express app.

## Falling back to long polling

Fall back to long polling when something between your server and the browser buffers streaming responses. Events then arrive all at once, or the connection times out. Some corporate proxies and load balancers do this.

Long polling reuses the run registry. The browser asks for the events after the last ID it has. The server answers as soon as there is something new, or after 25 seconds with an empty list. Add this route to the Express app from the SSE section:

```typescript
import type { PublicEnvelope } from './public-events'

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
```

The browser calls `GET /runs/<id>/poll?after=<last id>` in a loop and stops at the final event. Each event goes to the same handler as the SSE client. Keep the wait shorter than the idle timeout of your proxies and load balancers. In Next.js, the same logic fits a route handler that returns `Response.json({ events })`.

## Preparing for production

Close the gaps the examples leave open before you ship. They keep every run in one process and skip authentication, so cover these points:

-   **Authenticate every route.** Tie each run to the user who started it, and check ownership on every events, poll, and cancel request. `EventSource` can’t set headers, so authenticate with cookies.
-   **Share runs across instances.** The registry lives in one process’s memory. Behind a load balancer, use sticky sessions or move the buffer to a shared store such as Redis Streams. There, `XADD` with `MAXLEN` bounds the buffer and `XREAD` resumes from an ID.
-   **Keep runs alive on serverless platforms.** `startRun()` keeps the agent running after the POST response, so it needs a process that outlives the request. A serverless function can be frozen or shut down once it responds, and a shared store doesn’t change that. For runs that fit within the function’s maximum duration, hand the run’s promise to Next.js [`after()`](https://nextjs.org/docs/app/api-reference/functions/after) or to your platform’s `waitUntil()`. For longer runs, queue the prompt and run the agent in a worker. Either way, publish the events to a shared store, because the events request can reach another instance.
-   **Keep streams unbuffered.** Exclude `text/event-stream` from compression middleware, and check that every proxy in the path passes the stream through.
-   **Serve over HTTP/2.** Over HTTP/1.1, a browser allows six connections per domain across all its tabs, and each `EventSource` holds one of them.
-   **Limit runs per user.** Each run holds an agent and up to 500 events in memory. Cap the number of concurrent runs and the prompt size.

## Next steps

Continue with these pages:

-   [Stream event types](/docs/user-guide/sdk/streaming/events/index.md): every event the Strands stream emits, including the ones this schema drops.
-   [Async Iterators](/docs/user-guide/sdk/streaming/async-iterators/index.md): consume the stream directly in server code.
-   [Session management](/docs/user-guide/sdk/agents/session-management/index.md): keep a conversation across runs.
-   [Deploy to production](/docs/user-guide/sdk/deploy/index.md): deployment options for the server.

## Related pages

- [Async Iterators for Streaming](/docs/user-guide/sdk/streaming/async-iterators/index.md) (1 shared tag)
- [Callback Handlers](/docs/user-guide/sdk/streaming/callback-handlers/index.md) (1 shared tag)
- [Stream event types](/docs/user-guide/sdk/streaming/events/index.md) (1 shared tag)
- [Stream responses](/docs/user-guide/sdk/streaming/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/hooks/events.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/hooks/events.ts)
- [harness-sdk/strands-ts/src/models/streaming.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/streaming.ts)
- [harness-sdk/strands-ts/src/types/agent.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/agent.ts)
