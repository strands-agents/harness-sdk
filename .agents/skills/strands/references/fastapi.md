# Use Strands in FastAPI

## Install

```bash
pip install strands-agents "fastapi[standard]"
```

The default model provider is Amazon Bedrock. Configure AWS credentials or select
another supported model provider.

## Add a request endpoint

Create an agent for each concurrent request. An `Agent` owns mutable message history
and rejects overlapping invocations.

```python
from fastapi import FastAPI
from pydantic import BaseModel
from strands import Agent

app = FastAPI()


class AskRequest(BaseModel):
    prompt: str


def create_agent() -> Agent:
    return Agent(
        system_prompt="You are a helpful assistant.",
        callback_handler=None,
    )


@app.post("/ask")
async def ask(body: AskRequest):
    agent = create_agent()
    result = await agent.invoke_async(body.prompt)

    return {
        "response": str(result),
        "stopReason": result.stop_reason,
    }
```

Use `invoke_async` in async endpoints. The synchronous `agent(prompt)` call blocks
the event-loop worker.

For a multi-turn conversation, keep one agent per conversation and serialize access
to it, or restore the conversation into a new agent for each request. Do not share one
global agent across unrelated requests.

## Stream text with server-sent events

To stream text over server-sent events, iterate over `stream_async`. It yields
dictionaries whose text deltas use the `data` key and whose final event uses the
`result` key.

```python
import json
from threading import Event

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from strands import Agent

app = FastAPI()


class AskRequest(BaseModel):
    prompt: str


def create_agent() -> Agent:
    return Agent(
        system_prompt="You are a helpful assistant.",
        callback_handler=None,
    )


@app.post("/ask/stream")
async def ask_stream(body: AskRequest, request: Request):
    agent = create_agent()
    cancel_signal = Event()

    async def events():
        try:
            async for event in agent.stream_async(
                body.prompt,
                cancel_signal=cancel_signal,
            ):
                if await request.is_disconnected():
                    cancel_signal.set()
                    break

                text = event.get("data")
                if text:
                    yield f"data: {json.dumps({'text': text})}\n\n"

                result = event.get("result")
                if result:
                    payload = {"stopReason": result.stop_reason}
                    yield f"event: done\ndata: {json.dumps(payload)}\n\n"
        finally:
            cancel_signal.set()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )
```

The cancellation argument is a caller-owned `threading.Event`. Set it from client
disconnect, application timeout, or shutdown logic. A cancelled invocation returns a
result with `stop_reason="cancelled"`.

Run either application with:

```bash
fastapi dev main.py
```
