Stream agent events as they happen and handle each one in your own async code. Async iterators are the streaming interface for asynchronous frameworks like FastAPI, aiohttp, and Express, where you control the flow of execution.

For every event the stream can emit, including text, tool usage, lifecycle, and reasoning events, see the [stream event types](/docs/user-guide/sdk/streaming/events/index.md#event-types) reference.

## Basic Usage

(( tab "Python" ))
Python uses the [`stream_async`](/docs/api/python/strands.agent.agent#Agent.stream_async), which is a streaming counterpart to the [`invoke_async`](/docs/api/python/strands.agent.agent#Agent.invoke_async) method, for asynchronous streaming. This is ideal for frameworks like FastAPI, aiohttp, or Django Channels.

> **Note**: Python also supports synchronous event handling via [callback handlers](/docs/user-guide/sdk/streaming/callback-handlers/index.md).

```python
import asyncio
from strands import Agent
from strands.vended_tools import notebook

# Initialize our agent without a callback handler
agent = Agent(
    tools=[notebook],
    callback_handler=None
)

# Async function that iterates over streamed agent events
async def process_streaming_response():
    agent_stream = agent.stream_async(
        'Create a notebook named "ideas" and add three project ideas.'
    )
    async for event in agent_stream:
        print(event)

# Run the agent
asyncio.run(process_streaming_response())
```
(( /tab "Python" ))

(( tab "TypeScript" ))
TypeScript uses the [`stream`](/docs/api/typescript/Agent/index.md) method for streaming, which is async by default. This is ideal for frameworks like Express.js or NestJS.

```typescript
// Initialize our agent without a printer
const agent = new Agent({
  tools: [notebook],
  printer: false,
})

// Async function that iterates over streamed agent events
async function processStreamingResponse(): Promise<void> {
  for await (const event of agent.stream('Record that my favorite color is blue!')) {
    console.log(event)
  }
}

// Run the agent
await processStreamingResponse()
```
(( /tab "TypeScript" ))

## Server examples

Here’s how to integrate streaming with web frameworks to create a streaming endpoint:

(( tab "Python - FastAPI" ))
```python
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from strands import Agent
from strands.vended_tools import notebook, http_request

app = FastAPI()

class PromptRequest(BaseModel):
    prompt: str

@app.post("/stream")
async def stream_response(request: PromptRequest):
    async def generate():
        agent = Agent(
            tools=[notebook, http_request],
            callback_handler=None
        )

        try:
            async for event in agent.stream_async(request.prompt):
                if "data" in event:
                    # Only stream text chunks to the client
                    yield event["data"]
        except Exception as e:
            yield f"Error: {str(e)}"

    return StreamingResponse(
        generate(),
        media_type="text/plain"
    )
```
(( /tab "Python - FastAPI" ))

(( tab "TypeScript - Express.js" ))
> **Note**: This is a conceptual example. Install Express.js with `npm install express @types/express` to use it in your project.

```typescript
// Install Express: npm install express @types/express

interface PromptRequest {
  prompt: string
}

async function handleStreamRequest(req: any, res: any) {
  console.log(`Got Request: ${JSON.stringify(req.body)}`)
  const { prompt } = req.body as PromptRequest

  res.setHeader('Content-Type', 'application/x-ndjson')

  const agent = new Agent({
    tools: [notebook],
    printer: false,
  })

  for await (const event of agent.stream(prompt)) {
    // Events automatically serialize to compact JSON via toJSON(),
    // keeping only relevant data fields. The full Agent instance,
    // Tool classes, and mutable hook flags (cancel/retry) are excluded.
    res.write(`${JSON.stringify(event)}\n`)
  }
  res.end()
}

const app = express()
app.use(express.json())
app.post('/stream', handleStreamRequest)
app.listen(3000)
```

You can then curl your local server with:

```bash
curl localhost:3000/stream -d '{"prompt": "Hello"}' -H "Content-Type: application/json"
```
(( /tab "TypeScript - Express.js" ))

### Agentic Loop

This processor prints each lifecycle event as it arrives, so you can watch the order the agent moves through its loop:

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import notebook

# Create agent with event loop tracker
agent = Agent(
    tools=[notebook],
    callback_handler=None
)

# Print the full event lifecycle to the console
async for event in agent.stream_async(
    'Create a notebook named "ideas" and add three project ideas.'
):
    # Track event loop lifecycle
    if event.get("init_event_loop", False):
        print("Event loop initialized")
    elif event.get("start_event_loop", False):
        print("Event loop cycle starting")
    elif "message" in event:
        print(f"New message created: {event['message']['role']}")
    elif "result" in event:
        print("Agent completed with result")
    elif event.get("force_stop", False):
        print(f"Event loop force-stopped: {event.get('force_stop_reason', 'unknown reason')}")

    # Track tool usage
    if "current_tool_use" in event and event["current_tool_use"].get("name"):
        tool_name = event["current_tool_use"]["name"]
        print(f"Using tool: {tool_name}")

    # Show the first 20 characters of each text chunk to keep output readable
    if "data" in event:
        data_snippet = event["data"][:20] + ("..." if len(event["data"]) > 20 else "")
        print(f"Text: {data_snippet}")
```

The output will show the sequence of events:

1.  First the event loop initializes (`init_event_loop`)
2.  Then the cycle begins (`start_event_loop`)
3.  New cycles may start multiple times during execution (`start_event_loop`)
4.  Text generation and tool usage events occur during the cycle
5.  Finally, the agent completes with a `result` event or may be force-stopped (`force_stop`)
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
function processEvent(event: AgentStreamEvent): void {
  // Track agent loop lifecycle
  switch (event.type) {
    case 'beforeInvocationEvent':
      console.log('Agent loop initialized')
      break
    case 'beforeModelCallEvent':
      console.log('Agent loop cycle starting')
      break
    case 'afterModelCallEvent':
      console.log(`New message created: ${event.stopData?.message.role}`)
      break
    case 'beforeToolsEvent':
      console.log('About to execute tool!')
      break
    case 'afterToolsEvent':
      console.log('Finished executing tool!')
      break
    case 'afterInvocationEvent':
      console.log('Agent loop completed')
      break
  }

  // Track tool usage
  if (
    event.type === 'modelStreamUpdateEvent' &&
    event.event.type === 'modelContentBlockStartEvent' &&
    event.event.start?.type === 'toolUseStart'
  ) {
    console.log(`\nUsing tool: ${event.event.start.name}`)
  }

  // Show text snippets
  if (
    event.type === 'modelStreamUpdateEvent' &&
    event.event.type === 'modelContentBlockDeltaEvent' &&
    event.event.delta.type === 'textDelta'
  ) {
    process.stdout.write(event.event.delta.text)
  }
}
const responseGenerator = agent.stream(
  'What is the capital of France and what is 42+7? Record in the notebook.'
)
for await (const event of responseGenerator) {
  processEvent(event)
}
```

The output will show the sequence of events:

1.  First the invocation starts (`beforeInvocationEvent`)
2.  Then the model is called (`beforeModelCallEvent`)
3.  The model generates content with delta events (wrapped in `modelStreamUpdateEvent`)
4.  Tools may be executed (`beforeToolsEvent`, `afterToolsEvent`)
5.  The model may be called again in subsequent cycles
6.  Finally, the invocation completes (`afterInvocationEvent`)
(( /tab "TypeScript" ))

## Streaming from sub-agents

This example combines [agents as tools](/docs/user-guide/sdk/multi-agent/agents-as-tools/index.md) and [tool streaming](/docs/user-guide/sdk/tools/custom-tools/index.md#tool-streaming) to stream events from a sub-agent:

(( tab "Python" ))
```python
from typing import AsyncIterator
from dataclasses import dataclass
from strands import Agent, tool
from strands.vended_tools import notebook

@dataclass
class SubAgentResult:
    agent: Agent
    event: dict

@tool
async def notes_agent(query: str) -> AsyncIterator:
    """Organize notes using the notebook tool."""
    agent = Agent(
        name="Notes Expert",
        system_prompt="Organize the user's information with the notebook tool.",
        callback_handler=None,
        tools=[notebook]
    )

    result = None
    async for event in agent.stream_async(query):
        yield SubAgentResult(agent=agent, event=event)
        if "result" in event:
            result = event["result"]

    yield str(result)

def process_sub_agent_events(event):
    """Shared processor for sub-agent streaming events"""
    tool_stream = event.get("tool_stream_event", {}).get("data")

    if isinstance(tool_stream, SubAgentResult):
        current_tool = tool_stream.event.get("current_tool_use", {})
        tool_name = current_tool.get("name")

        if tool_name:
            print(f"Agent '{tool_stream.agent.name}' using tool '{tool_name}'")

    # Also show regular text output
    if "data" in event:
        print(event["data"], end="")

# Using with async iterators
orchestrator_async_iterator = Agent(
    system_prompt="Route note-taking requests to the notes_agent tool.",
    callback_handler=None,
    tools=[notes_agent]
)


# With async-iterator
async for event in orchestrator_async_iterator.stream_async(
    'Create a notebook named "ideas" and add three project ideas.'
):
    process_sub_agent_events(event)


# With callback handler
def handle_events(**kwargs):
    process_sub_agent_events(kwargs)

orchestrator_callback = Agent(
    system_prompt="Route note-taking requests to the notes_agent tool.",
    callback_handler=handle_events,
    tools=[notes_agent]
)

orchestrator_callback('Add two more ideas to the "ideas" notebook.')
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// Create the math agent
const mathAgent = new Agent({
  systemPrompt: 'You are a math expert. Answer a math problem in one sentence',
  printer: false,
})

const calculator = tool({
  name: 'mathAgent',
  description: 'Agent that calculates the answer to a math problem input.',
  inputSchema: z.object({ input: z.string() }),
  callback: async function* (input): AsyncGenerator<string, string, unknown> {
    // Stream from the sub-agent
    const generator = mathAgent.stream(input.input)
    let result = await generator.next()
    while (!result.done) {
      // Process events from the sub-agent
      if (
        result.value.type === 'modelStreamUpdateEvent' &&
        result.value.event.type === 'modelContentBlockDeltaEvent' &&
        result.value.event.delta.type === 'textDelta'
      ) {
        yield result.value.event.delta.text
      }
      result = await generator.next()
    }
    return result.value.lastMessage.content[0]!.type === 'textBlock'
      ? result.value.lastMessage.content[0]!.text
      : result.value.lastMessage.content[0]!.toString()
  },
})

const agent = new Agent({ tools: [calculator] })
for await (const event of agent.stream('What is 2 * 3? Use your tool.')) {
  if (event.type === 'toolStreamUpdateEvent') {
    console.log(`Tool Event: ${JSON.stringify(event.event.data)}`)
  }
}
console.log('\nDone!')
```
(( /tab "TypeScript" ))

## Related pages

- [Callback Handlers](/docs/user-guide/sdk/streaming/callback-handlers/index.md) (1 shared tag)
- [Stream event types](/docs/user-guide/sdk/streaming/events/index.md) (1 shared tag)
- [Stream responses](/docs/user-guide/sdk/streaming/index.md) (1 shared tag)
- [Stream to the browser with SSE](/docs/user-guide/sdk/streaming/streaming-to-the-browser-guide/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/agent/agent.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py)
- [harness-sdk/strands-py/src/strands/event_loop/streaming.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/streaming.py)

### TypeScript

- [harness-sdk/strands-ts/src/agent/agent.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/agent/agent.ts)
- [harness-sdk/strands-ts/src/models/streaming.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/streaming.ts)
