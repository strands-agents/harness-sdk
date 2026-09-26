"""Tests for the Amazon SageMaker model provider."""

import json
import logging
import unittest.mock
from typing import Any

import boto3
import pytest
from botocore.config import Config as BotocoreConfig

from strands.models.model import CacheConfig
from strands.models.sagemaker import (
    FunctionCall,
    SageMakerAIModel,
    ToolCall,
    UsageMetadata,
    _parse_event_stream,
)
from strands.types.content import Messages
from strands.types.tools import ToolSpec


@pytest.fixture
def boto_session():
    """Mock boto3 session."""
    with unittest.mock.patch.object(boto3, "Session") as mock_session:
        yield mock_session.return_value


@pytest.fixture
def sagemaker_client(boto_session):
    """Mock SageMaker runtime client."""
    return boto_session.client.return_value


@pytest.fixture
def endpoint_config() -> dict[str, Any]:
    """Default endpoint configuration for tests."""
    return {
        "endpoint_name": "test-endpoint",
        "inference_component_name": "test-component",
        "region_name": "us-east-1",
    }


@pytest.fixture
def payload_config() -> dict[str, Any]:
    """Default payload configuration for tests."""
    return {
        "max_tokens": 1024,
        "temperature": 0.7,
        "stream": True,
    }


@pytest.fixture
def model(boto_session, endpoint_config, payload_config):
    """SageMaker model instance with mocked boto session."""
    return SageMakerAIModel(endpoint_config=endpoint_config, payload_config=payload_config, boto_session=boto_session)


@pytest.fixture
def messages() -> Messages:
    """Sample messages for testing."""
    return [{"role": "user", "content": [{"text": "What is the capital of France?"}]}]


@pytest.fixture
def tool_specs() -> list[ToolSpec]:
    """Sample tool specifications for testing."""
    return [
        {
            "name": "get_weather",
            "description": "Get the weather for a location",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {"location": {"type": "string"}},
                    "required": ["location"],
                }
            },
        }
    ]


@pytest.fixture
def system_prompt() -> str:
    """Sample system prompt for testing."""
    return "You are a helpful assistant."


def test_format_request_tool_message_preserves_non_ascii():
    """Tool-result JSON content must keep non-ASCII text (no \\uXXXX escaping)."""
    tool_result = {
        "toolUseId": "c1",
        "status": "success",
        "content": [{"json": {"city": "東京"}}],
    }

    tru_result = SageMakerAIModel.format_request_tool_message(tool_result)
    exp_result = {
        "role": "tool",
        "tool_call_id": "c1",
        "content": '{"city": "東京"}',
    }
    assert tru_result == exp_result


def _payload_parts(*chunks: str) -> list[dict[str, dict[str, bytes]]]:
    """Build the PayloadPart shape returned by SageMaker streaming responses."""
    return [{"PayloadPart": {"Bytes": chunk.encode("utf-8")}} for chunk in chunks]


class TestSageMakerEventStreamParser:
    """Tests for SageMaker PayloadPart and SSE framing edge cases."""

    def test_skips_malformed_sse_event_and_continues(self, caplog):
        """A malformed data field is warned about without dropping later events."""
        caplog.set_level(logging.WARNING, logger="strands.models.sagemaker")
        body = _payload_parts('data: {malformed\ndata: {"value": "valid"}\n')

        assert list(_parse_event_stream(body)) == [{"value": "valid"}]
        assert [record.message for record in caplog.records] == ["line=<data: {malformed> | skipping malformed event"]

    def test_buffers_multiline_bare_json_until_it_parses(self, caplog):
        """A bare JSON document containing newlines is decoded as a whole."""
        caplog.set_level(logging.WARNING, logger="strands.models.sagemaker")
        event = {"value": "pretty"}
        payload = json.dumps(event, indent=2)
        split = len(payload) // 2
        body = _payload_parts(payload[:split], payload[split:])

        assert list(_parse_event_stream(body)) == [event]
        assert not caplog.records

    def test_skips_sse_control_fields_and_done(self, caplog):
        """SSE control fields, comments, blank lines, and DONE carry no JSON event."""
        caplog.set_level(logging.WARNING, logger="strands.models.sagemaker")
        body = _payload_parts(
            'event: message\nid: 42\nretry: 1000\n: keep-alive\n\ndata: {"value": "valid"}\n\ndata: [DONE]\n\n'
        )

        assert list(_parse_event_stream(body)) == [{"value": "valid"}]
        assert not caplog.records

    def test_warns_when_stream_ends_with_partial_event(self, caplog):
        """An undecoded residual is reported rather than silently discarded."""
        caplog.set_level(logging.WARNING, logger="strands.models.sagemaker")
        body = _payload_parts('data: {"value":')

        assert list(_parse_event_stream(body)) == []
        assert [record.message for record in caplog.records] == [
            'buffer=<data: {"value":> | stream ended with an undecoded partial event'
        ]


@pytest.mark.asyncio
async def test_stream_emits_usage_only_chunk_after_finish(sagemaker_client, model, messages, alist):
    """A trailing OpenAI-compatible usage chunk is emitted despite its empty choices list."""
    usage = {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
    events = [
        {"choices": [{"delta": {"content": "answer"}, "finish_reason": None}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        # Choice events after the finish reason remain ignored while the usage tail is consumed.
        {"choices": [{"delta": {"content": "ignored"}, "finish_reason": None}]},
        {"choices": []},
        {"choices": [], "usage": usage},
    ]
    payload = "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"
    sagemaker_client.invoke_endpoint_with_response_stream.return_value = {"Body": _payload_parts(payload)}

    response = await alist(model.stream(messages))

    tru_text = "".join(
        event["contentBlockDelta"]["delta"]["text"]
        for event in response
        if "contentBlockDelta" in event and "text" in event["contentBlockDelta"]["delta"]
    )
    metadata = [event["metadata"]["usage"] for event in response if "metadata" in event]
    assert tru_text == "answer"
    assert metadata == [{"inputTokens": 10, "outputTokens": 20, "totalTokens": 30}]
    assert response[-1] == {"messageStop": {"stopReason": "end_turn"}}


@pytest.mark.asyncio
async def test_stream_preserves_choice_local_usage(sagemaker_client, model, messages, alist):
    """Usage nested in a choice remains supported for custom SageMaker containers."""
    usage = {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
    event = {"choices": [{"delta": {}, "finish_reason": "stop", "usage": usage}]}
    sagemaker_client.invoke_endpoint_with_response_stream.return_value = {"Body": _payload_parts(json.dumps(event))}

    response = await alist(model.stream(messages))

    metadata = next(item["metadata"]["usage"] for item in response if "metadata" in item)
    assert metadata == {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3}


@pytest.mark.asyncio
async def test_stream_usage_only_chunk_tolerates_undeclared_wire_field(sagemaker_client, model, messages, alist):
    """A trailing usage chunk carrying completion_tokens_details still reports usage."""
    usage = {
        "prompt_tokens": 10,
        "completion_tokens": 20,
        "total_tokens": 30,
        "completion_tokens_details": {"reasoning_tokens": 4},
    }
    events = [
        {"choices": [{"delta": {"content": "answer"}, "finish_reason": None}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        {"choices": [], "usage": usage},
    ]
    payload = "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"
    sagemaker_client.invoke_endpoint_with_response_stream.return_value = {"Body": _payload_parts(payload)}

    response = await alist(model.stream(messages))

    metadata = [event["metadata"]["usage"] for event in response if "metadata" in event]
    assert metadata == [{"inputTokens": 10, "outputTokens": 20, "totalTokens": 30}]
    assert response[-1] == {"messageStop": {"stopReason": "end_turn"}}


@pytest.mark.asyncio
async def test_stream_choice_local_usage_tolerates_undeclared_wire_field(sagemaker_client, model, messages, alist):
    """Usage nested in a choice survives an undeclared field from the endpoint."""
    usage = {
        "prompt_tokens": 1,
        "completion_tokens": 2,
        "total_tokens": 3,
        "completion_tokens_details": {"reasoning_tokens": 0},
    }
    event = {"choices": [{"delta": {}, "finish_reason": "stop", "usage": usage}]}
    sagemaker_client.invoke_endpoint_with_response_stream.return_value = {"Body": _payload_parts(json.dumps(event))}

    response = await alist(model.stream(messages))

    metadata = next(item["metadata"]["usage"] for item in response if "metadata" in item)
    assert metadata == {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3}


@pytest.mark.asyncio
async def test_stream_non_streaming_usage_tolerates_undeclared_wire_field(sagemaker_client, model, messages, alist):
    """The non-streaming branch reports usage that carries an undeclared field."""
    model.payload_config["stream"] = False
    body = unittest.mock.MagicMock()
    body.read.return_value = json.dumps(
        {
            "choices": [{"message": {"content": "answer", "tool_calls": None}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": 7,
                "completion_tokens": 8,
                "total_tokens": 15,
                "completion_tokens_details": {"reasoning_tokens": 2},
            },
        }
    ).encode("utf-8")
    sagemaker_client.invoke_endpoint.return_value = {"Body": body}

    response = await alist(model.stream(messages))

    metadata = next(item["metadata"]["usage"] for item in response if "metadata" in item)
    assert metadata == {"inputTokens": 7, "outputTokens": 8, "totalTokens": 15}


class TestSageMakerAIModel:
    """Test suite for SageMakerAIModel."""

    def test_init_default(self, boto_session):
        """Test initialization with default parameters."""
        endpoint_config = {"endpoint_name": "test-endpoint", "region_name": "us-east-1"}
        payload_config = {"max_tokens": 1024}
        model = SageMakerAIModel(
            endpoint_config=endpoint_config, payload_config=payload_config, boto_session=boto_session
        )

        assert model.endpoint_config["endpoint_name"] == "test-endpoint"
        assert model.payload_config.get("stream", True) is True

        boto_session.client.assert_called_once_with(
            service_name="sagemaker-runtime",
            config=unittest.mock.ANY,
        )

    def test_init_with_all_params(self, boto_session):
        """Test initialization with all parameters."""
        endpoint_config = {
            "endpoint_name": "test-endpoint",
            "inference_component_name": "test-component",
            "region_name": "us-west-2",
            "additional_args": {"test_req_arg_name": "test_req_arg_value"},
        }
        payload_config = {
            "stream": False,
            "max_tokens": 1024,
            "temperature": 0.7,
            "additional_args": {"test_payload_arg_name": "test_payload_arg_value"},
        }
        client_config = BotocoreConfig(user_agent_extra="test-agent")

        model = SageMakerAIModel(
            endpoint_config=endpoint_config,
            payload_config=payload_config,
            boto_session=boto_session,
            boto_client_config=client_config,
        )

        assert model.endpoint_config["endpoint_name"] == "test-endpoint"
        assert model.endpoint_config["inference_component_name"] == "test-component"
        assert model.endpoint_config["additional_args"]["test_req_arg_name"] == "test_req_arg_value"
        assert model.payload_config["stream"] is False
        assert model.payload_config["max_tokens"] == 1024
        assert model.payload_config["temperature"] == 0.7
        assert model.payload_config["additional_args"]["test_payload_arg_name"] == "test_payload_arg_value"

        boto_session.client.assert_called_once_with(
            service_name="sagemaker-runtime",
            config=unittest.mock.ANY,
        )

    def test_init_with_client_config(self, boto_session):
        """Test initialization with client configuration."""
        endpoint_config = {"endpoint_name": "test-endpoint", "region_name": "us-east-1"}
        payload_config = {"max_tokens": 1024}
        client_config = BotocoreConfig(user_agent_extra="test-agent")

        SageMakerAIModel(
            endpoint_config=endpoint_config,
            payload_config=payload_config,
            boto_session=boto_session,
            boto_client_config=client_config,
        )

        # Verify client was created with a config that includes our user agent
        boto_session.client.assert_called_once_with(
            service_name="sagemaker-runtime",
            config=unittest.mock.ANY,
        )

        # Get the actual config passed to client
        actual_config = boto_session.client.call_args[1]["config"]
        assert "strands-agents" in actual_config.user_agent_extra
        assert "test-agent" in actual_config.user_agent_extra

    def test_update_config(self, model):
        """Test updating model configuration."""
        new_config = {"target_model": "new-model", "target_variant": "new-variant"}
        model.update_config(**new_config)

        assert model.endpoint_config["target_model"] == "new-model"
        assert model.endpoint_config["target_variant"] == "new-variant"
        # Original values should be preserved
        assert model.endpoint_config["endpoint_name"] == "test-endpoint"
        assert model.endpoint_config["inference_component_name"] == "test-component"

    def test_get_config(self, model, endpoint_config):
        """Test getting model configuration."""
        config = model.get_config()
        assert config == model.endpoint_config
        assert isinstance(config, dict)

    # def test_format_request_messages_with_system_prompt(self, model):
    #     """Test formatting request messages with system prompt."""
    #     messages = [{"role": "user", "content": "Hello"}]
    #     system_prompt = "You are a helpful assistant."

    #     formatted_messages = model.format_request_messages(messages, system_prompt)

    #     assert len(formatted_messages) == 2
    #     assert formatted_messages[0]["role"] == "system"
    #     assert formatted_messages[0]["content"] == system_prompt
    #     assert formatted_messages[1]["role"] == "user"
    #     assert formatted_messages[1]["content"] == "Hello"

    # def test_format_request_messages_with_tool_calls(self, model):
    #     """Test formatting request messages with tool calls."""
    #     messages = [
    #         {"role": "user", "content": "Hello"},
    #         {
    #             "role": "assistant",
    #             "content": None,
    #             "tool_calls": [{"id": "123", "type": "function", "function": {"name": "test", "arguments": "{}"}}],
    #         },
    #     ]

    #     formatted_messages = model.format_request_messages(messages, None)

    #     assert len(formatted_messages) == 2
    #     assert formatted_messages[0]["role"] == "user"
    #     assert formatted_messages[1]["role"] == "assistant"
    #     assert "content" not in formatted_messages[1]
    #     assert "tool_calls" in formatted_messages[1]

    # def test_format_request(self, model, messages, tool_specs, system_prompt):
    #     """Test formatting a request with all parameters."""
    #     request = model.format_request(messages, tool_specs, system_prompt)

    #     assert request["EndpointName"] == "test-endpoint"
    #     assert request["InferenceComponentName"] == "test-component"
    #     assert request["ContentType"] == "application/json"
    #     assert request["Accept"] == "application/json"

    #     payload = json.loads(request["Body"])
    #     assert "messages" in payload
    #     assert len(payload["messages"]) > 0
    #     assert "tools" in payload
    #     assert len(payload["tools"]) == 1
    #     assert payload["tools"][0]["type"] == "function"
    #     assert payload["tools"][0]["function"]["name"] == "get_weather"
    #     assert payload["max_tokens"] == 1024
    #     assert payload["temperature"] == 0.7
    #     assert payload["stream"] is True

    # def test_format_request_without_tools(self, model, messages, system_prompt):
    #     """Test formatting a request without tools."""
    #     request = model.format_request(messages, None, system_prompt)

    #     payload = json.loads(request["Body"])
    #     assert "tools" in payload
    #     assert payload["tools"] == []

    def test_format_request_with_additional_args(self, boto_session, endpoint_config, messages, payload_config):
        """Test formatting a request's `additional_args` where provided"""
        endpoint_config_ext = {
            **endpoint_config,
            "additional_args": {
                "extra_request_key": "extra_request_value",
            },
        }
        payload_config_ext = {
            **payload_config,
            "additional_args": {
                "extra_payload_key": "extra_payload_value",
            },
        }
        model = SageMakerAIModel(
            boto_session=boto_session,
            endpoint_config=endpoint_config_ext,
            payload_config=payload_config_ext,
        )
        request = model.format_request(messages)
        assert request.get("extra_request_key") == "extra_request_value"
        payload = json.loads(request["Body"])
        assert payload.get("extra_payload_key") == "extra_payload_value"

    @pytest.mark.asyncio
    async def test_stream_with_streaming_enabled(self, sagemaker_client, model, messages):
        """Test streaming response with streaming enabled."""
        # Mock the response from SageMaker
        mock_response = {
            "Body": [
                {
                    "PayloadPart": {
                        "Bytes": json.dumps(
                            {
                                "choices": [
                                    {
                                        "delta": {"content": "Paris is the capital of France."},
                                        "finish_reason": None,
                                    }
                                ]
                            }
                        ).encode("utf-8")
                    }
                },
                {
                    "PayloadPart": {
                        "Bytes": json.dumps(
                            {
                                "choices": [
                                    {
                                        "delta": {"content": " It is known for the Eiffel Tower."},
                                        "finish_reason": "stop",
                                    }
                                ]
                            }
                        ).encode("utf-8")
                    }
                },
            ]
        }
        sagemaker_client.invoke_endpoint_with_response_stream.return_value = mock_response

        response = [chunk async for chunk in model.stream(messages)]

        assert len(response) >= 5
        assert response[0] == {"messageStart": {"role": "assistant"}}

        # Find content events
        content_start = next((e for e in response if "contentBlockStart" in e), None)
        content_delta = next((e for e in response if "contentBlockDelta" in e), None)
        content_stop = next((e for e in response if "contentBlockStop" in e), None)
        message_stop = next((e for e in response if "messageStop" in e), None)

        assert content_start is not None
        assert content_delta is not None
        assert content_stop is not None
        assert message_stop is not None
        assert message_stop["messageStop"]["stopReason"] == "end_turn"

        # Every part must contribute to the reassembled text, not just the first one.
        tru_text = "".join(
            e["contentBlockDelta"]["delta"]["text"]
            for e in response
            if "contentBlockDelta" in e and "text" in e["contentBlockDelta"]["delta"]
        )
        exp_text = "Paris is the capital of France. It is known for the Eiffel Tower."
        assert tru_text == exp_text

        sagemaker_client.invoke_endpoint_with_response_stream.assert_called_once()

    @pytest.mark.asyncio
    async def test_stream_with_tool_calls(self, sagemaker_client, model, messages):
        """Test streaming response with tool calls."""
        # Mock the response from SageMaker with tool calls
        mock_response = {
            "Body": [
                {
                    "PayloadPart": {
                        "Bytes": json.dumps(
                            {
                                "choices": [
                                    {
                                        "delta": {
                                            "content": None,
                                            "tool_calls": {
                                                "index": 0,
                                                "id": "tool123",
                                                "type": "function",
                                                "function": {
                                                    "name": "get_weather",
                                                    "arguments": '{"location": "Paris"}',
                                                },
                                            },
                                        },
                                        "finish_reason": "tool_calls",
                                    }
                                ]
                            }
                        ).encode("utf-8")
                    }
                }
            ]
        }
        sagemaker_client.invoke_endpoint_with_response_stream.return_value = mock_response

        response = [chunk async for chunk in model.stream(messages)]

        # Verify the response contains tool call events
        assert len(response) >= 4
        assert response[0] == {"messageStart": {"role": "assistant"}}

        message_stop = next((e for e in response if "messageStop" in e), None)
        assert message_stop is not None
        assert message_stop["messageStop"]["stopReason"] == "tool_use"

        # Find tool call events
        tool_start = next(
            (
                e
                for e in response
                if "contentBlockStart" in e and e.get("contentBlockStart", {}).get("start", {}).get("toolUse")
            ),
            None,
        )
        tool_delta = next(
            (
                e
                for e in response
                if "contentBlockDelta" in e and e.get("contentBlockDelta", {}).get("delta", {}).get("toolUse")
            ),
            None,
        )
        tool_stop = next((e for e in response if "contentBlockStop" in e), None)

        assert tool_start is not None
        assert tool_delta is not None
        assert tool_stop is not None

        # Verify tool call data
        tool_use_data = tool_start["contentBlockStart"]["start"]["toolUse"]
        assert tool_use_data["toolUseId"] == "tool123"
        assert tool_use_data["name"] == "get_weather"

    @pytest.mark.asyncio
    async def test_stream_with_partial_json(self, sagemaker_client, model, messages, captured_warnings):
        """Test streaming response with partial JSON chunks."""
        # Mock the response from SageMaker with split JSON
        mock_response = {
            "Body": [
                {"PayloadPart": {"Bytes": b'{"choices": [{"delta": {"content": "Paris is'}},
                {"PayloadPart": {"Bytes": b' the capital of France."}, "finish_reason": "stop"}]}'}},
            ]
        }
        sagemaker_client.invoke_endpoint_with_response_stream.return_value = mock_response

        response = [chunk async for chunk in model.stream(messages)]

        assert len(response) == 5
        assert response[0] == {"messageStart": {"role": "assistant"}}

        # Find content events
        content_start = next((e for e in response if "contentBlockStart" in e), None)
        content_delta = next((e for e in response if "contentBlockDelta" in e), None)
        content_stop = next((e for e in response if "contentBlockStop" in e), None)
        message_stop = next((e for e in response if "messageStop" in e), None)

        assert content_start is not None
        assert content_delta is not None
        assert content_stop is not None
        assert message_stop is not None
        assert message_stop["messageStop"]["stopReason"] == "end_turn"

        # Verify content
        text_delta = content_delta["contentBlockDelta"]["delta"]["text"]
        assert text_delta == "Paris is the capital of France."

        # Ensure no warnings emitted
        assert len(captured_warnings) == 0

    @pytest.mark.asyncio
    async def test_stream_multiple_events_per_payload_part(self, sagemaker_client, model, messages, alist, caplog):
        """Every SSE event is surfaced when a PayloadPart carries more than one event or splits one.

        SageMaker does not align PayloadParts to SSE event boundaries: a container such as vLLM or
        TGI may flush several ``data:`` events into one part or split a single event mid-JSON across
        parts. All content up to and including the terminating event must be yielded in order.

        Regression test for #4035.
        """
        caplog.set_level(logging.WARNING, logger="strands.models.sagemaker")

        def sse(content: str, finish_reason: str | None = None) -> str:
            event = {"choices": [{"delta": {"content": content}, "finish_reason": finish_reason}]}
            return f"data: {json.dumps(event)}\n\n"

        final_event = sse("!", finish_reason="stop")
        split = len(final_event) // 2
        mock_response = {
            "Body": [
                # Three complete SSE events packed into a single PayloadPart.
                {"PayloadPart": {"Bytes": (sse("Paris ") + sse("is the ") + sse("capital of France")).encode("utf-8")}},
                # A fourth event split mid-JSON across two parts.
                {"PayloadPart": {"Bytes": final_event[:split].encode("utf-8")}},
                {"PayloadPart": {"Bytes": final_event[split:].encode("utf-8")}},
            ]
        }
        sagemaker_client.invoke_endpoint_with_response_stream.return_value = mock_response

        response = await alist(model.stream(messages))

        tru_text = "".join(
            event["contentBlockDelta"]["delta"]["text"]
            for event in response
            if "contentBlockDelta" in event and "text" in event["contentBlockDelta"]["delta"]
        )
        exp_text = "Paris is the capital of France!"
        message_stop = next((event for event in response if "messageStop" in event), None)

        assert tru_text == exp_text
        assert message_stop is not None
        assert message_stop["messageStop"]["stopReason"] == "end_turn"
        assert not caplog.records

    @pytest.mark.asyncio
    async def test_tool_choice_not_supported_warns(self, sagemaker_client, model, messages, captured_warnings, alist):
        """Test that non-None toolChoice emits warning for unsupported providers."""
        tool_choice = {"auto": {}}

        """Test streaming response with partial JSON chunks."""
        # Mock the response from SageMaker with split JSON
        mock_response = {
            "Body": [
                {"PayloadPart": {"Bytes": b'{"choices": [{"delta": {"content": "Paris is'}},
                {"PayloadPart": {"Bytes": b' the capital of France."}, "finish_reason": "stop"}]}'}},
            ]
        }
        sagemaker_client.invoke_endpoint_with_response_stream.return_value = mock_response

        await alist(model.stream(messages, tool_choice=tool_choice))

        # Ensure toolChoice parameter warning
        assert len(captured_warnings) == 1
        assert "ToolChoice was provided to this provider but is not supported" in str(captured_warnings[0].message)

    @pytest.mark.asyncio
    async def test_stream_non_streaming(self, sagemaker_client, model, messages):
        """Test non-streaming response."""
        # Configure model for non-streaming
        model.payload_config["stream"] = False

        # Mock the response from SageMaker
        mock_response = {"Body": unittest.mock.MagicMock()}
        mock_response["Body"].read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {"content": "Paris is the capital of France.", "tool_calls": None},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30, "prompt_tokens_details": 0},
            }
        ).encode("utf-8")

        sagemaker_client.invoke_endpoint.return_value = mock_response

        response = [chunk async for chunk in model.stream(messages)]

        assert len(response) >= 6
        assert response[0] == {"messageStart": {"role": "assistant"}}

        # Find content events
        content_start = next((e for e in response if "contentBlockStart" in e), None)
        content_delta = next((e for e in response if "contentBlockDelta" in e), None)
        content_stop = next((e for e in response if "contentBlockStop" in e), None)
        message_stop = next((e for e in response if "messageStop" in e), None)

        assert content_start is not None
        assert content_delta is not None
        assert content_stop is not None
        assert message_stop is not None

        # Verify content
        text_delta = content_delta["contentBlockDelta"]["delta"]["text"]
        assert text_delta == "Paris is the capital of France."

        sagemaker_client.invoke_endpoint.assert_called_once()

    @pytest.mark.asyncio
    async def test_stream_non_streaming_with_tool_calls(self, sagemaker_client, model, messages):
        """Test non-streaming response with tool calls."""
        # Configure model for non-streaming
        model.payload_config["stream"] = False

        # Mock the response from SageMaker with tool calls
        mock_response = {"Body": unittest.mock.MagicMock()}
        mock_response["Body"].read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "tool123",
                                    "type": "function",
                                    "function": {"name": "get_weather", "arguments": '{"location": "Paris"}'},
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30, "prompt_tokens_details": 0},
            }
        ).encode("utf-8")

        sagemaker_client.invoke_endpoint.return_value = mock_response

        response = [chunk async for chunk in model.stream(messages)]

        # Verify basic structure
        assert len(response) >= 6
        assert response[0] == {"messageStart": {"role": "assistant"}}

        # Find tool call events
        tool_start = next(
            (
                e
                for e in response
                if "contentBlockStart" in e and e.get("contentBlockStart", {}).get("start", {}).get("toolUse")
            ),
            None,
        )
        tool_delta = next(
            (
                e
                for e in response
                if "contentBlockDelta" in e and e.get("contentBlockDelta", {}).get("delta", {}).get("toolUse")
            ),
            None,
        )
        tool_stop = next((e for e in response if "contentBlockStop" in e), None)
        message_stop = next((e for e in response if "messageStop" in e), None)

        assert tool_start is not None
        assert tool_delta is not None
        assert tool_stop is not None
        assert message_stop is not None

        # Verify tool call data
        tool_use_data = tool_start["contentBlockStart"]["start"]["toolUse"]
        assert tool_use_data["toolUseId"] == "tool123"
        assert tool_use_data["name"] == "get_weather"

        # Verify metadata
        metadata = next((e for e in response if "metadata" in e), None)
        assert metadata is not None
        usage_data = metadata["metadata"]["usage"]
        assert usage_data["totalTokens"] == 30


class TestDataClasses:
    """Test suite for data classes."""

    def test_usage_metadata(self):
        """Test UsageMetadata dataclass."""
        usage = UsageMetadata(total_tokens=100, completion_tokens=30, prompt_tokens=70, prompt_tokens_details=5)

        assert usage.total_tokens == 100
        assert usage.completion_tokens == 30
        assert usage.prompt_tokens == 70
        assert usage.prompt_tokens_details == 5

    def test_usage_metadata_from_usage_ignores_undeclared_fields(self):
        """from_usage drops wire fields the dataclass does not declare."""
        usage = UsageMetadata.from_usage(
            {
                "total_tokens": 100,
                "completion_tokens": 30,
                "prompt_tokens": 70,
                "completion_tokens_details": {"reasoning_tokens": 12},
            }
        )

        assert usage == UsageMetadata(total_tokens=100, completion_tokens=30, prompt_tokens=70)

    def test_usage_metadata_from_usage_keeps_every_declared_field(self):
        """from_usage forwards a usage object that carries only declared fields unchanged."""
        usage = UsageMetadata.from_usage(
            {"total_tokens": 100, "completion_tokens": 30, "prompt_tokens": 70, "prompt_tokens_details": 5}
        )

        assert usage == UsageMetadata(total_tokens=100, completion_tokens=30, prompt_tokens=70, prompt_tokens_details=5)

    def test_function_call(self):
        """Test FunctionCall dataclass."""
        func = FunctionCall(name="get_weather", arguments='{"location": "Paris"}')

        assert func.name == "get_weather"
        assert func.arguments == '{"location": "Paris"}'

        # Test initialization with kwargs
        func2 = FunctionCall(**{"name": "get_time", "arguments": '{"timezone": "UTC"}'})

        assert func2.name == "get_time"
        assert func2.arguments == '{"timezone": "UTC"}'

    def test_tool_call(self):
        """Test ToolCall dataclass."""
        # Create a tool call using kwargs directly
        tool = ToolCall(
            id="tool123", type="function", function={"name": "get_weather", "arguments": '{"location": "Paris"}'}
        )

        assert tool.id == "tool123"
        assert tool.type == "function"
        assert tool.function.name == "get_weather"
        assert tool.function.arguments == '{"location": "Paris"}'

        # Test initialization with kwargs
        tool2 = ToolCall(
            **{
                "id": "tool456",
                "type": "function",
                "function": {"name": "get_time", "arguments": '{"timezone": "UTC"}'},
            }
        )

        assert tool2.id == "tool456"
        assert tool2.type == "function"
        assert tool2.function.name == "get_time"
        assert tool2.function.arguments == '{"timezone": "UTC"}'


def test_config_validation_warns_on_unknown_keys_in_endpoint(boto_session, captured_warnings):
    """Test that unknown config keys emit a warning."""
    endpoint_config = {"endpoint_name": "test-endpoint", "region_name": "us-east-1", "invalid_param": "test"}
    payload_config = {"max_tokens": 1024}

    SageMakerAIModel(
        endpoint_config=endpoint_config,
        payload_config=payload_config,
        boto_session=boto_session,
    )

    assert len(captured_warnings) == 1
    assert "Invalid configuration parameters" in str(captured_warnings[0].message)
    assert "invalid_param" in str(captured_warnings[0].message)


def test_config_validation_warns_on_unknown_keys_in_payload(boto_session, captured_warnings):
    """Test that unknown config keys emit a warning."""
    endpoint_config = {"endpoint_name": "test-endpoint", "region_name": "us-east-1"}
    payload_config = {"max_tokens": 1024, "invalid_param": "test"}

    SageMakerAIModel(
        endpoint_config=endpoint_config,
        payload_config=payload_config,
        boto_session=boto_session,
    )

    assert len(captured_warnings) == 1
    assert "Invalid configuration parameters" in str(captured_warnings[0].message)
    assert "invalid_param" in str(captured_warnings[0].message)


def test_update_config_validation_warns_on_unknown_keys(model, captured_warnings):
    """Test that update_config warns on unknown keys."""
    model.update_config(wrong_param="test")

    assert len(captured_warnings) == 1
    assert "Invalid configuration parameters" in str(captured_warnings[0].message)
    assert "wrong_param" in str(captured_warnings[0].message)


class TestSageMakerReasoningContent:
    """Tests for vLLM reasoning field support in streaming and non-streaming paths."""

    @pytest.mark.asyncio
    async def test_stream_reasoning_with_reasoning_field(self, sagemaker_client, model, messages):
        """vLLM v0.16.0+ sends reasoning in 'reasoning' field instead of 'reasoning_content'."""
        mock_response = {
            "Body": [
                {
                    "PayloadPart": {
                        "Bytes": json.dumps(
                            {"choices": [{"delta": {"reasoning": "Let me think..."}, "finish_reason": None}]}
                        ).encode("utf-8")
                    }
                },
                {
                    "PayloadPart": {
                        "Bytes": json.dumps(
                            {"choices": [{"delta": {"reasoning": " still thinking."}, "finish_reason": None}]}
                        ).encode("utf-8")
                    }
                },
                {
                    "PayloadPart": {
                        "Bytes": json.dumps(
                            {"choices": [{"delta": {"content": "Paris."}, "finish_reason": "stop"}]}
                        ).encode("utf-8")
                    }
                },
            ]
        }
        sagemaker_client.invoke_endpoint_with_response_stream.return_value = mock_response

        response = [chunk async for chunk in model.stream(messages)]

        reasoning_deltas = [
            e for e in response if "contentBlockDelta" in e and "reasoningContent" in e["contentBlockDelta"]["delta"]
        ]
        assert [event["contentBlockDelta"]["delta"]["reasoningContent"]["text"] for event in reasoning_deltas] == [
            "Let me think...",
            " still thinking.",
        ]

    @pytest.mark.asyncio
    async def test_stream_reasoning_with_reasoning_content_field(self, sagemaker_client, model, messages):
        """Old vLLM versions send reasoning in 'reasoning_content' field."""
        mock_response = {
            "Body": [
                {
                    "PayloadPart": {
                        "Bytes": json.dumps(
                            {"choices": [{"delta": {"reasoning_content": "Thinking..."}, "finish_reason": None}]}
                        ).encode("utf-8")
                    }
                },
                {
                    "PayloadPart": {
                        "Bytes": json.dumps(
                            {"choices": [{"delta": {"content": "Paris."}, "finish_reason": "stop"}]}
                        ).encode("utf-8")
                    }
                },
            ]
        }
        sagemaker_client.invoke_endpoint_with_response_stream.return_value = mock_response

        response = [chunk async for chunk in model.stream(messages)]

        reasoning_deltas = [
            e for e in response if "contentBlockDelta" in e and "reasoningContent" in e["contentBlockDelta"]["delta"]
        ]
        assert len(reasoning_deltas) == 1
        assert reasoning_deltas[0]["contentBlockDelta"]["delta"]["reasoningContent"]["text"] == "Thinking..."

    @pytest.mark.asyncio
    async def test_stream_reasoning_prefers_reasoning_content_over_reasoning(self, sagemaker_client, model, messages):
        """When both fields are present, reasoning_content takes precedence."""
        mock_response = {
            "Body": [
                {
                    "PayloadPart": {
                        "Bytes": json.dumps(
                            {
                                "choices": [
                                    {
                                        "delta": {"reasoning_content": "From old field", "reasoning": "From new field"},
                                        "finish_reason": "stop",
                                    }
                                ]
                            }
                        ).encode("utf-8")
                    }
                },
            ]
        }
        sagemaker_client.invoke_endpoint_with_response_stream.return_value = mock_response

        response = [chunk async for chunk in model.stream(messages)]

        reasoning_deltas = [
            e for e in response if "contentBlockDelta" in e and "reasoningContent" in e["contentBlockDelta"]["delta"]
        ]
        assert len(reasoning_deltas) == 1
        assert reasoning_deltas[0]["contentBlockDelta"]["delta"]["reasoningContent"]["text"] == "From old field"

    @pytest.mark.asyncio
    async def test_stream_reasoning_skips_none_values(self, sagemaker_client, model, messages):
        """Reasoning fields with None values should not emit reasoning content."""
        mock_response = {
            "Body": [
                {
                    "PayloadPart": {
                        "Bytes": json.dumps(
                            {
                                "choices": [
                                    {
                                        "delta": {"reasoning_content": None, "reasoning": None, "content": "Hello"},
                                        "finish_reason": "stop",
                                    }
                                ]
                            }
                        ).encode("utf-8")
                    }
                },
            ]
        }
        sagemaker_client.invoke_endpoint_with_response_stream.return_value = mock_response

        response = [chunk async for chunk in model.stream(messages)]

        reasoning_deltas = [
            e for e in response if "contentBlockDelta" in e and "reasoningContent" in e["contentBlockDelta"]["delta"]
        ]
        assert len(reasoning_deltas) == 0

    @pytest.mark.asyncio
    async def test_non_streaming_reasoning_with_reasoning_field(self, sagemaker_client, model, messages):
        """Non-streaming path: vLLM v0.16.0+ sends reasoning in 'reasoning' field."""
        model.payload_config["stream"] = False

        mock_response = {"Body": unittest.mock.MagicMock()}
        mock_response["Body"].read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {"content": "Paris.", "reasoning": "Let me think...", "tool_calls": None},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30, "prompt_tokens_details": 0},
            }
        ).encode("utf-8")

        sagemaker_client.invoke_endpoint.return_value = mock_response

        response = [chunk async for chunk in model.stream(messages)]

        reasoning_deltas = [
            e for e in response if "contentBlockDelta" in e and "reasoningContent" in e["contentBlockDelta"]["delta"]
        ]
        assert len(reasoning_deltas) == 1
        assert reasoning_deltas[0]["contentBlockDelta"]["delta"]["reasoningContent"]["text"] == "Let me think..."

    @pytest.mark.asyncio
    async def test_non_streaming_reasoning_with_reasoning_content_field(self, sagemaker_client, model, messages):
        """Non-streaming path: old vLLM versions send reasoning in 'reasoning_content' field."""
        model.payload_config["stream"] = False

        mock_response = {"Body": unittest.mock.MagicMock()}
        mock_response["Body"].read.return_value = json.dumps(
            {
                "choices": [
                    {
                        "message": {"content": "Paris.", "reasoning_content": "Thinking...", "tool_calls": None},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30, "prompt_tokens_details": 0},
            }
        ).encode("utf-8")

        sagemaker_client.invoke_endpoint.return_value = mock_response

        response = [chunk async for chunk in model.stream(messages)]

        reasoning_deltas = [
            e for e in response if "contentBlockDelta" in e and "reasoningContent" in e["contentBlockDelta"]["delta"]
        ]
        assert len(reasoning_deltas) == 1
        assert reasoning_deltas[0]["contentBlockDelta"]["delta"]["reasoningContent"]["text"] == "Thinking..."


def test_cache_config_round_trips(boto_session, endpoint_config, payload_config, captured_warnings):
    """cache_config is a valid endpoint_config field and survives get_config/update_config unchanged."""
    cache_config = CacheConfig()
    model = SageMakerAIModel(
        boto_session=boto_session,
        endpoint_config={**endpoint_config, "cache_config": cache_config},
        payload_config=payload_config,
    )

    assert model.get_config()["cache_config"] is cache_config

    updated = CacheConfig()
    model.update_config(cache_config=updated)
    assert model.get_config()["cache_config"] is updated

    assert not any("Invalid configuration parameters" in str(warning.message) for warning in captured_warnings)


def test_cache_config_default_is_silent_and_not_routed(
    boto_session, endpoint_config, payload_config, messages, captured_warnings
):
    """A CacheConfig whose fields are all default warns about nothing and never reaches the request."""
    model = SageMakerAIModel(
        boto_session=boto_session,
        endpoint_config={**endpoint_config, "cache_config": CacheConfig(strategy="auto")},
        payload_config=payload_config,
    )

    request = model.format_request(messages)

    assert "cache_config" not in request
    assert "cache_config" not in json.loads(request["Body"])
    assert not any("have no effect" in str(warning.message) for warning in captured_warnings)


@pytest.mark.parametrize(
    ("cache_config", "field"),
    [
        (CacheConfig(strategy="anthropic"), "strategy"),
        (CacheConfig(ttl="1h"), "ttl"),
        (CacheConfig(system_prompt_ttl="1h"), "system_prompt_ttl"),
        (CacheConfig(cache_key="tenant-42"), "cache_key"),
        (CacheConfig(tools_ttl=True), "tools_ttl"),
    ],
)
def test_cache_config_unsupported_field_warns_and_is_not_routed(
    boto_session, endpoint_config, payload_config, messages, cache_config, field
):
    """SageMaker honors no cache field: a non-default field warns (naming the provider) and never reaches request."""
    model = SageMakerAIModel(
        boto_session=boto_session,
        endpoint_config={**endpoint_config, "cache_config": cache_config},
        payload_config=payload_config,
    )

    with pytest.warns(UserWarning, match=rf"fields \['{field}'\] have no effect on SageMaker"):
        request = model.format_request(messages)

    assert "cache_config" not in request
    assert "cache_config" not in json.loads(request["Body"])
