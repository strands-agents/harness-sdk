Stream an agent’s output as it happens instead of waiting for the final response: text tokens, tool calls, and lifecycle events, as they occur. This is what drives responsive user interfaces and real-time monitoring.

Strands emits the same set of events regardless of how you consume them; you choose the consumption model that fits your application. Async iterators suit asynchronous server frameworks, and callback handlers suit synchronous Python.

## Stream an agent’s response

[Async Iterators](async-iterators/index.md)Consume the event stream with async iterators, for async server frameworks like FastAPI and Express.

[Callback Handlers](callback-handlers/index.md)Intercept events with a callback function in synchronous Python.

[Stream event types](events/index.md)Reference for every event the stream emits: lifecycle, model, tool, and multi-agent.

[Stream to the browser with SSE](streaming-to-the-browser-guide/index.md)Send agent output to a browser from Express or Next.js, with a safe event schema and resumable streams.

## A running stream

The smallest real thing streaming does is print an agent’s answer token by token as the model produces it. Iterate over the stream and forward the text chunks:

(( tab "Python" ))
```python
import asyncio
from strands import Agent

agent = Agent(callback_handler=None)


async def main():
    async for event in agent.stream_async("Tell me about agents in one sentence."):
        if "data" in event:
            print(event["data"], end="", flush=True)


asyncio.run(main())
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const agent = new Agent({ tools: [notebook] })

for await (const event of agent.stream('Calculate 2+2')) {
  if (
    event.type === 'modelStreamUpdateEvent' &&
    event.event.type === 'modelContentBlockDeltaEvent' &&
    event.event.delta.type === 'textDelta'
  ) {
    // Print out the model text delta event data
    process.stdout.write(event.event.delta.text)
  }
}
console.log('\nDone!')
```
(( /tab "TypeScript" ))

Each `data` chunk is one piece of the model’s output. The [event reference](/docs/user-guide/sdk/streaming/events/index.md) lists everything else the stream carries: tool calls, lifecycle signals, and multi-agent coordination.

## Where to go next

New to streaming? Start with [Async Iterators](/docs/user-guide/sdk/streaming/async-iterators/index.md) to consume the stream in an async server, or [Callback Handlers](/docs/user-guide/sdk/streaming/callback-handlers/index.md) if your Python application is synchronous. Both receive the same events; the [event reference](/docs/user-guide/sdk/streaming/events/index.md) is the complete list of what you can react to.

To send the stream to a browser, see [Stream to the browser with SSE](/docs/user-guide/sdk/streaming/streaming-to-the-browser-guide/index.md).

## Related pages

- [Async Iterators for Streaming](/docs/user-guide/sdk/streaming/async-iterators/index.md) (1 shared tag)
- [Callback Handlers](/docs/user-guide/sdk/streaming/callback-handlers/index.md) (1 shared tag)
- [Stream event types](/docs/user-guide/sdk/streaming/events/index.md) (1 shared tag)
- [Stream to the browser with SSE](/docs/user-guide/sdk/streaming/streaming-to-the-browser-guide/index.md) (1 shared tag)
