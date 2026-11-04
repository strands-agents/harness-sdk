Give `BidiAgent` tools to look up information, call services, or take actions during a conversation. You define them as you would for `Agent`, and the model decides when to call them.

Tool execution runs alongside the conversation. Users can keep talking while tools work, and results can arrive during a later response.

Note

`BidiAgent` does not yet support [tool interrupts](/docs/user-guide/sdk/bidi/interrupts/index.md).

## Register tools

Pass tools to `BidiAgent(tools=...)`. This timer uses `asyncio.sleep()` to wait without blocking the conversation:

```python
import asyncio

from strands import tool
from strands.bidi.agent import BidiAgent


@tool
async def set_timer(seconds: int) -> str:
    """Start a timer and report when it finishes.

    Args:
        seconds: Number of seconds to wait.
    """
    await asyncio.sleep(seconds)
    return f"Your {seconds}-second timer has finished."


agent = BidiAgent(tools=[set_timer])
```

During a conversation, the model can call this tool when you ask for a timer. You can continue asking questions while it waits.

For tool descriptions, input schemas, and other ways to define tools, see [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md). You can also use [MCP tools](/docs/user-guide/sdk/tools/mcp-tools/index.md). Keep the client open with its context manager while the agent runs, and pass `client.list_tools_sync()` as `tools`.

## Concurrent execution

When the model requests multiple tools together, they run concurrently as a group. The agent sends their results to the model once every tool in the group finishes.

The conversation can continue while tools run, and the model can request more tools. Each new group runs independently, so it can return results before an earlier group finishes. Running tools also continue through [barge-in](/docs/user-guide/sdk/bidi/events/index.md#barge-in-1).

To keep the conversation responsive, use asynchronous I/O in `async def` tools, as the timer does with `asyncio.sleep()`. The `@tool` decorator runs synchronous functions in worker threads.

## End a conversation

Tools can also control when a conversation ends. Here, `end_conversation` uses `ToolContext` to call [`cancel()`](/docs/api/python/strands.bidi.agent#strands.bidi.agent.BidiAgent.cancel) when the user asks to stop:

```python
from strands import ToolContext, tool
from strands.bidi.agent import BidiAgent


@tool(context=True)
def end_conversation(tool_context: ToolContext[BidiAgent]) -> str:
    """End the conversation when the user asks to stop or says goodbye."""
    tool_context.agent.cancel()
    return "Ending conversation."


agent = BidiAgent(tools=[end_conversation])
```

The docstring becomes the tool description that helps the model decide when to call it. Customize it with example phrases or the kinds of requests you want the model to recognize.

When the model calls the tool, cancellation takes effect after the tool’s group finishes and its results are recorded.

See the [quickstart](/docs/user-guide/sdk/bidi/quickstart/index.md#end-the-conversation-by-voice) for a complete example using this tool with `agent.run()`.

## Related pages

- [BidiAgent](/docs/user-guide/sdk/bidi/agent/index.md) (1 shared tag)
- [Bidirectional Streaming](/docs/user-guide/sdk/bidi/index.md) (1 shared tag)
- [Bidirectional Streaming Models](/docs/user-guide/sdk/bidi/models/index.md) (1 shared tag)
- [Google Gemini Live](/docs/user-guide/sdk/bidi/models/google/index.md) (1 shared tag)
- [I/O Streams](/docs/user-guide/sdk/bidi/io/index.md) (1 shared tag)
- [Input Content](/docs/user-guide/sdk/bidi/content/index.md) (1 shared tag)
- [Interrupts](/docs/user-guide/sdk/bidi/interrupts/index.md) (1 shared tag)
- [OpenAI Live](/docs/user-guide/sdk/bidi/models/openai/live/index.md) (1 shared tag)
- [OpenAI Realtime](/docs/user-guide/sdk/bidi/models/openai/realtime/index.md) (1 shared tag)
- [Stream Events](/docs/user-guide/sdk/bidi/events/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/bidi/agent/agent.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py)
- [harness-sdk/strands-py/src/strands/bidi/agent/loop.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/loop.py)
- [harness-sdk/strands-py/src/strands/tools/decorator.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/decorator.py)
- [harness-sdk/strands-py/src/strands/types/tools.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/tools.py)
