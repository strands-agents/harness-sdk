Strands Agents allows you to intercept and process events as they happen during agent execution using two methods:

-   **Async iterators**: ideal for asynchronous frameworks like FastAPI, aiohttp, or Django Channels. For these environments, the SDK offers the `stream_async` method which returns an asynchronous iterator.
-   **Callback handlers**: allow you to intercept and process events as they happen during agent execution. This enables real-time monitoring, custom output formatting, and integration with external systems.

In this example, we will show you how to use both methods to handle calls on your agent

## Agent Details

| Feature | Description |
| --- | --- |
| Feature used | async iterators, callback handlers |
| Agent Structure | single agent architecture |
| Native tools used | none |
| Custom tools created | calculator, Weather forecast |

## Architecture

![Streaming: Architecture diagram](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/04-streaming/images/architecture.png)

## Key Features

-   Async Iterators for Streaming
-   Callback Handlers

## Setup and prerequisites

### Prerequisites

-   Python 3.10+
-   AWS account
-   Anthropic Claude Sonnet 4.5 enabled on Amazon Bedrock

Let’s now install the required packages for our Strands Agent

```bash
# installing pre-requisites
pip install -r requirements.txt
```

### Importing dependency packages

Now let’s import the dependency packages

```python
import operator
from typing import Literal

import asyncio

import httpx
import uvicorn
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from strands import Agent, tool

_OPS = {
    "+": operator.add,
    "-": operator.sub,
    "*": operator.mul,
    "/": operator.truediv,
    "**": operator.pow,
}


@tool
def calculator(a: float, b: float, op: Literal["+", "-", "*", "/", "**"]) -> float:
    """Apply an arithmetic operator to two numbers.

    Args:
        a: Left operand.
        b: Right operand.
        op: One of "+", "-", "*", "/", "**".
    """
    return _OPS[op](a, b)
```

## Method 1 - Async Iterators for Streaming

Strands Agents provides support for asynchronous iterators through the `stream_async` method, enabling real-time streaming of agent responses in asynchronous environments like web servers, APIs, and other async applications.

Because notebooks run inside an active event loop, we can invoke our async function directly with `await` and iterate over the streamed events as they arrive.

### Creating and invoking agent with stream\_async

Let’s now create our agent with the calculator tool defined above and no `callback_handler`. We will use the `stream_async` method to iterate over the streamed agent events

```python
# Initialize our agent without a callback handler
agent = Agent(
    model="us.anthropic.claude-sonnet-4-5-20250929-v1:0",  # Optional: Specify the model ID
    tools=[calculator],
    callback_handler=None)

# Async function that iterates over streamed agent events


async def process_streaming_response():
    agent_stream = agent.stream_async("Calculate 2+2")
    async for event in agent_stream:
        print(event)


# Run the agent
await process_streaming_response()
```

### Tracking event loop lifecycle

This example illustrates the event loop lifecycle and how events relate to each other. It’s useful for understanding the flow of execution in the Strands Agent:

Let’s create some printing format code to better analyse the agent stream events. We will continue to use the same agent for it

```python
# Async function that iterates over streamed agent events


async def process_streaming_response():
    agent_stream = agent.stream_async("What is the capital of France and what is 42+7?")
    async for event in agent_stream:
        # Track event loop lifecycle
        if event.get("init_event_loop", False):
            print("🔄 Event loop initialized")
        elif event.get("start_event_loop", False):
            print("▶️ Event loop cycle starting")
        elif event.get("start", False):
            print("📝 New cycle started")
        elif "message" in event:
            print(f"📬 New message created: {event['message']['role']}")
        elif event.get("force_stop", False):
            print(
                f"🛑 Event loop force-stopped: {event.get('force_stop_reason', 'unknown reason')}"
            )

        # Track tool usage
        if "current_tool_use" in event and event["current_tool_use"].get("name"):
            tool_name = event["current_tool_use"]["name"]
            print(f"🔧 Using tool: {tool_name}")

        # Show only a snippet of text to keep output clean
        if "data" in event:
            # Only show first 20 chars of each chunk for demo purposes
            data_snippet = event["data"][:20] + (
                "..." if len(event["data"]) > 20 else ""
            )
            print(f"📟 Text: {data_snippet}")

    return event["result"]


# Run the agent
await process_streaming_response()
```

### FastAPI Integration

You can also integrate your `stream_async` with FastAPI to create a streaming endpoint to your applications. For this, we will add a `weather_forecast` tool to our agent. The architecture update looks as following

![Streaming: Architecture diagram 2](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/04-streaming/images/architecture_2.png)

```python
# Tool definition


@tool
def weather_forecast(city: str, days: int = 3) -> str:
    return f"Weather forecast for {city} for the next {days} days..."


# FastAPI app
app = FastAPI()


class PromptRequest(BaseModel):
    prompt: str


@app.post("/stream")
async def stream_response(request: PromptRequest):
    async def generate():
        agent = Agent(
            model="us.anthropic.claude-sonnet-4-5-20250929-v1:0",  # Specify the model ID; do not rely on the SDK default, which can reach end of life
            tools=[calculator, weather_forecast],
            callback_handler=None,
        )
        try:
            async for event in agent.stream_async(request.prompt):
                if "data" in event:
                    yield event["data"]
        except Exception as e:
            yield f"Error: {str(e)}"

    return StreamingResponse(generate(), media_type="text/plain")


# Function to start server without blocking


async def start_server():
    config = uvicorn.Config(app, host="0.0.0.0", port=8001, log_level="info")
    server = uvicorn.Server(config)
    await server.serve()


# Run server as background task
if "server_task" not in globals():
    server_task = asyncio.create_task(start_server())
    await asyncio.sleep(0.1)  # Give server time to start

print("✅ Server is running at http://0.0.0.0:8001")
```

#### Invoking the FastAPI agent

And we can now invoke the agent with a prompt

```python
async def fetch_stream():
    async with httpx.AsyncClient(timeout=httpx.Timeout(45.0)) as client:
        async with client.stream(
            "POST",
            "http://0.0.0.0:8001/stream",
            json={"prompt": "What is weather in NYC?"},
        ) as response:
            async for line in response.aiter_lines():
                if line.strip():  # Skip empty lines
                    print("Received:", line)


await fetch_stream()
```

## Method 2 - Callback Handlers for streaming

Callback handlers are a powerful feature of the Strands Agents that allow you to intercept and process events as they happen during agent execution. This enables real-time monitoring, custom output formatting, and integration with external systems.

Callback handlers receive events in real-time as they occur during an agent’s lifecycle:

-   Text generation from the model
-   Tool selection and execution
-   Reasoning process
-   Errors and completions

Let’s now create a custom callback handler function that formats the event inputs to highlight tool usage and model output. To do so, we will again use the agent with a calculator tool only

![Streaming: Architecture diagram](https://raw.githubusercontent.com/strands-agents/samples/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/04-streaming/images/architecture.png)

```python
def custom_callback_handler(**kwargs):
    # Process stream data
    if "data" in kwargs:
        print(f"MODEL OUTPUT: {kwargs['data']}")
    elif "current_tool_use" in kwargs and kwargs["current_tool_use"].get("name"):
        print(f"\nUSING TOOL: {kwargs['current_tool_use']['name']}")


# Create an agent with custom callback handler
agent = Agent(
        model="us.anthropic.claude-sonnet-4-5-20250929-v1:0",  # Optional: Specify the model ID
        tools=[calculator],
        callback_handler=custom_callback_handler)

agent("Calculate 2+2")
```

### Congratulations!

In this notebook you learned how to stream your agents outputs using async iterators and callback handlers.

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/04-streaming)
