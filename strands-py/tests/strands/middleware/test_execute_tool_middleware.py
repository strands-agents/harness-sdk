"""Integration tests for ExecuteToolStage middleware with Agent."""

import threading
from dataclasses import replace

import pytest

import strands
from strands import Agent, Plugin
from strands._middleware.stages import ExecuteToolContext, ExecuteToolStage
from strands._middleware.types import MiddlewareResult
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent
from strands.types._events import ToolInterruptEvent, ToolResultEvent, ToolStreamEvent
from strands.types.tools import ToolContext
from tests.fixtures.mock_hook_provider import MockHookProvider
from tests.fixtures.mocked_model_provider import MockedModelProvider


@pytest.fixture
def calculator_tool():
    @strands.tool(name="calculator")
    def func(expression: str) -> str:
        """Evaluate a math expression."""
        return str(eval(expression))

    return func


@pytest.fixture
def model():
    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "tool_1", "name": "calculator", "input": {"expression": "2+2"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "The answer is 4."}]}
    return MockedModelProvider([tool_use_msg, final_msg])


@pytest.fixture
def agent(model, calculator_tool):
    return Agent(model=model, tools=[calculator_tool], callback_handler=None)


# --- wrap handler ---


def test_wrap_passthrough_does_not_alter_behavior(agent):
    async def passthrough(context, next_fn):
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, passthrough)
    result = agent("what is 2+2?")
    assert result.message["content"][0]["text"] == "The answer is 4."


def test_wrap_handler_receives_execute_tool_context(agent):
    received_contexts: list[ExecuteToolContext] = []

    async def capture(context, next_fn):
        received_contexts.append(context)
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, capture)
    agent("what is 2+2?")

    assert len(received_contexts) == 1
    context = received_contexts[0]
    assert context.agent is agent
    assert context.tool is not None
    assert context.tool_use["name"] == "calculator"
    assert context.tool_use["input"] == {"expression": "2+2"}
    assert isinstance(context.invocation_state, dict)


def test_wrap_handler_runs_for_unknown_tool_with_tool_none(calculator_tool):
    """Middleware observes an unknown-tool call with context.tool is None (matches TS).

    TS runs the middleware chain for unknown tools too (context.tool === undefined), letting
    middleware mock or route a tool the registry doesn't have. The chain must run and see the
    call, while the unknown-tool error result still flows through.
    """
    received_contexts: list[ExecuteToolContext] = []
    observed_results: list[ToolResultEvent] = []

    # Model calls a tool that isn't registered.
    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "ghost_tool", "input": {}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    async def observer(context, next_fn):
        received_contexts.append(context)
        async for event in next_fn(context):
            if isinstance(event, ToolResultEvent):
                observed_results.append(event)
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, observer)
    agent("call the ghost")

    # Middleware ran and saw the unknown-tool call with tool resolved to None.
    assert len(received_contexts) == 1
    assert received_contexts[0].tool is None
    assert received_contexts[0].tool_use["name"] == "ghost_tool"
    # The unknown-tool error result still flows through the chain.
    assert len(observed_results) == 1
    assert observed_results[0].tool_result["status"] == "error"
    assert "ghost_tool" in observed_results[0].tool_result["content"][0]["text"]


def test_wrap_can_mock_unknown_tool(calculator_tool):
    """Middleware can short-circuit an unknown tool with a mock result (the key TS use case)."""
    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "ghost_tool", "input": {}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    async def mock_missing(context, next_fn):
        if context.tool is None:
            yield ToolResultEvent(
                {"toolUseId": context.tool_use["toolUseId"], "status": "success", "content": [{"text": "mocked"}]}
            )
            return
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, mock_missing)
    agent("call the ghost")

    tool_result_messages = [
        msg for msg in agent.messages if msg.get("role") == "user" and any("toolResult" in c for c in msg["content"])
    ]
    assert len(tool_result_messages) == 1
    assert tool_result_messages[0]["content"][0]["toolResult"] == {
        "toolUseId": "t1",
        "status": "success",
        "content": [{"text": "mocked"}],
    }


def test_wrap_short_circuit_with_cached_result(agent):
    """Middleware can short-circuit by yielding a cached ToolResultEvent without calling next."""

    async def mock_tool(context, next_fn):
        yield ToolResultEvent(
            {
                "toolUseId": context.tool_use["toolUseId"],
                "status": "success",
                "content": [{"text": "mocked: 42"}],
            }
        )

    agent._middleware_registry.add_middleware(ExecuteToolStage, mock_tool)
    result = agent("what is 2+2?")
    # The model still produces its scripted final response after seeing the tool result.
    assert result.message["content"][0]["text"] == "The answer is 4."


def test_wrap_multiple_middleware_compose_correctly(agent):
    order: list[str] = []

    async def outer(context, next_fn):
        order.append("outer_before")
        async for event in next_fn(context):
            yield event
        order.append("outer_after")

    async def inner(context, next_fn):
        order.append("inner_before")
        async for event in next_fn(context):
            yield event
        order.append("inner_after")

    agent._middleware_registry.add_middleware(ExecuteToolStage, outer)
    agent._middleware_registry.add_middleware(ExecuteToolStage, inner)
    agent("what is 2+2?")

    assert order == ["outer_before", "inner_before", "inner_after", "outer_after"]


def test_wrap_tool_error_surfaces_as_error_result():
    """A tool that raises produces an error result that flows through middleware."""

    @strands.tool(name="broken_tool")
    def broken_tool() -> str:
        """Always fails."""
        raise RuntimeError("tool exploded")

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "broken_tool", "input": {}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "Error occurred."}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[broken_tool], callback_handler=None)

    observed_results: list[ToolResultEvent] = []

    async def error_observer(context, next_fn):
        # Decorated tools catch their own exceptions and yield an error ToolResultEvent,
        # so the error shows up in the result rather than propagating here.
        async for event in next_fn(context):
            if isinstance(event, ToolResultEvent):
                observed_results.append(event)
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, error_observer)
    agent("do something")

    assert len(observed_results) == 1
    assert observed_results[0].tool_result["status"] == "error"


def test_raw_tool_exception_reaches_middleware_as_result_not_exception(calculator_tool):
    """A tool whose stream() raises directly is seen by middleware as an error result.

    Unlike decorated @tool tools (which self-convert), a raw AgentTool.stream() can raise.
    The terminal converts it to an error ToolResultEvent so middleware observes a result, not
    a thrown exception — a middleware wrapping next_fn in try/except must NOT catch it.
    """
    caught_in_middleware = False
    observed_results: list[ToolResultEvent] = []

    async def raising_stream(_tool_use, _invocation_state, **_kwargs):
        raise RuntimeError("kaboom")
        yield  # pragma: no cover - makes this an async generator

    calculator_tool.stream = raising_stream

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "calculator", "input": {"expression": "2+2"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    async def error_observer(context, next_fn):
        nonlocal caught_in_middleware
        try:
            async for event in next_fn(context):
                if isinstance(event, ToolResultEvent):
                    observed_results.append(event)
                yield event
        except Exception:
            caught_in_middleware = True
            raise

    agent._middleware_registry.add_middleware(ExecuteToolStage, error_observer)
    agent("go")

    assert not caught_in_middleware
    assert len(observed_results) == 1
    assert observed_results[0].tool_result["status"] == "error"
    assert observed_results[0].exception is not None


# --- input phase ---


def test_input_transforms_tool_context(agent):
    received_input: dict = {}

    async def capture(context, next_fn):
        received_input.update(context.tool_use.get("input", {}))
        async for event in next_fn(context):
            yield event

    def modify_input(context):
        modified_tool_use = {**context.tool_use, "input": {"expression": "3+3"}}
        return replace(context, tool_use=modified_tool_use)

    agent._middleware_registry.add_middleware(ExecuteToolStage.Input, modify_input)
    agent._middleware_registry.add_middleware(ExecuteToolStage, capture)
    agent("what is 2+2?")

    assert received_input == {"expression": "3+3"}


def test_input_rewriting_tool_use_id_stays_consistent_across_events(calculator_tool):
    """An Input handler that rewrites toolUseId is reflected consistently in all emitted events.

    The terminal derives stream-wrapping and result events from ctx.tool_use (the transformed
    value), so the ToolStreamEvent and the final ToolResultEvent agree on the new id rather
    than one carrying the original.
    """
    stream_ids: list[str] = []
    result_ids: list[str] = []

    # A raw (non-SDK) tool stream: yields a bare value (wrapped into ToolStreamEvent by the
    # terminal) then a ToolResult, exercising the terminal's own event construction.
    async def raw_stream(tool_use, _invocation_state, **_kwargs):
        yield "progress"
        yield {"toolUseId": tool_use["toolUseId"], "status": "success", "content": [{"text": "42"}]}

    calculator_tool.stream = raw_stream

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "original_id", "name": "calculator", "input": {"expression": "2+2"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    def rewrite_id(context):
        return replace(context, tool_use={**context.tool_use, "toolUseId": "rewritten_id"})

    async def capture_ids(context, next_fn):
        async for event in next_fn(context):
            if isinstance(event, ToolStreamEvent):
                stream_ids.append(event.tool_use_id)
            elif isinstance(event, ToolResultEvent):
                result_ids.append(event.tool_result["toolUseId"])
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage.Input, rewrite_id)
    agent._middleware_registry.add_middleware(ExecuteToolStage, capture_ids)
    agent("go")

    # Every stream-wrapped and result event carries the rewritten id — none desync to the
    # original. (The raw-value result also surfaces as a trailing stream event, so there may
    # be more than one of each; what matters is that they all agree.)
    assert stream_ids and all(stream_id == "rewritten_id" for stream_id in stream_ids)
    assert result_ids == ["rewritten_id"]


def test_context_transform_modified_input_reaches_tool():
    """When middleware transforms tool_use input, the tool receives modified arguments."""
    received_args: list[dict] = []

    @strands.tool(name="echo_tool")
    def echo_tool(value: str) -> str:
        """Echo the value."""
        received_args.append({"value": value})
        return value

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "echo_tool", "input": {"value": "original"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[echo_tool], callback_handler=None)

    def modify_input(context):
        modified_tool_use = {**context.tool_use, "input": {"value": "modified"}}
        return replace(context, tool_use=modified_tool_use)

    agent._middleware_registry.add_middleware(ExecuteToolStage.Input, modify_input)
    agent("test")

    assert received_args == [{"value": "modified"}]


# --- output phase ---


def test_output_transforms_tool_result(agent):
    """Output handler receives a MiddlewareResult wrapping the ToolResultEvent and can transform it."""
    transformed: list[MiddlewareResult] = []

    def output_handler(result):
        transformed.append(result)
        # result.value is the ToolResultEvent
        new_tool_result = {**result.value.tool_result, "content": [{"text": "intercepted"}]}
        return result.replace(value=ToolResultEvent(new_tool_result))

    agent._middleware_registry.add_middleware(ExecuteToolStage.Output, output_handler)
    agent("what is 2+2?")

    assert len(transformed) == 1
    assert isinstance(transformed[0], MiddlewareResult)
    assert transformed[0].value.tool_result["content"] == [{"text": "4"}]


def test_output_transformed_result_reaches_conversation(agent):
    """The transformed Output result is what lands in the conversation history."""

    def output_handler(result):
        new_tool_result = {**result.value.tool_result, "content": [{"text": "intercepted"}]}
        return result.replace(value=ToolResultEvent(new_tool_result))

    agent._middleware_registry.add_middleware(ExecuteToolStage.Output, output_handler)
    agent("what is 2+2?")

    tool_result_messages = [
        msg for msg in agent.messages if msg.get("role") == "user" and any("toolResult" in c for c in msg["content"])
    ]
    assert len(tool_result_messages) == 1
    # Whole-object assertion: the Output handler rewrote content while preserving toolUseId/status.
    assert tool_result_messages[0]["content"][0]["toolResult"] == {
        "toolUseId": "tool_1",
        "status": "success",
        "content": [{"text": "intercepted"}],
    }


# --- hooks fire outside middleware ---


def test_hooks_fire_outside_middleware(model, calculator_tool):
    hook_provider = MockHookProvider(event_types="all")
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None, hooks=[hook_provider])

    middleware_saw_before_hook = False

    async def check_middleware(context, next_fn):
        nonlocal middleware_saw_before_hook
        _, events = hook_provider.get_events()
        middleware_saw_before_hook = BeforeToolCallEvent in [type(event) for event in events]
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, check_middleware)
    agent("what is 2+2?")
    assert middleware_saw_before_hook


def test_after_tool_call_event_fires_after_middleware(model, calculator_tool):
    """AfterToolCallEvent fires after the middleware chain completes."""
    hook_provider = MockHookProvider(event_types="all")
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None, hooks=[hook_provider])

    middleware_completed = False

    async def tracker(context, next_fn):
        nonlocal middleware_completed
        async for event in next_fn(context):
            yield event
        middleware_completed = True

    agent._middleware_registry.add_middleware(ExecuteToolStage, tracker)
    agent("what is 2+2?")

    assert middleware_completed
    _, events = hook_provider.get_events()
    assert AfterToolCallEvent in [type(event) for event in events]


def test_hooks_fire_when_middleware_short_circuits(model, calculator_tool):
    """AfterToolCallEvent still fires when middleware short-circuits."""
    hook_provider = MockHookProvider(event_types="all")
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None, hooks=[hook_provider])

    async def cached(context, next_fn):
        yield ToolResultEvent(
            {"toolUseId": context.tool_use["toolUseId"], "status": "success", "content": [{"text": "4"}]}
        )

    agent._middleware_registry.add_middleware(ExecuteToolStage, cached)
    agent("what is 2+2?")

    _, events = hook_provider.get_events()
    assert AfterToolCallEvent in [type(event) for event in events]


def test_after_tool_call_receives_middleware_result_on_short_circuit(model, calculator_tool):
    """AfterToolCallEvent.result carries the middleware-provided result on short-circuit."""
    hook_provider = MockHookProvider(event_types="all")
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None, hooks=[hook_provider])

    async def cached(context, next_fn):
        yield ToolResultEvent(
            {
                "toolUseId": context.tool_use["toolUseId"],
                "status": "success",
                "content": [{"text": "mocked_42"}],
            }
        )

    agent._middleware_registry.add_middleware(ExecuteToolStage, cached)
    agent("what is 2+2?")

    _, events = hook_provider.get_events()
    after_events = [event for event in events if isinstance(event, AfterToolCallEvent)]
    assert len(after_events) == 1
    assert after_events[0].result["content"] == [{"text": "mocked_42"}]


# --- short-circuit and defensive-copy behavior ---


def test_short_circuit_tool_not_called(calculator_tool):
    """When middleware short-circuits, the actual tool function is NOT called."""
    tool_called = False
    original_stream = calculator_tool.stream

    async def tracking_stream(*args, **kwargs):
        nonlocal tool_called
        tool_called = True
        async for event in original_stream(*args, **kwargs):
            yield event

    calculator_tool.stream = tracking_stream

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "calculator", "input": {"expression": "1+1"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "2"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    async def cached(context, next_fn):
        yield ToolResultEvent(
            {"toolUseId": context.tool_use["toolUseId"], "status": "success", "content": [{"text": "2"}]}
        )

    agent._middleware_registry.add_middleware(ExecuteToolStage, cached)
    agent("calc")
    assert not tool_called


def test_context_transform_does_not_mutate_original():
    """Modifying the tool_use in the context does not mutate the executor's tool_use."""

    @strands.tool(name="echo_tool")
    def echo_tool(value: str) -> str:
        """Echo."""
        return value

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "echo_tool", "input": {"value": "original"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[echo_tool], callback_handler=None)

    original_contexts: list[ExecuteToolContext] = []

    async def mutating_middleware(context, next_fn):
        original_contexts.append(context)
        modified = replace(context, tool_use={**context.tool_use, "input": {"value": "changed"}})
        async for event in next_fn(modified):
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, mutating_middleware)
    agent("test")

    assert len(original_contexts) == 1
    # The original context object is untouched.
    assert original_contexts[0].tool_use["input"] == {"value": "original"}


def test_short_circuit_result_appears_in_conversation(calculator_tool):
    """When middleware short-circuits, the mocked result appears in agent.messages."""
    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "calculator", "input": {"expression": "1+1"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    async def cached(context, next_fn):
        yield ToolResultEvent(
            {
                "toolUseId": context.tool_use["toolUseId"],
                "status": "success",
                "content": [{"text": "mocked_result"}],
            }
        )

    agent._middleware_registry.add_middleware(ExecuteToolStage, cached)
    agent("calc")

    tool_result_messages = [
        msg for msg in agent.messages if msg.get("role") == "user" and any("toolResult" in c for c in msg["content"])
    ]
    assert len(tool_result_messages) == 1
    # Whole-object assertion also guards toolUseId/status against regressions.
    assert tool_result_messages[0]["content"][0]["toolResult"] == {
        "toolUseId": "t1",
        "status": "success",
        "content": [{"text": "mocked_result"}],
    }


def test_no_middleware_agent_with_tools_works_correctly(agent):
    """An agent with tools but no middleware behaves exactly as before."""
    result = agent("what is 2+2?")
    assert result.message["content"][0]["text"] == "The answer is 4."


def test_caching_plugin_use_case():
    """Full caching plugin: first call executes the tool, second returns the cached result."""
    call_count = 0

    @strands.tool(name="expensive_tool")
    def expensive_tool(query: str) -> str:
        """Simulates an expensive operation."""
        nonlocal call_count
        call_count += 1
        return f"result_for_{query}"

    class CachingPlugin(Plugin):
        name = "caching"

        def __init__(self):
            super().__init__()
            self._cache: dict[str, dict] = {}

        def init_agent(self, agent):
            agent._middleware_registry.add_middleware(ExecuteToolStage, self._middleware)

        async def _middleware(self, context, next_fn):
            key = f"{context.tool_use['name']}:{context.tool_use['input']}"
            if key in self._cache:
                yield ToolResultEvent(self._cache[key])
                return
            async for event in next_fn(context):
                if isinstance(event, ToolResultEvent):
                    self._cache[key] = event.tool_result
                yield event

    plugin = CachingPlugin()

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "expensive_tool", "input": {"query": "hello"}}}],
    }
    tool_use_msg_2 = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t2", "name": "expensive_tool", "input": {"query": "hello"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}

    model = MockedModelProvider([tool_use_msg, final_msg, tool_use_msg_2, final_msg])
    agent = Agent(model=model, tools=[expensive_tool], callback_handler=None, plugins=[plugin])

    agent("first call")
    assert call_count == 1

    agent("second call")
    # Second call hits the cache — the tool is not invoked again.
    assert call_count == 1


# --- edge cases / regressions ---


def test_tool_yielding_nothing_degrades_to_error_result():
    """A tool whose stream yields nothing produces an error result, not a crash.

    Regression: the middleware terminal must not wrap a missing result as
    ``ToolResultEvent(None)``, which crashed the event loop downstream.
    """

    @strands.tool(name="empty_tool")
    def empty_tool() -> str:
        """Never yields a result."""
        return "unused"

    async def empty_stream(_tool_use, _invocation_state, **_kwargs):
        if False:
            yield  # make this an (empty) async generator

    empty_tool.stream = empty_stream

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "empty_tool", "input": {}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[empty_tool], callback_handler=None)

    result = agent("go")
    assert result.stop_reason == "end_turn"

    tool_result_messages = [
        msg for msg in agent.messages if msg.get("role") == "user" and any("toolResult" in c for c in msg["content"])
    ]
    assert len(tool_result_messages) == 1
    assert tool_result_messages[0]["content"][0]["toolResult"]["status"] == "error"


def test_cancel_tool_bypasses_middleware(calculator_tool):
    """A BeforeToolCallEvent that cancels the tool short-circuits before the chain runs."""

    class CancelHook:
        def register_hooks(self, registry, **kwargs):
            registry.add_callback(BeforeToolCallEvent, self._cancel)

        def _cancel(self, event):
            event.cancel_tool = "not allowed"

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "calculator", "input": {"expression": "2+2"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None, hooks=[CancelHook()])

    middleware_ran = False

    async def observer(context, next_fn):
        nonlocal middleware_ran
        middleware_ran = True
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, observer)
    agent("calc")

    # Cancellation happens before the middleware chain is invoked.
    assert not middleware_ran
    tool_result_messages = [
        msg for msg in agent.messages if msg.get("role") == "user" and any("toolResult" in c for c in msg["content"])
    ]
    assert tool_result_messages[0]["content"][0]["toolResult"]["content"] == [{"text": "not allowed"}]


def test_shallow_copy_protects_tool_use_top_level_keys():
    """Reassigning a top-level tool_use key in middleware does not corrupt executor state."""
    seen_after_name: list[str] = []

    @strands.tool(name="echo_tool")
    def echo_tool(value: str) -> str:
        """Echo."""
        return value

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "echo_tool", "input": {"value": "hi"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[echo_tool], callback_handler=None)

    class NameHook:
        def register_hooks(self, registry, **kwargs):
            registry.add_callback(AfterToolCallEvent, self._capture)

        def _capture(self, event):
            seen_after_name.append(event.tool_use["name"])

    agent.hooks.add_hook(NameHook())

    async def clobber(context, next_fn):
        # Mutating the shallow-copied dict's top-level key must not leak to the executor.
        context.tool_use["name"] = "hacked"
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, clobber)
    agent("go")

    # The after-hook (fed by the executor's own tool_use) still sees the real name.
    assert seen_after_name == ["echo_tool"]


def test_output_handler_not_invoked_on_tool_interrupt(calculator_tool):
    """A tool-originated interrupt bypasses the Output handler (it has no result)."""
    output_calls: list[MiddlewareResult] = []

    @strands.tool(name="interrupting_tool", context=True)
    def interrupting_tool(tool_context) -> str:
        """Interrupts on first call."""
        return tool_context.interrupt("confirm", reason="ok?")

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "interrupting_tool", "input": {}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[interrupting_tool], callback_handler=None)

    def output_handler(result):
        output_calls.append(result)
        return result

    seen_interrupt_events: list[ToolInterruptEvent] = []

    async def observer(context, next_fn):
        async for event in next_fn(context):
            if isinstance(event, ToolInterruptEvent):
                seen_interrupt_events.append(event)
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, observer)
    agent._middleware_registry.add_middleware(ExecuteToolStage.Output, output_handler)

    result = agent("go")
    assert result.stop_reason == "interrupt"
    # The interrupt flowed through as a normal event, but was never treated as a result.
    assert len(seen_interrupt_events) == 1
    assert output_calls == []


def test_invocation_state_is_shared_by_reference(calculator_tool):
    """A middleware write to context.invocation_state is visible to the tool (shared, not copied).

    Locks in the documented contract that invocation_state is passed by reference, matching hooks.
    """
    seen_in_tool: dict = {}

    @strands.tool(name="probe_tool", context=True)
    def probe_tool(tool_context) -> str:
        """Records what it sees in invocation_state."""
        seen_in_tool["marker"] = tool_context.invocation_state.get("marker")
        return "ok"

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "probe_tool", "input": {}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[probe_tool], callback_handler=None)

    async def setter(context, next_fn):
        context.invocation_state["marker"] = "set_by_middleware"
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, setter)
    agent("go")

    assert seen_in_tool["marker"] == "set_by_middleware"


def test_in_place_input_mutation_leaks_to_tool():
    """Mutating tool_use['input'] in place DOES leak (input is shared by reference, by design).

    The shallow copy guards top-level keys only; this pins the documented divergence so it is
    regression-guarded rather than only described in the stages.py docstring.
    """
    received_values: list[str] = []

    @strands.tool(name="echo_tool")
    def echo_tool(value: str) -> str:
        """Echo."""
        received_values.append(value)
        return value

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "echo_tool", "input": {"value": "original"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[echo_tool], callback_handler=None)

    async def mutate_input(context, next_fn):
        # In-place edit of the shared input dict — not isolated by the shallow copy.
        context.tool_use["input"]["value"] = "mutated"
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, mutate_input)
    agent("go")

    assert received_values == ["mutated"]


def test_wrap_yielding_no_result_surfaces_actionable_error(calculator_tool):
    """A Wrap middleware that consumes next_fn but yields no result produces an actionable error.

    Guards the most common middleware-authoring mistake: forwarding nothing from next(). The
    RuntimeError is raised inside _stream, caught by its error handler, and surfaced as an
    error ToolResult carrying the guidance message so the agent can continue rather than crash.
    """
    observed_results: list[ToolResultEvent] = []

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "calculator", "input": {"expression": "2+2"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    model = MockedModelProvider([tool_use_msg, final_msg])
    agent = Agent(model=model, tools=[calculator_tool], callback_handler=None)

    async def swallow_result(context, next_fn):
        # Drives the tool but forwards nothing, so the chain yields no ToolResultEvent.
        async for _event in next_fn(context):
            pass
        return
        yield  # pragma: no cover - makes this an async generator

    async def observer(context, next_fn):
        async for event in next_fn(context):
            if isinstance(event, ToolResultEvent):
                observed_results.append(event)
            yield event

    # Observer is outermost so it sees the error result the executor produces on the retry-less
    # failure path; swallow_result is the inner handler that drops the result.
    agent._middleware_registry.add_middleware(ExecuteToolStage, swallow_result)
    agent("go")

    tool_result_messages = [
        msg for msg in agent.messages if msg.get("role") == "user" and any("toolResult" in c for c in msg["content"])
    ]
    assert len(tool_result_messages) == 1
    result = tool_result_messages[0]["content"][0]["toolResult"]
    assert result["status"] == "error"
    assert "did not yield a ToolResultEvent" in result["content"][0]["text"]


def test_middleware_observes_but_cannot_replace_cancel_signal():
    """ExecuteToolContext.cancel_signal is executor-owned: middleware replacement never reaches the tool."""
    observed_signals: list[threading.Event] = []
    tool_signals: list[threading.Event] = []
    replacement = threading.Event()

    @strands.tool(name="probe", context=True)
    def probe(tool_context: ToolContext) -> str:
        """Record the cancellation signal handed to the tool."""
        tool_signals.append(tool_context.cancel_signal)
        return "ok"

    tool_use_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "probe", "input": {}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "done"}]}
    agent = Agent(model=MockedModelProvider([tool_use_msg, final_msg]), tools=[probe], callback_handler=None)

    async def replace_signal(context, next_fn):
        observed_signals.append(context.cancel_signal)
        async for event in next_fn(replace(context, cancel_signal=replacement)):
            yield event

    agent._middleware_registry.add_middleware(ExecuteToolStage, replace_signal)
    agent("use the probe tool")

    assert observed_signals == [agent.cancel_signal]
    assert tool_signals == [agent.cancel_signal]
    assert tool_signals[0] is not replacement
