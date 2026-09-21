"""Integration tests for middleware with Agent (InvokeModelStage)."""

from dataclasses import replace
from unittest.mock import AsyncMock

import pytest

from strands import Agent, Plugin
from strands._middleware.stages import InvokeModelContext, InvokeModelStage
from strands._middleware.types import MiddlewareResult
from strands.hooks import AfterModelCallEvent, BeforeModelCallEvent
from strands.types._events import ModelStopReason
from strands.types.streaming import Metrics, Usage
from tests.fixtures.mock_hook_provider import MockHookProvider
from tests.fixtures.mocked_model_provider import MockedModelProvider


class PromptCapturingModel(MockedModelProvider):
    """Captures the system_prompt / system_prompt_content the model receives."""

    def __init__(self, responses):
        super().__init__(responses)
        self.received_system_prompt = "UNSET"
        self.received_system_prompt_content = "UNSET"

    async def stream(self, messages, tool_specs=None, system_prompt=None, *args, **kwargs):
        self.received_system_prompt = system_prompt
        self.received_system_prompt_content = kwargs.get("system_prompt_content")
        async for event in super().stream(messages, tool_specs, system_prompt, *args, **kwargs):
            yield event


class ModelStateMutatingModel(MockedModelProvider):
    """Model that mutates the model_state dict it receives during stream()."""

    def __init__(self, responses, mutate):
        super().__init__(responses)
        self._mutate = mutate
        self.received_model_state = None

    async def stream(self, *args, **kwargs):
        model_state = kwargs.get("model_state")
        # Capture a copy of what the model actually received
        self.received_model_state = dict(model_state) if model_state is not None else None
        self._mutate(model_state)
        async for event in super().stream(*args, **kwargs):
            yield event


@pytest.fixture
def model():
    return MockedModelProvider(
        [
            {"role": "assistant", "content": [{"text": "Hello!"}]},
        ]
    )


@pytest.fixture
def agent(model):
    return Agent(model=model, callback_handler=None)


# --- add_middleware API ---


# --- wrap phase ---


def test_wrap_passthrough_does_not_alter_behavior(agent):
    async def passthrough(context, next_fn):
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, passthrough)
    result = agent("test")
    assert result.message["content"][0]["text"] == "Hello!"


def test_wrap_handler_receives_invoke_model_context(agent):
    received_context: list[InvokeModelContext] = []

    async def capture(context, next_fn):
        received_context.append(context)
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, capture)
    agent("test")

    assert len(received_context) == 1
    ctx = received_context[0]
    assert ctx.agent is agent
    assert isinstance(ctx.messages, list)
    assert hasattr(ctx, "system_prompt")
    assert isinstance(ctx.tool_specs, list)
    assert hasattr(ctx, "tool_choice")
    assert isinstance(ctx.invocation_state, dict)


def test_wrap_context_transformation(agent):
    """Middleware can modify the context before it reaches the model."""
    transformed_system_prompt = None

    async def inject_prompt(context, next_fn):
        modified = replace(context, system_prompt="Injected prompt")
        async for event in next_fn(modified):
            yield event

    async def capture_terminal(context, next_fn):
        nonlocal transformed_system_prompt
        transformed_system_prompt = context.system_prompt
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, inject_prompt)
    agent._middleware_registry.add_middleware(InvokeModelStage, capture_terminal)
    agent("test")

    assert transformed_system_prompt == "Injected prompt"


def test_wrap_context_transformation_tool_specs(agent):
    """Middleware can modify tool_specs and the model receives the modified list."""
    received_tool_specs = None

    async def modify_specs(context, next_fn):
        modified = replace(context, tool_specs=[])
        async for event in next_fn(modified):
            yield event

    async def capture(context, next_fn):
        nonlocal received_tool_specs
        received_tool_specs = context.tool_specs
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, modify_specs)
    agent._middleware_registry.add_middleware(InvokeModelStage, capture)
    agent("test")

    assert received_tool_specs == []


def test_string_system_prompt_reaches_model_as_both_forms():
    """A string system prompt is passed to the model as both string and content blocks."""
    model = PromptCapturingModel([{"role": "assistant", "content": [{"text": "ok"}]}])
    agent = Agent(model=model, callback_handler=None, system_prompt="be concise")
    agent("test")

    assert model.received_system_prompt == "be concise"
    assert model.received_system_prompt_content == [{"text": "be concise"}]


def test_system_prompt_blocks_with_cache_point_preserved_through_middleware():
    """System-prompt content blocks (incl. cachePoint) survive the middleware round-trip."""
    blocks = [{"text": "be concise"}, {"cachePoint": {"type": "default"}}]
    model = PromptCapturingModel([{"role": "assistant", "content": [{"text": "ok"}]}])
    agent = Agent(model=model, callback_handler=None, system_prompt=blocks)

    received_in_middleware = None

    async def capture(context, next_fn):
        nonlocal received_in_middleware
        received_in_middleware = context.system_prompt
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, capture)
    agent("test")

    # Middleware sees the full content-block form (not the lossy string)
    assert received_in_middleware == blocks
    # The model receives the cachePoint-preserving content blocks
    assert model.received_system_prompt_content == blocks


def test_middleware_transformed_system_prompt_reaches_model():
    """A system_prompt transformed by middleware is what the model receives."""
    model = PromptCapturingModel([{"role": "assistant", "content": [{"text": "ok"}]}])
    agent = Agent(model=model, callback_handler=None, system_prompt="original")

    async def inject(context, next_fn):
        modified = replace(context, system_prompt="transformed by middleware")
        async for event in next_fn(modified):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, inject)
    agent("test")

    assert model.received_system_prompt == "transformed by middleware"
    assert model.received_system_prompt_content == [{"text": "transformed by middleware"}]


def test_context_modification_does_not_mutate_agent_state():
    """Context fields are defensive copies — middleware mutations don't affect agent state."""
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "ok"}]}])
    agent = Agent(model=model, callback_handler=None, system_prompt="original")

    async def mutating_middleware(context, next_fn):
        context.messages.append({"role": "user", "content": [{"text": "injected"}]})
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, mutating_middleware)
    agent("test")

    # Agent's messages should not contain the injected message from middleware mutation
    # (it will have the user "test" message and the model response, but not "injected" before "test")
    user_texts = [m["content"][0].get("text") for m in agent.messages if m.get("role") == "user"]
    assert "injected" not in user_texts


def test_wrap_short_circuit_skips_model_call(agent):
    """Middleware can short-circuit by not calling next and yielding its own result."""

    async def cached_response(context, next_fn):
        cached_message = {"role": "assistant", "content": [{"text": "Cached!"}]}
        yield ModelStopReason(
            stop_reason="end_turn",
            message=cached_message,
            usage=Usage(inputTokens=0, outputTokens=0, totalTokens=0),
            metrics=Metrics(latencyMs=0),
        )

    agent._middleware_registry.add_middleware(InvokeModelStage, cached_response)
    result = agent("test")
    assert result.message["content"][0]["text"] == "Cached!"
    assert (result.metrics.average_output_tokens_per_second, result.metrics.output_throughput_sample_count) == (None, 0)


def test_wrap_yields_nothing_raises_runtime_error(agent):
    """Middleware that yields zero events produces an actionable RuntimeError."""

    async def silent(context, next_fn):
        if False:
            yield  # noqa: B901

    agent._middleware_registry.add_middleware(InvokeModelStage, silent)
    with pytest.raises(RuntimeError, match="did not yield a result event"):
        agent("test")


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

    agent._middleware_registry.add_middleware(InvokeModelStage, outer)
    agent._middleware_registry.add_middleware(InvokeModelStage, inner)
    agent("test")

    assert order == ["outer_before", "inner_before", "inner_after", "outer_after"]


def test_wrap_error_from_model_propagates_through_middleware():
    """Errors from the model propagate through middleware layers."""

    class FailingModel(MockedModelProvider):
        async def stream(self, *args, **kwargs):
            raise RuntimeError("model error")
            yield  # noqa: B901

    agent = Agent(model=FailingModel([]), callback_handler=None, retry_strategy=None)

    caught_error = None

    async def error_catcher(context, next_fn):
        nonlocal caught_error
        try:
            async for event in next_fn(context):
                yield event
        except RuntimeError as e:
            caught_error = e
            raise

    agent._middleware_registry.add_middleware(InvokeModelStage, error_catcher)

    with pytest.raises(RuntimeError, match="model error"):
        agent("test")

    assert caught_error is not None


# --- input phase ---


def test_input_transforms_context(agent):
    received_system_prompt = None

    async def capture(context, next_fn):
        nonlocal received_system_prompt
        received_system_prompt = context.system_prompt
        async for event in next_fn(context):
            yield event

    def inject_prompt(context):
        return replace(context, system_prompt="From input handler")

    agent._middleware_registry.add_middleware(InvokeModelStage.Input, inject_prompt)
    agent._middleware_registry.add_middleware(InvokeModelStage, capture)
    agent("test")

    assert received_system_prompt == "From input handler"


def test_input_async_handler(agent):
    received_system_prompt = None

    async def capture(context, next_fn):
        nonlocal received_system_prompt
        received_system_prompt = context.system_prompt
        async for event in next_fn(context):
            yield event

    async def async_inject(context):
        return replace(context, system_prompt="Async input")

    agent._middleware_registry.add_middleware(InvokeModelStage.Input, async_inject)
    agent._middleware_registry.add_middleware(InvokeModelStage, capture)
    agent("test")

    assert received_system_prompt == "Async input"


# --- output phase ---


def test_output_transforms_result(agent):
    """Output handler receives a MiddlewareResult wrapping the result event and can transform it."""
    transformed = []

    def output_handler(result):
        transformed.append(result)
        # result.value is the ModelStopReason event
        stop_reason, message, usage, metrics = result.value["stop"]
        return result.replace(
            value=ModelStopReason(stop_reason="custom_stop", message=message, usage=usage, metrics=metrics),
        )

    agent._middleware_registry.add_middleware(InvokeModelStage.Output, output_handler)
    result = agent("test")

    assert len(transformed) == 1
    assert isinstance(transformed[0], MiddlewareResult)
    assert result.stop_reason == "custom_stop"


def test_output_transformed_message_appended_to_history(agent):
    """The message from a transformed Output result is what lands in agent.messages."""

    def output_handler(result):
        stop_reason, message, usage, metrics = result.value["stop"]
        rewritten = {"role": "assistant", "content": [{"text": "rewritten by middleware"}]}
        return result.replace(
            value=ModelStopReason(stop_reason=stop_reason, message=rewritten, usage=usage, metrics=metrics),
        )

    agent._middleware_registry.add_middleware(InvokeModelStage.Output, output_handler)
    agent("test")

    assistant_messages = [m for m in agent.messages if m["role"] == "assistant"]
    assert assistant_messages[-1]["content"][0]["text"] == "rewritten by middleware"


def test_output_stop_reason_change_prevents_tool_dispatch():
    """Changing stop_reason from tool_use to end_turn via Output prevents tool execution."""
    import strands

    tool_called = False

    @strands.tool(name="should_not_run")
    def should_not_run() -> str:
        """A tool that must not be dispatched."""
        nonlocal tool_called
        tool_called = True
        return "ran"

    tool_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "should_not_run", "input": {}}}],
    }
    model = MockedModelProvider([tool_msg])
    agent = Agent(model=model, tools=[should_not_run], callback_handler=None)

    def force_end_turn(result):
        stop_reason, message, usage, metrics = result.value["stop"]
        return result.replace(
            value=ModelStopReason(stop_reason="end_turn", message=message, usage=usage, metrics=metrics),
        )

    agent._middleware_registry.add_middleware(InvokeModelStage.Output, force_end_turn)
    result = agent("test")

    assert result.stop_reason == "end_turn"
    assert not tool_called


# --- model state isolation ---


def test_model_state_not_exposed_on_context(agent):
    """InvokeModelContext does not expose a model_state field (state isolation)."""
    captured: list[InvokeModelContext] = []

    async def capture(context, next_fn):
        captured.append(context)
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, capture)
    agent("test")

    assert len(captured) == 1
    assert not hasattr(captured[0], "model_state")


def test_model_state_changes_written_back_after_streaming():
    """Model writes to model_state during streaming; changes land on agent._model_state."""

    def mutate(state):
        state["responseId"] = "resp_123"

    model = ModelStateMutatingModel([{"role": "assistant", "content": [{"text": "Hi"}]}], mutate)
    agent = Agent(model=model, callback_handler=None)
    agent("Hello")

    assert agent._model_state == {"responseId": "resp_123"}


def test_model_state_deletions_synced_back():
    """Model deletions and additions to model_state sync back to the agent."""

    def mutate(state):
        state.pop("oldKey", None)
        state["newKey"] = "fresh"

    model = ModelStateMutatingModel([{"role": "assistant", "content": [{"text": "Hi"}]}], mutate)
    agent = Agent(model=model, callback_handler=None)
    agent._model_state = {"oldKey": "stale"}
    agent("Hello")

    assert "oldKey" not in agent._model_state
    assert agent._model_state["newKey"] == "fresh"


def test_middleware_mutation_before_next_does_not_reach_model():
    """Middleware mutating agent._model_state before next() does not affect the model call."""

    def mutate(state):
        pass  # model reads but doesn't change

    model = ModelStateMutatingModel([{"role": "assistant", "content": [{"text": "Hi"}]}], mutate)
    agent = Agent(model=model, callback_handler=None)
    agent._model_state = {"key": "snapshotted"}

    async def mutate_before_next(context, next_fn):
        agent._model_state["key"] = "mutated-before-next"
        agent._model_state["extra"] = "injected"
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, mutate_before_next)
    agent("Hello")

    # The model received the pre-middleware snapshot, not the mutated state
    assert model.received_model_state == {"key": "snapshotted"}


def test_middleware_mutation_after_next_does_not_persist():
    """Middleware mutating agent._model_state after next() is discarded by writeback."""

    def mutate(state):
        state["fromModel"] = "model-wrote-this"

    model = ModelStateMutatingModel([{"role": "assistant", "content": [{"text": "Hi"}]}], mutate)
    agent = Agent(model=model, callback_handler=None)
    agent._model_state = {"key": "original"}

    async def mutate_after_next(context, next_fn):
        async for event in next_fn(context):
            yield event
        agent._model_state["sneaky"] = "should-be-gone"
        agent._model_state["fromModel"] = "overwritten"

    agent._middleware_registry.add_middleware(InvokeModelStage, mutate_after_next)
    agent("Hello")

    # Writeback (from the snapshot the model wrote to) overwrites post-next mutations
    assert agent._model_state["fromModel"] == "model-wrote-this"
    assert "sneaky" not in agent._model_state
    # 'key' persists because it was in the snapshot the model received
    assert agent._model_state["key"] == "original"


# --- hooks fire outside middleware ---


def test_before_model_call_fires_before_middleware(model):
    hook_provider = MockHookProvider(event_types="all")
    agent = Agent(model=model, callback_handler=None, hooks=[hook_provider])

    middleware_saw_hook_fired = False

    async def check_middleware(context, next_fn):
        nonlocal middleware_saw_hook_fired
        _, events = hook_provider.get_events()

        event_types = [type(e) for e in events]
        middleware_saw_hook_fired = BeforeModelCallEvent in event_types
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, check_middleware)
    agent("test")
    assert middleware_saw_hook_fired


def test_after_model_call_fires_after_middleware(model):
    hook_provider = MockHookProvider(event_types="all")
    agent = Agent(model=model, callback_handler=None, hooks=[hook_provider])

    middleware_completed = False

    async def tracking_middleware(context, next_fn):
        nonlocal middleware_completed
        async for event in next_fn(context):
            yield event
        middleware_completed = True

    agent._middleware_registry.add_middleware(InvokeModelStage, tracking_middleware)
    agent("test")

    assert middleware_completed

    _, events = hook_provider.get_events()
    event_types = [type(e) for e in events]
    assert AfterModelCallEvent in event_types


# --- plugin middleware ---


def test_plugin_can_register_middleware(model):
    class TimingPlugin(Plugin):
        name = "timing"

        def __init__(self):
            super().__init__()
            self.call_count = 0

        def init_agent(self, agent):
            agent._middleware_registry.add_middleware(InvokeModelStage, self._middleware)

        async def _middleware(self, context, next_fn):
            self.call_count += 1
            async for event in next_fn(context):
                yield event

    plugin = TimingPlugin()
    agent = Agent(model=model, callback_handler=None, plugins=[plugin])
    agent("test")

    assert plugin.call_count == 1


# --- no-middleware baselines ---


def test_no_middleware_agent_works_correctly():
    """Agent with no middleware produces correct results."""
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "Response"}]}])
    agent = Agent(model=model, callback_handler=None)
    result = agent("hello")
    assert result.message["content"][0]["text"] == "Response"
    assert result.stop_reason == "end_turn"


def test_no_middleware_agent_with_tools_works_correctly():
    """Agent with tools but no middleware executes tools correctly."""
    import strands

    @strands.tool(name="greet")
    def greet(name: str) -> str:
        """Greet someone."""
        return f"Hello, {name}!"

    tool_msg = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "t1", "name": "greet", "input": {"name": "World"}}}],
    }
    final_msg = {"role": "assistant", "content": [{"text": "Greeted!"}]}
    model = MockedModelProvider([tool_msg, final_msg])
    agent = Agent(model=model, tools=[greet], callback_handler=None)
    result = agent("greet someone")
    assert result.message["content"][0]["text"] == "Greeted!"


def test_passthrough_middleware_preserves_result():
    """Passthrough middleware returns the correct stop_reason and message."""
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "Correct"}]}])
    agent = Agent(model=model, callback_handler=None)

    async def passthrough(context, next_fn):
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, passthrough)
    result = agent("test")
    assert result.stop_reason == "end_turn"
    assert result.message["content"][0]["text"] == "Correct"


# --- additional coverage ---


def test_short_circuit_model_not_called(model):
    """When middleware short-circuits, model.stream is never invoked."""

    agent = Agent(model=model, callback_handler=None)
    agent.model.stream = AsyncMock(wraps=agent.model.stream)

    usage = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    metrics = {"latencyMs": 0}

    async def cached(context, next_fn):
        msg = {"role": "assistant", "content": [{"text": "Cached"}]}
        yield ModelStopReason("end_turn", msg, Usage(**usage), Metrics(**metrics))

    agent._middleware_registry.add_middleware(InvokeModelStage, cached)
    agent("test")
    agent.model.stream.assert_not_called()


def test_hooks_fire_when_middleware_short_circuits(model):
    """Both BeforeModelCallEvent and AfterModelCallEvent fire even when middleware short-circuits."""

    hook_provider = MockHookProvider(event_types="all")
    agent = Agent(model=model, callback_handler=None, hooks=[hook_provider])

    usage = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    metrics = {"latencyMs": 0}

    async def cached(context, next_fn):
        msg = {"role": "assistant", "content": [{"text": "Cached"}]}
        yield ModelStopReason("end_turn", msg, Usage(**usage), Metrics(**metrics))

    agent._middleware_registry.add_middleware(InvokeModelStage, cached)
    agent("test")

    _, events = hook_provider.get_events()
    event_types = [type(e) for e in events]
    assert BeforeModelCallEvent in event_types
    assert AfterModelCallEvent in event_types


def test_phase_ordering_at_agent_level(model):
    """Input/Output/Wrap ordering works at agent level regardless of registration order."""
    order: list[str] = []

    def output_handler(result):
        order.append("output")
        return result

    async def wrap_handler(context, next_fn):
        order.append("wrap")
        async for event in next_fn(context):
            yield event

    def input_handler(context):
        order.append("input")
        return context

    agent = Agent(model=model, callback_handler=None)
    # Register in non-canonical order: output, wrap, input
    agent._middleware_registry.add_middleware(InvokeModelStage.Output, output_handler)
    agent._middleware_registry.add_middleware(InvokeModelStage, wrap_handler)
    agent._middleware_registry.add_middleware(InvokeModelStage.Input, input_handler)

    agent("test")
    assert order == ["input", "wrap", "output"]


def test_retry_on_error_use_case():
    """Middleware can retry model calls on transient errors."""
    call_count = 0

    class FlakyModel(MockedModelProvider):
        async def stream(self, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise RuntimeError("ThrottlingException")
            async for event in super().stream(*args, **kwargs):
                yield event

    model = FlakyModel([{"role": "assistant", "content": [{"text": "Success!"}]}])
    agent = Agent(model=model, callback_handler=None, retry_strategy=None)

    async def retry_middleware(context, next_fn):
        for attempt in range(3):
            try:
                async for event in next_fn(context):
                    yield event
                return
            except RuntimeError as e:
                if "ThrottlingException" not in str(e) or attempt == 2:
                    raise

    agent._middleware_registry.add_middleware(InvokeModelStage, retry_middleware)
    result = agent("test")
    assert result.message["content"][0]["text"] == "Success!"
    assert call_count == 3


# --- per-call model on context (routing plumbing) ---


def test_invoke_model_context_exposes_agent_model(agent):
    """InvokeModelContext.model defaults to agent.model."""
    captured: list = []

    async def capture(context, next_fn):
        captured.append(context.model)
        async for event in next_fn(context):
            yield event

    agent._middleware_registry.add_middleware(InvokeModelStage, capture)
    agent("test")

    assert captured == [agent.model]


def test_terminal_streams_context_model_override():
    """The terminal streams the model set on the context, not agent.model."""
    model_a = MockedModelProvider([{"role": "assistant", "content": [{"text": "A"}]}])
    model_b = MockedModelProvider(
        [{"role": "assistant", "content": [{"text": "B"}]}],
        [{"inputTokens": 1, "outputTokens": 12, "totalTokens": 13}],
    )
    model_b.config = {"model_id": "routed-model"}
    agent = Agent(model=model_a, callback_handler=None)
    model_a.stream = AsyncMock(wraps=model_a.stream)

    def route_to_b(context):
        return replace(context, model=model_b)

    agent._middleware_registry.add_middleware(InvokeModelStage.Input, route_to_b)
    result = agent("test")

    assert result.message["content"][0]["text"] == "B"
    model_a.stream.assert_not_called()
    samples = result.metrics.latest_agent_invocation.cycles[0].model_invocations
    assert [(sample.model_id, sample.output_tokens) for sample in samples] == [("routed-model", 12)]
    assert result.metrics.output_throughput_sample_count == 1
