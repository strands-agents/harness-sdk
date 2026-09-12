import asyncio
import json
import logging
import os
from datetime import date, datetime, timezone
from unittest import mock

import pytest
from opentelemetry.trace import (
    SpanContext,
    SpanKind,
    StatusCode,  # type: ignore
)

from strands.memory.types import MemoryEntry
from strands.telemetry.tracer import JSONEncoder, Tracer, get_tracer, serialize
from strands.types.content import ContentBlock
from strands.types.interrupt import InterruptResponseContent
from strands.types.streaming import Metrics, StopReason, Usage


@pytest.fixture(autouse=True)
def moto_autouse(moto_env, moto_mock_aws):
    _ = moto_env
    _ = moto_mock_aws


@pytest.fixture
def mock_get_tracer_provider():
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer_provider") as mock_get_tracer_provider:
        mock_tracer = mock.MagicMock()
        mock_get_tracer_provider.get_tracer.return_value = mock_tracer
        yield mock_get_tracer_provider


@pytest.fixture
def mock_tracer():
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer") as mock_get_tracer:
        mock_tracer = mock.MagicMock()
        mock_get_tracer.return_value = mock_tracer
        yield mock_tracer


@pytest.fixture
def mock_span():
    mock_span = mock.MagicMock()
    return mock_span


@pytest.fixture
def clean_env():
    """Fixture to provide a clean environment for each test."""
    with mock.patch.dict(os.environ, {}, clear=True):
        yield


def test_init_default():
    """Test initializing the Tracer with default parameters."""
    tracer = Tracer()

    assert tracer.service_name == "strands.telemetry.tracer"
    assert tracer.tracer_provider is not None
    assert tracer.tracer is not None


@pytest.mark.parametrize("disable_var", ["OTEL_SDK_DISABLED", "STRANDS_OTEL_DISABLED"])
def test_init_disabled_uses_noop_tracer_over_global_provider(disable_var, monkeypatch):
    """When disabled, the Tracer instance emits through a no-op provider even if a real
    provider is registered globally — the tracer reads from global, so gating only the
    StrandsTelemetry setup is not enough to silence it (#1059, poshinchen review)."""
    from opentelemetry.sdk.trace import TracerProvider as SDKTracerProvider
    from opentelemetry.trace import NoOpTracer, NoOpTracerProvider

    for name in ("OTEL_SDK_DISABLED", "STRANDS_OTEL_DISABLED"):
        monkeypatch.delenv(name, raising=False)
    # Host app owns OTel: a real provider is globally registered.
    real_provider = SDKTracerProvider()
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer_provider", return_value=real_provider):
        monkeypatch.setenv(disable_var, "true")
        tracer = Tracer()

    assert isinstance(tracer.tracer_provider, NoOpTracerProvider)
    assert isinstance(tracer.tracer, NoOpTracer)
    span = tracer.tracer.start_span("s")
    assert span.is_recording() is False


def test_init_enabled_uses_global_provider(monkeypatch):
    """With no disable env var, the Tracer instance uses the global provider unchanged."""
    for name in ("OTEL_SDK_DISABLED", "STRANDS_OTEL_DISABLED"):
        monkeypatch.delenv(name, raising=False)
    sentinel_provider = mock.MagicMock()
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer_provider", return_value=sentinel_provider):
        tracer = Tracer()

    assert tracer.tracer_provider is sentinel_provider
    sentinel_provider.get_tracer.assert_called_once_with(tracer.service_name)


def test_start_span_no_tracer():
    """Test starting a span when no tracer is configured."""
    tracer = Tracer()
    span = tracer._start_span("test_span")

    assert span is not None


def test_start_span(mock_tracer):
    """Test starting a span with attributes."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        span = tracer._start_span("test_span", attributes={"key": "value"})

        mock_tracer.start_span.assert_called_once_with(
            name="test_span", context=None, kind=SpanKind.INTERNAL, links=None
        )
        # Check that set_attributes was called with the provided attributes
        mock_span.set_attributes.assert_called_once_with({"key": "value"})
        assert span is not None


def test_end_span_no_span():
    """Test ending a span when span is None."""
    tracer = Tracer()
    # Should not raise an exception
    tracer._end_span(None)


def test_end_span(mock_span):
    """Test ending a span with attributes and no error."""
    tracer = Tracer()
    attributes = {"key": "value"}

    tracer._end_span(mock_span, attributes)

    # Check that set_attributes was called with the provided attributes
    mock_span.set_attributes.assert_called_once_with({"key": "value"})
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_span_with_error(mock_span):
    """Test ending a span with an error."""
    tracer = Tracer()
    error = Exception("Test error")

    tracer._end_span(mock_span, error=error)

    mock_span.set_status.assert_called_once_with(StatusCode.ERROR, str(error))
    mock_span.record_exception.assert_called_once_with(error)
    mock_span.end.assert_called_once()


def test_end_span_with_error_message(mock_span):
    """Test ending a span with an error message."""
    tracer = Tracer()
    error_message = "Test error message"

    tracer.end_span_with_error(mock_span, error_message)

    mock_span.set_status.assert_called_once()
    assert mock_span.set_status.call_args[0][0] == StatusCode.ERROR
    mock_span.end.assert_called_once()


def test_end_span_with_empty_exception_message_uses_exception_name(mock_span):
    """Test that empty exception messages fall back to the exception type name."""
    tracer = Tracer()
    error = Exception()

    tracer.end_span_with_error(mock_span, "", error)

    mock_span.set_status.assert_called_once_with(StatusCode.ERROR, "Exception")
    mock_span.record_exception.assert_called_once_with(error)
    mock_span.end.assert_called_once()


def test_end_span_with_error_prefers_explicit_message(mock_span):
    """Test that an explicit error message takes precedence over the exception text."""
    tracer = Tracer()
    error = Exception()

    tracer.end_span_with_error(mock_span, "Explicit error message", error)

    mock_span.set_status.assert_called_once_with(StatusCode.ERROR, "Explicit error message")
    mock_span.record_exception.assert_called_once_with(error)
    mock_span.end.assert_called_once()


@pytest.mark.parametrize(
    "cancellation",
    [asyncio.CancelledError(), KeyboardInterrupt(), SystemExit()],
)
def test_end_span_with_cancellation(mock_span, cancellation):
    """Cancelled spans end with UNSET status and a cancellation type attribute."""
    tracer = Tracer()

    tracer.end_span_with_cancellation(mock_span, cancellation)

    mock_span.set_attribute.assert_any_call("strands.cancellation.type", type(cancellation).__name__)
    mock_span.set_status.assert_not_called()
    mock_span.record_exception.assert_not_called()
    mock_span.end.assert_called_once()


def test_end_span_with_cancellation_not_recording(mock_span):
    """No-op when the span is not recording."""
    mock_span.is_recording.return_value = False
    tracer = Tracer()

    tracer.end_span_with_cancellation(mock_span, asyncio.CancelledError())

    mock_span.set_attribute.assert_not_called()
    mock_span.end.assert_not_called()


def test_end_span_with_cancellation_attribute_error(mock_span):
    """Span is still ended even when set_attribute raises."""
    mock_span.set_attribute.side_effect = RuntimeError("oops")
    tracer = Tracer()

    tracer.end_span_with_cancellation(mock_span, asyncio.CancelledError())

    mock_span.end.assert_called_once()


def test_start_model_invoke_span(mock_tracer):
    """Test starting a model invoke span."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        messages = [{"role": "user", "content": [{"text": "Hello"}]}]
        model_id = "test-model"
        custom_attrs = {"custom_key": "custom_value", "user_id": "12345"}
        system_prompt = "You are a helpful assistant"

        span = tracer.start_model_invoke_span(
            messages=messages,
            agent_name="TestAgent",
            model_id=model_id,
            custom_trace_attributes=custom_attrs,
            system_prompt=system_prompt,
        )

        mock_tracer.start_span.assert_called_once()
        assert mock_tracer.start_span.call_args[1]["name"] == "chat"
        assert mock_tracer.start_span.call_args[1]["kind"] == SpanKind.INTERNAL
        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "chat",
                "gen_ai.system": "strands-agents",
                "custom_key": "custom_value",
                "user_id": "12345",
                "gen_ai.request.model": model_id,
                "agent_name": "TestAgent",
            }
        )

        calls = mock_span.add_event.call_args_list
        assert len(calls) == 2
        assert calls[0] == mock.call(
            "gen_ai.system.message",
            attributes={"content": serialize([{"text": system_prompt}])},
        )
        assert calls[1] == mock.call("gen_ai.user.message", attributes={"content": json.dumps(messages[0]["content"])})
        assert span is not None


def test_start_model_invoke_span_latest_conventions(mock_tracer, monkeypatch):
    """Test starting a model invoke span with the latest semantic conventions."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        messages = [
            {"role": "user", "content": [{"text": "Hello 2025-1993"}]},
            {
                "role": "assistant",
                "content": [
                    {"toolUse": {"input": '"expression": "2025-1993"', "name": "calculator", "toolUseId": "123"}}
                ],
            },
        ]
        model_id = "test-model"
        system_prompt = "You are a calculator assistant"

        span = tracer.start_model_invoke_span(
            messages=messages, agent_name="TestAgent", model_id=model_id, system_prompt=system_prompt
        )

        mock_tracer.start_span.assert_called_once()
        assert mock_tracer.start_span.call_args[1]["name"] == "chat"
        assert mock_tracer.start_span.call_args[1]["kind"] == SpanKind.INTERNAL

        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "chat",
                "gen_ai.provider.name": "strands-agents",
                "gen_ai.request.model": model_id,
                "agent_name": "TestAgent",
            }
        )

        calls = mock_span.add_event.call_args_list
        assert len(calls) == 2
        assert calls[0] == mock.call(
            "gen_ai.client.inference.operation.details",
            attributes={
                "gen_ai.system_instructions": serialize([{"type": "text", "content": system_prompt}]),
            },
        )
        assert calls[1] == mock.call(
            "gen_ai.client.inference.operation.details",
            attributes={
                "gen_ai.input.messages": serialize(
                    [
                        {
                            "role": messages[0]["role"],
                            "parts": [{"type": "text", "content": "Hello 2025-1993"}],
                        },
                        {
                            "role": messages[1]["role"],
                            "parts": [
                                {
                                    "type": "tool_call",
                                    "name": "calculator",
                                    "id": "123",
                                    "arguments": '"expression": "2025-1993"',
                                }
                            ],
                        },
                    ]
                )
            },
        )
        assert span is not None


def test_start_model_invoke_span_without_system_prompt(mock_tracer):
    """Test that no system prompt event is emitted when system_prompt is None."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        messages = [{"role": "user", "content": [{"text": "Hello"}]}]

        span = tracer.start_model_invoke_span(messages=messages, model_id="test-model")

        assert mock_span.add_event.call_count == 1
        mock_span.add_event.assert_called_once_with(
            "gen_ai.user.message", attributes={"content": json.dumps(messages[0]["content"])}
        )
        assert span is not None


def test_start_model_invoke_span_with_system_prompt_content(mock_tracer):
    """Test that system_prompt_content takes priority over system_prompt string."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        messages = [{"role": "user", "content": [{"text": "Hello"}]}]
        system_prompt_content = [{"text": "You are helpful"}, {"text": "Be concise"}]

        span = tracer.start_model_invoke_span(
            messages=messages,
            model_id="test-model",
            system_prompt="ignored string",
            system_prompt_content=system_prompt_content,
        )

        calls = mock_span.add_event.call_args_list
        assert len(calls) == 2
        assert calls[0] == mock.call(
            "gen_ai.system.message",
            attributes={"content": serialize(system_prompt_content)},
        )
        assert span is not None


def test_end_model_invoke_span(mock_span):
    """Test ending a model invoke span."""
    tracer = Tracer()
    message = {"role": "assistant", "content": [{"text": "Response"}]}
    usage = Usage(inputTokens=10, outputTokens=20, totalTokens=30)
    metrics = Metrics(latencyMs=20, timeToFirstByteMs=10)
    stop_reason: StopReason = "end_turn"

    tracer.end_model_invoke_span(mock_span, message, usage, metrics, stop_reason)

    mock_span.set_attributes.assert_called_once_with(
        {
            "gen_ai.usage.prompt_tokens": 10,
            "gen_ai.usage.input_tokens": 10,
            "gen_ai.usage.completion_tokens": 20,
            "gen_ai.usage.output_tokens": 20,
            "gen_ai.usage.total_tokens": 30,
            "gen_ai.server.time_to_first_token": 10,
            "gen_ai.server.request.duration": 20,
        }
    )
    mock_span.add_event.assert_called_with(
        "gen_ai.choice",
        attributes={"message": json.dumps(message["content"]), "finish_reason": "end_turn"},
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_model_invoke_span_latest_conventions(mock_span, monkeypatch):
    """Test ending a model invoke span with the latest semantic conventions."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
        tracer = Tracer()
        message = {"role": "assistant", "content": [{"text": "Response"}]}
        usage = Usage(inputTokens=10, outputTokens=20, totalTokens=30)
        metrics = Metrics(latencyMs=20, timeToFirstByteMs=10)
        stop_reason: StopReason = "end_turn"

        tracer.end_model_invoke_span(mock_span, message, usage, metrics, stop_reason)

        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.usage.prompt_tokens": 10,
                "gen_ai.usage.input_tokens": 10,
                "gen_ai.usage.completion_tokens": 20,
                "gen_ai.usage.output_tokens": 20,
                "gen_ai.usage.total_tokens": 30,
                "gen_ai.server.time_to_first_token": 10,
                "gen_ai.server.request.duration": 20,
            }
        )
        mock_span.add_event.assert_called_with(
            "gen_ai.client.inference.operation.details",
            attributes={
                "gen_ai.output.messages": serialize(
                    [
                        {
                            "role": "assistant",
                            "parts": [{"type": "text", "content": "Response"}],
                            "finish_reason": "end_turn",
                        }
                    ]
                ),
            },
        )
        mock_span.set_status.assert_called_once_with(StatusCode.OK)
        mock_span.end.assert_called_once()


def test_start_tool_call_span(mock_tracer):
    """Test starting a tool call span."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        tool = {"name": "test-tool", "toolUseId": "123", "input": {"param": "value"}}
        custom_attrs = {"session_id": "abc123", "environment": "production"}

        span = tracer.start_tool_call_span(tool, custom_trace_attributes=custom_attrs)

        mock_tracer.start_span.assert_called_once()
        assert mock_tracer.start_span.call_args[1]["name"] == "execute_tool test-tool"

        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.tool.name": "test-tool",
                "gen_ai.system": "strands-agents",
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.call.id": "123",
                "session_id": "abc123",
                "environment": "production",
            }
        )
        mock_span.add_event.assert_any_call(
            "gen_ai.tool.message", attributes={"role": "tool", "content": json.dumps({"param": "value"}), "id": "123"}
        )
        assert span is not None


def test_start_tool_call_span_latest_conventions(mock_tracer, monkeypatch):
    """Test starting a tool call span with the latest semantic conventions."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        tool = {"name": "test-tool", "toolUseId": "123", "input": {"param": "value"}}

        span = tracer.start_tool_call_span(tool)

        mock_tracer.start_span.assert_called_once()
        assert mock_tracer.start_span.call_args[1]["name"] == "execute_tool test-tool"

        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.tool.name": "test-tool",
                "gen_ai.provider.name": "strands-agents",
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.call.id": "123",
            }
        )
        mock_span.set_attribute.assert_any_call("gen_ai.tool.call.arguments", serialize(tool["input"]))
        mock_span.add_event.assert_called_with(
            "gen_ai.client.inference.operation.details",
            attributes={
                "gen_ai.input.messages": serialize(
                    [
                        {
                            "role": "tool",
                            "parts": [
                                {
                                    "type": "tool_call",
                                    "name": tool["name"],
                                    "id": tool["toolUseId"],
                                    "arguments": tool["input"],
                                }
                            ],
                        }
                    ]
                )
            },
        )
        assert span is not None


def test_start_swarm_call_span_with_string_task(mock_tracer):
    """Test starting a swarm call span with task as string."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        task = "Design foo bar"
        custom_attrs = {"workflow_id": "wf-789", "priority": "high"}

        span = tracer.start_multiagent_span(task, "swarm", custom_trace_attributes=custom_attrs)

        mock_tracer.start_span.assert_called_once()
        assert mock_tracer.start_span.call_args[1]["name"] == "invoke_swarm"

        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "invoke_swarm",
                "gen_ai.system": "strands-agents",
                "workflow_id": "wf-789",
                "priority": "high",
            }
        )
        mock_span.add_event.assert_any_call("gen_ai.user.message", attributes={"content": "Design foo bar"})
        assert span is not None


def test_start_swarm_span_with_contentblock_task(mock_tracer):
    """Test starting a swarm call span with task as list of contentBlock."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        task = [ContentBlock(text="Original Task: foo bar")]

        span = tracer.start_multiagent_span(task, "swarm")

        mock_tracer.start_span.assert_called_once()
        assert mock_tracer.start_span.call_args[1]["name"] == "invoke_swarm"

        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "invoke_swarm",
                "gen_ai.system": "strands-agents",
            }
        )
        mock_span.add_event.assert_any_call(
            "gen_ai.user.message", attributes={"content": '[{"text": "Original Task: foo bar"}]'}
        )
        assert span is not None


@pytest.mark.parametrize(
    "task, expected_parts",
    [
        ([ContentBlock(text="Test message")], [{"type": "text", "content": "Test message"}]),
        (
            [InterruptResponseContent(interruptResponse={"interruptId": "test-id", "response": "approved"})],
            [{"type": "interrupt_response", "id": "test-id", "response": "approved"}],
        ),
    ],
)
def test_start_multiagent_span_task_part_conversion(mock_tracer, task, expected_parts, monkeypatch):
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")

    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        tracer.start_multiagent_span(task, "swarm")

        expected_content = json.dumps([{"role": "user", "parts": expected_parts}])
        mock_span.add_event.assert_any_call(
            "gen_ai.client.inference.operation.details", attributes={"gen_ai.input.messages": expected_content}
        )


def test_start_swarm_span_with_contentblock_task_latest_conventions(mock_tracer, monkeypatch):
    """Test starting a swarm call span with task as list of contentBlock with latest semantic conventions."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        task = [ContentBlock(text="Original Task: foo bar")]

        span = tracer.start_multiagent_span(task, "swarm")

        mock_tracer.start_span.assert_called_once()
        assert mock_tracer.start_span.call_args[1]["name"] == "invoke_swarm"

        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "invoke_swarm",
                "gen_ai.provider.name": "strands-agents",
            }
        )
        mock_span.add_event.assert_any_call(
            "gen_ai.client.inference.operation.details",
            attributes={
                "gen_ai.input.messages": serialize(
                    [{"role": "user", "parts": [{"type": "text", "content": "Original Task: foo bar"}]}]
                )
            },
        )
        assert span is not None


def test_end_swarm_span(mock_span):
    """Test ending a tool call span."""
    tracer = Tracer()
    swarm_final_reuslt = "foo bar bar"

    tracer.end_swarm_span(mock_span, swarm_final_reuslt)

    mock_span.add_event.assert_called_with(
        "gen_ai.choice",
        attributes={"message": "foo bar bar"},
    )


def test_end_swarm_span_latest_conventions(mock_span, monkeypatch):
    """Test ending a tool call span with latest semantic conventions."""
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
    tracer = Tracer()
    swarm_final_reuslt = "foo bar bar"

    tracer.end_swarm_span(mock_span, swarm_final_reuslt)

    mock_span.add_event.assert_called_with(
        "gen_ai.client.inference.operation.details",
        attributes={
            "gen_ai.output.messages": serialize(
                [
                    {
                        "role": "assistant",
                        "parts": [{"type": "text", "content": "foo bar bar"}],
                    }
                ]
            )
        },
    )


def test_start_graph_call_span(mock_tracer):
    """Test starting a graph call span."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        tool = {"name": "test-tool", "toolUseId": "123", "input": {"param": "value"}}

        span = tracer.start_tool_call_span(tool)

        mock_tracer.start_span.assert_called_once()
        assert mock_tracer.start_span.call_args[1]["name"] == "execute_tool test-tool"

        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.system": "strands-agents",
                "gen_ai.tool.name": "test-tool",
                "gen_ai.tool.call.id": "123",
            }
        )
        mock_span.add_event.assert_any_call(
            "gen_ai.tool.message", attributes={"role": "tool", "content": json.dumps({"param": "value"}), "id": "123"}
        )
        assert span is not None


def test_end_tool_call_span(mock_span):
    """Test ending a tool call span."""
    tracer = Tracer()
    tool_result = {"status": "success", "content": [{"text": "Tool result"}]}

    tracer.end_tool_call_span(mock_span, tool_result)

    mock_span.set_attributes.assert_called_once_with({"gen_ai.tool.status": "success"})
    mock_span.add_event.assert_called_with(
        "gen_ai.choice",
        attributes={"message": json.dumps(tool_result.get("content")), "id": ""},
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_tool_call_span_latest_conventions(mock_span, monkeypatch):
    """Test ending a tool call span with the latest semantic conventions."""
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
    tracer = Tracer()
    tool_result = {"status": "success", "content": [{"text": "Tool result"}, {"json": {"foo": "bar"}}]}

    tracer.end_tool_call_span(mock_span, tool_result)

    mock_span.set_attributes.assert_called_once_with(
        {
            "gen_ai.tool.status": "success",
            "gen_ai.tool.call.result": serialize(tool_result.get("content")),
        }
    )
    mock_span.add_event.assert_called_with(
        "gen_ai.client.inference.operation.details",
        attributes={
            "gen_ai.output.messages": serialize(
                [
                    {
                        "role": "tool",
                        "parts": [
                            {
                                "type": "tool_call_response",
                                "id": tool_result.get("toolUseId", ""),
                                "response": tool_result.get("content"),
                            }
                        ],
                    }
                ]
            )
        },
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_tool_call_span_latest_conventions_error_omits_result(mock_span, monkeypatch):
    """The gen_ai.tool.call.result attribute is scoped to successful executions and omitted on error status."""
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
    tracer = Tracer()
    tool_result = {"toolUseId": "abc", "status": "error", "content": [{"text": "tool exploded"}]}

    tracer.end_tool_call_span(mock_span, tool_result)

    mock_span.set_attributes.assert_called_once_with({"gen_ai.tool.status": "error"})
    mock_span.set_status.assert_called_once_with(StatusCode.ERROR, "tool exploded")
    mock_span.end.assert_called_once()


def test_end_tool_call_span_with_error(mock_span):
    """Test ending a tool call span with an explicit error sets StatusCode.ERROR."""
    tracer = Tracer()
    error = ValueError("tool exploded")
    tool_result = {"status": "error", "content": [{"text": "Error: tool exploded"}]}

    tracer.end_tool_call_span(mock_span, tool_result, error=error)

    mock_span.set_attributes.assert_called_once_with({"gen_ai.tool.status": "error"})
    mock_span.set_status.assert_called_once_with(StatusCode.ERROR, "tool exploded")
    mock_span.record_exception.assert_called_once_with(error)
    mock_span.end.assert_called_once()


def test_end_tool_call_span_error_result_no_exception(mock_span):
    """Test that an error result without an exception still sets StatusCode.ERROR."""
    tracer = Tracer()
    tool_result = {"status": "error", "content": [{"text": "tool cancelled by user"}]}

    tracer.end_tool_call_span(mock_span, tool_result)

    mock_span.set_attributes.assert_called_once_with({"gen_ai.tool.status": "error"})
    mock_span.set_status.assert_called_once_with(StatusCode.ERROR, "tool cancelled by user")
    mock_span.record_exception.assert_not_called()
    mock_span.end.assert_called_once()


def test_start_event_loop_cycle_span(mock_tracer):
    """Test starting an event loop cycle span."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        event_loop_kwargs = {"event_loop_cycle_id": "cycle-123"}
        messages = [{"role": "user", "content": [{"text": "Hello"}]}]
        custom_attrs = {"request_id": "req-456", "trace_level": "debug"}

        span = tracer.start_event_loop_cycle_span(
            event_loop_kwargs, messages=messages, custom_trace_attributes=custom_attrs
        )

        mock_tracer.start_span.assert_called_once()
        assert mock_tracer.start_span.call_args[1]["name"] == "execute_event_loop_cycle"

        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "execute_event_loop_cycle",
                "gen_ai.system": "strands-agents",
                "event_loop.cycle_id": "cycle-123",
                "request_id": "req-456",
                "trace_level": "debug",
            }
        )
        mock_span.add_event.assert_any_call(
            "gen_ai.user.message", attributes={"content": json.dumps([{"text": "Hello"}])}
        )
        assert span is not None


def test_start_event_loop_cycle_span_latest_conventions(mock_tracer, monkeypatch):
    """Test starting an event loop cycle span with the latest semantic conventions."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        event_loop_kwargs = {"event_loop_cycle_id": "cycle-123"}
        messages = [{"role": "user", "content": [{"text": "Hello"}]}]

        span = tracer.start_event_loop_cycle_span(event_loop_kwargs, messages=messages)

        mock_tracer.start_span.assert_called_once()
        assert mock_tracer.start_span.call_args[1]["name"] == "execute_event_loop_cycle"

        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "execute_event_loop_cycle",
                "gen_ai.provider.name": "strands-agents",
                "event_loop.cycle_id": "cycle-123",
            }
        )
        mock_span.add_event.assert_any_call(
            "gen_ai.client.inference.operation.details",
            attributes={
                "gen_ai.input.messages": serialize([{"role": "user", "parts": [{"type": "text", "content": "Hello"}]}])
            },
        )
        assert span is not None


def test_end_event_loop_cycle_span(mock_span):
    """Test ending an event loop cycle span."""
    tracer = Tracer()
    message = {"role": "assistant", "content": [{"text": "Response"}]}
    tool_result_message = {
        "role": "assistant",
        "content": [
            {"toolResult": {"toolUseId": "123", "status": "success", "content": [{"text": "Weather is sunny"}]}}
        ],
    }

    tracer.end_event_loop_cycle_span(mock_span, message, tool_result_message)

    mock_span.add_event.assert_called_with(
        "gen_ai.choice",
        attributes={
            "message": json.dumps(message["content"]),
            "tool.result": json.dumps(tool_result_message["content"]),
        },
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_event_loop_cycle_span_latest_conventions(mock_span, monkeypatch):
    """Test ending an event loop cycle span with the latest semantic conventions."""
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
    tracer = Tracer()
    message = {"role": "assistant", "content": [{"text": "Response"}]}
    tool_result_message = {
        "role": "assistant",
        "content": [
            {"toolResult": {"toolUseId": "123", "status": "success", "content": [{"text": "Weather is sunny"}]}}
        ],
    }

    tracer.end_event_loop_cycle_span(mock_span, message, tool_result_message)

    mock_span.add_event.assert_called_with(
        "gen_ai.client.inference.operation.details",
        attributes={
            "gen_ai.input.messages": serialize(
                [
                    {
                        "role": "assistant",
                        "parts": [
                            {
                                "type": "tool_call_response",
                                "id": "123",
                                "response": [{"text": "Weather is sunny"}],
                            }
                        ],
                    }
                ]
            )
        },
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_start_agent_span(mock_tracer):
    """Test starting an agent span."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        content = [{"text": "test prompt"}]
        model_id = "test-model"
        tools = [{"name": "weather_tool"}]
        custom_attrs = {"custom_attr": "value"}
        system_prompt = "You are a helpful assistant"

        span = tracer.start_agent_span(
            custom_trace_attributes=custom_attrs,
            agent_name="WeatherAgent",
            messages=[{"content": content, "role": "user"}],
            model_id=model_id,
            tools=tools,
            system_prompt=system_prompt,
        )

        mock_tracer.start_span.assert_called_once()
        assert mock_tracer.start_span.call_args[1]["name"] == "invoke_agent WeatherAgent"
        assert mock_tracer.start_span.call_args[1]["kind"] == SpanKind.INTERNAL

        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "invoke_agent",
                "gen_ai.system": "strands-agents",
                "gen_ai.agent.name": "WeatherAgent",
                "gen_ai.request.model": model_id,
                "gen_ai.agent.tools": json.dumps(tools),
                "custom_attr": "value",
            }
        )
        mock_span.add_event.assert_any_call(
            "gen_ai.system.message", attributes={"content": serialize([{"text": system_prompt}])}
        )
        mock_span.add_event.assert_any_call("gen_ai.user.message", attributes={"content": json.dumps(content)})
        assert span is not None


def test_start_agent_span_latest_conventions(mock_tracer, monkeypatch):
    """Test starting an agent span with the latest semantic conventions."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        content = [{"text": "test prompt"}]
        model_id = "test-model"
        tools = [{"name": "weather_tool"}]
        custom_attrs = {"custom_attr": "value"}
        system_prompt = "You are a helpful assistant"

        span = tracer.start_agent_span(
            custom_trace_attributes=custom_attrs,
            agent_name="WeatherAgent",
            messages=[{"content": content, "role": "user"}],
            model_id=model_id,
            tools=tools,
            system_prompt=system_prompt,
        )

        mock_tracer.start_span.assert_called_once()
        assert mock_tracer.start_span.call_args[1]["name"] == "invoke_agent WeatherAgent"

        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "invoke_agent",
                "gen_ai.provider.name": "strands-agents",
                "gen_ai.agent.name": "WeatherAgent",
                "gen_ai.request.model": model_id,
                "gen_ai.agent.tools": json.dumps(tools),
                "custom_attr": "value",
                "gen_ai.system_instructions": serialize([{"type": "text", "content": system_prompt}]),
            }
        )
        mock_span.add_event.assert_any_call(
            "gen_ai.client.inference.operation.details",
            attributes={
                "gen_ai.input.messages": serialize(
                    [{"role": "user", "parts": [{"type": "text", "content": "test prompt"}]}]
                )
            },
        )
        assert span is not None


def test_start_agent_span_records_system_instructions(mock_tracer, monkeypatch):
    """Test that agent system prompts use the semantic-convention attribute."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        system_prompt_content = [{"text": "Be helpful"}, {"cachePoint": {"type": "default"}}]
        tracer.start_agent_span(
            messages=[],
            agent_name="TestAgent",
            system_prompt="ignored string",
            system_prompt_content=system_prompt_content,
        )

        set_attrs_call = mock_span.set_attributes.call_args_list[0][0][0]
        assert set_attrs_call["gen_ai.system_instructions"] == serialize(
            [
                {"type": "text", "content": "Be helpful"},
                {"type": "cachePoint", "content": {"type": "default"}},
            ]
        )
        assert "system_prompt" not in set_attrs_call


def test_end_agent_span(mock_span):
    """Test ending an agent span."""
    tracer = Tracer()

    # Mock AgentResult with metrics
    mock_metrics = mock.MagicMock()
    mock_metrics.accumulated_usage = {"inputTokens": 50, "outputTokens": 100, "totalTokens": 150}

    mock_response = mock.MagicMock()
    mock_response.metrics = mock_metrics
    mock_response.stop_reason = "end_turn"
    mock_response.__str__ = mock.MagicMock(return_value="Agent response")

    tracer.end_agent_span(mock_span, mock_response)

    mock_span.set_attributes.assert_called_once_with(
        {
            "gen_ai.usage.prompt_tokens": 50,
            "gen_ai.usage.input_tokens": 50,
            "gen_ai.usage.completion_tokens": 100,
            "gen_ai.usage.output_tokens": 100,
            "gen_ai.usage.total_tokens": 150,
            "gen_ai.usage.cache_read.input_tokens": 0,
            "gen_ai.usage.cache_creation.input_tokens": 0,
            "gen_ai.usage.cache_read_input_tokens": 0,
            "gen_ai.usage.cache_write_input_tokens": 0,
        }
    )
    mock_span.add_event.assert_any_call(
        "gen_ai.choice",
        attributes={"message": "Agent response", "finish_reason": "end_turn"},
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_agent_span_with_langfuse_observation_type(mock_span, monkeypatch):
    """Test ending an agent span with Langfuse observation type to prevent double counting the tokens."""
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://us.cloud.langfuse.com")
    tracer = Tracer()

    # Mock AgentResult with metrics
    mock_metrics = mock.MagicMock()
    mock_metrics.accumulated_usage = {"inputTokens": 50, "outputTokens": 100, "totalTokens": 150}

    mock_response = mock.MagicMock()
    mock_response.metrics = mock_metrics
    mock_response.stop_reason = "end_turn"
    mock_response.__str__ = mock.MagicMock(return_value="Agent response")

    tracer.end_agent_span(mock_span, mock_response)

    mock_span.set_attributes.assert_called_once_with(
        {
            "langfuse.observation.type": "span",
            "gen_ai.usage.prompt_tokens": 50,
            "gen_ai.usage.input_tokens": 50,
            "gen_ai.usage.completion_tokens": 100,
            "gen_ai.usage.output_tokens": 100,
            "gen_ai.usage.total_tokens": 150,
            "gen_ai.usage.cache_read.input_tokens": 0,
            "gen_ai.usage.cache_creation.input_tokens": 0,
            "gen_ai.usage.cache_read_input_tokens": 0,
            "gen_ai.usage.cache_write_input_tokens": 0,
        }
    )
    mock_span.add_event.assert_any_call(
        "gen_ai.choice",
        attributes={"message": "Agent response", "finish_reason": "end_turn"},
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_agent_span_latest_conventions(mock_span, monkeypatch):
    """Test ending an agent span with the latest semantic conventions."""
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
    tracer = Tracer()

    # Mock AgentResult with metrics
    mock_metrics = mock.MagicMock()
    mock_metrics.accumulated_usage = {"inputTokens": 50, "outputTokens": 100, "totalTokens": 150}

    mock_response = mock.MagicMock()
    mock_response.metrics = mock_metrics
    mock_response.stop_reason = "end_turn"
    mock_response.__str__ = mock.MagicMock(return_value="Agent response")

    tracer.end_agent_span(mock_span, mock_response)

    # Opted into the latest conventions: semconv cache names only, deprecated aliases suppressed.
    mock_span.set_attributes.assert_called_once_with(
        {
            "gen_ai.usage.prompt_tokens": 50,
            "gen_ai.usage.input_tokens": 50,
            "gen_ai.usage.completion_tokens": 100,
            "gen_ai.usage.output_tokens": 100,
            "gen_ai.usage.total_tokens": 150,
            "gen_ai.usage.cache_read.input_tokens": 0,
            "gen_ai.usage.cache_creation.input_tokens": 0,
        }
    )
    mock_span.add_event.assert_called_with(
        "gen_ai.client.inference.operation.details",
        attributes={
            "gen_ai.output.messages": serialize(
                [
                    {
                        "role": "assistant",
                        "parts": [{"type": "text", "content": "Agent response"}],
                        "finish_reason": "end_turn",
                    }
                ]
            )
        },
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_agent_span_uses_per_invocation_usage_when_opted_in(mock_span, monkeypatch):
    """Test that agent span reports per-invocation usage when gen_ai_use_latest_invocation_tokens is set."""
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_use_latest_invocation_tokens")
    tracer = Tracer()

    mock_invocation = mock.MagicMock()
    mock_invocation.usage = {"inputTokens": 100, "outputTokens": 50, "totalTokens": 150}

    mock_metrics = mock.MagicMock()
    mock_metrics.accumulated_usage = {"inputTokens": 1000, "outputTokens": 500, "totalTokens": 1500}
    mock_metrics.latest_agent_invocation = mock_invocation

    mock_response = mock.MagicMock()
    mock_response.metrics = mock_metrics
    mock_response.stop_reason = "end_turn"
    mock_response.__str__ = mock.MagicMock(return_value="Agent response")

    tracer.end_agent_span(mock_span, mock_response)

    call_args = mock_span.set_attributes.call_args[0][0]
    assert call_args["gen_ai.usage.input_tokens"] == 100
    assert call_args["gen_ai.usage.output_tokens"] == 50
    assert call_args["gen_ai.usage.total_tokens"] == 150
    assert call_args["gen_ai.usage.prompt_tokens"] == 100
    assert call_args["gen_ai.usage.completion_tokens"] == 50


def test_end_agent_span_warns_when_opted_in_but_no_invocations(mock_span, monkeypatch, caplog):
    """Test warning and zero usage when opted in but no agent invocations exist."""
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_use_latest_invocation_tokens")
    tracer = Tracer()

    mock_metrics = mock.MagicMock()
    mock_metrics.accumulated_usage = {"inputTokens": 200, "outputTokens": 100, "totalTokens": 300}
    mock_metrics.latest_agent_invocation = None

    mock_response = mock.MagicMock()
    mock_response.metrics = mock_metrics
    mock_response.stop_reason = "end_turn"
    mock_response.__str__ = mock.MagicMock(return_value="Agent response")

    with caplog.at_level(logging.WARNING):
        tracer.end_agent_span(mock_span, mock_response)

    assert "latest_agent_invocation is None" in caplog.text
    call_args = mock_span.set_attributes.call_args[0][0]
    assert call_args["gen_ai.usage.input_tokens"] == 0
    assert call_args["gen_ai.usage.output_tokens"] == 0
    assert call_args["gen_ai.usage.total_tokens"] == 0


def test_end_model_invoke_span_with_cache_metrics(mock_span):
    """Test ending a model invoke span with cache metrics."""
    tracer = Tracer()
    message = {"role": "assistant", "content": [{"text": "Response"}]}
    usage = Usage(
        inputTokens=10,
        outputTokens=20,
        totalTokens=30,
        cacheReadInputTokens=5,
        cacheWriteInputTokens=3,
    )
    stop_reason: StopReason = "end_turn"
    metrics = Metrics(latencyMs=10, timeToFirstByteMs=5)

    tracer.end_model_invoke_span(mock_span, message, usage, metrics, stop_reason)

    mock_span.set_attributes.assert_called_once_with(
        {
            "gen_ai.usage.prompt_tokens": 10,
            "gen_ai.usage.input_tokens": 10,
            "gen_ai.usage.completion_tokens": 20,
            "gen_ai.usage.output_tokens": 20,
            "gen_ai.usage.total_tokens": 30,
            "gen_ai.usage.cache_read.input_tokens": 5,
            "gen_ai.usage.cache_creation.input_tokens": 3,
            "gen_ai.usage.cache_read_input_tokens": 5,
            "gen_ai.usage.cache_write_input_tokens": 3,
            "gen_ai.server.request.duration": 10,
            "gen_ai.server.time_to_first_token": 5,
        }
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_model_invoke_span_counts_disjoint_cache_tokens(mock_span):
    """Regression for #3546: input_tokens is the total prompt when cache is additional to inputTokens.

    On disjoint providers (Bedrock/Anthropic) inputTokens + outputTokens != totalTokens, so the cache
    reads/writes are additional and count toward the prompt the model processed. gen_ai.usage.input_tokens
    (and its prompt_tokens alias) report 38, not the bare inputTokens of 10.
    """
    tracer = Tracer()
    message = {"role": "assistant", "content": [{"text": "Response"}]}
    usage = Usage(
        inputTokens=10,
        outputTokens=20,
        totalTokens=58,
        cacheReadInputTokens=25,
        cacheWriteInputTokens=3,
    )
    stop_reason: StopReason = "end_turn"
    metrics = Metrics(latencyMs=10, timeToFirstByteMs=5)

    tracer.end_model_invoke_span(mock_span, message, usage, metrics, stop_reason)

    mock_span.set_attributes.assert_called_once_with(
        {
            "gen_ai.usage.prompt_tokens": 38,
            "gen_ai.usage.input_tokens": 38,
            "gen_ai.usage.completion_tokens": 20,
            "gen_ai.usage.output_tokens": 20,
            "gen_ai.usage.total_tokens": 58,
            "gen_ai.usage.cache_read.input_tokens": 25,
            "gen_ai.usage.cache_creation.input_tokens": 3,
            "gen_ai.usage.cache_read_input_tokens": 25,
            "gen_ai.usage.cache_write_input_tokens": 3,
            "gen_ai.server.request.duration": 10,
            "gen_ai.server.time_to_first_token": 5,
        }
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_agent_span_with_cache_metrics(mock_span):
    """Test ending an agent span with cache metrics."""
    tracer = Tracer()

    # Mock AgentResult with metrics including cache tokens
    mock_metrics = mock.MagicMock()
    mock_metrics.accumulated_usage = {
        "inputTokens": 50,
        "outputTokens": 100,
        "totalTokens": 150,
        "cacheReadInputTokens": 25,
        "cacheWriteInputTokens": 10,
    }

    mock_response = mock.MagicMock()
    mock_response.metrics = mock_metrics
    mock_response.stop_reason = "end_turn"
    mock_response.__str__ = mock.MagicMock(return_value="Agent response")

    tracer.end_agent_span(mock_span, mock_response)

    mock_span.set_attributes.assert_called_once_with(
        {
            "gen_ai.usage.prompt_tokens": 50,
            "gen_ai.usage.input_tokens": 50,
            "gen_ai.usage.completion_tokens": 100,
            "gen_ai.usage.output_tokens": 100,
            "gen_ai.usage.total_tokens": 150,
            "gen_ai.usage.cache_read.input_tokens": 25,
            "gen_ai.usage.cache_creation.input_tokens": 10,
            "gen_ai.usage.cache_read_input_tokens": 25,
            "gen_ai.usage.cache_write_input_tokens": 10,
        }
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_agent_span_counts_disjoint_cache_tokens(mock_span):
    """Regression for #3546: input_tokens is the total prompt when cache is additional to inputTokens.

    On disjoint providers (Bedrock/Anthropic) inputTokens + outputTokens != totalTokens, so the cache
    reads/writes are additional and count toward the prompt the model processed. gen_ai.usage.input_tokens
    (and its prompt_tokens alias) report 85, not the bare inputTokens of 50.
    """
    tracer = Tracer()

    mock_metrics = mock.MagicMock()
    mock_metrics.accumulated_usage = {
        "inputTokens": 50,
        "outputTokens": 100,
        "totalTokens": 185,
        "cacheReadInputTokens": 25,
        "cacheWriteInputTokens": 10,
    }

    mock_response = mock.MagicMock()
    mock_response.metrics = mock_metrics
    mock_response.stop_reason = "end_turn"
    mock_response.__str__ = mock.MagicMock(return_value="Agent response")

    tracer.end_agent_span(mock_span, mock_response)

    mock_span.set_attributes.assert_called_once_with(
        {
            "gen_ai.usage.prompt_tokens": 85,
            "gen_ai.usage.input_tokens": 85,
            "gen_ai.usage.completion_tokens": 100,
            "gen_ai.usage.output_tokens": 100,
            "gen_ai.usage.total_tokens": 185,
            "gen_ai.usage.cache_read.input_tokens": 25,
            "gen_ai.usage.cache_creation.input_tokens": 10,
            "gen_ai.usage.cache_read_input_tokens": 25,
            "gen_ai.usage.cache_write_input_tokens": 10,
        }
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_model_invoke_span_dual_emits_semconv_and_deprecated_cache_names(mock_span):
    """Cache usage is emitted under both the semconv names and the deprecated pre-semconv aliases.

    Regression for https://github.com/strands-agents/harness-sdk/issues/3754.
    """
    tracer = Tracer()
    message = {"role": "assistant", "content": [{"text": "Response"}]}
    usage = Usage(inputTokens=10, outputTokens=4, totalTokens=14, cacheReadInputTokens=5848)
    metrics = Metrics(latencyMs=0, timeToFirstByteMs=0)

    tracer.end_model_invoke_span(mock_span, message, usage, metrics, "end_turn")

    emitted = mock_span.set_attributes.call_args[0][0]
    assert emitted["gen_ai.usage.cache_read.input_tokens"] == 5848
    # deprecated alias kept so existing consumers keep resolving, value-identical to the semconv name
    assert emitted["gen_ai.usage.cache_read_input_tokens"] == 5848


def test_end_model_invoke_span_latest_conventions_suppresses_deprecated_cache_names(mock_span, monkeypatch):
    """Opting into the latest conventions emits the semconv cache names only, without the deprecated aliases."""
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
    tracer = Tracer()
    message = {"role": "assistant", "content": [{"text": "Response"}]}
    usage = Usage(inputTokens=10, outputTokens=4, totalTokens=14, cacheReadInputTokens=5848, cacheWriteInputTokens=3)
    metrics = Metrics(latencyMs=0, timeToFirstByteMs=0)

    tracer.end_model_invoke_span(mock_span, message, usage, metrics, "end_turn")

    emitted = mock_span.set_attributes.call_args[0][0]
    assert emitted["gen_ai.usage.cache_read.input_tokens"] == 5848
    assert emitted["gen_ai.usage.cache_creation.input_tokens"] == 3
    assert "gen_ai.usage.cache_read_input_tokens" not in emitted
    assert "gen_ai.usage.cache_write_input_tokens" not in emitted


def test_get_tracer_singleton():
    """Test that get_tracer returns a singleton instance."""
    # Reset the singleton first
    with mock.patch("strands.telemetry.tracer._tracer_instance", None):
        tracer1 = get_tracer()
        tracer2 = get_tracer()

        assert tracer1 is tracer2


def test_get_tracer_new_endpoint():
    """Test that get_tracer creates a new instance when endpoint changes."""
    # Reset the singleton first
    with mock.patch("strands.telemetry.tracer._tracer_instance", None):
        tracer1 = get_tracer()
        tracer2 = get_tracer()

        assert tracer1 is tracer2


def test_initialize_tracer_with_custom_tracer_provider(mock_get_tracer_provider):
    """Test initializing the tracer with NoOpTracerProvider."""
    tracer = Tracer()

    mock_get_tracer_provider.assert_called()

    assert tracer.tracer_provider is not None
    assert tracer.tracer is not None


def test_end_span_with_exception_handling(mock_span):
    """Test ending a span with exception handling."""
    tracer = Tracer()

    # Make set_attribute throw an exception
    mock_span.set_attribute.side_effect = Exception("Test error during set_attribute")

    try:
        # Should not raise an exception
        tracer._end_span(mock_span, {"key": "value"})

        # Should still try to end the span
        mock_span.end.assert_called_once()
    except Exception:
        pytest.fail("_end_span should not raise exceptions")


def test_end_tool_call_span_with_none(mock_span):
    """Test ending a tool call span with None result."""
    tracer = Tracer()

    # Should not raise an exception
    tracer.end_tool_call_span(mock_span, None)

    # Should still end the span
    mock_span.end.assert_called_once()


def test_start_model_invoke_span_with_parent(mock_tracer):
    """Test starting a model invoke span with a parent span."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        parent_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        span = tracer.start_model_invoke_span(
            messages=[], parent_span=parent_span, agent_name="TestAgent", model_id="test-model"
        )

        # Verify trace.set_span_in_context was called with parent span
        mock_tracer.start_span.assert_called_once()

        # Verify span was returned
        assert span is mock_span


@pytest.mark.parametrize(
    "input_data, expected_result",
    [
        ("test string", '"test string"'),
        (1234, "1234"),
        (13.37, "13.37"),
        (False, "false"),
        (None, "null"),
    ],
)
def test_json_encoder_serializable(input_data, expected_result):
    """Test encoding of serializable values."""
    encoder = JSONEncoder()

    result = encoder.encode(input_data)
    assert result == expected_result


def test_json_encoder_datetime():
    """Test encoding datetime and date objects."""
    encoder = JSONEncoder()

    dt = datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    result = encoder.encode(dt)
    assert result == f'"{dt.isoformat()}"'

    d = date(2025, 1, 1)
    result = encoder.encode(d)
    assert result == f'"{d.isoformat()}"'


def test_json_encoder_list():
    """Test encoding a list with mixed content."""
    encoder = JSONEncoder()

    non_serializable = lambda x: x  # noqa: E731

    data = ["value", 42, 13.37, non_serializable, None, {"key": True}, ["value here"]]

    result = json.loads(encoder.encode(data))
    assert result == ["value", 42, 13.37, "<replaced>", None, {"key": True}, ["value here"]]


def test_json_encoder_dict():
    """Test encoding a dict with mixed content."""
    encoder = JSONEncoder()

    class UnserializableClass:
        def __str__(self):
            return "Unserializable Object"

    non_serializable = lambda x: x  # noqa: E731

    now = datetime.now(timezone.utc)

    data = {
        "metadata": {
            "timestamp": now,
            "version": "1.0",
            "debug_info": {"object": non_serializable, "callable": lambda x: x + 1},  # noqa: E731
        },
        "content": [
            {"type": "text", "value": "Hello world"},
            {"type": "binary", "value": non_serializable},
            {"type": "mixed", "values": [1, "text", non_serializable, {"nested": non_serializable}]},
        ],
        "statistics": {
            "processed": 100,
            "failed": 5,
            "details": [{"id": 1, "status": "ok"}, {"id": 2, "status": "error", "error_obj": non_serializable}],
        },
        "list": [
            non_serializable,
            1234,
            13.37,
            True,
            None,
            "string here",
        ],
    }

    expected = {
        "metadata": {
            "timestamp": now.isoformat(),
            "version": "1.0",
            "debug_info": {"object": "<replaced>", "callable": "<replaced>"},
        },
        "content": [
            {"type": "text", "value": "Hello world"},
            {"type": "binary", "value": "<replaced>"},
            {"type": "mixed", "values": [1, "text", "<replaced>", {"nested": "<replaced>"}]},
        ],
        "statistics": {
            "processed": 100,
            "failed": 5,
            "details": [{"id": 1, "status": "ok"}, {"id": 2, "status": "error", "error_obj": "<replaced>"}],
        },
        "list": [
            "<replaced>",
            1234,
            13.37,
            True,
            None,
            "string here",
        ],
    }

    result = json.loads(encoder.encode(data))

    assert result == expected


def test_json_encoder_value_error():
    """Test encoding values that cause ValueError."""
    encoder = JSONEncoder()

    # A very large integer that exceeds JSON limits and throws ValueError
    huge_number = 2**100000

    # Test in a dictionary
    dict_data = {"normal": 42, "huge": huge_number}
    result = json.loads(encoder.encode(dict_data))
    assert result == {"normal": 42, "huge": "<replaced>"}

    # Test in a list
    list_data = [42, huge_number]
    result = json.loads(encoder.encode(list_data))
    assert result == [42, "<replaced>"]

    # Test just the value
    result = json.loads(encoder.encode(huge_number))
    assert result == "<replaced>"


def test_serialize_non_ascii_characters():
    """Test that non-ASCII characters are preserved in JSON serialization."""

    # Test with Japanese text
    japanese_text = "こんにちは世界"
    result = serialize({"text": japanese_text})
    assert japanese_text in result
    assert "\\u" not in result

    # Test with emoji
    emoji_text = "Hello 🌍"
    result = serialize({"text": emoji_text})
    assert emoji_text in result
    assert "\\u" not in result

    # Test with Chinese characters
    chinese_text = "你好，世界"
    result = serialize({"text": chinese_text})
    assert chinese_text in result
    assert "\\u" not in result

    # Test with mixed content
    mixed_text = {"ja": "こんにちは", "emoji": "😊", "zh": "你好", "en": "hello"}
    result = serialize(mixed_text)
    assert "こんにちは" in result
    assert "😊" in result
    assert "你好" in result
    assert "\\u" not in result


def test_serialize_vs_json_dumps():
    """Test that serialize behaves differently from default json.dumps for non-ASCII characters."""

    # Test with Japanese text
    japanese_text = "こんにちは世界"

    # Default json.dumps should escape non-ASCII characters
    default_result = json.dumps({"text": japanese_text})
    assert "\\u" in default_result

    # Our serialize function should preserve non-ASCII characters
    custom_result = serialize({"text": japanese_text})
    assert japanese_text in custom_result
    assert "\\u" not in custom_result


@pytest.mark.parametrize(
    "message, expected_event_name, description",
    [
        # Regular role-based messages
        (
            {"role": "user", "content": [{"text": "Hello"}]},
            "gen_ai.user.message",
            "regular user message",
        ),
        (
            {"role": "assistant", "content": [{"text": "Hello"}]},
            "gen_ai.assistant.message",
            "regular assistant message",
        ),
        (
            {"role": "system", "content": [{"text": "You are a helpful assistant"}]},
            "gen_ai.system.message",
            "regular system message",
        ),
        # Messages with tool results should always be labeled as tool messages
        (
            {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "123",
                            "status": "success",
                            "content": [{"text": "Tool response"}],
                        }
                    }
                ],
            },
            "gen_ai.tool.message",
            "user message containing tool result",
        ),
        (
            {
                "role": "assistant",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "123",
                            "status": "success",
                            "content": [{"text": "Tool response"}],
                        }
                    }
                ],
            },
            "gen_ai.tool.message",
            "assistant message containing tool result",
        ),
        # Mixed content with tool results
        (
            {
                "role": "user",
                "content": [
                    {"text": "Here are the results:"},
                    {
                        "toolResult": {
                            "toolUseId": "123",
                            "status": "success",
                            "content": [{"text": "Tool response"}],
                        }
                    },
                ],
            },
            "gen_ai.tool.message",
            "message with both text and tool result",
        ),
        # Multiple tool results
        (
            {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "123",
                            "status": "success",
                            "content": [{"text": "First tool"}],
                        }
                    },
                    {
                        "toolResult": {
                            "toolUseId": "456",
                            "status": "success",
                            "content": [{"text": "Second tool"}],
                        }
                    },
                ],
            },
            "gen_ai.tool.message",
            "message with multiple tool results",
        ),
        # Edge cases
        (
            {"role": "user", "content": []},
            "gen_ai.user.message",
            "message with empty content",
        ),
        (
            {"role": "assistant"},
            "gen_ai.assistant.message",
            "message with no content key",
        ),
    ],
)
def test_get_event_name_for_message(message, expected_event_name, description):
    """Test getting event name for various message types using data-driven approach."""
    tracer = Tracer()

    event_name = tracer._get_event_name_for_message(message)

    assert event_name == expected_event_name, f"Failed for {description}"


def test_start_model_invoke_span_with_tool_result_message(mock_tracer):
    """Test that start_model_invoke_span correctly labels tool result messages."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        # Message that contains a tool result
        messages = [
            {
                "role": "user",
                "content": [
                    {"toolResult": {"toolUseId": "123", "status": "success", "content": [{"text": "Weather is sunny"}]}}
                ],
            }
        ]

        span = tracer.start_model_invoke_span(messages=messages, model_id="test-model")

        # Should use gen_ai.tool.message event name instead of gen_ai.user.message
        mock_span.add_event.assert_called_with(
            "gen_ai.tool.message", attributes={"content": json.dumps(messages[0]["content"])}
        )
        assert span is not None


def test_start_agent_span_with_tool_result_message(mock_tracer):
    """Test that start_agent_span correctly labels tool result messages."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        # Message that contains a tool result
        messages = [
            {
                "role": "user",
                "content": [
                    {"toolResult": {"toolUseId": "123", "status": "success", "content": [{"text": "Weather is sunny"}]}}
                ],
            }
        ]

        span = tracer.start_agent_span(messages=messages, agent_name="WeatherAgent", model_id="test-model")

        # Should use gen_ai.tool.message event name instead of gen_ai.user.message
        mock_span.add_event.assert_called_with(
            "gen_ai.tool.message", attributes={"content": json.dumps(messages[0]["content"])}
        )
        assert span is not None


def test_start_event_loop_cycle_span_with_tool_result_message(mock_tracer):
    """Test that start_event_loop_cycle_span correctly labels tool result messages."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        # Message that contains a tool result
        messages = [
            {
                "role": "user",
                "content": [
                    {"toolResult": {"toolUseId": "123", "status": "success", "content": [{"text": "Weather is sunny"}]}}
                ],
            }
        ]

        event_loop_kwargs = {"event_loop_cycle_id": "cycle-123"}
        span = tracer.start_event_loop_cycle_span(event_loop_kwargs, messages=messages)

        # Should use gen_ai.tool.message event name instead of gen_ai.user.message
        mock_span.add_event.assert_called_with(
            "gen_ai.tool.message", attributes={"content": json.dumps(messages[0]["content"])}
        )
        assert span is not None


def test_start_agent_span_does_not_include_tool_definitions_by_default():
    """Verify that start_agent_span does not include tool definitions by default."""
    tracer = Tracer()
    tracer._start_span = mock.MagicMock()

    tools_config = {
        "my_tool": {
            "name": "my_tool",
            "description": "A test tool",
            "inputSchema": {"json": {}},
            "outputSchema": {"json": {}},
        }
    }

    tracer.start_agent_span(messages=[], agent_name="TestAgent", tools_config=tools_config)

    tracer._start_span.assert_called_once()
    _, call_kwargs = tracer._start_span.call_args
    attributes = call_kwargs.get("attributes", {})
    assert "gen_ai.tool.definitions" not in attributes


def test_start_agent_span_includes_tool_definitions_when_enabled(monkeypatch):
    """Verify that start_agent_span includes tool definitions when enabled."""
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_tool_definitions")
    tracer = Tracer()
    tracer._start_span = mock.MagicMock()

    tools_config = {
        "my_tool": {
            "name": "my_tool",
            "description": "A test tool",
            "inputSchema": {"json": {"type": "object", "properties": {}}},
            "outputSchema": {"json": {"type": "object", "properties": {}}},
        }
    }

    tracer.start_agent_span(messages=[], agent_name="TestAgent", tools_config=tools_config)

    tracer._start_span.assert_called_once()
    _, call_kwargs = tracer._start_span.call_args
    attributes = call_kwargs.get("attributes", {})

    assert "gen_ai.tool.definitions" in attributes
    expected_tool_details = [
        {
            "name": "my_tool",
            "description": "A test tool",
            "inputSchema": {"json": {"type": "object", "properties": {}}},
            "outputSchema": {"json": {"type": "object", "properties": {}}},
        }
    ]
    expected_json = serialize(expected_tool_details)
    assert attributes["gen_ai.tool.definitions"] == expected_json


def test_end_model_invoke_span_langfuse_adds_attributes(mock_span, monkeypatch):
    """Test that end_model_invoke_span records content on span attributes, not an event, for Langfuse."""
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://us.cloud.langfuse.com")

    tracer = Tracer()
    message = {"role": "assistant", "content": [{"text": "Response"}]}
    usage = Usage(inputTokens=10, outputTokens=20, totalTokens=30)
    metrics = Metrics(latencyMs=20, timeToFirstByteMs=10)
    stop_reason: StopReason = "end_turn"

    tracer.end_model_invoke_span(mock_span, message, usage, metrics, stop_reason)

    expected_output = serialize(
        [
            {
                "role": "assistant",
                "parts": [{"type": "text", "content": "Response"}],
                "finish_reason": "end_turn",
            }
        ]
    )

    assert mock_span.set_attributes.call_count == 2
    mock_span.set_attributes.assert_any_call({"gen_ai.output.messages": expected_output})
    mock_span.set_attributes.assert_any_call(
        {
            "gen_ai.usage.prompt_tokens": 10,
            "gen_ai.usage.input_tokens": 10,
            "gen_ai.usage.completion_tokens": 20,
            "gen_ai.usage.output_tokens": 20,
            "gen_ai.usage.total_tokens": 30,
            "gen_ai.server.time_to_first_token": 10,
            "gen_ai.server.request.duration": 20,
        }
    )

    # Content is recorded once as a span attribute; the deprecated content event is not duplicated.
    content_event_names = [call.args[0] for call in mock_span.add_event.call_args_list]
    assert "gen_ai.client.inference.operation.details" not in content_event_names


def test_end_model_invoke_span_non_langfuse_no_extra_attributes(mock_span, monkeypatch):
    """Test that end_model_invoke_span doesn't add extra attributes for non-Langfuse endpoints."""
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://api.honeycomb.io")

    tracer = Tracer()
    message = {"role": "assistant", "content": [{"text": "Response"}]}
    usage = Usage(inputTokens=10, outputTokens=20, totalTokens=30)
    metrics = Metrics(latencyMs=20, timeToFirstByteMs=10)
    stop_reason: StopReason = "end_turn"

    tracer.end_model_invoke_span(mock_span, message, usage, metrics, stop_reason)

    # Verify that set_attribute was NOT called with gen_ai.output.messages
    # (it should only be in the event, not as an attribute)
    expected_output = serialize(
        [
            {
                "role": "assistant",
                "parts": [{"type": "text", "content": "Response"}],
                "finish_reason": "end_turn",
            }
        ]
    )

    # Check that gen_ai.output.messages was not set as an attribute
    set_attribute_calls = [call[0][0] for call in mock_span.set_attribute.call_args_list]
    assert "gen_ai.output.messages" not in set_attribute_calls

    # But verify that add_event was still called
    mock_span.add_event.assert_called_with(
        "gen_ai.client.inference.operation.details",
        attributes={"gen_ai.output.messages": expected_output},
    )


def test_start_memory_search_span(mock_tracer):
    """Test starting a memory search span records the query as an event, not an attribute."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        span = tracer.start_memory_search_span("dark mode preference", ["personal", "team"], max_search_results=5)

        assert mock_tracer.start_span.call_args[1]["name"] == "memory.search"
        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "memory.search",
                "gen_ai.system": "strands-agents",
                "memory.store.names": serialize(["personal", "team"]),
                "memory.store.count": 2,
                "memory.max_search_results": 5,
            }
        )
        mock_span.add_event.assert_called_once_with("memory.query", attributes={"content": "dark mode preference"})
        assert span is not None


def test_start_memory_span_merges_custom_attributes_and_drops_non_scalar_kwargs(mock_tracer):
    """custom_trace_attributes and scalar kwargs are merged; non-scalar kwargs are dropped."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer
        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        tracer.start_memory_search_span(
            "q",
            ["personal"],
            custom_trace_attributes={"session_id": "abc"},
            scalar_kwarg=7,
            dropped_kwarg={"not": "scalar"},
        )

        attributes = mock_span.set_attributes.call_args[0][0]
        assert attributes["session_id"] == "abc"
        assert attributes["scalar_kwarg"] == 7
        assert "dropped_kwarg" not in attributes


def test_end_memory_search_span(mock_span):
    """Test ending a memory search span records result/failure counts and the entries event."""
    tracer = Tracer()
    entry = MemoryEntry(content="user prefers dark mode", store_name="personal", metadata={"score": 0.9})

    tracer.end_memory_search_span(mock_span, entries=[entry], store_failure_count=1)

    mock_span.add_event.assert_called_once_with(
        "memory.results",
        attributes={
            "content": serialize(
                [{"content": "user prefers dark mode", "store_name": "personal", "metadata": {"score": 0.9}}]
            )
        },
    )
    mock_span.set_attributes.assert_called_once_with({"memory.result.count": 1, "memory.store.failure_count": 1})
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


def test_end_memory_search_span_with_error(mock_span):
    """Test ending a memory search span with an error sets error status and skips the results event."""
    tracer = Tracer()
    error = ValueError("store 'missing' not found")

    tracer.end_memory_search_span(mock_span, error=error)

    mock_span.add_event.assert_not_called()
    mock_span.set_status.assert_called_once_with(StatusCode.ERROR, str(error))
    mock_span.record_exception.assert_called_once_with(error)
    mock_span.end.assert_called_once()


def test_start_memory_add_span(mock_tracer):
    """Test starting a memory add span records content as an event."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        tracer.start_memory_add_span("remember dark mode", ["personal"])

        assert mock_tracer.start_span.call_args[1]["name"] == "memory.add"
        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "memory.add",
                "gen_ai.system": "strands-agents",
                "memory.store.names": serialize(["personal"]),
                "memory.store.count": 1,
            }
        )
        mock_span.add_event.assert_called_once_with("memory.content", attributes={"content": "remember dark mode"})


def test_start_memory_add_span_force_root(mock_tracer):
    """Test that a forced-root add span detaches from any current span."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        current_span = mock.MagicMock()
        current_span.is_recording.return_value = True
        with mock.patch("strands.telemetry.tracer.trace_api.get_current_span", return_value=current_span):
            tracer.start_memory_add_span("content", ["personal"], force_root=True)

        # An empty Context (no parent) is passed when force_root is set.
        passed_context = mock_tracer.start_span.call_args[1]["context"]
        assert passed_context is not None
        assert len(passed_context) == 0


def test_end_memory_add_span_with_error(mock_span):
    """Test ending a memory add span with an error sets error status and failure count."""
    tracer = Tracer()
    error = Exception("write failed")

    tracer.end_memory_add_span(mock_span, store_failure_count=2, error=error)

    mock_span.set_attributes.assert_called_once_with({"memory.store.failure_count": 2})
    mock_span.set_status.assert_called_once_with(StatusCode.ERROR, str(error))
    mock_span.record_exception.assert_called_once_with(error)


def test_memory_inject_span(mock_tracer):
    """Test starting and ending a memory inject span on the happy path."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        span = tracer.start_memory_inject_span(max_entries=5)
        assert mock_tracer.start_span.call_args[1]["name"] == "memory.inject"
        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "memory.inject",
                "gen_ai.system": "strands-agents",
                "memory.max_entries": 5,
            }
        )

        tracer.end_memory_inject_span(span, injected=True, entry_count=3)
        mock_span.set_attributes.assert_any_call({"memory.injected": True, "memory.entry.count": 3})
        mock_span.set_status.assert_called_once_with(StatusCode.OK)


def test_start_memory_inject_span_without_max_entries(mock_tracer):
    """Test that max_entries is omitted from attributes when not provided."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        mock_span = mock.MagicMock()
        mock_tracer.start_span.return_value = mock_span

        tracer.start_memory_inject_span()

        assert mock_tracer.start_span.call_args[1]["name"] == "memory.inject"
        mock_span.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "memory.inject",
                "gen_ai.system": "strands-agents",
            }
        )


def test_end_memory_inject_span_format_error(mock_span):
    """Test that a format error ends the inject span OK (fail-open) with a flag, not an error."""
    tracer = Tracer()

    tracer.end_memory_inject_span(mock_span, injected=False, format_error=True)

    mock_span.set_attributes.assert_called_once_with(
        {"memory.injected": False, "memory.entry.count": 0, "memory.inject.format_error": True}
    )
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.record_exception.assert_not_called()


def test_start_memory_extract_span_is_root(mock_tracer):
    """Test that an extract span is always a root span, even when a current span is active."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        current_span = mock.MagicMock()
        current_span.is_recording.return_value = True
        with mock.patch("strands.telemetry.tracer.trace_api.get_current_span", return_value=current_span):
            tracer.start_memory_extract_span("personal", message_count=2, filtered_count=1, extractor="ModelExtractor")

        assert mock_tracer.start_span.call_args[1]["name"] == "memory.extract"
        # An empty Context (no parent) detaches from the active current span.
        passed_context = mock_tracer.start_span.call_args[1]["context"]
        assert passed_context is not None
        assert len(passed_context) == 0
        # No agent span context was provided, so no links are attached.
        assert mock_tracer.start_span.call_args[1]["links"] is None
        mock_tracer.start_span.return_value.set_attributes.assert_called_once_with(
            {
                "gen_ai.operation.name": "memory.extract",
                "gen_ai.system": "strands-agents",
                "memory.store.name": "personal",
                "memory.message.count": 2,
                "memory.message.filtered_count": 1,
                "memory.extractor": "ModelExtractor",
            }
        )


def test_start_memory_extract_span_links_agent_span(mock_tracer):
    """Test that a valid agent span context is attached as a link on the extract span."""
    with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
        tracer = Tracer()
        tracer.tracer = mock_tracer

        agent_context = SpanContext(trace_id=1, span_id=2, is_remote=False)
        tracer.start_memory_extract_span("personal", message_count=1, agent_span_context=agent_context)

        links = mock_tracer.start_span.call_args[1]["links"]
        assert links is not None
        assert len(links) == 1
        assert links[0].context is agent_context

        # The detached root has no OTel parent, so the scheduling run's ids are also recorded as
        # plain attributes for backends that don't render span links.
        attributes = mock_tracer.start_span.return_value.set_attributes.call_args[0][0]
        assert attributes["memory.parent.trace_id"] == "00000000000000000000000000000001"
        assert attributes["memory.parent.span_id"] == "0000000000000002"


def test_end_memory_extract_span_with_error(mock_span):
    """Test ending an extract span with an error records it (failures are swallowed by the coordinator)."""
    tracer = Tracer()
    error = Exception("save failed")

    tracer.end_memory_extract_span(mock_span, error=error)

    mock_span.set_status.assert_called_once_with(StatusCode.ERROR, str(error))
    mock_span.record_exception.assert_called_once_with(error)
    mock_span.end.assert_called_once()


def test_end_memory_extract_span_records_entry_count(mock_span):
    """Test ending an extract span on success sets the entry count and OK status."""
    tracer = Tracer()

    tracer.end_memory_extract_span(mock_span, entry_count=3)

    mock_span.set_attributes.assert_called_once_with({"memory.entry.count": 3})
    mock_span.set_status.assert_called_once_with(StatusCode.OK)
    mock_span.end.assert_called_once()


class TestIsLangfuse:
    """Tests for the is_langfuse property."""

    def test_is_langfuse_with_otel_exporter_otlp_endpoint(self, monkeypatch):
        """Test is_langfuse returns True when OTEL_EXPORTER_OTLP_ENDPOINT contains langfuse."""
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://us.cloud.langfuse.com")
        tracer = Tracer()
        assert tracer.is_langfuse is True

    def test_is_langfuse_with_otel_exporter_otlp_traces_endpoint(self, monkeypatch):
        """Test is_langfuse returns True when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT contains langfuse."""
        monkeypatch.setenv(
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://us.cloud.langfuse.com/api/public/otel/v1/traces"
        )
        tracer = Tracer()
        assert tracer.is_langfuse is True

    def test_is_langfuse_with_langfuse_base_url(self, monkeypatch):
        """Test is_langfuse returns True when LANGFUSE_BASE_URL contains langfuse."""
        monkeypatch.setenv("LANGFUSE_BASE_URL", "https://us.cloud.langfuse.com")
        tracer = Tracer()
        assert tracer.is_langfuse is True

    def test_is_langfuse_false_when_no_langfuse_env_vars(self, monkeypatch):
        """Test is_langfuse returns False when no Langfuse-related env vars are set."""
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", raising=False)
        monkeypatch.delenv("LANGFUSE_BASE_URL", raising=False)
        tracer = Tracer()
        assert tracer.is_langfuse is False

    def test_is_langfuse_false_with_non_langfuse_endpoint(self, monkeypatch):
        """Test is_langfuse returns False when endpoint is not Langfuse."""
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://api.honeycomb.io")
        monkeypatch.delenv("LANGFUSE_BASE_URL", raising=False)
        tracer = Tracer()
        assert tracer.is_langfuse is False

    def test_is_langfuse_false_with_non_langfuse_base_url(self, monkeypatch):
        """Test is_langfuse returns False when LANGFUSE_BASE_URL doesn't contain langfuse."""
        monkeypatch.setenv("LANGFUSE_BASE_URL", "https://some-other-service.com")
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", raising=False)
        tracer = Tracer()
        assert tracer.is_langfuse is False


class TestSpanAttributeRedaction:
    """Tests for GDPR-compliant redaction of sensitive span attributes."""

    def _user_message(self):
        return [{"role": "user", "content": [{"text": "secret user input"}]}]

    def _assistant_message(self):
        return {"role": "assistant", "content": [{"text": "secret model output"}]}

    def test_redaction_disabled_by_default(self, mock_tracer, monkeypatch):
        """No env var set: sensitive content is emitted verbatim (backward compatible)."""
        monkeypatch.delenv("OTEL_SEMCONV_STABILITY_OPT_IN", raising=False)
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_tracer.start_span.return_value = mock_span

            tracer.start_model_invoke_span(messages=self._user_message(), model_id="m")

            mock_span.add_event.assert_any_call(
                "gen_ai.user.message",
                attributes={"content": json.dumps([{"text": "secret user input"}])},
            )

    def test_redaction_disabled_when_other_tokens_present(self, mock_tracer, monkeypatch):
        """Other opt-in tokens must not accidentally enable redaction."""
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental,gen_ai_tool_definitions")
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_tracer.start_span.return_value = mock_span

            tracer.start_model_invoke_span(messages=self._user_message(), model_id="m")

            input_messages = serialize([{"role": "user", "parts": [{"type": "text", "content": "secret user input"}]}])
            mock_span.add_event.assert_any_call(
                "gen_ai.client.inference.operation.details",
                attributes={"gen_ai.input.messages": input_messages},
            )

    def test_empty_unredacted_list_redacts_everything(self, mock_tracer, monkeypatch):
        """gen_ai_unredacted_attributes= (empty) redacts all sensitive attributes."""
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_unredacted_attributes=")
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_tracer.start_span.return_value = mock_span

            tracer.start_model_invoke_span(messages=self._user_message(), model_id="m", system_prompt="secret system")
            tracer.end_model_invoke_span(
                mock_span,
                self._assistant_message(),
                Usage(inputTokens=1, outputTokens=2, totalTokens=3),
                Metrics(latencyMs=0, timeToFirstByteMs=0),
                "end_turn",
            )

            mock_span.add_event.assert_any_call("gen_ai.system.message", attributes={"content": "[REDACTED]"})
            mock_span.add_event.assert_any_call("gen_ai.user.message", attributes={"content": "[REDACTED]"})
            mock_span.add_event.assert_any_call(
                "gen_ai.choice",
                attributes={"finish_reason": "end_turn", "message": "[REDACTED]"},
            )

    def test_explicit_allowlist_with_semicolon(self, mock_tracer, monkeypatch):
        """Allowlisted attributes pass through; others redact."""
        monkeypatch.setenv(
            "OTEL_SEMCONV_STABILITY_OPT_IN",
            "gen_ai_latest_experimental,gen_ai_unredacted_attributes=gen_ai.input.messages;gen_ai.system_instructions",
        )
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_tracer.start_span.return_value = mock_span

            tracer.start_model_invoke_span(messages=self._user_message(), model_id="m", system_prompt="visible system")
            tracer.end_model_invoke_span(
                mock_span,
                self._assistant_message(),
                Usage(inputTokens=1, outputTokens=2, totalTokens=3),
                Metrics(latencyMs=0, timeToFirstByteMs=0),
                "end_turn",
            )

            visible_input = serialize([{"role": "user", "parts": [{"type": "text", "content": "secret user input"}]}])
            visible_system = serialize([{"type": "text", "content": "visible system"}])
            mock_span.add_event.assert_any_call(
                "gen_ai.client.inference.operation.details",
                attributes={"gen_ai.system_instructions": visible_system},
            )
            mock_span.add_event.assert_any_call(
                "gen_ai.client.inference.operation.details",
                attributes={"gen_ai.input.messages": visible_input},
            )
            mock_span.add_event.assert_any_call(
                "gen_ai.client.inference.operation.details",
                attributes={"gen_ai.output.messages": "[REDACTED]"},
            )

    def test_glob_match_for_output_messages(self, mock_tracer, monkeypatch):
        """A trailing `*` glob matches by prefix."""
        monkeypatch.setenv(
            "OTEL_SEMCONV_STABILITY_OPT_IN",
            "gen_ai_latest_experimental,gen_ai_unredacted_attributes=gen_ai.output.*",
        )
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_tracer.start_span.return_value = mock_span

            tracer.start_model_invoke_span(messages=self._user_message(), model_id="m")
            tracer.end_model_invoke_span(
                mock_span,
                self._assistant_message(),
                Usage(inputTokens=1, outputTokens=2, totalTokens=3),
                Metrics(latencyMs=0, timeToFirstByteMs=0),
                "end_turn",
            )

            visible_output = serialize(
                [
                    {
                        "role": "assistant",
                        "parts": [{"type": "text", "content": "secret model output"}],
                        "finish_reason": "end_turn",
                    }
                ]
            )
            mock_span.add_event.assert_any_call(
                "gen_ai.client.inference.operation.details",
                attributes={"gen_ai.input.messages": "[REDACTED]"},
            )
            mock_span.add_event.assert_any_call(
                "gen_ai.client.inference.operation.details",
                attributes={"gen_ai.output.messages": visible_output},
            )

    def test_redaction_preserves_tool_metadata(self, mock_tracer, monkeypatch):
        """Tool name, ID, and status are preserved; only payload content is redacted."""
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_unredacted_attributes=")
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_tracer.start_span.return_value = mock_span

            tool = {"name": "calculator", "toolUseId": "abc", "input": {"expression": "2+2"}}
            tracer.start_tool_call_span(tool)
            tracer.end_tool_call_span(
                mock_span,
                {"toolUseId": "abc", "status": "success", "content": [{"text": "4"}]},
            )

            start_attrs = mock_span.set_attributes.call_args_list[0][0][0]
            assert start_attrs["gen_ai.tool.name"] == "calculator"
            assert start_attrs["gen_ai.tool.call.id"] == "abc"

            mock_span.add_event.assert_any_call(
                "gen_ai.tool.message",
                attributes={"role": "tool", "content": "[REDACTED]", "id": "abc"},
            )
            mock_span.add_event.assert_any_call(
                "gen_ai.choice",
                attributes={"message": "[REDACTED]", "id": "abc"},
            )

    def test_parser_handles_kv_and_bare_tokens(self, monkeypatch):
        """Parser keeps bare flags working alongside the new key=value token."""
        monkeypatch.setenv(
            "OTEL_SEMCONV_STABILITY_OPT_IN",
            " gen_ai_latest_experimental ,gen_ai_unredacted_attributes=gen_ai.input.messages ,gen_ai_tool_definitions",
        )
        tracer = Tracer()
        assert tracer.use_latest_genai_conventions is True
        assert tracer._include_tool_definitions is True
        assert tracer._redaction_enabled is True
        assert "gen_ai.input.messages" in tracer._unredacted_exact

    def test_assistant_message_uses_output_key_for_redaction(self, mock_tracer, monkeypatch):
        """Assistant messages in legacy `_add_event_messages` use the output-messages policy."""
        monkeypatch.setenv(
            "OTEL_SEMCONV_STABILITY_OPT_IN",
            "gen_ai_unredacted_attributes=gen_ai.output.*",
        )
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_span.is_recording.return_value = True

            messages = [
                {"role": "user", "content": [{"text": "user query"}]},
                {"role": "assistant", "content": [{"text": "assistant reply"}]},
            ]
            tracer._add_event_messages(mock_span, messages)

            mock_span.add_event.assert_any_call("gen_ai.user.message", attributes={"content": "[REDACTED]"})
            mock_span.add_event.assert_any_call(
                "gen_ai.assistant.message",
                attributes={"content": serialize([{"text": "assistant reply"}])},
            )

    def test_system_instructions_redacted_in_latest_conventions(self, mock_tracer, monkeypatch):
        """gen_ai.system_instructions must be redacted under an empty allowlist (latest conventions)."""
        monkeypatch.setenv(
            "OTEL_SEMCONV_STABILITY_OPT_IN",
            "gen_ai_latest_experimental,gen_ai_unredacted_attributes=",
        )
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_span.is_recording.return_value = True
            mock_tracer.start_span.return_value = mock_span

            tracer.start_model_invoke_span(
                messages=[{"role": "user", "content": [{"text": "hi"}]}],
                model_id="m",
                system_prompt="confidential system prompt",
            )

            mock_span.add_event.assert_any_call(
                "gen_ai.client.inference.operation.details",
                attributes={"gen_ai.system_instructions": "[REDACTED]"},
            )

    def test_agent_system_instructions_redacted(self, mock_tracer, monkeypatch):
        """Agent system instructions follow the configured redaction policy."""
        monkeypatch.setenv(
            "OTEL_SEMCONV_STABILITY_OPT_IN",
            "gen_ai_latest_experimental,gen_ai_unredacted_attributes=",
        )
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_tracer.start_span.return_value = mock_span

            tracer.start_agent_span(
                messages=[],
                agent_name="TestAgent",
                system_prompt="confidential system prompt",
            )

            set_attrs_call = mock_span.set_attributes.call_args_list[0][0][0]
            assert set_attrs_call["gen_ai.system_instructions"] == "[REDACTED]"
            assert "system_prompt" not in set_attrs_call

    def test_model_id_and_operation_never_redacted(self, mock_tracer, monkeypatch):
        """Structural span attributes (model id, tool name, operation) are never replaced."""
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_unredacted_attributes=")
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_tracer.start_span.return_value = mock_span

            tracer.start_model_invoke_span(
                messages=[{"role": "user", "content": [{"text": "hi"}]}],
                model_id="anthropic.claude-v3",
            )

            set_attrs_call = mock_span.set_attributes.call_args_list[0][0][0]
            assert set_attrs_call["gen_ai.request.model"] == "anthropic.claude-v3"
            assert set_attrs_call["gen_ai.operation.name"] == "chat"
            assert "[REDACTED]" not in set_attrs_call.values()

    def test_glob_only_trailing_star(self, monkeypatch):
        """Only trailing `*` is treated as a glob; other entries are exact-match."""
        monkeypatch.setenv(
            "OTEL_SEMCONV_STABILITY_OPT_IN",
            "gen_ai_unredacted_attributes=gen_ai.output.*;gen_ai.exact.name",
        )
        tracer = Tracer()
        assert tracer._is_attribute_unredacted("gen_ai.output.messages")
        assert tracer._is_attribute_unredacted("gen_ai.output.anything.else")
        assert tracer._is_attribute_unredacted("gen_ai.exact.name")
        assert not tracer._is_attribute_unredacted("gen_ai.input.messages")

    def test_tool_result_cycle_span_uses_input_messages_key(self, mock_tracer, monkeypatch):
        """tool_result_message in end_event_loop_cycle_span emits under gen_ai.input.messages, not output.messages."""
        monkeypatch.setenv(
            "OTEL_SEMCONV_STABILITY_OPT_IN",
            "gen_ai_latest_experimental,gen_ai_unredacted_attributes=gen_ai.input.messages",
        )
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_span.is_recording.return_value = True

            message = {"role": "assistant", "content": [{"text": "calling tool"}]}
            tool_result_message = {"role": "tool", "content": [{"text": "tool output"}]}

            tracer.end_event_loop_cycle_span(mock_span, message, tool_result_message)

            expected_payload = serialize(
                [
                    {
                        "role": "tool",
                        "parts": tracer._map_content_blocks_to_otel_parts([{"text": "tool output"}]),
                    }
                ]
            )
            mock_span.add_event.assert_any_call(
                "gen_ai.client.inference.operation.details",
                attributes={"gen_ai.input.messages": expected_payload},
            )
            all_attr_keys = set()
            for call in mock_span.add_event.call_args_list:
                attrs = call.kwargs.get("attributes") or (call.args[1] if len(call.args) > 1 else {})
                all_attr_keys.update(attrs.keys())
            assert "gen_ai.output.messages" not in all_attr_keys, (
                "tool_result_message must not be emitted under gen_ai.output.messages"
            )

    def test_legacy_tool_result_redacts_under_input_messages_policy(self, mock_tracer, monkeypatch):
        """Legacy gen_ai.choice path: tool.result field redacted under gen_ai.input.messages policy."""
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_unredacted_attributes=")
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_span.is_recording.return_value = True
            message = {"role": "assistant", "content": [{"text": "visible"}]}
            tool_result_message = {"role": "tool", "content": [{"text": "secret result"}]}
            tracer.end_event_loop_cycle_span(mock_span, message, tool_result_message)
            call_kwargs = {
                k: v
                for call in mock_span.add_event.call_args_list
                for k, v in (call.kwargs.get("attributes") or {}).items()
            }
            assert call_kwargs.get("tool.result") == "[REDACTED]"


class TestSpanAttributesOnly:
    """Tests for the gen_ai_span_attributes_only opt-in.

    With the opt-in set, the latest-convention message content is recorded as span attributes
    rather than a deprecated span event, for backends that cannot read span events.
    """

    def _user_message(self):
        return [{"role": "user", "content": [{"text": "hello"}]}]

    def test_flag_parsed_from_env(self, mock_tracer, monkeypatch):
        """The opt-in token is parsed off OTEL_SEMCONV_STABILITY_OPT_IN."""
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental,gen_ai_span_attributes_only")
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            assert tracer._span_attributes_only is True

    def test_flag_defaults_off(self, mock_tracer, monkeypatch):
        """Absent the token, the flag is off and output stays event-based."""
        monkeypatch.delenv("OTEL_SEMCONV_STABILITY_OPT_IN", raising=False)
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            assert tracer._span_attributes_only is False

    def test_content_written_to_span_attributes_not_events(self, mock_tracer, monkeypatch):
        """Message content is stamped on the span and no content event is emitted."""
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental,gen_ai_span_attributes_only")
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_tracer.start_span.return_value = mock_span

            tracer.start_model_invoke_span(messages=self._user_message(), model_id="m")

            input_messages = serialize([{"role": "user", "parts": [{"type": "text", "content": "hello"}]}])
            mock_span.set_attributes.assert_any_call({"gen_ai.input.messages": input_messages})
            event_names = [call.args[0] for call in mock_span.add_event.call_args_list]
            assert "gen_ai.client.inference.operation.details" not in event_names

    def test_no_effect_without_latest_conventions(self, mock_tracer, monkeypatch):
        """The flag only applies to latest conventions; legacy per-message events are unchanged."""
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_span_attributes_only")
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            tracer.tracer = mock_tracer
            mock_span = mock.MagicMock()
            mock_tracer.start_span.return_value = mock_span

            tracer.start_model_invoke_span(messages=self._user_message(), model_id="m")

            mock_span.add_event.assert_any_call(
                "gen_ai.user.message",
                attributes={"content": json.dumps([{"text": "hello"}])},
            )

    def test_empty_attributes_records_nothing(self, mock_tracer, monkeypatch):
        """With no attributes, neither a span attribute nor an event is recorded."""
        monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_span_attributes_only")
        with mock.patch("strands.telemetry.tracer.trace_api.get_tracer", return_value=mock_tracer):
            tracer = Tracer()
            mock_span = mock.MagicMock()

            tracer._add_event(mock_span, "gen_ai.user.message", event_attributes=None, to_span_attributes=True)

            mock_span.set_attributes.assert_not_called()
            mock_span.add_event.assert_not_called()
