import { getRun } from './streaming-to-the-browser-guide.js'
import type { AgentRun } from './streaming-to-the-browser-guide.js'
// --8<-- [start:nextjs_events_route]
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
// --8<-- [end:nextjs_events_route]
