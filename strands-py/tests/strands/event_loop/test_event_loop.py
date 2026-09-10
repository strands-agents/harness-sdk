import asyncio
import concurrent
import threading
import unittest.mock
from unittest.mock import ANY, AsyncMock, MagicMock, call, patch

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import strands
import strands._middleware
import strands.telemetry
from strands import Agent
from strands.event_loop._retry import ModelRetryStrategy
from strands.experimental.checkpoint import Checkpoint
from strands.hooks import (
    AfterModelCallEvent,
    AfterToolCallEvent,
    AfterToolsEvent,
    BeforeModelCallEvent,
    BeforeToolCallEvent,
    BeforeToolsEvent,
    HookRegistry,
    MessageAddedEvent,
)
from strands.interrupt import Interrupt, PendingToolExecution, _InterruptState
from strands.telemetry.metrics import EventLoopMetrics
from strands.telemetry.tracer import Tracer
from strands.tools.executors import ConcurrentToolExecutor, SequentialToolExecutor
from strands.tools.registry import ToolRegistry
from strands.types._events import EventLoopStopEvent
from strands.types.exceptions import (
    ContextWindowOverflowException,
    EventLoopException,
    MaxTokensReachedException,
    ModelThrottledException,
)
from tests.fixtures.mock_hook_provider import MockHookProvider
from tests.fixtures.mocked_model_provider import MockedModelProvider


@pytest.fixture
def mock_sleep():
    with patch.object(strands.event_loop._retry.asyncio, "sleep", new_callable=AsyncMock) as mock:
        yield mock


@pytest.fixture
def model():
    return unittest.mock.Mock()


@pytest.fixture
def system_prompt():
    return "p1"


@pytest.fixture
def messages():
    return [{"role": "user", "content": [{"text": "Hello"}]}]


@pytest.fixture
def tool_registry():
    return ToolRegistry()


@pytest.fixture
def thread_pool():
    return concurrent.futures.ThreadPoolExecutor(max_workers=1)


@pytest.fixture
def tool(tool_registry):
    @strands.tool
    def tool_for_testing(random_string: str):
        return random_string

    tool_registry.register_tool(tool_for_testing)

    return tool_for_testing


@pytest.fixture
def tool_times_2(tool_registry):
    @strands.tools.tool
    def multiply_by_2(x: int) -> int:
        return x * 2

    tool_registry.register_tool(multiply_by_2)

    return multiply_by_2


@pytest.fixture
def tool_times_5(tool_registry):
    @strands.tools.tool
    def multiply_by_5(x: int) -> int:
        return x * 5

    tool_registry.register_tool(multiply_by_5)

    return multiply_by_5


@pytest.fixture
def tool_stream(tool):
    return [
        {
            "contentBlockStart": {
                "start": {
                    "toolUse": {
                        "toolUseId": "t1",
                        "name": tool.tool_spec["name"],
                    },
                },
            },
        },
        {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"random_string": "abcdEfghI123"}'}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use"}},
    ]


@pytest.fixture
def hook_registry():
    registry = HookRegistry()
    # Register default retry strategy
    retry_strategy = ModelRetryStrategy()
    retry_strategy.register_hooks(registry)
    return registry


@pytest.fixture
def hook_provider(hook_registry):
    provider = MockHookProvider(event_types="all")
    hook_registry.add_hook(provider)
    return provider


@pytest.fixture
def tool_executor():
    return SequentialToolExecutor()


@pytest.fixture
def agent(model, system_prompt, messages, tool_registry, thread_pool, hook_registry, tool_executor):
    mock = unittest.mock.Mock(name="agent")
    mock.__class__ = Agent
    mock.config.cache_points = []
    mock.model = model
    mock.system_prompt = system_prompt
    mock.messages = messages
    mock.tool_registry = tool_registry
    mock.thread_pool = thread_pool
    mock.event_loop_metrics = EventLoopMetrics()
    mock.event_loop_metrics.reset_usage_metrics()
    mock.hooks = hook_registry
    mock.tool_executor = tool_executor
    mock._interrupt_state = _InterruptState()
    mock._cancel_signal = threading.Event()
    mock._background_tasks = None
    mock._observe_cancellation = mock._cancel_signal.is_set
    mock._model_state = {}
    mock._system_prompt_content = None
    mock._middleware_registry = strands._middleware.MiddlewareRegistry()
    mock._checkpointing = False
    mock._checkpoint = None
    mock._checkpoint_cycle_index = 0
    mock._checkpoint_resume_position = None
    mock.trace_attributes = {}
    mock.retry_strategy = ModelRetryStrategy()
    # Bind the real _append_messages chokepoint so appends assign tracking ids
    # and fire MessageAddedEvent exactly as production does.
    mock._append_messages = Agent._append_messages.__get__(mock, Agent)

    return mock


@pytest.fixture
def mock_tracer():
    tracer = MagicMock()
    tracer.start_event_loop_cycle_span.return_value = MagicMock()
    tracer.start_model_invoke_span.return_value = MagicMock()
    return tracer


@pytest.mark.asyncio
async def test_event_loop_cycle_text_response(
    agent,
    model,
    agenerator,
    alist,
):
    model.stream.return_value = agenerator(
        [
            {"contentBlockDelta": {"delta": {"text": "test text"}}},
            {"contentBlockStop": {}},
        ]
    )

    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    events = await alist(stream)
    tru_stop_reason, tru_message, _, tru_request_state, _, _, _ = events[-1]["stop"]

    exp_stop_reason = "end_turn"
    exp_message = {"role": "assistant", "content": [{"text": "test text"}], "metadata": ANY, "tracking_id": ANY}
    exp_request_state = {}

    assert tru_stop_reason == exp_stop_reason and tru_message == exp_message and tru_request_state == exp_request_state


@pytest.mark.asyncio
async def test_event_loop_cycle_text_response_throttling(
    mock_sleep,
    agent,
    model,
    agenerator,
    alist,
):
    model.stream.side_effect = [
        ModelThrottledException("ThrottlingException | ConverseStream"),
        agenerator(
            [
                {"contentBlockDelta": {"delta": {"text": "test text"}}},
                {"contentBlockStop": {}},
            ]
        ),
    ]

    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    events = await alist(stream)
    tru_stop_reason, tru_message, _, tru_request_state, _, _, _ = events[-1]["stop"]

    exp_stop_reason = "end_turn"
    exp_message = {"role": "assistant", "content": [{"text": "test text"}], "metadata": ANY, "tracking_id": ANY}
    exp_request_state = {}

    assert tru_stop_reason == exp_stop_reason and tru_message == exp_message and tru_request_state == exp_request_state
    # Verify that sleep was called once with the initial delay
    mock_sleep.assert_called_once()


@pytest.mark.asyncio
async def test_event_loop_cycle_exponential_backoff(
    mock_sleep,
    agent,
    model,
    agenerator,
    alist,
):
    """Test that the exponential backoff works correctly with multiple retries."""
    # Set up the model to raise throttling exceptions multiple times before succeeding
    model.stream.side_effect = [
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
        agenerator(
            [
                {"contentBlockDelta": {"delta": {"text": "test text"}}},
                {"contentBlockStop": {}},
            ]
        ),
    ]

    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    events = await alist(stream)
    tru_stop_reason, tru_message, _, tru_request_state, _, _, _ = events[-1]["stop"]

    # Verify the final response
    assert tru_stop_reason == "end_turn"
    assert tru_message == {"role": "assistant", "content": [{"text": "test text"}], "metadata": ANY, "tracking_id": ANY}
    assert tru_request_state == {}

    # Verify that sleep was called with increasing delays
    # Initial delay is 4, then 8, then 16
    assert mock_sleep.call_count == 3
    assert mock_sleep.call_args_list == [call(4), call(8), call(16)]


@pytest.mark.asyncio
async def test_event_loop_cycle_text_response_throttling_exceeded(
    mock_sleep,
    agent,
    model,
    alist,
):
    model.stream.side_effect = [
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
        ModelThrottledException("ThrottlingException | ConverseStream"),
    ]

    with pytest.raises(ModelThrottledException):
        stream = strands.event_loop.event_loop.event_loop_cycle(
            agent=agent,
            invocation_state={},
        )
        await alist(stream)

    mock_sleep.assert_has_calls(
        [
            call(4),
            call(8),
            call(16),
            call(32),
            call(64),
        ]
    )


@pytest.mark.asyncio
async def test_event_loop_cycle_text_response_error(
    agent,
    model,
    alist,
):
    model.stream.side_effect = RuntimeError("Unhandled error")

    with pytest.raises(RuntimeError):
        stream = strands.event_loop.event_loop.event_loop_cycle(
            agent=agent,
            invocation_state={},
        )
        await alist(stream)


@patch("strands.event_loop.event_loop.recover_message_on_max_tokens_reached")
@pytest.mark.asyncio
async def test_event_loop_cycle_tool_result(
    mock_recover_message,
    agent,
    model,
    system_prompt,
    messages,
    tool_stream,
    tool_registry,
    agenerator,
    alist,
):
    model.stream.side_effect = [
        agenerator(tool_stream),
        agenerator(
            [
                {"contentBlockDelta": {"delta": {"text": "test text"}}},
                {"contentBlockStop": {}},
            ]
        ),
    ]

    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    events = await alist(stream)
    tru_stop_reason, tru_message, _, tru_request_state, _, _, _ = events[-1]["stop"]

    exp_stop_reason = "end_turn"
    exp_message = {"role": "assistant", "content": [{"text": "test text"}], "metadata": ANY, "tracking_id": ANY}
    exp_request_state = {}

    assert tru_stop_reason == exp_stop_reason and tru_message == exp_message and tru_request_state == exp_request_state

    # Verify that recover_message_on_max_tokens_reached was NOT called for tool_use stop reason
    mock_recover_message.assert_not_called()

    model.stream.assert_called_with(
        [
            {"role": "user", "content": [{"text": "Hello"}]},
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": "t1",
                            "name": "tool_for_testing",
                            "input": {"random_string": "abcdEfghI123"},
                        }
                    }
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "t1",
                            "status": "success",
                            "content": [{"text": "abcdEfghI123"}],
                        },
                    },
                ],
            },
        ],
        tool_registry.get_all_tool_specs(),
        "p1",
        tool_choice=None,
        system_prompt_content=unittest.mock.ANY,
        invocation_state=unittest.mock.ANY,
        model_state=unittest.mock.ANY,
        cancel_signal=unittest.mock.ANY,
    )


@pytest.mark.asyncio
async def test_event_loop_cycle_tool_result_error(
    agent,
    model,
    tool_stream,
    agenerator,
    alist,
):
    model.stream.side_effect = [agenerator(tool_stream)]

    with pytest.raises(EventLoopException):
        stream = strands.event_loop.event_loop.event_loop_cycle(
            agent=agent,
            invocation_state={},
        )
        await alist(stream)


@pytest.mark.asyncio
async def test_event_loop_cycle_tool_result_no_tool_handler(
    agent,
    model,
    tool_stream,
    agenerator,
    alist,
):
    model.stream.side_effect = [agenerator(tool_stream)]
    # Set tool_handler to None for this test
    agent.tool_handler = None

    with pytest.raises(EventLoopException):
        stream = strands.event_loop.event_loop.event_loop_cycle(
            agent=agent,
            invocation_state={},
        )
        await alist(stream)


@pytest.mark.asyncio
async def test_event_loop_cycle_stop(
    agent,
    model,
    tool,
    agenerator,
    alist,
):
    model.stream.side_effect = [
        agenerator(
            [
                {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": "t1",
                                "name": tool.tool_spec["name"],
                            },
                        },
                    },
                },
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        ),
    ]

    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={"request_state": {"stop_event_loop": True}},
    )
    events = await alist(stream)
    tru_stop_reason, tru_message, _, tru_request_state, _, _, _ = events[-1]["stop"]

    exp_stop_reason = "tool_use"
    exp_message = {
        "role": "assistant",
        "content": [
            {
                "toolUse": {
                    "input": {},
                    "name": "tool_for_testing",
                    "toolUseId": "t1",
                }
            }
        ],
        "metadata": ANY,
        "tracking_id": ANY,
    }
    exp_request_state = {"stop_event_loop": True}

    assert tru_stop_reason == exp_stop_reason and tru_message == exp_message and tru_request_state == exp_request_state


@pytest.mark.asyncio
async def test_cycle_exception(
    agent,
    model,
    tool_stream,
    agenerator,
):
    model.stream.side_effect = [
        agenerator(tool_stream),
        agenerator(tool_stream),
        agenerator(tool_stream),
        ValueError("Invalid error presented"),
    ]

    tru_stop_event = None
    exp_stop_event = {"force_stop": True, "force_stop_reason": "Invalid error presented"}

    with pytest.raises(EventLoopException):
        stream = strands.event_loop.event_loop.event_loop_cycle(
            agent=agent,
            invocation_state={},
        )
        async for event in stream:
            tru_stop_event = event

    assert tru_stop_event == exp_stop_event


@pytest.mark.asyncio
async def test_cycle_exception_logs_exception_type_without_traceback(
    agent,
    model,
    tool_stream,
    agenerator,
    caplog,
):
    """A failed cycle logs the exception type at ERROR without attaching a full traceback.

    The ERROR-level cycle-failure record names the exception type and carries no exc_info, so the
    handler's exception arguments and stack frames are not emitted into application logs.
    """
    model.stream.side_effect = [
        agenerator(tool_stream),
        agenerator(tool_stream),
        agenerator(tool_stream),
        ValueError("Invalid error presented"),
    ]

    with caplog.at_level("DEBUG", logger="strands.event_loop.event_loop"):
        with pytest.raises(EventLoopException):
            stream = strands.event_loop.event_loop.event_loop_cycle(
                agent=agent,
                invocation_state={},
            )
            async for _event in stream:
                pass

    cycle_records = [r for r in caplog.records if "event loop cycle failed" in r.getMessage()]

    # The ERROR record names the exception type but carries no traceback (payload-free by default).
    error_records = [record for record in cycle_records if record.levelname == "ERROR"]
    assert error_records
    cycle_record = error_records[0]
    assert "ValueError" in cycle_record.getMessage()
    assert cycle_record.exc_info is None

    # The full traceback remains available opt-in at DEBUG.
    debug_records = [record for record in cycle_records if record.levelname == "DEBUG"]
    assert debug_records
    assert debug_records[0].exc_info is not None


@pytest.mark.asyncio
async def test_post_stream_exception_logs_exception_type_without_traceback(
    agent,
    model,
    agenerator,
    alist,
    caplog,
):
    """A failure while finalizing a completed stream logs the type at ERROR and the traceback at DEBUG.

    This exercises the post-stream handler (the metrics/message-append block) rather than the
    model-invocation handler, so both cycle-failure log sites share the same payload-free behavior.
    """
    model.stream.return_value = agenerator(
        [
            {"contentBlockDelta": {"delta": {"text": "test text"}}},
            {"contentBlockStop": {}},
        ]
    )
    agent.event_loop_metrics.update_metrics = MagicMock(side_effect=ValueError("Invalid error presented"))

    with caplog.at_level("DEBUG", logger="strands.event_loop.event_loop"):
        with pytest.raises(EventLoopException):
            stream = strands.event_loop.event_loop.event_loop_cycle(
                agent=agent,
                invocation_state={},
            )
            await alist(stream)

    cycle_records = [r for r in caplog.records if "event loop cycle failed" in r.getMessage()]

    error_records = [record for record in cycle_records if record.levelname == "ERROR"]
    assert error_records
    assert "ValueError" in error_records[0].getMessage()
    assert error_records[0].exc_info is None

    debug_records = [record for record in cycle_records if record.levelname == "DEBUG"]
    assert debug_records
    assert debug_records[0].exc_info is not None


@patch("strands.event_loop.event_loop.get_tracer")
@pytest.mark.asyncio
async def test_event_loop_cycle_creates_spans(
    mock_get_tracer,
    agent,
    model,
    mock_tracer,
    agenerator,
    alist,
):
    # Setup
    mock_get_tracer.return_value = mock_tracer
    cycle_span = MagicMock()
    mock_tracer.start_event_loop_cycle_span.return_value = cycle_span
    model_span = MagicMock()
    mock_tracer.start_model_invoke_span.return_value = model_span

    model.stream.return_value = agenerator(
        [
            {"contentBlockDelta": {"delta": {"text": "test text"}}},
            {"contentBlockStop": {}},
        ]
    )

    # Call event_loop_cycle
    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    await alist(stream)

    # Verify tracer methods were called correctly
    mock_get_tracer.assert_called_once()
    mock_tracer.start_event_loop_cycle_span.assert_called_once()
    mock_tracer.start_model_invoke_span.assert_called_once()
    call_kwargs = mock_tracer.start_model_invoke_span.call_args[1]
    assert call_kwargs["system_prompt"] == agent.system_prompt
    assert call_kwargs["system_prompt_content"] == [{"text": agent.system_prompt}]
    mock_tracer.end_model_invoke_span.assert_called_once()
    mock_tracer.end_event_loop_cycle_span.assert_called_once()


@patch("strands.event_loop.event_loop.get_tracer")
@pytest.mark.asyncio
async def test_event_loop_tracing_with_model_error(
    mock_get_tracer,
    agent,
    model,
    mock_tracer,
    alist,
):
    # Setup
    mock_get_tracer.return_value = mock_tracer
    cycle_span = MagicMock()
    mock_tracer.start_event_loop_cycle_span.return_value = cycle_span
    model_span = MagicMock()
    mock_tracer.start_model_invoke_span.return_value = model_span

    # Set up model to raise an exception
    model.stream.side_effect = ContextWindowOverflowException("Input too long")

    # Call event_loop_cycle, expecting it to handle the exception
    with pytest.raises(ContextWindowOverflowException):
        stream = strands.event_loop.event_loop.event_loop_cycle(
            agent=agent,
            invocation_state={},
        )
        await alist(stream)

    assert mock_tracer.end_span_with_error.call_count == 2
    mock_tracer.end_span_with_error.assert_has_calls(
        [
            call(model_span, "Input too long", model.stream.side_effect),
            call(cycle_span, "Input too long", model.stream.side_effect),
        ]
    )


@pytest.mark.asyncio
async def test_event_loop_cycle_max_tokens_exception(
    agent,
    model,
    agenerator,
    alist,
):
    """Test that max_tokens stop reason calls _recover_message_on_max_tokens_reached then MaxTokensReachedException."""

    model.stream.side_effect = [
        agenerator(
            [
                {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": "t1",
                                "name": "asdf",
                                "input": {},  # empty
                            },
                        },
                    },
                },
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "max_tokens"}},
            ]
        ),
    ]

    # Call event_loop_cycle, expecting it to raise MaxTokensReachedException
    expected_message = (
        "Model stopped generating due to maximum token limit. "
        "The partial message has been added to the conversation history. "
        "You can continue by calling the agent again. "
        "For more information see: "
        "https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/#maxtokensreachedexception"
    )
    with pytest.raises(MaxTokensReachedException, match=expected_message):
        stream = strands.event_loop.event_loop.event_loop_cycle(
            agent=agent,
            invocation_state={},
        )
        await alist(stream)

    # Verify the exception message contains the expected content
    assert len(agent.messages) == 2
    assert "tool use was incomplete due" in agent.messages[1]["content"][0]["text"]


@patch("strands.event_loop.event_loop.get_tracer")
@pytest.mark.asyncio
async def test_event_loop_tracing_with_tool_execution(
    mock_get_tracer,
    agent,
    model,
    tool_stream,
    mock_tracer,
    agenerator,
    alist,
):
    # Setup
    mock_get_tracer.return_value = mock_tracer
    cycle_span = MagicMock()
    mock_tracer.start_event_loop_cycle_span.return_value = cycle_span
    model_span = MagicMock()
    mock_tracer.start_model_invoke_span.return_value = model_span

    # Set up model to return tool use and then text response
    model.stream.side_effect = [
        agenerator(tool_stream),
        agenerator(
            [
                {"contentBlockDelta": {"delta": {"text": "test text"}}},
                {"contentBlockStop": {}},
            ]
        ),
    ]

    # Call event_loop_cycle which should execute a tool
    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    await alist(stream)

    # Verify the parent_span parameter is passed to run_tools
    # At a minimum, verify both model spans were created (one for each model invocation)
    assert mock_tracer.start_model_invoke_span.call_count == 2
    assert mock_tracer.end_model_invoke_span.call_count == 2


@pytest.mark.asyncio
async def test_event_loop_cycle_closes_cycle_span_before_recursive_cycle(
    agent,
    model,
    tool_stream,
    agenerator,
    alist,
):
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))

    tracer = Tracer()
    tracer.tracer_provider = provider
    tracer.tracer = provider.get_tracer(tracer.service_name)

    async def delayed_text_stream():
        yield {"contentBlockDelta": {"delta": {"text": "test text"}}}
        await asyncio.sleep(0.05)
        yield {"contentBlockStop": {}}

    agent.trace_span = None
    agent._system_prompt_content = None
    model.config = {"model_id": "test-model"}
    model.stream.side_effect = [
        agenerator(tool_stream),
        delayed_text_stream(),
    ]

    with patch("strands.event_loop.event_loop.get_tracer", return_value=tracer):
        stream = strands.event_loop.event_loop.event_loop_cycle(
            agent=agent,
            invocation_state={},
        )
        await alist(stream)

    provider.force_flush()
    cycle_spans = sorted(
        [span for span in exporter.get_finished_spans() if span.name == "execute_event_loop_cycle"],
        key=lambda span: span.start_time,
    )

    assert len(cycle_spans) == 2
    assert cycle_spans[0].end_time <= cycle_spans[1].start_time
    assert cycle_spans[0].end_time < cycle_spans[1].end_time


@patch("strands.event_loop.event_loop.get_tracer")
@pytest.mark.asyncio
async def test_event_loop_tracing_with_throttling_exception(
    mock_get_tracer,
    agent,
    model,
    mock_tracer,
    agenerator,
    alist,
):
    # Setup
    mock_get_tracer.return_value = mock_tracer
    cycle_span = MagicMock()
    mock_tracer.start_event_loop_cycle_span.return_value = cycle_span
    model_span = MagicMock()
    mock_tracer.start_model_invoke_span.return_value = model_span

    # Set up model to raise a throttling exception and then succeed
    model.stream.side_effect = [
        ModelThrottledException("Throttling Error"),
        agenerator(
            [
                {"contentBlockDelta": {"delta": {"text": "test text"}}},
                {"contentBlockStop": {}},
            ]
        ),
    ]

    # Mock the time.sleep function to speed up the test
    with patch.object(asyncio, "sleep", new_callable=unittest.mock.AsyncMock):
        stream = strands.event_loop.event_loop.event_loop_cycle(
            agent=agent,
            invocation_state={},
        )
        await alist(stream)

    assert mock_tracer.end_span_with_error.call_count == 1
    # Verify span was created for the successful retry
    assert mock_tracer.start_model_invoke_span.call_count == 2
    assert mock_tracer.end_model_invoke_span.call_count == 1


@patch("strands.event_loop.event_loop.get_tracer")
@pytest.mark.asyncio
async def test_event_loop_cycle_with_parent_span(
    mock_get_tracer,
    agent,
    model,
    messages,
    mock_tracer,
    agenerator,
    alist,
):
    # Setup
    mock_get_tracer.return_value = mock_tracer
    parent_span = MagicMock()
    cycle_span = MagicMock()
    mock_tracer.start_event_loop_cycle_span.return_value = cycle_span

    model.stream.return_value = agenerator(
        [
            {"contentBlockDelta": {"delta": {"text": "test text"}}},
            {"contentBlockStop": {}},
        ]
    )

    # Set the parent span for this test
    agent.trace_span = parent_span

    # Call event_loop_cycle with a parent span
    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    await alist(stream)

    # Verify parent_span was used when creating cycle span
    mock_tracer.start_event_loop_cycle_span.assert_called_once_with(
        invocation_state=unittest.mock.ANY,
        parent_span=parent_span,
        messages=messages,
        custom_trace_attributes=unittest.mock.ANY,
    )


@pytest.mark.asyncio
async def test_request_state_initialization(alist):
    # Create a mock agent
    mock_agent = MagicMock()
    # not setting this to False results in endless recursion
    mock_agent._interrupt_state.activated = False
    mock_agent._cancel_signal = threading.Event()
    mock_agent._observe_cancellation = mock_agent._cancel_signal.is_set
    mock_agent._system_prompt_content = None
    mock_agent.system_prompt = None
    mock_agent._model_state = {}
    mock_agent._middleware_registry = strands._middleware.MiddlewareRegistry()
    mock_agent.messages = []
    mock_agent.tool_registry.get_all_tool_specs.return_value = []
    mock_agent.event_loop_metrics.start_cycle.return_value = (0, MagicMock())
    mock_agent.hooks.invoke_callbacks_async = AsyncMock(side_effect=lambda event: (event, []))
    mock_agent._append_messages = Agent._append_messages.__get__(mock_agent, Agent)

    # Call without providing request_state
    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=mock_agent,
        invocation_state={},
    )
    events = await alist(stream)
    _, _, _, tru_request_state, _, _, _ = events[-1]["stop"]

    # Verify request_state was initialized to empty dict
    assert tru_request_state == {}

    # Call with pre-existing request_state
    initial_request_state = {"key": "value"}
    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=mock_agent,
        invocation_state={"request_state": initial_request_state},
    )
    events = await alist(stream)
    _, _, _, tru_request_state, _, _, _ = events[-1]["stop"]

    # Verify existing request_state was preserved
    assert tru_request_state == initial_request_state


@pytest.mark.asyncio
async def test_prepare_next_cycle_in_tool_execution(agent, model, tool_stream, agenerator, alist):
    """Test that cycle ID and metrics are properly updated during tool execution."""
    model.stream.side_effect = [
        agenerator(tool_stream),
        agenerator(
            [
                {"contentBlockStop": {}},
            ]
        ),
    ]

    # Create a mock for recurse_event_loop to capture the invocation_state passed to it
    with unittest.mock.patch.object(strands.event_loop.event_loop, "recurse_event_loop") as mock_recurse:
        # Set up mock to return a valid response
        mock_recurse.return_value = agenerator(
            [
                (
                    "end_turn",
                    {"role": "assistant", "content": [{"text": "test text"}]},
                    strands.telemetry.metrics.EventLoopMetrics(),
                    {},
                ),
            ]
        )

        # Call event_loop_cycle which should execute a tool and then call recurse_event_loop
        stream = strands.event_loop.event_loop.event_loop_cycle(
            agent=agent,
            invocation_state={},
        )
        await alist(stream)

        assert mock_recurse.called

        # Verify required properties are present
        recursive_args = mock_recurse.call_args[1]
        assert "event_loop_parent_cycle_id" in recursive_args["invocation_state"]
        assert (
            recursive_args["invocation_state"]["event_loop_parent_cycle_id"]
            == recursive_args["invocation_state"]["event_loop_cycle_id"]
        )


@pytest.mark.asyncio
async def test_event_loop_cycle_exception_model_hooks(mock_sleep, agent, model, agenerator, alist, hook_provider):
    """Test that model hooks are correctly emitted even when throttled."""
    # Set up the model to raise throttling exceptions multiple times before succeeding
    exception = ModelThrottledException("ThrottlingException | ConverseStream")
    model.stream.side_effect = [
        exception,
        exception,
        exception,
        agenerator(
            [
                {"contentBlockDelta": {"delta": {"text": "test text"}}},
                {"contentBlockStop": {}},
            ]
        ),
    ]

    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    await alist(stream)

    count, events = hook_provider.get_events()

    assert count == 9

    # 1st call - throttled
    assert next(events) == BeforeModelCallEvent(agent=agent, invocation_state=ANY)
    expected_after = AfterModelCallEvent(agent=agent, invocation_state=ANY, stop_response=None, exception=exception)
    expected_after.retry = True
    assert next(events) == expected_after

    # 2nd call - throttled
    assert next(events) == BeforeModelCallEvent(agent=agent, invocation_state=ANY)
    expected_after = AfterModelCallEvent(agent=agent, invocation_state=ANY, stop_response=None, exception=exception)
    expected_after.retry = True
    assert next(events) == expected_after

    # 3rd call - throttled
    assert next(events) == BeforeModelCallEvent(agent=agent, invocation_state=ANY)
    expected_after = AfterModelCallEvent(agent=agent, invocation_state=ANY, stop_response=None, exception=exception)
    expected_after.retry = True
    assert next(events) == expected_after

    # 4th call - successful
    assert next(events) == BeforeModelCallEvent(agent=agent, invocation_state=ANY)
    assert next(events) == AfterModelCallEvent(
        agent=agent,
        invocation_state=ANY,
        stop_response=AfterModelCallEvent.ModelStopResponse(
            message={"content": [{"text": "test text"}], "role": "assistant", "metadata": ANY, "tracking_id": ANY},
            stop_reason="end_turn",
        ),
        exception=None,
    )

    # Final message
    assert next(events) == MessageAddedEvent(
        agent=agent,
        message={"content": [{"text": "test text"}], "role": "assistant", "metadata": ANY, "tracking_id": ANY},
    )


@pytest.mark.asyncio
async def test_event_loop_cycle_before_tools_payload_order_and_result(agent, model, tool_stream, agenerator, alist):
    callback_order = []
    before_tools_events = []

    def before_tools_callback(event):
        callback_order.append("before_tools")
        before_tools_events.append(event)

    def before_tool_callback(event):
        callback_order.append("before_tool")

    agent.hooks.add_callback(BeforeToolsEvent, before_tools_callback)
    agent.hooks.add_callback(BeforeToolCallEvent, before_tool_callback)
    model.stream.side_effect = [
        agenerator(tool_stream),
        agenerator([{"contentBlockDelta": {"delta": {"text": "done"}}}, {"contentBlockStop": {}}]),
    ]

    await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    tru_order = callback_order
    exp_order = ["before_tools", "before_tool"]
    assert tru_order == exp_order

    tru_event = before_tools_events[0]
    assert tru_event.agent is agent
    assert tru_event.message is agent.messages[1]
    assert tru_event.message["role"] == "assistant"
    assert tru_event.message["content"][0]["toolUse"]["toolUseId"] == "t1"
    assert tru_event.invocation_state["request_state"] == {}


@pytest.mark.asyncio
async def test_event_loop_cycle_before_tools_fires_once_per_batch(agent, model, tool, tool_times_2, agenerator, alist):
    before_tools_count = 0

    def count_before_tools(event):
        nonlocal before_tools_count
        before_tools_count += 1

    agent.hooks.add_callback(BeforeToolsEvent, count_before_tools)
    model.stream.side_effect = [
        agenerator(
            [
                {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t1", "name": tool.tool_name}}}},
                {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"random_string": "first"}'}}}},
                {"contentBlockStop": {}},
                {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t2", "name": tool_times_2.tool_name}}}},
                {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"x": 2}'}}}},
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        ),
        agenerator([{"contentBlockDelta": {"delta": {"text": "done"}}}, {"contentBlockStop": {}}]),
    ]

    await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    assert before_tools_count == 1


@pytest.mark.asyncio
async def test_event_loop_cycle_after_tools_order_and_message(agent, model, tool_stream, agenerator, alist):
    callback_order = []
    after_tools_events = []

    def before_tools_callback(event):
        callback_order.append("before_tools")

    def after_tool_callback(event):
        callback_order.append("after_tool")

    def after_tools_callback(event):
        callback_order.append("after_tools")
        after_tools_events.append(event)

    agent.hooks.add_callback(BeforeToolsEvent, before_tools_callback)
    agent.hooks.add_callback(AfterToolCallEvent, after_tool_callback)
    agent.hooks.add_callback(AfterToolsEvent, after_tools_callback)
    model.stream.side_effect = [
        agenerator(tool_stream),
        agenerator([{"contentBlockDelta": {"delta": {"text": "done"}}}, {"contentBlockStop": {}}]),
    ]

    await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    tru_order = callback_order
    exp_order = ["before_tools", "after_tool", "after_tools"]
    assert tru_order == exp_order

    tru_event = after_tools_events[0]
    assert tru_event.agent is agent
    assert tru_event.message["role"] == "user"
    assert tru_event.message["content"][0]["toolResult"]["toolUseId"] == "t1"
    assert tru_event.end_turn is False


@pytest.mark.asyncio
@pytest.mark.parametrize("executor_type", [SequentialToolExecutor, ConcurrentToolExecutor])
@pytest.mark.parametrize(
    ("end_turn", "expected_content"),
    [
        (True, [{"text": "Turn ended early by hook after tool execution"}]),
        ("stop now", [{"text": "stop now"}]),
        ([{"text": "delegated"}], [{"text": "delegated"}]),
    ],
)
async def test_event_loop_cycle_after_tools_end_turn_halts_loop(
    agent, model, tool_stream, agenerator, alist, executor_type, end_turn, expected_content
):
    agent.tool_executor = executor_type()

    def set_end_turn(event):
        event.end_turn = end_turn

    agent.hooks.add_callback(AfterToolsEvent, set_end_turn)
    # Only one model call should happen — the loop must not recurse.
    model.stream.side_effect = [agenerator(tool_stream)]

    events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    tru_stop_reason = events[-1]["stop"][0]
    assert tru_stop_reason == "end_turn"
    assert model.stream.call_count == 1
    tru_last_message = agent.messages[-1]
    assert tru_last_message["role"] == "assistant"
    assert tru_last_message["content"] == expected_content
    assert events[-1]["stop"][1]["content"] == expected_content


@pytest.mark.asyncio
async def test_event_loop_cycle_after_tools_message_reflects_mutated_result(
    agent, model, tool_stream, agenerator, alist
):
    after_tools_messages = []

    def mutate_result(event):
        event.result = {"toolUseId": "t1", "status": "success", "content": [{"text": "mutated"}]}

    def record_after_tools(event):
        after_tools_messages.append(event.message)

    agent.hooks.add_callback(AfterToolCallEvent, mutate_result)
    agent.hooks.add_callback(AfterToolsEvent, record_after_tools)
    model.stream.side_effect = [
        agenerator(tool_stream),
        agenerator([{"contentBlockDelta": {"delta": {"text": "done"}}}, {"contentBlockStop": {}}]),
    ]

    await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    # A result mutated in AfterToolCallEvent is reflected in the AfterToolsEvent batch message.
    assert len(after_tools_messages) == 1
    assert after_tools_messages[0]["content"] == [
        {"toolResult": {"toolUseId": "t1", "status": "success", "content": [{"text": "mutated"}]}}
    ]


@pytest.mark.asyncio
async def test_event_loop_cycle_after_tools_message_preserves_source_order_concurrent(
    agent, model, tool, tool_times_2, agenerator, alist
):
    agent.tool_executor = ConcurrentToolExecutor()
    after_tools_messages = []

    agent.hooks.add_callback(AfterToolsEvent, lambda event: after_tools_messages.append(event.message))
    model.stream.side_effect = [
        agenerator(
            [
                {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t1", "name": tool.tool_name}}}},
                {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"random_string": "first"}'}}}},
                {"contentBlockStop": {}},
                {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t2", "name": tool_times_2.tool_name}}}},
                {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"x": 2}'}}}},
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        ),
        agenerator([{"contentBlockDelta": {"delta": {"text": "done"}}}, {"contentBlockStop": {}}]),
    ]

    await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    # AfterToolsEvent.message preserves the source order of tool uses even under concurrent execution.
    assert len(after_tools_messages) == 1
    tru_ids = [content["toolResult"]["toolUseId"] for content in after_tools_messages[0]["content"]]
    assert tru_ids == ["t1", "t2"]


@pytest.mark.asyncio
async def test_event_loop_cycle_after_tools_fires_on_batch_cancel(agent, model, tool_stream, agenerator, alist):
    after_tools_messages = []

    def cancel_batch(event):
        event.cancel = "Batch cancelled"

    def record_after_tools(event):
        after_tools_messages.append(event.message)
        event.end_turn = True

    agent.hooks.add_callback(BeforeToolsEvent, cancel_batch)
    agent.hooks.add_callback(AfterToolsEvent, record_after_tools)
    model.stream.side_effect = [agenerator(tool_stream)]

    events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    # AfterToolsEvent fires even though the batch was cancelled, and its end_turn halts the loop.
    assert len(after_tools_messages) == 1
    tru_after_content = after_tools_messages[0]["content"]
    exp_after_content = [
        {"toolResult": {"toolUseId": "t1", "status": "error", "content": [{"text": "Batch cancelled"}]}}
    ]
    assert tru_after_content == exp_after_content
    assert events[-1]["stop"][0] == "end_turn"
    assert model.stream.call_count == 1


@pytest.mark.asyncio
async def test_event_loop_cycle_after_tools_fires_when_tool_hook_raises(agent, model, tool_stream, agenerator, alist):
    after_tools_calls = []

    def raise_in_after_tool(event):
        raise RuntimeError("after tool hook failed")

    def record_after_tools(event):
        after_tools_calls.append(event)

    agent.hooks.add_callback(AfterToolCallEvent, raise_in_after_tool)
    agent.hooks.add_callback(AfterToolsEvent, record_after_tools)
    model.stream.side_effect = [agenerator(tool_stream)]

    with pytest.raises(EventLoopException, match="after tool hook failed"):
        await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    # AfterToolsEvent still fires on the error path.
    assert len(after_tools_calls) == 1


@pytest.mark.asyncio
async def test_event_loop_cycle_interrupts_preserved_when_after_tools_hook_raises(
    agent, model, tool_stream, agenerator, alist
):
    """Per-tool interrupts are persisted even when an AfterToolsEvent hook raises."""

    def interrupt_tool(event):
        event.interrupt("approval", "Approve?")

    def raise_in_after_tools(event):
        raise RuntimeError("after tools hook failed")

    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_tool)
    agent.hooks.add_callback(AfterToolsEvent, raise_in_after_tools)
    model.stream.side_effect = [agenerator(tool_stream)]

    with pytest.raises(EventLoopException, match="after tools hook failed"):
        await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    # Interrupt state was preserved before the exception propagated.
    assert agent._interrupt_state.activated
    assert agent._interrupt_state.pending_tool_execution == PendingToolExecution(
        assistant_message=agent.messages[-1],
        completed_tool_results=[],
    )


@pytest.mark.asyncio
async def test_event_loop_cycle_after_tools_not_fired_on_before_tools_interrupt(
    agent, model, tool_stream, agenerator, alist
):
    after_tools_calls = []

    def interrupt_batch(event):
        event.interrupt("approval", "Approve?")

    def record_after_tools(event):
        after_tools_calls.append(event)

    agent.hooks.add_callback(BeforeToolsEvent, interrupt_batch)
    agent.hooks.add_callback(AfterToolsEvent, record_after_tools)
    model.stream.side_effect = [agenerator(tool_stream)]

    events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    assert events[-1]["stop"][0] == "interrupt"
    # A BeforeToolsEvent interrupt short-circuits before the tool batch, so AfterToolsEvent does not fire.
    assert after_tools_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("falsy_end_turn", ["", []])
async def test_event_loop_cycle_after_tools_falsy_end_turn_does_not_halt(
    agent, model, tool_stream, agenerator, alist, falsy_end_turn
):
    def set_falsy_end_turn(event):
        event.end_turn = falsy_end_turn

    agent.hooks.add_callback(AfterToolsEvent, set_falsy_end_turn)
    model.stream.side_effect = [
        agenerator(tool_stream),
        agenerator([{"contentBlockDelta": {"delta": {"text": "done"}}}, {"contentBlockStop": {}}]),
    ]

    events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    # A falsy end_turn does not halt — the loop continues to the next model call.
    assert events[-1]["stop"][0] == "end_turn"
    assert model.stream.call_count == 2


@pytest.mark.asyncio
async def test_event_loop_cycle_after_tools_end_turn_list_not_aliased(agent, model, tool_stream, agenerator, alist):
    hook_list = [{"text": "from hook"}]

    def set_list_end_turn(event):
        event.end_turn = hook_list

    agent.hooks.add_callback(AfterToolsEvent, set_list_end_turn)
    model.stream.side_effect = [agenerator(tool_stream)]

    await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    # Mutate the hook's list after the invocation returns.
    hook_list.append({"text": "MUTATED AFTER THE FACT"})

    # The committed message must be unchanged — the event loop shallow-copied.
    assert agent.messages[-1]["content"] == [{"text": "from hook"}]


@pytest.mark.asyncio
async def test_event_loop_cycle_after_tools_fires_on_per_tool_interrupt(agent, model, tool_stream, agenerator, alist):
    after_tools_calls = []

    def interrupt_tool(event):
        event.interrupt("approval", "Approve?")

    def record_after_tools(event):
        after_tools_calls.append(event)

    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_tool)
    agent.hooks.add_callback(AfterToolsEvent, record_after_tools)
    model.stream.side_effect = [agenerator(tool_stream)]

    events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    # A per-tool interrupt stops the batch, but AfterToolsEvent still fires.
    assert events[-1]["stop"][0] == "interrupt"
    assert len(after_tools_calls) == 1


@pytest.mark.asyncio
async def test_event_loop_cycle_after_tools_fires_per_cycle_across_per_tool_interrupt_resume(
    agent, model, tool, tool_times_2, agenerator, alist
):
    """AfterToolsEvent fires once per event-loop cycle, not once per logical batch.

    A per-tool interrupt splits one batch across two cycles, so the event fires twice.
    """
    agent.tool_executor = SequentialToolExecutor()
    after_tools_ids = []

    def interrupt_second_tool(event):
        if event.tool_use["name"] == tool_times_2.tool_name:
            event.interrupt("approval", "Approve?")

    def record_after_tools(event):
        after_tools_ids.append([content["toolResult"]["toolUseId"] for content in event.message["content"]])

    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_second_tool)
    agent.hooks.add_callback(AfterToolsEvent, record_after_tools)
    model.stream.side_effect = [
        agenerator(
            [
                {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t1", "name": tool.tool_name}}}},
                {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"random_string": "first"}'}}}},
                {"contentBlockStop": {}},
                {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t2", "name": tool_times_2.tool_name}}}},
                {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"x": 2}'}}}},
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        ),
        agenerator([{"contentBlockDelta": {"delta": {"text": "done"}}}, {"contentBlockStop": {}}]),
    ]

    first_events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))
    stop_reason, _, _, _, interrupts, _, _ = first_events[-1]["stop"]

    # Interrupt cycle: t1 completed, t2 was interrupted, so the batch message is partial.
    assert stop_reason == "interrupt"
    assert after_tools_ids == [["t1"]]

    agent._interrupt_state.resume([{"interruptResponse": {"interruptId": interrupts[0].id, "response": "approved"}}])
    resumed_events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    # Resume cycle: fires a second time for the same logical batch, now with the full result set.
    assert resumed_events[-1]["stop"][0] == "end_turn"
    assert after_tools_ids == [["t1"], ["t1", "t2"]]


@pytest.mark.asyncio
@pytest.mark.parametrize("executor_type", [SequentialToolExecutor, ConcurrentToolExecutor])
@pytest.mark.parametrize(
    ("cancel", "expected_text"),
    [(True, "Tool cancelled by hook"), ("Batch cancelled", "Batch cancelled")],
)
async def test_event_loop_cycle_before_tools_cancels_batch(
    agent, model, tool, tool_times_2, agenerator, alist, executor_type, cancel, expected_text
):
    agent.tool_executor = executor_type()
    assistant_message = {
        "role": "assistant",
        "content": [
            {
                "toolUse": {
                    "toolUseId": "t1",
                    "name": tool.tool_name,
                    "input": {"random_string": "first"},
                }
            },
            {
                "toolUse": {
                    "toolUseId": "t2",
                    "name": tool_times_2.tool_name,
                    "input": {"x": 2},
                }
            },
        ],
    }
    model.stream.side_effect = [
        agenerator(
            [
                {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": "t1",
                                "name": tool.tool_name,
                            }
                        }
                    }
                },
                {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"random_string": "first"}'}}}},
                {"contentBlockStop": {}},
                {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": "t2",
                                "name": tool_times_2.tool_name,
                            }
                        }
                    }
                },
                {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"x": 2}'}}}},
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        ),
        agenerator([{"contentBlockDelta": {"delta": {"text": "done"}}}, {"contentBlockStop": {}}]),
    ]
    per_tool_events = []
    executor = agent.tool_executor
    executor._execute = MagicMock(wraps=executor._execute)

    def cancel_batch(event):
        event.cancel = cancel

    def record_per_tool(event):
        per_tool_events.append(event)

    agent.hooks.add_callback(BeforeToolsEvent, cancel_batch)
    agent.hooks.add_callback(BeforeToolCallEvent, record_per_tool)

    events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    tru_results = [event.tool_result for event in events if event.get("type") == "tool_result"]
    exp_results = [
        {"toolUseId": "t1", "status": "error", "content": [{"text": expected_text}]},
        {"toolUseId": "t2", "status": "error", "content": [{"text": expected_text}]},
    ]
    assert tru_results == exp_results
    assert per_tool_events == []
    executor._execute.assert_not_called()
    assert agent.messages[1]["role"] == assistant_message["role"]
    assert agent.messages[2]["content"] == [{"toolResult": result} for result in exp_results]
    assert model.stream.call_count == 2


@pytest.mark.asyncio
async def test_event_loop_cycle_before_tools_hook_cancel_precedes_agent_cancel(
    agent, model, tool_stream, agenerator, alist
):
    def cancel_hook_and_agent(event):
        event.agent._cancel_signal.set()
        event.cancel = "hook wins"

    agent.hooks.add_callback(BeforeToolsEvent, cancel_hook_and_agent)
    model.stream.side_effect = [agenerator(tool_stream)]

    events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    tru_results = [event.tool_result for event in events if event.get("type") == "tool_result"]
    exp_results = [{"toolUseId": "t1", "status": "error", "content": [{"text": "hook wins"}]}]
    assert tru_results == exp_results
    assert events[-1]["stop"][0] == "cancelled"


@pytest.mark.asyncio
async def test_event_loop_cycle_agent_cancel_from_before_tools_uses_batch_results(
    agent, model, tool_stream, agenerator, alist
):
    def cancel_agent(event):
        event.agent._cancel_signal.set()

    agent.hooks.add_callback(BeforeToolsEvent, cancel_agent)
    model.stream.side_effect = [agenerator(tool_stream)]

    events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    tru_results = [event.tool_result for event in events if event.get("type") == "tool_result"]
    exp_results = [{"toolUseId": "t1", "status": "error", "content": [{"text": "Tool execution cancelled"}]}]
    assert tru_results == exp_results
    assert agent.messages[-1]["content"] == [{"toolResult": exp_results[0]}]
    assert events[-1]["stop"][0] == "cancelled"
    assert model.stream.call_count == 1


@pytest.mark.asyncio
async def test_event_loop_cycle_before_tools_hook_exception_skips_execution(
    agent, model, tool_stream, agenerator, alist
):
    executor = agent.tool_executor
    executor._execute = MagicMock(wraps=executor._execute)
    after_tools_calls = []

    def raise_error(event):
        raise RuntimeError("batch hook failed")

    agent.hooks.add_callback(BeforeToolsEvent, raise_error)
    agent.hooks.add_callback(AfterToolsEvent, lambda event: after_tools_calls.append(event))
    model.stream.side_effect = [agenerator(tool_stream)]

    with pytest.raises(EventLoopException, match="batch hook failed"):
        await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    # Hook exception propagates before tools execute; AfterToolsEvent never fires.
    executor._execute.assert_not_called()
    assert after_tools_calls == []


@pytest.mark.asyncio
async def test_event_loop_cycle_before_tools_cancel_includes_invalid_tool(agent, alist):
    assistant_message = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "bad", "name": "invalid tool", "input": {}}}],
    }
    agent.messages.append(assistant_message)
    executor = agent.tool_executor
    executor._execute = MagicMock(wraps=executor._execute)

    def cancel_batch(event):
        event.cancel = "Batch cancelled"

    agent.hooks.add_callback(BeforeToolsEvent, cancel_batch)

    events = await alist(
        strands.event_loop.event_loop.event_loop_cycle(
            agent,
            invocation_state={"request_state": {"stop_event_loop": True}},
        )
    )

    tru_results = [event.tool_result for event in events if event.get("type") == "tool_result"]
    exp_results = [{"toolUseId": "bad", "status": "error", "content": [{"text": "Batch cancelled"}]}]
    assert tru_results == exp_results
    executor._execute.assert_not_called()


@pytest.mark.asyncio
async def test_event_loop_cycle_before_tools_interrupt_invalid_tool_result_not_duplicated(agent, alist):
    assistant_message = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "bad", "name": "invalid tool", "input": {}}}],
    }
    agent.messages.append(assistant_message)
    interrupt_response = None

    def interrupt_batch(event):
        nonlocal interrupt_response
        interrupt_response = event.interrupt("approval", "Approve?")

    agent.hooks.add_callback(BeforeToolsEvent, interrupt_batch)

    first_events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))
    _, _, _, _, interrupts, _, _ = first_events[-1]["stop"]
    interrupt = interrupts[0]
    agent._interrupt_state.resume([{"interruptResponse": {"interruptId": interrupt.id, "response": "approved"}}])

    resumed_events = await alist(
        strands.event_loop.event_loop.event_loop_cycle(
            agent,
            invocation_state={"request_state": {"stop_event_loop": True}},
        )
    )

    assert resumed_events[-1]["stop"][0] == "tool_use"
    assert interrupt_response == "approved"
    result_ids = [content["toolResult"]["toolUseId"] for content in agent.messages[-1]["content"]]
    assert result_ids == ["bad"]


@pytest.mark.asyncio
async def test_event_loop_cycle_per_tool_interrupt_with_invalid_tool_no_duplicate_result(agent, tool, alist):
    """A per-tool interrupt in a batch containing an invalid tool must not duplicate the invalid tool's result."""
    assistant_message = {
        "role": "assistant",
        "content": [
            {"toolUse": {"toolUseId": "t1", "name": tool.tool_name, "input": {"random_string": "hello"}}},
            {"toolUse": {"toolUseId": "t2", "name": "invalid tool", "input": {}}},
        ],
    }
    agent.messages.append(assistant_message)

    def interrupt_tool(event):
        if event.tool_use["toolUseId"] == "t1":
            event.interrupt("approval", "Approve?")

    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_tool)

    # First cycle: t2 gets an invalid-tool result, t1 is interrupted before execution.
    first_events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))
    _, _, _, _, interrupts, _, _ = first_events[-1]["stop"]
    interrupt = interrupts[0]

    # Resume: t1 should execute, t2's result should not be duplicated.
    agent._interrupt_state.resume([{"interruptResponse": {"interruptId": interrupt.id, "response": "approved"}}])

    resumed_events = await alist(
        strands.event_loop.event_loop.event_loop_cycle(
            agent,
            invocation_state={"request_state": {"stop_event_loop": True}},
        )
    )

    assert resumed_events[-1]["stop"][0] == "tool_use"
    result_ids = [content["toolResult"]["toolUseId"] for content in agent.messages[-1]["content"]]
    assert result_ids.count("t2") == 1, f"t2 duplicated: {result_ids}"
    assert "t1" in result_ids


@pytest.mark.asyncio
async def test_event_loop_cycle_before_tools_interrupt_resume_with_checkpoint(agent, tool_stream, agenerator, alist):
    agent._checkpointing = True
    agent._checkpoint = Checkpoint(position="after_model", cycle_index=0)
    agent.model.stream.side_effect = [
        agenerator(tool_stream),
        agenerator([{"contentBlockDelta": {"delta": {"text": "done"}}}, {"contentBlockStop": {}}]),
    ]
    response = None

    def interrupt_batch(event):
        nonlocal response
        response = event.interrupt("approval", "Approve?")

    agent.hooks.add_callback(BeforeToolsEvent, interrupt_batch)

    interrupted_events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))
    stop_reason, _, _, _, interrupts, _, _ = interrupted_events[-1]["stop"]
    interrupt = interrupts[0]
    assert stop_reason == "interrupt"

    agent._interrupt_state.resume([{"interruptResponse": {"interruptId": interrupt.id, "response": "approved"}}])
    resumed_events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    resumed_stop_reason, _, _, _, _, _, checkpoint = resumed_events[-1]["stop"]
    assert resumed_stop_reason == "checkpoint"
    assert checkpoint.position == "after_tools"
    assert response == "approved"


@pytest.mark.asyncio
async def test_event_loop_cycle_before_tools_interrupts_and_resume_without_model_recall(
    agent, model, tool_stream, agenerator, alist
):
    responses = {}
    execution_events = []

    def interrupt_first(event):
        responses["first"] = event.interrupt("approval_a", "First approval")

    def interrupt_second(event):
        responses["second"] = event.interrupt("approval_b", "Second approval")

    def record_execution(event):
        execution_events.append(event)

    agent.hooks.add_callback(BeforeToolsEvent, interrupt_first)
    agent.hooks.add_callback(BeforeToolsEvent, interrupt_second)
    agent.hooks.add_callback(BeforeToolCallEvent, record_execution)
    model.stream.side_effect = [
        agenerator(tool_stream),
        agenerator([{"contentBlockDelta": {"delta": {"text": "done"}}}, {"contentBlockStop": {}}]),
    ]

    first_events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    tru_stop_reason, _, _, _, tru_interrupts, _, _ = first_events[-1]["stop"]
    assert tru_stop_reason == "interrupt"
    assert [interrupt.id for interrupt in tru_interrupts] == [
        "v1:before_tools:aa15d401-a27c-53f3-9e1b-8c0d4545f840",
        "v1:before_tools:fc7d4db5-7c70-583b-86ca-392fc71cadf6",
    ]
    assert execution_events == []
    assert agent._interrupt_state.context == {}
    assert agent._interrupt_state.pending_tool_execution == PendingToolExecution(
        assistant_message=agent.messages[1],
        completed_tool_results=[],
    )
    assert model.stream.call_count == 1

    agent._interrupt_state.resume(
        [
            {"interruptResponse": {"interruptId": tru_interrupts[0].id, "response": "approved-a"}},
            {"interruptResponse": {"interruptId": tru_interrupts[1].id, "response": "approved-b"}},
        ]
    )
    resumed_events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    assert resumed_events[-1]["stop"][0] == "end_turn"
    assert responses == {"first": "approved-a", "second": "approved-b"}
    assert len(execution_events) == 1
    assert model.stream.call_count == 2


@pytest.mark.asyncio
async def test_event_loop_cycle_before_tools_interrupts_again_on_later_cycle(agent, model, tool, agenerator, alist):
    def tool_stream(tool_use_id, tool_input):
        return [
            {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": tool_use_id, "name": tool.tool_name}},
                }
            },
            {"contentBlockDelta": {"delta": {"toolUse": {"input": f'{{"random_string": "{tool_input}"}}'}}}},
            {"contentBlockStop": {}},
            {"messageStop": {"stopReason": "tool_use"}},
        ]

    model.stream.side_effect = [
        agenerator(tool_stream("t1", "first")),
        agenerator(tool_stream("t2", "second")),
        agenerator([{"contentBlockDelta": {"delta": {"text": "done"}}}, {"contentBlockStop": {}}]),
    ]
    responses = []

    def interrupt_batch(event):
        responses.append(event.interrupt("approval", "Approve?"))

    agent.hooks.add_callback(BeforeToolsEvent, interrupt_batch)

    first_events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))
    _, _, _, _, first_interrupts, _, _ = first_events[-1]["stop"]
    first_interrupt = first_interrupts[0]
    agent._interrupt_state.resume(
        [{"interruptResponse": {"interruptId": first_interrupt.id, "response": "first-approved"}}]
    )

    second_events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))
    second_stop_reason, _, _, _, second_interrupts, _, _ = second_events[-1]["stop"]
    second_interrupt = second_interrupts[0]
    assert second_stop_reason == "interrupt"
    agent._interrupt_state.resume(
        [{"interruptResponse": {"interruptId": second_interrupt.id, "response": "second-approved"}}]
    )

    final_events = await alist(strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={}))

    assert final_events[-1]["stop"][0] == "end_turn"
    assert responses == ["first-approved", "second-approved"]
    assert model.stream.call_count == 3


@pytest.mark.asyncio
async def test_event_loop_cycle_interrupt(agent, model, tool_stream, agenerator, alist):
    def interrupt_callback(event):
        event.interrupt("test_name", "test reason")

    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_callback)

    model.stream.side_effect = [agenerator(tool_stream)]

    stream = strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={})
    events = await alist(stream)

    tru_stop_reason, _, _, _, tru_interrupts, _, _ = events[-1]["stop"]
    exp_stop_reason = "interrupt"
    exp_interrupts = [
        Interrupt(
            id="v1:before_tool_call:t1:78714d6c-613c-5cf4-bf25-7037569941f9",
            name="test_name",
            reason="test reason",
        ),
    ]

    assert tru_stop_reason == exp_stop_reason and tru_interrupts == exp_interrupts

    tru_state = agent._interrupt_state.to_dict()
    exp_state = {
        "activated": True,
        "context": {},
        "pending_tool_execution": {
            "completed_tool_results": [],
            "assistant_message": {
                "content": [
                    {
                        "toolUse": {
                            "input": {"random_string": "abcdEfghI123"},
                            "name": "tool_for_testing",
                            "toolUseId": "t1",
                        },
                    },
                ],
                "role": "assistant",
                "metadata": ANY,
                "tracking_id": ANY,
            },
        },
        "interrupts": {
            "v1:before_tool_call:t1:78714d6c-613c-5cf4-bf25-7037569941f9": {
                "id": "v1:before_tool_call:t1:78714d6c-613c-5cf4-bf25-7037569941f9",
                "name": "test_name",
                "reason": "test reason",
                "response": None,
            },
        },
    }
    assert tru_state == exp_state


@pytest.mark.asyncio
async def test_event_loop_cycle_interrupt_resume(agent, model, tool, tool_times_2, agenerator, alist):
    interrupt = Interrupt(
        id="v1:before_tool_call:t1:78714d6c-613c-5cf4-bf25-7037569941f9",
        name="test_name",
        reason="test reason",
        response="test response",
    )

    tool_use_message = {
        "role": "assistant",
        "content": [
            {
                "toolUse": {
                    "toolUseId": "t1",
                    "name": "tool_for_testing",
                    "input": {"random_string": "test input"},
                }
            },
            {
                "toolUse": {
                    "toolUseId": "t2",
                    "name": "tool_times_2",
                    "input": {},
                }
            },
        ],
    }
    tool_results = [
        {
            "toolUseId": "t2",
            "status": "success",
            "content": [{"text": "t2 result"}],
        },
    ]

    agent._interrupt_state.pending_tool_execution = PendingToolExecution(
        assistant_message=tool_use_message,
        completed_tool_results=tool_results,
    )
    agent._interrupt_state.interrupts[interrupt.id] = interrupt
    agent._interrupt_state.activate()

    interrupt_response = {}

    def interrupt_callback(event):
        interrupt_response["response"] = event.interrupt("test_name", "test reason")

    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_callback)

    model.stream.side_effect = [agenerator([{"contentBlockStop": {}}])]

    stream = strands.event_loop.event_loop.event_loop_cycle(agent, invocation_state={})
    events = await alist(stream)

    tru_stop_reason, _, _, _, _, _, _ = events[-1]["stop"]
    exp_stop_reason = "end_turn"
    assert tru_stop_reason == exp_stop_reason

    tru_result_message = agent.messages[-2]
    exp_result_message = {
        "role": "user",
        "content": [
            {
                "toolResult": {
                    "toolUseId": "t2",
                    "status": "success",
                    "content": [{"text": "t2 result"}],
                },
            },
            {
                "toolResult": {
                    "toolUseId": "t1",
                    "status": "success",
                    "content": [{"text": "test input"}],
                },
            },
        ],
        "tracking_id": ANY,
    }
    assert tru_result_message == exp_result_message

    tru_response = interrupt_response["response"]
    exp_response = "test response"
    assert tru_response == exp_response

    tru_state = agent._interrupt_state.to_dict()
    exp_state = {
        "activated": False,
        "context": {},
        "interrupts": {},
    }
    assert tru_state == exp_state


@pytest.mark.asyncio
async def test_invalid_tool_names_adds_tool_uses(agent, model, alist):
    model.stream = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": "tool_use_id",
                            "name": "invalid tool",
                            "input": "{}",
                        }
                    }
                ],
            },
            {"role": "assistant", "content": [{"text": "I invoked a tool!"}]},
        ]
    ).stream

    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    events = await alist(stream)

    # ensure that we got end_turn and not tool_use
    assert events[-1] == EventLoopStopEvent(
        stop_reason="end_turn",
        message={"content": [{"text": "I invoked a tool!"}], "role": "assistant", "metadata": ANY, "tracking_id": ANY},
        metrics=ANY,
        request_state={},
    )

    # Ensure that an "invalid tool name" message was added properly
    assert agent.messages[-2] == {
        "content": [
            {
                "toolResult": {
                    "content": [{"text": "Error: tool_name=<invalid tool> | invalid tool name pattern"}],
                    "status": "error",
                    "toolUseId": "tool_use_id",
                }
            }
        ],
        "role": "user",
        "tracking_id": ANY,
    }


@pytest.mark.asyncio
async def test_event_loop_metrics_recorded_before_recursion(
    agent,
    model,
    tool,
    agenerator,
    alist,
):
    model.stream.side_effect = [
        agenerator(
            [
                {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": "t1",
                                "name": tool.tool_spec["name"],
                            },
                        },
                    },
                },
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        ),
        agenerator(
            [
                {"contentBlockDelta": {"delta": {"text": "test text"}}},
                {"contentBlockStop": {}},
            ]
        ),
    ]

    with unittest.mock.patch.object(agent.event_loop_metrics, "end_cycle") as mock_end_cycle:
        stream = strands.event_loop.event_loop.event_loop_cycle(
            agent=agent,
            invocation_state={"request_state": {}},
        )
        events = await alist(stream)

        # Verify end_cycle was called once for tool cycle, once for text cycle
        assert mock_end_cycle.call_count == 2

        # Verify the event loop completed successfully
        tru_stop_reason, _, _, _, _, _, _ = events[-1]["stop"]
        assert tru_stop_reason == "end_turn"


class TestEstimateInputTokens:
    """Tests for _estimate_input_tokens helper."""

    @pytest.mark.asyncio
    async def test_cold_start_estimates_all_messages(self):
        """On cold start (no prior usage metadata), estimates all messages with lazily resolved tool specs."""
        agent = unittest.mock.AsyncMock()
        agent.messages = [{"role": "user", "content": [{"text": "Hi"}]}]
        agent.system_prompt = "You are helpful"
        agent._system_prompt_content = None
        agent.tool_registry = unittest.mock.MagicMock()
        agent.tool_registry.get_all_tool_specs.return_value = [{"name": "tool1"}]
        agent.model.count_tokens = AsyncMock(return_value=42)

        result = await strands.event_loop.event_loop._estimate_input_tokens(agent)

        assert result == 42
        agent.tool_registry.get_all_tool_specs.assert_called_once()
        agent.model.count_tokens.assert_called_once_with(
            agent.messages,
            tool_specs=[{"name": "tool1"}],
            system_prompt="You are helpful",
            system_prompt_content=None,
        )

    @pytest.mark.asyncio
    async def test_baseline_only_no_new_messages(self):
        """When last message is assistant with usage and no new messages after, returns baseline."""
        agent = unittest.mock.AsyncMock()
        agent.messages = [
            {"role": "user", "content": [{"text": "Hi"}]},
            {
                "role": "assistant",
                "content": [{"text": "Hello"}],
                "metadata": {"usage": {"inputTokens": 100, "outputTokens": 20, "totalTokens": 120}},
            },
        ]
        agent.system_prompt = "You are helpful"

        result = await strands.event_loop.event_loop._estimate_input_tokens(agent)

        assert result == 120
        agent.model.count_tokens.assert_not_called()

    @pytest.mark.asyncio
    async def test_baseline_plus_delta(self):
        """When new messages exist after last assistant, adds estimated delta to baseline."""
        agent = unittest.mock.AsyncMock()
        agent.messages = [
            {"role": "user", "content": [{"text": "Hi"}]},
            {
                "role": "assistant",
                "content": [{"text": "Hello"}],
                "metadata": {"usage": {"inputTokens": 100, "outputTokens": 30, "totalTokens": 130}},
            },
            {"role": "user", "content": [{"text": "tool result"}]},
        ]
        agent.system_prompt = "You are helpful"
        agent.model.count_tokens = AsyncMock(return_value=50)

        result = await strands.event_loop.event_loop._estimate_input_tokens(agent)

        # baseline (100+30) + delta (50) = 180
        assert result == 180
        agent.model.count_tokens.assert_called_once()

    @pytest.mark.asyncio
    async def test_baseline_counts_disjoint_cache_tokens(self):
        """Baseline includes cache reads on disjoint providers (#3546).

        Without counting the cache read, a large cached prompt reads as a handful of tokens and
        proactive compaction never fires. Here inputTokens + outputTokens != totalTokens, so the
        cache read is additional to inputTokens and must be included in the baseline.
        """
        agent = unittest.mock.AsyncMock()
        agent.messages = [
            {"role": "user", "content": [{"text": "Hi"}]},
            {
                "role": "assistant",
                "content": [{"text": "Hello"}],
                "metadata": {
                    "usage": {
                        "inputTokens": 10,
                        "outputTokens": 4,
                        "totalTokens": 5862,
                        "cacheReadInputTokens": 5848,
                    }
                },
            },
        ]
        agent.system_prompt = "You are helpful"

        result = await strands.event_loop.event_loop._estimate_input_tokens(agent)

        # total prompt (10 + 5848 cache read) + output (4) = 5862, not 14
        assert result == 5862
        agent.model.count_tokens.assert_not_called()

    @pytest.mark.asyncio
    async def test_error_fallback_returns_none_at_call_site(self):
        """When count_tokens raises, the caller catches and sets projected_input_tokens to None."""
        agent = unittest.mock.AsyncMock()
        agent.messages = [{"role": "user", "content": [{"text": "Hi"}]}]
        agent.system_prompt = "You are helpful"
        agent._system_prompt_content = None
        agent.tool_registry = unittest.mock.MagicMock()
        agent.tool_registry.get_all_tool_specs.return_value = []
        agent.model.count_tokens = AsyncMock(side_effect=Exception("API unavailable"))

        with pytest.raises(Exception, match="API unavailable"):
            await strands.event_loop.event_loop._estimate_input_tokens(agent)


# --- Checkpoint event loop integration (Tasks 9-10) ---


@pytest.mark.asyncio
async def test_event_loop_cycle_checkpoint_after_model(
    agent,
    model,
    tool_stream,
    agenerator,
    alist,
):
    """With checkpointing=True, tool_use stop_reason yields after_model checkpoint instead of running tools."""
    agent._checkpointing = True
    agent._checkpoint = None

    model.stream.return_value = agenerator(tool_stream)

    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    events = await alist(stream)
    stop = events[-1]["stop"]
    tru_stop_reason, _, _, _, _, _, tru_checkpoint = stop

    assert tru_stop_reason == "checkpoint"
    assert tru_checkpoint is not None
    assert tru_checkpoint.position == "after_model"
    assert tru_checkpoint.cycle_index == 0


@pytest.mark.asyncio
async def test_event_loop_cycle_checkpoint_after_tools(
    agent,
    model,
    tool,
    tool_stream,
    agenerator,
    alist,
):
    """With checkpointing=True and resume from after_model, tools execute then yield after_tools checkpoint."""
    agent._checkpointing = True
    agent._checkpoint = Checkpoint(position="after_model", cycle_index=0)

    model.stream.return_value = agenerator(tool_stream)

    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    events = await alist(stream)
    tru_stop_reason, _, _, _, _, _, tru_checkpoint = events[-1]["stop"]

    assert tru_stop_reason == "checkpoint"
    assert tru_checkpoint is not None
    assert tru_checkpoint.position == "after_tools"
    assert tru_checkpoint.cycle_index == 0


@pytest.mark.asyncio
async def test_event_loop_cycle_checkpoint_resume_after_tools_increments_cycle(
    agent,
    model,
    tool_stream,
    agenerator,
    alist,
):
    """Resuming from after_tools sets cycle_index to previous + 1 for the next after_model checkpoint."""
    agent._checkpointing = True
    agent._checkpoint = Checkpoint(position="after_tools", cycle_index=2)

    model.stream.return_value = agenerator(tool_stream)

    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    events = await alist(stream)
    tru_stop_reason, _, _, _, _, _, tru_checkpoint = events[-1]["stop"]

    assert tru_stop_reason == "checkpoint"
    assert tru_checkpoint.position == "after_model"
    assert tru_checkpoint.cycle_index == 3


@pytest.mark.asyncio
async def test_event_loop_cycle_cancel_beats_after_model_checkpoint(
    agent,
    model,
    tool_stream,
    agenerator,
    alist,
):
    """When a cancel signal is set after model call, cancel wins over after_model checkpoint.

    A user who calls agent.cancel() expects stop_reason="cancelled", not a stray
    "checkpoint" with a snapshot they never asked for. Documented in Agent.cancel().
    """
    agent._checkpointing = True
    agent._checkpoint = None

    # Cancel the agent before invoking. Model streams tool_use — the emission site
    # that would normally fire an after_model checkpoint must yield "cancelled" instead.
    agent._cancel_signal.set()
    model.stream.return_value = agenerator(tool_stream)

    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    events = await alist(stream)
    tru_stop_reason, _, _, _, _, _, tru_checkpoint = events[-1]["stop"]

    assert tru_stop_reason == "cancelled"
    assert tru_checkpoint is None


@pytest.mark.asyncio
async def test_event_loop_cycle_cancel_mid_cycle_beats_after_model_checkpoint(
    agent,
    model,
    tool_stream,
    agenerator,
    alist,
):
    """Cancel signal set between model completion and after_model emission yields 'cancelled', not 'checkpoint'."""
    agent._checkpointing = True
    agent._checkpoint = None

    # Stub the model stream so that after it yields its stop event, we simulate
    # a cancel signal arriving between model completion and the after_model check.
    original_stream = agenerator(tool_stream)

    async def stream_with_mid_cycle_cancel():
        async for item in original_stream:
            yield item
        agent._cancel_signal.set()

    model.stream.return_value = stream_with_mid_cycle_cancel()

    stream = strands.event_loop.event_loop.event_loop_cycle(
        agent=agent,
        invocation_state={},
    )
    events = await alist(stream)
    tru_stop_reason, _, _, _, _, _, tru_checkpoint = events[-1]["stop"]

    assert tru_stop_reason == "cancelled"
    assert tru_checkpoint is None


@pytest.mark.asyncio
async def test_event_loop_cycle_cancel_mid_cycle_beats_after_tools_checkpoint(
    agent,
    model,
    tool,
    tool_stream,
    agenerator,
    alist,
):
    """Cancel set after tools complete but before after_tools emission yields 'cancelled'."""
    from strands.experimental.checkpoint import Checkpoint

    agent._checkpointing = True
    agent._checkpoint = Checkpoint(position="after_model", cycle_index=0)

    # Wrap the tool executor so that after tools complete, cancel is signaled.
    # The real gap: cancel arriving between tool completion and checkpoint emission.
    original_execute = agent.tool_executor._execute

    def execute_then_cancel(*args, **kwargs):
        stream = original_execute(*args, **kwargs)

        async def wrapped():
            async for event in stream:
                yield event
            agent._cancel_signal.set()

        return wrapped()

    model.stream.return_value = agenerator(tool_stream)

    with unittest.mock.patch.object(agent.tool_executor, "_execute", side_effect=execute_then_cancel):
        stream = strands.event_loop.event_loop.event_loop_cycle(
            agent=agent,
            invocation_state={},
        )
        events = await alist(stream)
    tru_stop_reason, _, _, _, _, _, tru_checkpoint = events[-1]["stop"]

    assert tru_stop_reason == "cancelled"
    assert tru_checkpoint is None


@pytest.mark.asyncio
async def test_event_loop_cycle_cancel_after_tools_stops_without_checkpointing(
    agent,
    model,
    tool,
    tool_stream,
    agenerator,
    alist,
):
    """Cancel set during tool execution stops the invocation before another model call."""
    original_execute = agent.tool_executor._execute

    def execute_then_cancel(*args, **kwargs):
        stream = original_execute(*args, **kwargs)

        async def wrapped():
            async for event in stream:
                yield event
            agent._cancel_signal.set()

        return wrapped()

    model.stream.return_value = agenerator(tool_stream)

    with unittest.mock.patch.object(agent.tool_executor, "_execute", side_effect=execute_then_cancel):
        stream = strands.event_loop.event_loop.event_loop_cycle(agent=agent, invocation_state={})
        events = await alist(stream)

    assert events[-1]["stop"][0] == "cancelled"
    assert model.stream.call_count == 1
