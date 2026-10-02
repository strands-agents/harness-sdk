# Direct Method Call Streaming

**Status**: Proposed

**Date**: 2026-06-21

**Issue**: https://github.com/strands-agents/sdk-python/issues/1436

## Context

When using Strands Agents, developers can invoke tools directly via the method-style interface:

```python
agent = Agent(tools=[my_tool])
result = agent.tool.my_tool(param="value")
```

This call currently **blocks** until the tool completes execution. Internally, `ToolExecutor._stream()` yields streaming events (progress updates, status changes, intermediate results), but the `_ToolCaller.__getattr__` method in `tools/_caller.py` consumes and discards these events:

```python
# Current implementation (line 120-133 of _caller.py)
async def acall() -> ToolResult:
    async for event in ToolExecutor._stream(self._agent, tool_use, tool_results, invocation_state):
        if isinstance(event, ToolInterruptEvent):
            self._agent._interrupt_state.deactivate()
            raise RuntimeError("cannot raise interrupt in direct tool call")
    # Events are consumed but never exposed to the caller
    tool_result = tool_results[0]
    return tool_result
```

This creates three problems:

- **No progress visibility**: Long-running tools provide no feedback to UIs or debugging workflows.
- **Inconsistency**: Agent-level calls (`agent("prompt")`) support streaming, but direct tool calls do not.
- **Debugging difficulty**: Developers cannot observe intermediate tool execution steps.

### Who experiences this problem?

- Developers building interactive UIs that need real-time progress indicators for tool execution.
- Developers debugging complex tool chains where intermediate events provide critical context.
- Framework authors building on Strands who need streaming for responsive applications.

## Decision

Add streaming support to direct method calls via an optional `stream` parameter:

```python
# Blocking call (existing behavior, unchanged)
result = agent.tool.my_tool(param="value")

# Streaming call (new)
async for event in agent.tool.my_tool(param="value", stream=True):
    if isinstance(event, ToolResult):
        final_result = event
    else:
        print(f"Progress: {event}")
```

### Implementation Details

#### 1. Modify `_ToolCaller.__getattr__` (tools/_caller.py)

The `caller()` function returned by `__getattr__` gains an optional `stream: bool = False` parameter:

```python
def caller(
    user_message_override: str | None = None,
    record_direct_tool_call: bool | None = None,
    stream: bool = False,
    **kwargs: Any,
) -> Any:
    if stream:
        return self._stream_tool(name, user_message_override, record_direct_tool_call, **kwargs)
    # ... existing blocking implementation
```

#### 2. Add `_stream_tool` async generator method

```python
async def _stream_tool(
    self,
    name: str,
    user_message_override: str | None = None,
    record_direct_tool_call: bool | None = None,
    **kwargs: Any,
) -> AsyncGenerator[StreamEvent | ToolResult, None]:
    """Stream tool execution events for direct tool calls.

    Yields:
        StreamEvent objects during execution, then the final ToolResult.
    """
    # Same setup as blocking caller (lock, normalize name, create tool_use)
    normalized_name = self._find_normalized_tool_name(name)
    tool_id = f"tooluse_{name}_{random.randint(100000000, 999999999)}"
    tool_use: ToolUse = {
        "toolUseId": tool_id,
        "name": normalized_name,
        "input": kwargs.copy(),
    }
    tool_results: list[ToolResult] = []
    invocation_state = kwargs

    async for event in ToolExecutor._stream(
        self._agent, tool_use, tool_results, invocation_state
    ):
        if isinstance(event, ToolInterruptEvent):
            self._agent._interrupt_state.deactivate()
            raise RuntimeError("cannot raise interrupt in direct tool call")
        yield event  # KEY: yield streaming events to caller

    tool_result = tool_results[0]

    if should_record_direct_tool_call:
        await self._record_tool_execution(tool_use, tool_result, user_message_override)

    yield tool_result  # Yield final result as last item
```

#### 3. Integration with existing features

- **Hooks**: Streaming events pass through existing hook infrastructure unchanged.
- **BidiAgent**: The `_stream_tool` method works with both `Agent` and `BidiAgent` since it uses the same `ToolExecutor._stream` that both already support.
- **Conversation management**: Applied after streaming completes, same as blocking path.
- **Concurrency lock**: Held for the duration of streaming, same semantics as blocking.

## Developer Experience

### Typical usage — Progress UI

```python
agent = Agent(tools=[long_running_analysis])

async for event in agent.tool.long_running_analysis(data=dataset, stream=True):
    if isinstance(event, ToolResult):
        print(f"Final: {event}")
    else:
        # Update progress bar, log intermediate steps, etc.
        print(f"Progress: {event}")
```

### Typical usage — Debugging

```python
agent = Agent(tools=[complex_tool])

events = []
async for event in agent.tool.complex_tool(input="test", stream=True):
    events.append(event)
    print(f"[{type(event).__name__}] {event}")

# Inspect all events post-execution
```

### Backward compatibility

The `stream` parameter defaults to `False`, so all existing code continues to work unchanged:

```python
# These are identical (both block)
result = agent.tool.my_tool(param="value")
result = agent.tool.my_tool(param="value", stream=False)
```

### Error messages

```python
# Interrupts during streaming (same as blocking)
RuntimeError: "cannot raise interrupt in direct tool call"

# Concurrent access (same as blocking)
ConcurrencyException: "Direct tool call cannot be made while the agent is in the middle of an invocation."
```

## Alternatives Considered

### Alternative A: Separate accessor (`agent.tool_stream.my_tool()`)

```python
async for event in agent.tool_stream.my_tool(param="value"):
    ...
```

**Pros**: Cleaner separation, no parameter collision risk.
**Cons**: New public API surface, additional `_ToolStreamCaller` class, `tool_stream` could conflict with a tool named `tool_stream`.

### Alternative B: Return type overloading

```python
stream = agent.tool.my_tool(param="value", stream=True)
async for event in stream:
    ...
```

**Pros**: Single entry point.
**Cons**: Return type changes based on parameter (blocking `Any` vs async generator), harder to type correctly.

### Recommended: Alternative B (parameter-based)

Chosen because:
1. **Minimal API change**: No new public attributes on `Agent`.
2. **Consistent with Strands patterns**: The LiteLLM provider uses `params={"stream": False}` to control streaming — same concept.
3. **No name conflict risk**: `stream` is a reserved parameter name handled by `caller()`, not passed to the tool.
4. **Tenet alignment**: "Simple at any scale" — adding one parameter is simpler than a new accessor.

## Consequences

### What becomes easier
- Building responsive UIs with real-time tool progress.
- Debugging complex tool execution chains.
- Consistent streaming API across agent-level and direct tool calls.

### What becomes harder
- The `stream` parameter name is now reserved and cannot be used as a tool input parameter name. This is a minor constraint since `stream` is not a common tool parameter name.

### Breaking changes
- None. Default behavior is unchanged (`stream=False`).

## Willingness to Implement

Yes. I am willing to implement this feature if the design is approved.
