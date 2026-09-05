import asyncio
import copy
import logging
import os
import sys
import threading
import time
import traceback
import unittest.mock
from unittest.mock import ANY

import boto3
import pydantic
import pytest
from botocore import UNSIGNED
from botocore.config import Config as BotocoreConfig
from botocore.exceptions import ClientError, EventStreamError

import strands
from strands import _exception_notes
from strands.models import BedrockModel, CacheConfig, CacheToolsConfig
from strands.models.bedrock import (
    DEFAULT_BEDROCK_MODEL_ID,
    DEFAULT_BEDROCK_REGION,
    DEFAULT_READ_TIMEOUT,
    _clear_skip_count_tokens_cache,
    _next_stream_event,
    _suppress_task_exception,
)
from strands.types.exceptions import ContextWindowOverflowException, ModelThrottledException
from strands.types.tools import ToolSpec

FORMATTED_DEFAULT_MODEL_ID = DEFAULT_BEDROCK_MODEL_ID

# cache_tools is deprecated in favor of CacheConfig(tools_ttl=...); tests that deliberately exercise the
# backward-compat path emit its config-time DeprecationWarning, and assert it explicitly where relevant.
pytestmark = pytest.mark.filterwarnings("ignore:cache_tools is deprecated:DeprecationWarning")


@pytest.fixture
def session_cls():
    # Mock the creation of a Session so that we don't depend on environment variables or profiles
    with unittest.mock.patch.object(strands.models.bedrock.boto3, "Session") as mock_session_cls:
        mock_session = unittest.mock.Mock()
        mock_session.region_name = None
        mock_session_cls.return_value = mock_session
        yield mock_session_cls


@pytest.fixture
def mock_client_method(session_cls):
    # the boto3.Session().client(...) method
    return session_cls.return_value.client


@pytest.fixture
def bedrock_client(session_cls):
    mock_client = session_cls.return_value.client.return_value
    mock_client.meta = unittest.mock.MagicMock()
    mock_client.meta.region_name = "us-west-2"
    mock_client.meta.service_model.shape_for.return_value.enum = ["png", "jpeg"]
    yield mock_client


@pytest.fixture
def model_id():
    return "m1"


@pytest.fixture
def model(bedrock_client, model_id):
    _ = bedrock_client

    return BedrockModel(model_id=model_id)


@pytest.fixture
def messages():
    return [{"role": "user", "content": [{"text": "test"}]}]


@pytest.fixture
def tool_result_turn_messages():
    return [
        {"role": "user", "content": [{"text": "Create structured output"}]},
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "tool-1", "name": "Result", "input": {"value": 1}}}],
        },
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "tool-1", "content": [{"text": "Validated"}]}}],
        },
        {"role": "user", "content": [{"text": "Create another result"}]},
    ]


@pytest.fixture
def separated_tool_result_turn_messages(tool_result_turn_messages):
    return [
        *tool_result_turn_messages[:3],
        {"role": "assistant", "content": [{"text": "Tool result received."}]},
        tool_result_turn_messages[3],
    ]


@pytest.fixture
def system_prompt():
    return "s1"


@pytest.fixture
def additional_request_fields():
    return {"a": 1}


@pytest.fixture
def additional_response_field_paths():
    return ["p1"]


@pytest.fixture
def guardrail_config():
    return {
        "guardrail_id": "g1",
        "guardrail_version": "v1",
        "guardrail_stream_processing_mode": "async",
        "guardrail_trace": "enabled",
    }


@pytest.fixture
def inference_config():
    return {
        "max_tokens": 1,
        "stop_sequences": ["stop"],
        "temperature": 1,
        "top_p": 1,
    }


@pytest.fixture
def tool_spec() -> ToolSpec:
    return {
        "description": "description",
        "name": "name",
        "inputSchema": {"key": "val"},
    }


@pytest.fixture
def cache_type():
    return "default"


@pytest.fixture
def test_output_model_cls():
    class TestOutputModel(pydantic.BaseModel):
        name: str
        age: int

    return TestOutputModel


def test__init__default_model_id(bedrock_client):
    """Test that BedrockModel uses DEFAULT_MODEL_ID when no model_id is provided."""
    _ = bedrock_client
    model = BedrockModel()

    tru_model_id = model.get_config().get("model_id")
    exp_model_id = FORMATTED_DEFAULT_MODEL_ID

    assert tru_model_id == exp_model_id


def test__init__with_default_region(session_cls, mock_client_method):
    """Test that BedrockModel uses the provided region."""
    with unittest.mock.patch.object(os, "environ", {}):
        BedrockModel()
        session_cls.return_value.client.assert_called_with(
            region_name=DEFAULT_BEDROCK_REGION, config=ANY, service_name=ANY, endpoint_url=None
        )


def test__init__with_session_region(session_cls, mock_client_method):
    """Test that BedrockModel uses the provided region."""
    session_cls.return_value.region_name = "eu-blah-1"

    BedrockModel()

    mock_client_method.assert_called_with(region_name="eu-blah-1", config=ANY, service_name=ANY, endpoint_url=None)


def test__init__with_custom_region(mock_client_method):
    """Test that BedrockModel uses the provided region."""
    custom_region = "us-east-1"
    BedrockModel(region_name=custom_region)
    mock_client_method.assert_called_with(region_name=custom_region, config=ANY, service_name=ANY, endpoint_url=None)


def test__init__with_default_environment_variable_region(mock_client_method):
    """Test that BedrockModel uses the AWS_REGION since we code that in."""
    with unittest.mock.patch.object(os, "environ", {"AWS_REGION": "eu-west-2"}):
        BedrockModel()

    mock_client_method.assert_called_with(region_name="eu-west-2", config=ANY, service_name=ANY, endpoint_url=None)


def test__init__region_precedence(mock_client_method, session_cls):
    """Test that BedrockModel uses the correct ordering of precedence when determining region."""
    with unittest.mock.patch.object(os, "environ", {"AWS_REGION": "us-environment-1"}) as mock_os_environ:
        session_cls.return_value.region_name = "us-session-1"

        # specifying a region always wins out
        BedrockModel(region_name="us-specified-1")
        mock_client_method.assert_called_with(
            region_name="us-specified-1", config=ANY, service_name=ANY, endpoint_url=None
        )

        # other-wise uses the session's
        BedrockModel()
        mock_client_method.assert_called_with(
            region_name="us-session-1", config=ANY, service_name=ANY, endpoint_url=None
        )

        # environment variable next
        session_cls.return_value.region_name = None
        BedrockModel()
        mock_client_method.assert_called_with(
            region_name="us-environment-1", config=ANY, service_name=ANY, endpoint_url=None
        )

        mock_os_environ.pop("AWS_REGION")
        session_cls.return_value.region_name = None  # No session region
        BedrockModel()
        mock_client_method.assert_called_with(
            region_name=DEFAULT_BEDROCK_REGION, config=ANY, service_name=ANY, endpoint_url=None
        )


def test__init__with_endpoint_url(mock_client_method):
    """Test that BedrockModel uses the provided endpoint_url for VPC endpoints."""
    custom_endpoint = "https://vpce-12345-abcde.bedrock-runtime.us-west-2.vpce.amazonaws.com"
    with unittest.mock.patch.object(os, "environ", {}):
        BedrockModel(endpoint_url=custom_endpoint)
        mock_client_method.assert_called_with(
            region_name=DEFAULT_BEDROCK_REGION, config=ANY, service_name=ANY, endpoint_url=custom_endpoint
        )


def test__init__with_region_and_session_raises_value_error():
    """Test that BedrockModel raises ValueError when both region and session are provided."""
    with pytest.raises(ValueError):
        _ = BedrockModel(region_name="us-east-1", boto_session=boto3.Session(region_name="us-east-1"))


def test__init__default_user_agent(session_cls, bedrock_client):
    """Set user agent when no boto_client_config is provided."""
    _ = BedrockModel()

    # Verify the client was created with the correct config
    client = session_cls.return_value.client
    client.assert_called_once()
    args, kwargs = client.call_args
    assert kwargs["service_name"] == "bedrock-runtime"
    assert isinstance(kwargs["config"], BotocoreConfig)
    assert kwargs["config"].user_agent_extra == "strands-agents"
    assert kwargs["config"].read_timeout == DEFAULT_READ_TIMEOUT


def test__init__default_read_timeout(session_cls, bedrock_client):
    """Set default read timeout when no boto_client_config is provided."""

    _ = BedrockModel()

    # Verify the client was created with the correct read timeout
    client = session_cls.return_value.client
    client.assert_called_once()
    args, kwargs = client.call_args
    assert isinstance(kwargs["config"], BotocoreConfig)
    assert kwargs["config"].read_timeout == DEFAULT_READ_TIMEOUT


def test__init__with_custom_boto_client_config_no_user_agent(session_cls, bedrock_client):
    """Set user agent when boto_client_config is provided without user_agent_extra."""
    custom_config = BotocoreConfig(read_timeout=900)

    _ = BedrockModel(boto_client_config=custom_config)

    # Verify the client was created with the correct config
    client = session_cls.return_value.client
    client.assert_called_once()
    args, kwargs = client.call_args
    assert kwargs["service_name"] == "bedrock-runtime"
    assert isinstance(kwargs["config"], BotocoreConfig)
    assert kwargs["config"].user_agent_extra == "strands-agents"
    assert kwargs["config"].read_timeout == 900


def test__init__with_custom_boto_client_config_with_user_agent(session_cls, bedrock_client):
    """Append to existing user agent when boto_client_config is provided with user_agent_extra."""
    custom_config = BotocoreConfig(user_agent_extra="existing-agent", read_timeout=900)

    _ = BedrockModel(boto_client_config=custom_config)

    # Verify the client was created with the correct config
    client = session_cls.return_value.client
    client.assert_called_once()
    args, kwargs = client.call_args
    assert kwargs["service_name"] == "bedrock-runtime"
    assert isinstance(kwargs["config"], BotocoreConfig)
    assert kwargs["config"].user_agent_extra == "existing-agent strands-agents"
    assert kwargs["config"].read_timeout == 900


def test__init__with_api_key_configures_bearer_auth(session_cls, bedrock_client):
    """Use unsigned requests and a bearer authorization hook for an API key (#1238)."""
    model = BedrockModel(
        api_key="br-test-key", boto_client_config=BotocoreConfig(read_timeout=900, signature_version="v4")
    )

    client = session_cls.return_value.client
    _, kwargs = client.call_args
    assert kwargs["config"].signature_version == UNSIGNED
    assert kwargs["config"].read_timeout == 900
    assert model.get_config().get("api_key") is None

    bedrock_client.meta.events.register.assert_called_once_with("before-send.bedrock-runtime.*", ANY)
    auth_handler = bedrock_client.meta.events.register.call_args.args[1]
    request = unittest.mock.Mock(headers={"Authorization": "AWS4-HMAC-SHA256 ..."})

    auth_handler(request)

    assert request.headers == {"Authorization": "Bearer br-test-key"}


def test__init__without_api_key_does_not_register_bearer_auth(session_cls, bedrock_client):
    """Keep the default IAM-signing path when no API key is provided."""
    _ = BedrockModel()

    _, kwargs = session_cls.return_value.client.call_args
    assert kwargs["config"].signature_version is None
    bedrock_client.meta.events.register.assert_not_called()


def test__init__model_config(bedrock_client):
    _ = bedrock_client

    model = BedrockModel(max_tokens=1)

    tru_max_tokens = model.get_config().get("max_tokens")
    exp_max_tokens = 1

    assert tru_max_tokens == exp_max_tokens


def test__init__context_window_limit(bedrock_client):
    _ = bedrock_client

    model = BedrockModel(context_window_limit=200_000)

    assert model.get_config().get("context_window_limit") == 200_000
    assert model.context_window_limit == 200_000


def test__init__auto_populates_context_window_limit(bedrock_client):
    _ = bedrock_client

    model = BedrockModel(model_id="anthropic.claude-sonnet-4-20250514-v1:0")

    assert model.get_config().get("context_window_limit") == 1_000_000


def test__init__auto_populates_context_window_limit_cross_region(bedrock_client):
    _ = bedrock_client

    model = BedrockModel(model_id="us.anthropic.claude-sonnet-4-6")

    assert model.get_config().get("context_window_limit") == 1_000_000


def test__init__auto_populates_context_window_limit_default_model(bedrock_client):
    _ = bedrock_client

    model = BedrockModel()

    assert model.get_config().get("context_window_limit") == 1_000_000


def test__init__explicit_context_window_limit_not_overridden(bedrock_client):
    _ = bedrock_client

    model = BedrockModel(model_id="anthropic.claude-sonnet-4-20250514-v1:0", context_window_limit=100_000)

    assert model.get_config().get("context_window_limit") == 100_000


def test__init__unknown_model_no_context_window_limit(bedrock_client):
    _ = bedrock_client

    model = BedrockModel(model_id="unknown.model-v1:0")

    assert model.get_config().get("context_window_limit") is None


def test_update_config(model, model_id):
    model.update_config(model_id=model_id)

    tru_model_id = model.get_config().get("model_id")
    exp_model_id = model_id

    assert tru_model_id == exp_model_id


def test_cache_key_round_trips_through_config(model):
    """Bedrock accepts and preserves cache_config.cache_key through update_config/get_config."""
    model.update_config(cache_config=CacheConfig(strategy="anthropic", cache_key="tenant-42"))

    assert model.get_config()["cache_config"].cache_key == "tenant-42"


def test_cache_key_does_not_change_request_shape(bedrock_client, messages):
    """Bedrock ignores cache_key: two configs differing only in cache_key format identically."""
    _ = bedrock_client
    without_key = BedrockModel(model_id="m1", cache_config=CacheConfig(strategy="anthropic"))
    with_key = BedrockModel(model_id="m1", cache_config=CacheConfig(strategy="anthropic", cache_key="tenant-42"))

    assert with_key.format_request(messages) == without_key.format_request(messages)


def test_format_request_default(model, messages, model_id):
    tru_request = model.format_request(messages)
    exp_request = {
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
    }

    assert tru_request == exp_request


def test_format_request_additional_request_fields(model, messages, model_id, additional_request_fields):
    model.update_config(additional_request_fields=additional_request_fields)
    tru_request = model.format_request(messages)
    exp_request = {
        "additionalModelRequestFields": additional_request_fields,
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
    }

    assert tru_request == exp_request


def test_format_request_additional_response_field_paths(model, messages, model_id, additional_response_field_paths):
    model.update_config(additional_response_field_paths=additional_response_field_paths)
    tru_request = model.format_request(messages)
    exp_request = {
        "additionalModelResponseFieldPaths": additional_response_field_paths,
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
    }

    assert tru_request == exp_request


def test_format_request_guardrail_config(model, messages, model_id, guardrail_config):
    model.update_config(**guardrail_config)
    tru_request = model.format_request(messages)
    exp_request = {
        "guardrailConfig": {
            "guardrailIdentifier": guardrail_config["guardrail_id"],
            "guardrailVersion": guardrail_config["guardrail_version"],
            "trace": guardrail_config["guardrail_trace"],
            "streamProcessingMode": guardrail_config["guardrail_stream_processing_mode"],
        },
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
    }

    assert tru_request == exp_request


def test_format_request_guardrail_config_without_trace_or_stream_processing_mode(model, messages, model_id):
    model.update_config(
        **{
            "guardrail_id": "g1",
            "guardrail_version": "v1",
        }
    )
    tru_request = model.format_request(messages)
    exp_request = {
        "guardrailConfig": {
            "guardrailIdentifier": "g1",
            "guardrailVersion": "v1",
            "trace": "enabled",
        },
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
    }

    assert tru_request == exp_request


def test_format_request_with_service_tier(model, messages, model_id):
    model.update_config(service_tier="flex")
    tru_request = model.format_request(messages)
    exp_request = {
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "serviceTier": {"type": "flex"},
        "system": [],
    }

    assert tru_request == exp_request


def test_format_request_with_request_metadata(model, messages, model_id):
    model.update_config(request_metadata={"team": "orchestrator", "environment": "prod"})
    tru_request = model._format_request(messages)
    exp_request = {
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "requestMetadata": {"team": "orchestrator", "environment": "prod"},
        "system": [],
    }

    assert tru_request == exp_request


def test_format_request_without_request_metadata(model, messages, model_id):
    tru_request = model._format_request(messages)
    assert "requestMetadata" not in tru_request


def test_format_request_inference_config(model, messages, model_id, inference_config):
    model.update_config(**inference_config)
    tru_request = model.format_request(messages)
    exp_request = {
        "inferenceConfig": {
            "maxTokens": inference_config["max_tokens"],
            "stopSequences": inference_config["stop_sequences"],
            "temperature": inference_config["temperature"],
            "topP": inference_config["top_p"],
        },
        "modelId": model_id,
        "messages": messages,
        "system": [],
    }

    assert tru_request == exp_request


def test_format_request_system_prompt(model, messages, model_id, system_prompt):
    tru_request = model.format_request(messages, system_prompt_content=[{"text": system_prompt}])
    exp_request = {
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [{"text": system_prompt}],
    }

    assert tru_request == exp_request


def test_format_request_system_prompt_content(model, messages, model_id):
    """Test format_request with SystemContentBlock input."""
    system_prompt_content = [{"text": "You are a helpful assistant."}, {"cachePoint": {"type": "default"}}]

    tru_request = model.format_request(messages, system_prompt_content=system_prompt_content)
    exp_request = {
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": system_prompt_content,
    }

    assert tru_request == exp_request


def test_format_request_system_prompt_content_with_cache_prompt_config(model, messages, model_id):
    """Test format_request with SystemContentBlock and cache_prompt config (backwards compatibility)."""
    system_prompt_content = [{"text": "You are a helpful assistant."}]
    model.update_config(cache_prompt="default")

    with pytest.warns(UserWarning, match="cache_prompt is deprecated"):
        tru_request = model.format_request(messages, system_prompt_content=system_prompt_content)

    exp_request = {
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [{"text": "You are a helpful assistant."}, {"cachePoint": {"type": "default"}}],
    }

    assert tru_request == exp_request


def test_format_request_empty_system_prompt_content(model, messages, model_id):
    """Test format_request with empty SystemContentBlock list."""
    tru_request = model.format_request(messages, system_prompt_content=[])
    exp_request = {
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
    }

    assert tru_request == exp_request


def test_format_request_tool_specs(model, messages, model_id, tool_spec):
    tru_request = model.format_request(messages, tool_specs=[tool_spec])
    exp_request = {
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
        "toolConfig": {
            "tools": [{"toolSpec": tool_spec}],
            "toolChoice": {"auto": {}},
        },
    }

    assert tru_request == exp_request


def test_format_request_strict_tools_injects_strict_and_closes_schema(bedrock_client, model_id, messages):
    tool_specs = [
        {
            "name": "my_tool",
            "description": "A tool",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {"param": {"type": "string"}},
                    "required": ["param"],
                }
            },
        }
    ]
    model = BedrockModel(model_id=model_id, strict_tools=True)
    request = model.format_request(messages, tool_specs=tool_specs)
    tool_spec_result = request["toolConfig"]["tools"][0]["toolSpec"]

    assert tool_spec_result == {
        "name": "my_tool",
        "description": "A tool",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {"param": {"type": "string"}},
                "required": ["param"],
                "additionalProperties": False,
            }
        },
        "strict": True,
    }


def test_format_request_strict_tools_does_not_mutate_original(bedrock_client, model_id, messages):
    tool_specs = [
        {
            "name": "my_tool",
            "description": "A tool",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {"param": {"type": "string"}},
                    "required": ["param"],
                }
            },
        }
    ]
    model = BedrockModel(model_id=model_id, strict_tools=True)
    model.format_request(messages, tool_specs=tool_specs)

    assert "additionalProperties" not in tool_specs[0]["inputSchema"]["json"]


def test_format_request_strict_tools_preserves_additional_properties_true(bedrock_client, model_id, messages):
    tool_specs = [
        {
            "name": "my_tool",
            "description": "A tool",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {"param": {"type": "string"}},
                    "required": ["param"],
                    "additionalProperties": True,
                }
            },
        }
    ]
    model = BedrockModel(model_id=model_id, strict_tools=True)
    request = model.format_request(messages, tool_specs=tool_specs)
    schema = request["toolConfig"]["tools"][0]["toolSpec"]["inputSchema"]["json"]

    assert schema["additionalProperties"] is True


def test_format_request_strict_tools_nested_objects(bedrock_client, model_id, messages):
    tool_specs = [
        {
            "name": "my_tool",
            "description": "A tool",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "config": {
                            "type": "object",
                            "properties": {"value": {"type": "integer"}},
                        }
                    },
                    "required": ["config"],
                }
            },
        }
    ]
    model = BedrockModel(model_id=model_id, strict_tools=True)
    request = model.format_request(messages, tool_specs=tool_specs)
    schema = request["toolConfig"]["tools"][0]["toolSpec"]["inputSchema"]["json"]

    assert schema == {
        "type": "object",
        "properties": {
            "config": {
                "type": "object",
                "properties": {"value": {"type": "integer"}},
                "additionalProperties": False,
            }
        },
        "required": ["config"],
        "additionalProperties": False,
    }


def test_format_request_strict_tools_default_no_strict(bedrock_client, model_id, messages):
    tool_specs = [
        {
            "name": "my_tool",
            "description": "A tool",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {"param": {"type": "string"}},
                    "required": ["param"],
                }
            },
        }
    ]
    model = BedrockModel(model_id=model_id)
    request = model.format_request(messages, tool_specs=tool_specs)
    tool_spec_result = request["toolConfig"]["tools"][0]["toolSpec"]

    assert "strict" not in tool_spec_result
    assert tool_spec_result["inputSchema"]["json"] == {
        "type": "object",
        "properties": {"param": {"type": "string"}},
        "required": ["param"],
    }


def test_format_request_strict_tools_false_no_strict(bedrock_client, model_id, messages):
    tool_specs = [
        {
            "name": "my_tool",
            "description": "A tool",
            "inputSchema": {"json": {"type": "object", "properties": {"x": {"type": "string"}}}},
        }
    ]
    model = BedrockModel(model_id=model_id, strict_tools=False)
    request = model.format_request(messages, tool_specs=tool_specs)
    tool_spec_result = request["toolConfig"]["tools"][0]["toolSpec"]

    assert "strict" not in tool_spec_result


def test_format_request_strict_tools_none_no_strict(bedrock_client, model_id, messages):
    tool_specs = [
        {
            "name": "my_tool",
            "description": "A tool",
            "inputSchema": {"json": {"type": "object", "properties": {"x": {"type": "string"}}}},
        }
    ]
    model = BedrockModel(model_id=model_id, strict_tools=None)
    request = model.format_request(messages, tool_specs=tool_specs)
    tool_spec_result = request["toolConfig"]["tools"][0]["toolSpec"]

    assert "strict" not in tool_spec_result


def test_format_request_strict_tools_applies_to_all_tools(bedrock_client, model_id, messages):
    tool_specs = [
        {"name": "tool_a", "description": "Tool A", "inputSchema": {"json": {"type": "object", "properties": {}}}},
        {"name": "tool_b", "description": "Tool B", "inputSchema": {"json": {"type": "object", "properties": {}}}},
    ]
    model = BedrockModel(model_id=model_id, strict_tools=True)
    request = model.format_request(messages, tool_specs=tool_specs)

    for tool in request["toolConfig"]["tools"]:
        if "toolSpec" in tool:
            assert tool["toolSpec"]["strict"] is True
            assert tool["toolSpec"]["inputSchema"]["json"]["additionalProperties"] is False


def test_format_request_tool_choice_auto(model, messages, model_id, tool_spec):
    tool_choice = {"auto": {}}
    tru_request = model.format_request(messages, [tool_spec], tool_choice=tool_choice)
    exp_request = {
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
        "toolConfig": {
            "tools": [{"toolSpec": tool_spec}],
            "toolChoice": tool_choice,
        },
    }

    assert tru_request == exp_request


def test_format_request_tool_choice_any(model, messages, model_id, tool_spec):
    tool_choice = {"any": {}}
    tru_request = model.format_request(messages, [tool_spec], tool_choice=tool_choice)
    exp_request = {
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
        "toolConfig": {
            "tools": [{"toolSpec": tool_spec}],
            "toolChoice": tool_choice,
        },
    }

    assert tru_request == exp_request


def test_format_request_tool_choice_tool(model, messages, model_id, tool_spec):
    tool_choice = {"tool": {"name": "test_tool"}}
    tru_request = model.format_request(messages, [tool_spec], tool_choice=tool_choice)
    exp_request = {
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
        "toolConfig": {
            "tools": [{"toolSpec": tool_spec}],
            "toolChoice": tool_choice,
        },
    }

    assert tru_request == exp_request


def test_format_request_cache(model, messages, model_id, tool_spec, cache_type):
    model.update_config(cache_prompt=cache_type, cache_tools=cache_type)

    with pytest.warns(UserWarning, match="cache_prompt is deprecated"):
        tru_request = model.format_request(messages, tool_specs=[tool_spec])

    exp_request = {
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [{"cachePoint": {"type": cache_type}}],
        "toolConfig": {
            "tools": [
                {"toolSpec": tool_spec},
                {"cachePoint": {"type": cache_type}},
            ],
            "toolChoice": {"auto": {}},
        },
    }

    assert tru_request == exp_request


@pytest.mark.asyncio
async def test_stream_throttling_exception_from_event_stream_error(bedrock_client, model, messages, alist):
    error_message = "Rate exceeded"
    bedrock_client.converse_stream.side_effect = EventStreamError(
        {"Error": {"Message": error_message, "Code": "ThrottlingException"}}, "ConverseStream"
    )

    with pytest.raises(ModelThrottledException) as excinfo:
        await alist(model.stream(messages))

    assert error_message in str(excinfo.value)
    bedrock_client.converse_stream.assert_called_once_with(
        modelId="m1", messages=messages, system=[], inferenceConfig={}
    )


@pytest.mark.asyncio
async def test_stream_with_invalid_content_throws(bedrock_client, model, alist):
    # We used to hang on None, so ensure we don't regress: https://github.com/strands-agents/harness-sdk/issues/642
    messages = [{"role": "user", "content": None}]

    with pytest.raises(TypeError):
        await alist(model.stream(messages))


@pytest.mark.asyncio
async def test_stream_cancellation_consumes_orphaned_task_exception(bedrock_client, model, messages):
    """Orphaned background task exception is consumed when stream generator is cancelled."""

    def slow_converse_stream(**kwargs):
        time.sleep(0.1)
        raise RuntimeError("simulated boto3 timeout")

    bedrock_client.converse_stream.side_effect = slow_converse_stream

    loop = asyncio.get_running_loop()
    captured: list[dict] = []
    loop.set_exception_handler(lambda _loop, ctx: captured.append(ctx))

    gen = model.stream(messages)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(gen.__anext__(), timeout=0.01)

    await gen.aclose()

    # Allow the background thread to finish and the done-callback to fire
    await asyncio.sleep(0.2)

    assert not captured, f"orphaned task exception was not consumed: {captured}"


@pytest.mark.asyncio
async def test_stream_throttling_exception_from_general_exception(bedrock_client, model, messages, alist):
    error_message = "ThrottlingException: Rate exceeded for ConverseStream"
    bedrock_client.converse_stream.side_effect = ClientError(
        {"Error": {"Message": error_message, "Code": "ThrottlingException"}}, "Any"
    )

    with pytest.raises(ModelThrottledException) as excinfo:
        await alist(model.stream(messages))

    assert error_message in str(excinfo.value)
    bedrock_client.converse_stream.assert_called_once_with(
        modelId="m1", messages=messages, system=[], inferenceConfig={}
    )


@pytest.mark.asyncio
async def test_stream_throttling_exception_lowercase(bedrock_client, model, messages, alist):
    """Test that lowercase throttlingException is converted to ModelThrottledException."""
    error_message = "throttlingException: Rate exceeded for ConverseStream"
    bedrock_client.converse_stream.side_effect = ClientError(
        {"Error": {"Message": error_message, "Code": "throttlingException"}}, "Any"
    )

    with pytest.raises(ModelThrottledException) as excinfo:
        await alist(model.stream(messages))

    assert error_message in str(excinfo.value)
    bedrock_client.converse_stream.assert_called_once_with(
        modelId="m1", messages=messages, system=[], inferenceConfig={}
    )


@pytest.mark.asyncio
async def test_stream_throttling_exception_lowercase_non_streaming(bedrock_client, messages, alist):
    """Test that lowercase throttlingException is converted to ModelThrottledException in non-streaming mode."""
    error_message = "throttlingException: Rate exceeded for Converse"
    bedrock_client.converse.side_effect = ClientError(
        {"Error": {"Message": error_message, "Code": "throttlingException"}}, "Any"
    )

    model = BedrockModel(model_id="test-model", streaming=False)
    with pytest.raises(ModelThrottledException) as excinfo:
        await alist(model.stream(messages))

    assert error_message in str(excinfo.value)
    bedrock_client.converse.assert_called_once()
    bedrock_client.converse_stream.assert_not_called()


@pytest.mark.parametrize("streaming", [True, False])
@pytest.mark.asyncio
async def test_stream_retries_with_separated_tool_result_turns(
    bedrock_client,
    alist,
    streaming,
    tool_result_turn_messages,
    separated_tool_result_turn_messages,
):
    """Tool-result turns are separated when Bedrock reports the incompatibility from issue #1223."""
    validation_error = ClientError(
        {
            "Error": {
                "Code": "ValidationException",
                "Message": (
                    "messages.3.content: "
                    "Conversation blocks and tool result blocks cannot be provided in the same turn."
                ),
            }
        },
        "ConverseStream" if streaming else "Converse",
    )
    response = (
        {"stream": []}
        if streaming
        else {
            "output": {"message": {"role": "assistant", "content": [{"text": "Done"}]}},
            "stopReason": "end_turn",
        }
    )
    converse_method = bedrock_client.converse_stream if streaming else bedrock_client.converse
    converse_method.side_effect = [validation_error, response]
    model = BedrockModel(
        model_id="us.meta.llama4-maverick-17b-instruct-v1:0",
        streaming=streaming,
        use_native_token_count=True,
    )

    await alist(model.stream(tool_result_turn_messages))

    tru_first_messages = converse_method.call_args_list[0].kwargs["messages"]
    assert tru_first_messages == tool_result_turn_messages

    tru_retry_messages = converse_method.call_args_list[1].kwargs["messages"]
    assert tru_retry_messages == separated_tool_result_turn_messages
    assert model._tool_result_turn_separation_model_id == "us.meta.llama4-maverick-17b-instruct-v1:0"


def test_format_request_separates_tool_result_turns_for_remembered_model(
    bedrock_client,
    tool_result_turn_messages,
    separated_tool_result_turn_messages,
):
    """Remembered model formatting separates incompatible user turns."""
    _ = bedrock_client
    model = BedrockModel(model_id="us.meta.llama4-maverick-17b-instruct-v1:0")
    model._tool_result_turn_separation_model_id = "us.meta.llama4-maverick-17b-instruct-v1:0"

    tru_messages = model.format_request(tool_result_turn_messages)["messages"]

    assert tru_messages == separated_tool_result_turn_messages


@pytest.mark.asyncio
async def test_count_tokens_separates_tool_result_turns_for_remembered_model(
    bedrock_client,
    tool_result_turn_messages,
    separated_tool_result_turn_messages,
):
    """Native token counting uses the same separated request as invocation."""
    bedrock_client.count_tokens.return_value = {"inputTokens": 42}
    model = BedrockModel(
        model_id="us.meta.llama4-maverick-17b-instruct-v1:0",
        use_native_token_count=True,
    )
    model._tool_result_turn_separation_model_id = "us.meta.llama4-maverick-17b-instruct-v1:0"

    await model.count_tokens(tool_result_turn_messages)

    tru_messages = bedrock_client.count_tokens.call_args.kwargs["input"]["converse"]["messages"]
    assert tru_messages == separated_tool_result_turn_messages


@pytest.mark.parametrize("streaming", [True, False])
@pytest.mark.asyncio
async def test_stream_uses_separated_tool_result_turns_for_remembered_model(
    bedrock_client,
    alist,
    streaming,
    tool_result_turn_messages,
    separated_tool_result_turn_messages,
):
    """Remembered models skip the failing canonical request."""
    response = (
        {"stream": []}
        if streaming
        else {
            "output": {"message": {"role": "assistant", "content": [{"text": "Done"}]}},
            "stopReason": "end_turn",
        }
    )
    converse_method = bedrock_client.converse_stream if streaming else bedrock_client.converse
    converse_method.return_value = response
    model = BedrockModel(
        model_id="us.meta.llama4-maverick-17b-instruct-v1:0",
        streaming=streaming,
    )
    model._tool_result_turn_separation_model_id = "us.meta.llama4-maverick-17b-instruct-v1:0"

    await alist(model.stream(tool_result_turn_messages))

    converse_method.assert_called_once()
    tru_messages = converse_method.call_args.kwargs["messages"]
    assert tru_messages == separated_tool_result_turn_messages


@pytest.mark.parametrize("streaming", [True, False])
@pytest.mark.asyncio
async def test_stream_does_not_retry_when_tool_result_turns_cannot_be_separated(
    bedrock_client,
    alist,
    streaming,
    messages,
):
    """The targeted validation error is re-raised when no transform applies."""
    validation_error = ClientError(
        {
            "Error": {
                "Code": "ValidationException",
                "Message": (
                    "messages.3.content: "
                    "Conversation blocks and tool result blocks cannot be provided in the same turn."
                ),
            }
        },
        "ConverseStream" if streaming else "Converse",
    )
    converse_method = bedrock_client.converse_stream if streaming else bedrock_client.converse
    converse_method.side_effect = validation_error
    model = BedrockModel(model_id="us.meta.llama4-maverick-17b-instruct-v1:0", streaming=streaming)

    with pytest.raises(ClientError):
        await alist(model.stream(messages))

    converse_method.assert_called_once()


@pytest.mark.parametrize("streaming", [True, False])
@pytest.mark.asyncio
async def test_stream_does_not_remember_separation_when_retry_fails(
    bedrock_client,
    alist,
    streaming,
    tool_result_turn_messages,
):
    """Tool-result separation is remembered only after Bedrock accepts the retry."""
    validation_error = ClientError(
        {
            "Error": {
                "Code": "ValidationException",
                "Message": (
                    "messages.3.content: "
                    "Conversation blocks and tool result blocks cannot be provided in the same turn."
                ),
            }
        },
        "ConverseStream" if streaming else "Converse",
    )
    converse_method = bedrock_client.converse_stream if streaming else bedrock_client.converse
    converse_method.side_effect = [validation_error, validation_error]
    model = BedrockModel(
        model_id="us.meta.llama4-maverick-17b-instruct-v1:0",
        streaming=streaming,
    )

    with pytest.raises(ClientError):
        await alist(model.stream(tool_result_turn_messages))

    assert model._tool_result_turn_separation_model_id is None

    converse_method.reset_mock(side_effect=True)
    converse_method.return_value = (
        {"stream": []}
        if streaming
        else {
            "output": {"message": {"role": "assistant", "content": [{"text": "Done"}]}},
            "stopReason": "end_turn",
        }
    )

    await alist(model.stream(tool_result_turn_messages))

    converse_method.assert_called_once()
    assert converse_method.call_args.kwargs["messages"] == tool_result_turn_messages


def test_separate_tool_result_turns_ignores_conversation_only_user_turns():
    """Adjacent conversation-only user turns do not gain a separator."""
    messages = [
        {"role": "user", "content": [{"text": "First"}]},
        {"role": "user", "content": [{"text": "Second"}]},
    ]

    assert BedrockModel._separate_tool_result_turns(messages) == messages


@pytest.mark.asyncio
async def test_general_exception_is_raised(bedrock_client, model, messages, alist):
    error_message = "Should be raised up"
    bedrock_client.converse_stream.side_effect = ValueError(error_message)

    with pytest.raises(ValueError) as excinfo:
        await alist(model.stream(messages))

    assert error_message in str(excinfo.value)
    bedrock_client.converse_stream.assert_called_once_with(
        modelId="m1", messages=messages, system=[], inferenceConfig={}
    )


@pytest.mark.asyncio
async def test_stream(bedrock_client, model, messages, tool_spec, model_id, additional_request_fields, alist):
    bedrock_client.converse_stream.return_value = {"stream": ["e1", "e2"]}

    request = {
        "additionalModelRequestFields": additional_request_fields,
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
        "toolConfig": {
            "tools": [{"toolSpec": tool_spec}],
            "toolChoice": {"auto": {}},
        },
    }

    model.update_config(additional_request_fields=additional_request_fields)
    response = model.stream(messages, [tool_spec])

    tru_chunks = await alist(response)
    exp_chunks = ["e1", "e2"]

    assert tru_chunks == exp_chunks
    bedrock_client.converse_stream.assert_called_once_with(**request)


@pytest.mark.asyncio
async def test_stream_with_system_prompt_content(bedrock_client, model, messages, alist):
    """Test stream method with system_prompt_content parameter."""
    bedrock_client.converse_stream.return_value = {"stream": ["e1", "e2"]}

    system_prompt_content = [{"text": "You are a helpful assistant."}, {"cachePoint": {"type": "default"}}]

    response = model.stream(messages, system_prompt_content=system_prompt_content)
    tru_chunks = await alist(response)
    exp_chunks = ["e1", "e2"]

    assert tru_chunks == exp_chunks

    # Verify the request was formatted with system_prompt_content
    expected_request = {
        "inferenceConfig": {},
        "modelId": "m1",
        "messages": messages,
        "system": system_prompt_content,
    }
    bedrock_client.converse_stream.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_stream_backwards_compatibility_single_text_block(bedrock_client, model, messages, alist):
    """Test that single text block in system_prompt_content works with legacy system_prompt."""
    bedrock_client.converse_stream.return_value = {"stream": ["e1", "e2"]}

    system_prompt_content = [{"text": "You are a helpful assistant."}]

    response = model.stream(
        messages, system_prompt="You are a helpful assistant.", system_prompt_content=system_prompt_content
    )
    await alist(response)

    # Verify the request was formatted with system_prompt_content
    expected_request = {
        "inferenceConfig": {},
        "modelId": "m1",
        "messages": messages,
        "system": system_prompt_content,
    }
    bedrock_client.converse_stream.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_stream_stream_input_guardrails(
    bedrock_client, model, messages, tool_spec, model_id, additional_request_fields, alist
):
    metadata_event = {
        "metadata": {
            "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
            "metrics": {"latencyMs": 245},
            "trace": {
                "guardrail": {
                    "inputAssessment": {
                        "3e59qlue4hag": {
                            "wordPolicy": {
                                "customWords": [
                                    {
                                        "match": "CACTUS",
                                        "action": "BLOCKED",
                                        "detected": True,
                                    }
                                ]
                            }
                        }
                    }
                }
            },
        }
    }
    bedrock_client.converse_stream.return_value = {"stream": [metadata_event]}

    request = {
        "additionalModelRequestFields": additional_request_fields,
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
        "toolConfig": {
            "tools": [{"toolSpec": tool_spec}],
            "toolChoice": {"auto": {}},
        },
    }

    model.update_config(additional_request_fields=additional_request_fields)
    response = model.stream(messages, [tool_spec])

    tru_chunks = await alist(response)
    exp_chunks = [
        {"redactContent": {"redactUserContentMessage": "[User input redacted.]"}},
        metadata_event,
    ]

    assert tru_chunks == exp_chunks
    bedrock_client.converse_stream.assert_called_once_with(**request)


@pytest.mark.asyncio
async def test_stream_stream_input_guardrails_full_trace(
    bedrock_client, model, messages, tool_spec, model_id, additional_request_fields, alist
):
    """Test guardrails are correctly detected also with guardrail_trace="enabled_full".
    In that case bedrock returns all filters, including those not detected/blocked."""
    metadata_event = {
        "metadata": {
            "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
            "metrics": {"latencyMs": 245},
            "trace": {
                "guardrail": {
                    "inputAssessment": {
                        "jrv9qlue4hag": {
                            "contentPolicy": {
                                "filters": [
                                    {
                                        "action": "NONE",
                                        "confidence": "NONE",
                                        "detected": False,
                                        "filterStrength": "HIGH",
                                        "type": "SEXUAL",
                                    },
                                    {
                                        "action": "BLOCKED",
                                        "confidence": "LOW",
                                        "detected": True,
                                        "filterStrength": "HIGH",
                                        "type": "VIOLENCE",
                                    },
                                    {
                                        "action": "NONE",
                                        "confidence": "NONE",
                                        "detected": False,
                                        "filterStrength": "HIGH",
                                        "type": "HATE",
                                    },
                                    {
                                        "action": "NONE",
                                        "confidence": "NONE",
                                        "detected": False,
                                        "filterStrength": "HIGH",
                                        "type": "INSULTS",
                                    },
                                    {
                                        "action": "NONE",
                                        "confidence": "NONE",
                                        "detected": False,
                                        "filterStrength": "HIGH",
                                        "type": "PROMPT_ATTACK",
                                    },
                                    {
                                        "action": "NONE",
                                        "confidence": "NONE",
                                        "detected": False,
                                        "filterStrength": "HIGH",
                                        "type": "MISCONDUCT",
                                    },
                                ]
                            }
                        }
                    }
                }
            },
        }
    }
    bedrock_client.converse_stream.return_value = {"stream": [metadata_event]}

    request = {
        "additionalModelRequestFields": additional_request_fields,
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
        "toolConfig": {
            "tools": [{"toolSpec": tool_spec}],
            "toolChoice": {"auto": {}},
        },
    }

    model.update_config(additional_request_fields=additional_request_fields)
    response = model.stream(messages, [tool_spec])

    tru_chunks = await alist(response)
    exp_chunks = [
        {"redactContent": {"redactUserContentMessage": "[User input redacted.]"}},
        metadata_event,
    ]

    assert tru_chunks == exp_chunks
    bedrock_client.converse_stream.assert_called_once_with(**request)


@pytest.mark.asyncio
async def test_stream_stream_output_guardrails(
    bedrock_client, model, messages, tool_spec, model_id, additional_request_fields, alist
):
    model.update_config(guardrail_redact_input=False, guardrail_redact_output=True)
    metadata_event = {
        "metadata": {
            "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
            "metrics": {"latencyMs": 245},
            "trace": {
                "guardrail": {
                    "outputAssessments": {
                        "3e59qlue4hag": [
                            {
                                "wordPolicy": {
                                    "customWords": [
                                        {
                                            "match": "CACTUS",
                                            "action": "BLOCKED",
                                            "detected": True,
                                        }
                                    ]
                                },
                            }
                        ]
                    },
                }
            },
        }
    }
    bedrock_client.converse_stream.return_value = {"stream": [metadata_event]}

    request = {
        "additionalModelRequestFields": additional_request_fields,
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
        "toolConfig": {
            "tools": [{"toolSpec": tool_spec}],
            "toolChoice": {"auto": {}},
        },
    }

    model.update_config(additional_request_fields=additional_request_fields)
    response = model.stream(messages, [tool_spec])

    tru_chunks = await alist(response)
    exp_chunks = [
        {"redactContent": {"redactAssistantContentMessage": "[Assistant output redacted.]"}},
        metadata_event,
    ]

    assert tru_chunks == exp_chunks
    bedrock_client.converse_stream.assert_called_once_with(**request)


@pytest.mark.asyncio
async def test_stream_output_guardrails_redacts_input_and_output(
    bedrock_client, model, messages, tool_spec, model_id, additional_request_fields, alist
):
    model.update_config(guardrail_redact_output=True)
    metadata_event = {
        "metadata": {
            "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
            "metrics": {"latencyMs": 245},
            "trace": {
                "guardrail": {
                    "outputAssessments": {
                        "3e59qlue4hag": [
                            {
                                "wordPolicy": {
                                    "customWords": [
                                        {
                                            "match": "CACTUS",
                                            "action": "BLOCKED",
                                            "detected": True,
                                        }
                                    ]
                                },
                            }
                        ]
                    },
                }
            },
        }
    }
    bedrock_client.converse_stream.return_value = {"stream": [metadata_event]}

    request = {
        "additionalModelRequestFields": additional_request_fields,
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
        "toolConfig": {
            "tools": [{"toolSpec": tool_spec}],
            "toolChoice": {"auto": {}},
        },
    }

    model.update_config(additional_request_fields=additional_request_fields)
    response = model.stream(messages, [tool_spec])

    tru_chunks = await alist(response)
    exp_chunks = [
        {"redactContent": {"redactUserContentMessage": "[User input redacted.]"}},
        {"redactContent": {"redactAssistantContentMessage": "[Assistant output redacted.]"}},
        metadata_event,
    ]

    assert tru_chunks == exp_chunks
    bedrock_client.converse_stream.assert_called_once_with(**request)


@pytest.mark.asyncio
async def test_stream_output_no_blocked_guardrails_doesnt_redact(
    bedrock_client, model, messages, tool_spec, model_id, additional_request_fields, alist
):
    metadata_event = {
        "metadata": {
            "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
            "metrics": {"latencyMs": 245},
            "trace": {
                "guardrail": {
                    "outputAssessments": {
                        "3e59qlue4hag": [
                            {
                                "wordPolicy": {
                                    "customWords": [
                                        {
                                            "match": "CACTUS",
                                            "action": "NONE",
                                            "detected": True,
                                        }
                                    ]
                                },
                            }
                        ]
                    },
                }
            },
        }
    }
    bedrock_client.converse_stream.return_value = {"stream": [metadata_event]}

    request = {
        "additionalModelRequestFields": additional_request_fields,
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
        "toolConfig": {
            "tools": [{"toolSpec": tool_spec}],
            "toolChoice": {"auto": {}},
        },
    }

    model.update_config(additional_request_fields=additional_request_fields)
    response = model.stream(messages, [tool_spec])

    tru_chunks = await alist(response)
    exp_chunks = [metadata_event]

    assert tru_chunks == exp_chunks
    bedrock_client.converse_stream.assert_called_once_with(**request)


@pytest.mark.asyncio
async def test_stream_stream_guardrails_redacts_without_trace(
    bedrock_client, model, messages, tool_spec, model_id, additional_request_fields, alist
):
    """Redaction still occurs when guardrail_trace="disabled" returns no assessment.

    Bedrock reports a guardrail_intervened stop reason without a trace, so redaction keys off the
    stop reason. Guards against https://github.com/strands-agents/harness-sdk/issues/3612.
    """
    message_stop_event = {"messageStop": {"stopReason": "guardrail_intervened"}}
    metadata_event = {"metadata": {"usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}}}
    bedrock_client.converse_stream.return_value = {"stream": [message_stop_event, metadata_event]}

    model.update_config(additional_request_fields=additional_request_fields)
    response = model.stream(messages, [tool_spec])

    tru_chunks = await alist(response)
    exp_chunks = [
        message_stop_event,
        {"redactContent": {"redactUserContentMessage": "[User input redacted.]"}},
        metadata_event,
    ]

    assert tru_chunks == exp_chunks


@pytest.mark.asyncio
async def test_stream_guardrails_redacts_without_trace_non_streaming(bedrock_client, alist, messages):
    """Non-streaming redaction keys off the guardrail_intervened stop reason when no trace is returned.

    Guards against https://github.com/strands-agents/harness-sdk/issues/3612.
    """
    bedrock_client.converse.return_value = {
        "output": {"message": {"role": "assistant", "content": [{"text": "test"}]}},
        "stopReason": "guardrail_intervened",
    }

    model = BedrockModel(model_id="test-model", streaming=False)
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockDelta": {"delta": {"text": "test"}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "guardrail_intervened", "additionalModelResponseFields": None}},
        {"redactContent": {"redactUserContentMessage": "[User input redacted.]"}},
    ]

    assert tru_events == exp_events
    bedrock_client.converse.assert_called_once()
    bedrock_client.converse_stream.assert_not_called()


@pytest.mark.asyncio
async def test_stream_guardrails_redacts_exactly_once_across_metadata_events(bedrock_client, model, messages, alist):
    """Redaction fires at most once even when Bedrock emits multiple metadata events.

    Exercises the redaction_emitted guard. Guards against
    https://github.com/strands-agents/harness-sdk/issues/3612.
    """
    message_stop_event = {"messageStop": {"stopReason": "guardrail_intervened"}}
    metadata_event = {"metadata": {"usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}}}
    bedrock_client.converse_stream.return_value = {"stream": [message_stop_event, metadata_event, metadata_event]}

    response = model.stream(messages)

    tru_chunks = await alist(response)
    exp_chunks = [
        message_stop_event,
        {"redactContent": {"redactUserContentMessage": "[User input redacted.]"}},
        metadata_event,
        metadata_event,
    ]

    assert tru_chunks == exp_chunks


@pytest.mark.asyncio
async def test_stream_non_guardrail_stop_reason_doesnt_redact(bedrock_client, model, messages, alist):
    """A non-guardrail_intervened stop reason with no trace must not trigger redaction.

    Guards against https://github.com/strands-agents/harness-sdk/issues/3612.
    """
    message_stop_event = {"messageStop": {"stopReason": "end_turn"}}
    metadata_event = {"metadata": {"usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}}}
    bedrock_client.converse_stream.return_value = {"stream": [message_stop_event, metadata_event]}

    response = model.stream(messages)

    tru_chunks = await alist(response)
    exp_chunks = [message_stop_event, metadata_event]

    assert tru_chunks == exp_chunks


@pytest.mark.asyncio
async def test_stream_guardrails_masked_content_does_not_redact(bedrock_client, model, messages, alist):
    """Bedrock reports guardrail_intervened even when a policy only ANONYMIZED (masked) content.

    The SDK must preserve the masked message rather than replacing it with the redaction placeholder,
    since Bedrock has already substituted the sensitive spans in place.
    """
    message_stop_event = {"messageStop": {"stopReason": "guardrail_intervened"}}
    metadata_event = {
        "metadata": {
            "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
            "trace": {
                "guardrail": {
                    "outputAssessments": {
                        "8oi5sp73w4ca": [
                            {
                                "sensitiveInformationPolicy": {
                                    "regexes": [
                                        {
                                            "action": "ANONYMIZED",
                                            "detected": True,
                                            "match": "Hello",
                                            "name": "BLOCKING_HELLO",
                                            "regex": "Hello",
                                        }
                                    ]
                                },
                            }
                        ]
                    },
                }
            },
        }
    }
    bedrock_client.converse_stream.return_value = {"stream": [message_stop_event, metadata_event]}

    response = model.stream(messages)

    tru_chunks = await alist(response)
    exp_chunks = [message_stop_event, metadata_event]

    assert tru_chunks == exp_chunks


@pytest.mark.asyncio
async def test_stream_guardrails_masked_content_does_not_redact_non_streaming(bedrock_client, alist, messages):
    """Non-streaming: guardrail_intervened + ANONYMIZED-only trace must not trigger redaction."""
    bedrock_client.converse.return_value = {
        "output": {"message": {"role": "assistant", "content": [{"text": "{BLOCKING_HELLO}! 👋"}]}},
        "stopReason": "guardrail_intervened",
        "trace": {
            "guardrail": {
                "outputAssessments": {
                    "8oi5sp73w4ca": [
                        {
                            "sensitiveInformationPolicy": {
                                "regexes": [
                                    {
                                        "action": "ANONYMIZED",
                                        "detected": True,
                                        "match": "Hello",
                                        "name": "BLOCKING_HELLO",
                                        "regex": "Hello",
                                    }
                                ]
                            },
                        }
                    ]
                }
            }
        },
    }

    model = BedrockModel(model_id="test-model", streaming=False)
    response = model.stream(messages)

    tru_events = await alist(response)
    assert not any("redactContent" in event for event in tru_events)


@pytest.mark.asyncio
async def test_stream_output_no_guardrail_redact(
    bedrock_client, model, messages, tool_spec, model_id, additional_request_fields, alist
):
    metadata_event = {
        "metadata": {
            "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
            "metrics": {"latencyMs": 245},
            "trace": {
                "guardrail": {
                    "outputAssessments": {
                        "3e59qlue4hag": [
                            {
                                "wordPolicy": {
                                    "customWords": [
                                        {
                                            "match": "CACTUS",
                                            "action": "BLOCKED",
                                            "detected": True,
                                        }
                                    ]
                                },
                            }
                        ]
                    },
                }
            },
        }
    }
    bedrock_client.converse_stream.return_value = {"stream": [metadata_event]}

    request = {
        "additionalModelRequestFields": additional_request_fields,
        "inferenceConfig": {},
        "modelId": model_id,
        "messages": messages,
        "system": [],
        "toolConfig": {
            "tools": [{"toolSpec": tool_spec}],
            "toolChoice": {"auto": {}},
        },
    }

    model.update_config(
        additional_request_fields=additional_request_fields,
        guardrail_redact_output=False,
        guardrail_redact_input=False,
    )
    response = model.stream(messages, [tool_spec])

    tru_chunks = await alist(response)
    exp_chunks = [metadata_event]

    assert tru_chunks == exp_chunks
    bedrock_client.converse_stream.assert_called_once_with(**request)


@pytest.mark.asyncio
async def test_stream_with_streaming_false(bedrock_client, alist, messages):
    """Test stream method with streaming=False."""
    bedrock_client.converse.return_value = {
        "output": {"message": {"role": "assistant", "content": [{"text": "test"}]}},
        "stopReason": "end_turn",
    }

    # Create model and call stream
    model = BedrockModel(model_id="test-model", streaming=False)
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockDelta": {"delta": {"text": "test"}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn", "additionalModelResponseFields": None}},
    ]
    assert tru_events == exp_events

    bedrock_client.converse.assert_called_once()
    bedrock_client.converse_stream.assert_not_called()


@pytest.mark.asyncio
async def test_stream_with_streaming_false_and_tool_use(bedrock_client, alist, messages):
    """Test stream method with streaming=False."""
    bedrock_client.converse.return_value = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "123", "name": "dummyTool", "input": {"hello": "world!"}}}],
            }
        },
        "stopReason": "tool_use",
    }

    # Create model and call stream
    model = BedrockModel(model_id="test-model", streaming=False)
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "123", "name": "dummyTool"}}}},
        {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"hello": "world!"}'}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use", "additionalModelResponseFields": None}},
    ]
    assert tru_events == exp_events

    bedrock_client.converse.assert_called_once()
    bedrock_client.converse_stream.assert_not_called()


@pytest.mark.asyncio
async def test_stream_with_streaming_false_and_reasoning(bedrock_client, alist, messages):
    """Test stream method with streaming=False."""
    bedrock_client.converse.return_value = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "reasoningContent": {
                            "reasoningText": {"text": "Thinking really hard....", "signature": "123"},
                        }
                    }
                ],
            }
        },
        "stopReason": "tool_use",
    }

    # Create model and call stream
    model = BedrockModel(model_id="test-model", streaming=False)
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "Thinking really hard...."}}}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"signature": "123"}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use", "additionalModelResponseFields": None}},
    ]
    assert tru_events == exp_events

    # Verify converse was called
    bedrock_client.converse.assert_called_once()
    bedrock_client.converse_stream.assert_not_called()


@pytest.mark.asyncio
async def test_stream_and_reasoning_no_signature(bedrock_client, alist, messages):
    """Test stream method with streaming=False."""
    bedrock_client.converse.return_value = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "reasoningContent": {
                            "reasoningText": {"text": "Thinking really hard...."},
                        }
                    }
                ],
            }
        },
        "stopReason": "tool_use",
    }

    # Create model and call stream
    model = BedrockModel(model_id="test-model", streaming=False)
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "Thinking really hard...."}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use", "additionalModelResponseFields": None}},
    ]
    assert tru_events == exp_events

    bedrock_client.converse.assert_called_once()
    bedrock_client.converse_stream.assert_not_called()


@pytest.mark.asyncio
async def test_stream_with_streaming_false_with_metrics_and_usage(bedrock_client, alist, messages):
    """Test stream method with streaming=False."""
    bedrock_client.converse.return_value = {
        "output": {"message": {"role": "assistant", "content": [{"text": "test"}]}},
        "usage": {"inputTokens": 1234, "outputTokens": 1234, "totalTokens": 2468},
        "metrics": {"latencyMs": 1234},
        "stopReason": "tool_use",
    }

    # Create model and call stream
    model = BedrockModel(model_id="test-model", streaming=False)
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockDelta": {"delta": {"text": "test"}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use", "additionalModelResponseFields": None}},
        {
            "metadata": {
                "usage": {"inputTokens": 1234, "outputTokens": 1234, "totalTokens": 2468},
                "metrics": {"latencyMs": 1234},
            }
        },
    ]
    assert tru_events == exp_events

    # Verify converse was called
    bedrock_client.converse.assert_called_once()
    bedrock_client.converse_stream.assert_not_called()


@pytest.mark.asyncio
async def test_stream_input_guardrails(bedrock_client, alist, messages):
    """Test stream method with streaming=False."""
    bedrock_client.converse.return_value = {
        "output": {"message": {"role": "assistant", "content": [{"text": "test"}]}},
        "trace": {
            "guardrail": {
                "inputAssessment": {
                    "3e59qlue4hag": {
                        "wordPolicy": {"customWords": [{"match": "CACTUS", "action": "BLOCKED", "detected": True}]}
                    }
                }
            }
        },
        "stopReason": "end_turn",
    }

    # Create model and call stream
    model = BedrockModel(model_id="test-model", streaming=False)
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockDelta": {"delta": {"text": "test"}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn", "additionalModelResponseFields": None}},
        {
            "metadata": {
                "trace": {
                    "guardrail": {
                        "inputAssessment": {
                            "3e59qlue4hag": {
                                "wordPolicy": {
                                    "customWords": [{"match": "CACTUS", "action": "BLOCKED", "detected": True}]
                                }
                            }
                        }
                    }
                }
            }
        },
        {"redactContent": {"redactUserContentMessage": "[User input redacted.]"}},
    ]
    assert tru_events == exp_events

    bedrock_client.converse.assert_called_once()
    bedrock_client.converse_stream.assert_not_called()


@pytest.mark.asyncio
async def test_stream_output_guardrails(bedrock_client, alist, messages):
    """Test stream method with streaming=False."""
    bedrock_client.converse.return_value = {
        "output": {"message": {"role": "assistant", "content": [{"text": "test"}]}},
        "trace": {
            "guardrail": {
                "outputAssessments": {
                    "3e59qlue4hag": [
                        {
                            "wordPolicy": {"customWords": [{"match": "CACTUS", "action": "BLOCKED", "detected": True}]},
                        }
                    ]
                },
            }
        },
        "stopReason": "end_turn",
    }

    model = BedrockModel(model_id="test-model", streaming=False)
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockDelta": {"delta": {"text": "test"}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn", "additionalModelResponseFields": None}},
        {
            "metadata": {
                "trace": {
                    "guardrail": {
                        "outputAssessments": {
                            "3e59qlue4hag": [
                                {
                                    "wordPolicy": {
                                        "customWords": [{"match": "CACTUS", "action": "BLOCKED", "detected": True}]
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        },
        {"redactContent": {"redactUserContentMessage": "[User input redacted.]"}},
    ]
    assert tru_events == exp_events

    bedrock_client.converse.assert_called_once()
    bedrock_client.converse_stream.assert_not_called()


@pytest.mark.asyncio
async def test_stream_output_guardrails_redacts_output(bedrock_client, alist, messages):
    """Test stream method with streaming=False."""
    bedrock_client.converse.return_value = {
        "output": {"message": {"role": "assistant", "content": [{"text": "test"}]}},
        "trace": {
            "guardrail": {
                "outputAssessments": {
                    "3e59qlue4hag": [
                        {
                            "wordPolicy": {"customWords": [{"match": "CACTUS", "action": "BLOCKED", "detected": True}]},
                        }
                    ]
                },
            }
        },
        "stopReason": "end_turn",
    }

    model = BedrockModel(model_id="test-model", streaming=False)
    response = model.stream(messages)

    tru_events = await alist(response)
    exp_events = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockDelta": {"delta": {"text": "test"}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn", "additionalModelResponseFields": None}},
        {
            "metadata": {
                "trace": {
                    "guardrail": {
                        "outputAssessments": {
                            "3e59qlue4hag": [
                                {
                                    "wordPolicy": {
                                        "customWords": [{"match": "CACTUS", "action": "BLOCKED", "detected": True}]
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        },
        {"redactContent": {"redactUserContentMessage": "[User input redacted.]"}},
    ]
    assert tru_events == exp_events

    bedrock_client.converse.assert_called_once()
    bedrock_client.converse_stream.assert_not_called()


@pytest.mark.asyncio
async def test_structured_output(bedrock_client, model, test_output_model_cls, alist):
    messages = [{"role": "user", "content": [{"text": "Generate a person"}]}]

    bedrock_client.converse_stream.return_value = {
        "stream": [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "123", "name": "TestOutputModel"}}}},
            {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"name": "John", "age": 30}'}}}},
            {"contentBlockStop": {}},
            {"messageStop": {"stopReason": "tool_use"}},
        ]
    }

    stream = model.structured_output(test_output_model_cls, messages)
    events = await alist(stream)

    tru_output = events[-1]
    exp_output = {"output": test_output_model_cls(name="John", age=30)}
    assert tru_output == exp_output


@pytest.mark.skipif(sys.version_info < (3, 11), reason="This test requires Python 3.11 or higher (need add_note)")
@pytest.mark.asyncio
async def test_add_note_on_client_error(bedrock_client, model, alist, messages):
    """Test that add_note is called on ClientError with region and model ID information."""
    # Mock the client error response
    error_response = {"Error": {"Code": "ValidationException", "Message": "Some error message"}}
    bedrock_client.converse_stream.side_effect = ClientError(error_response, "ConversationStream")

    # Call the stream method which should catch and add notes to the exception
    with pytest.raises(ClientError) as err:
        await alist(model.stream(messages))

    assert err.value.__notes__ == ["└ Bedrock region: us-west-2", "└ Model id: m1"]


@pytest.mark.asyncio
async def test_add_note_on_client_error_without_add_notes(bedrock_client, model, alist, messages):
    """Test that when add_note is not used, the region & model are still included in the error output."""
    with unittest.mock.patch.object(_exception_notes, "supports_add_note", False):
        # Mock the client error response
        error_response = {"Error": {"Code": "ValidationException", "Message": "Some error message"}}
        bedrock_client.converse_stream.side_effect = ClientError(error_response, "ConversationStream")

        # Call the stream method which should catch and add notes to the exception
        with pytest.raises(ClientError) as err:
            await alist(model.stream(messages))

    error_str = "".join(traceback.format_exception(err.value))
    assert "└ Bedrock region: us-west-2" in error_str
    assert "└ Model id: m1" in error_str


@pytest.mark.asyncio
async def test_no_add_note_when_not_available(bedrock_client, model, alist, messages):
    """Verify that on any python version (even < 3.11 where add_note is not available, we get the right exception)."""
    # Mock the client error response
    error_response = {"Error": {"Code": "ValidationException", "Message": "Some error message"}}
    bedrock_client.converse_stream.side_effect = ClientError(error_response, "ConversationStream")

    # Call the stream method which should catch and add notes to the exception
    with pytest.raises(ClientError):
        await alist(model.stream(messages))


@pytest.mark.skipif(sys.version_info < (3, 11), reason="This test requires Python 3.11 or higher (need add_note)")
@pytest.mark.asyncio
async def test_add_note_on_access_denied_exception(bedrock_client, model, alist, messages):
    """Test that add_note adds documentation link for AccessDeniedException."""
    # Mock the client error response for access denied
    error_response = {
        "Error": {
            "Code": "AccessDeniedException",
            "Message": "An error occurred (AccessDeniedException) when calling the ConverseStream operation: "
            "You don't have access to the model with the specified model ID.",
        }
    }
    bedrock_client.converse_stream.side_effect = ClientError(error_response, "ConversationStream")

    # Call the stream method which should catch and add notes to the exception
    with pytest.raises(ClientError) as err:
        await alist(model.stream(messages))

    assert err.value.__notes__ == [
        "└ Bedrock region: us-west-2",
        "└ Model id: m1",
        "└ For more information see "
        "https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/#required-iam-permissions",
    ]


@pytest.mark.skipif(sys.version_info < (3, 11), reason="This test requires Python 3.11 or higher (need add_note)")
@pytest.mark.asyncio
async def test_add_note_on_validation_exception_identifier(bedrock_client, model, alist, messages):
    """Test that add_note adds documentation link for ValidationException about invalid model identifier."""
    # Mock the client error response for invalid model identifier
    error_response = {
        "Error": {
            "Code": "ValidationException",
            "Message": "An error occurred (ValidationException) when calling the ConverseStream operation: "
            "The provided model identifier is invalid.",
        }
    }
    bedrock_client.converse_stream.side_effect = ClientError(error_response, "ConversationStream")

    # Call the stream method which should catch and add notes to the exception
    with pytest.raises(ClientError) as err:
        await alist(model.stream(messages))

    assert err.value.__notes__ == [
        "└ Bedrock region: us-west-2",
        "└ Model id: m1",
        "└ For more information see "
        "https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/#model-identifier-is-invalid",
    ]


@pytest.mark.skipif(sys.version_info < (3, 11), reason="This test requires Python 3.11 or higher (need add_note)")
@pytest.mark.asyncio
async def test_add_note_on_validation_exception_throughput(bedrock_client, model, alist, messages):
    """Test that add_note adds documentation link for ValidationException about on-demand throughput."""
    # Mock the client error response for validation exception
    error_response = {
        "Error": {
            "Code": "ValidationException",
            "Message": "An error occurred (ValidationException) when calling the ConverseStream operation: "
            "Invocation of model ID anthropic.claude-3-7-sonnet-20250219-v1:0 with on-demand throughput "
            "isn’t supported. Retry your request with the ID or ARN of an inference profile that contains "
            "this model.",
        }
    }
    bedrock_client.converse_stream.side_effect = ClientError(error_response, "ConversationStream")

    # Call the stream method which should catch and add notes to the exception
    with pytest.raises(ClientError) as err:
        await alist(model.stream(messages))

    assert err.value.__notes__ == [
        "└ Bedrock region: us-west-2",
        "└ Model id: m1",
        "└ For more information see "
        "https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/#on-demand-throughput-isnt-supported",
    ]


@pytest.mark.parametrize(
    "overflow_message",
    [
        "Input is too long for requested model",
        "input length and `max_tokens` exceed context limit",
        "too many total text bytes",
        "prompt is too long: 903884 tokens > 200000 maximum",
        "This model's maximum context length is 202752 tokens.",
    ],
)
@pytest.mark.asyncio
async def test_stream_context_window_overflow(overflow_message, bedrock_client, model, alist, messages):
    """Test that ClientError with overflow messages raises ContextWindowOverflowException."""
    error_response = {
        "Error": {
            "Code": "ValidationException",
            "Message": f"An error occurred (ValidationException) when calling the ConverseStream operation: "
            f"The model returned the following errors: {overflow_message}",
        }
    }
    bedrock_client.converse_stream.side_effect = ClientError(error_response, "ConverseStream")

    with pytest.raises(ContextWindowOverflowException):
        await alist(model.stream(messages))


@pytest.mark.asyncio
async def test_stream_logging(bedrock_client, model, messages, caplog, alist):
    """Test that stream method logs debug messages at the expected stages."""

    # Set the logger to debug level to capture debug messages
    caplog.set_level(logging.DEBUG, logger="strands.models.bedrock")

    # Mock the response
    bedrock_client.converse_stream.return_value = {"stream": ["e1", "e2"]}

    # Execute the stream method
    response = model.stream(messages)
    await alist(response)

    # Check that the expected log messages are present
    log_text = caplog.text
    assert "formatting request" in log_text
    assert "request=<" in log_text
    assert "invoking model" in log_text
    assert "got response from model" in log_text
    assert "finished streaming response from model" in log_text


def test_format_request_cleans_tool_result_content_blocks(model, model_id):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "content": [{"text": "Tool output"}],
                        "toolUseId": "tool123",
                        "status": "success",
                        "extraField": "should be removed",
                        "mcpMetadata": {"server": "test"},
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)

    tool_result = formatted_request["messages"][0]["content"][0]["toolResult"]
    expected = {"toolUseId": "tool123", "content": [{"text": "Tool output"}]}
    assert tool_result == expected
    assert "extraField" not in tool_result
    assert "mcpMetadata" not in tool_result
    assert "status" not in tool_result


def test_format_request_message_content_normalizes_empty_tool_result_content(model, model_id):
    """Test that _format_request_message_content replaces empty toolResult content with a minimal text block.

    Some model providers (e.g., Nemotron) reject toolResult blocks with content: [] via the
    Converse API, while others (e.g., Claude) accept them. The SDK should normalize empty
    content arrays to ensure cross-model compatibility.

    See: https://github.com/strands-agents/harness-sdk/issues/2122
    """
    messages = [
        {"role": "user", "content": [{"text": "List tables"}]},
        {
            "role": "assistant",
            "content": [
                {"text": "Querying...\n"},
                {"toolUse": {"toolUseId": "tool_001", "name": "run_query", "input": {"sql": "SELECT 1"}}},
            ],
        },
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "tool_001", "content": []}},
            ],
        },
    ]

    formatted_request = model.format_request(messages)

    tool_result = formatted_request["messages"][2]["content"][0]["toolResult"]
    assert tool_result["content"] == [{"text": ""}], "Empty toolResult content should be normalized to [{'text': ''}]"


def test_format_request_message_content_does_not_mutate_empty_tool_result(model, model_id):
    """Test that normalizing empty toolResult content does not mutate the original messages."""
    messages = [
        {"role": "user", "content": [{"text": "List tables"}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "tool_001", "name": "run_query", "input": {"sql": "SELECT 1"}}},
            ],
        },
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "tool_001", "content": []}},
            ],
        },
    ]

    original_content = messages[2]["content"][0]["toolResult"]["content"]
    model.format_request(messages)

    assert original_content == [], "Original empty content list should not be mutated"


def test_format_request_message_content_empty_block_raises_type_error(model, model_id):
    messages = [{"role": "user", "content": [{}]}]

    with pytest.raises(TypeError, match="content_type=<None> \\| unsupported type"):
        model._format_bedrock_messages(messages)


def test_format_request_message_content_preserves_nonempty_tool_result_content(model, model_id):
    """Test that _format_request_message_content does not modify non-empty toolResult content."""
    messages = [
        {"role": "user", "content": [{"text": "List tables"}]},
        {
            "role": "assistant",
            "content": [
                {"text": "Querying...\n"},
                {"toolUse": {"toolUseId": "tool_001", "name": "run_query", "input": {"sql": "SELECT 1"}}},
            ],
        },
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "tool_001", "content": [{"text": "some result"}]}},
            ],
        },
    ]

    formatted_request = model.format_request(messages)

    tool_result = formatted_request["messages"][2]["content"][0]["toolResult"]
    assert tool_result["content"] == [{"text": "some result"}]


def test_format_request_message_content_guard_content_without_qualifiers(model, model_id):
    """Test that _format_request_message_content accepts guardContent text blocks without qualifiers.

    The Bedrock GuardrailConverseTextBlock treats qualifiers as optional, so omitting it
    should not raise a KeyError.

    See: https://github.com/strands-agents/harness-sdk/issues/959
    """
    content = {"guardContent": {"text": {"text": "evaluate me"}}}

    formatted = model._format_request_message_content(content)

    assert formatted == {"guardContent": {"text": {"text": "evaluate me"}}}


def test_format_request_message_content_guard_content_with_qualifiers(model, model_id):
    """Test that _format_request_message_content forwards qualifiers when supplied."""
    content = {"guardContent": {"text": {"text": "evaluate me", "qualifiers": ["guard_content"]}}}

    formatted = model._format_request_message_content(content)

    assert formatted == {"guardContent": {"text": {"text": "evaluate me", "qualifiers": ["guard_content"]}}}


def test_format_request_removes_status_field_when_configured(model, model_id):
    model.update_config(include_tool_result_status=False)

    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "content": [{"text": "Tool output"}],
                        "toolUseId": "tool123",
                        "status": "success",
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)

    tool_result = formatted_request["messages"][0]["content"][0]["toolResult"]
    expected = {"toolUseId": "tool123", "content": [{"text": "Tool output"}]}
    assert tool_result == expected
    assert "status" not in tool_result


def test_auto_behavior_anthropic_vs_non_anthropic(bedrock_client):
    model_anthropic = BedrockModel(model_id="us.anthropic.claude-sonnet-4-20250514-v1:0")
    assert model_anthropic.get_config()["include_tool_result_status"] == "auto"

    model_non_anthropic = BedrockModel(model_id="amazon.titan-text-v1")
    assert model_non_anthropic.get_config()["include_tool_result_status"] == "auto"


def test_explicit_boolean_values_preserved(bedrock_client):
    model = BedrockModel(model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", include_tool_result_status=True)
    assert model.get_config()["include_tool_result_status"] is True

    model2 = BedrockModel(model_id="amazon.titan-text-v1", include_tool_result_status=False)
    assert model2.get_config()["include_tool_result_status"] is False
    """Test that format_request keeps status field by default for anthropic.claude models."""
    # Default model is anthropic.claude, so should keep status
    model = BedrockModel()

    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "content": [{"text": "Tool output"}],
                        "toolUseId": "tool123",
                        "status": "success",
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)

    # Verify toolResult contains status field by default
    tool_result = formatted_request["messages"][0]["content"][0]["toolResult"]
    expected = {"content": [{"text": "Tool output"}], "toolUseId": "tool123", "status": "success"}
    assert tool_result == expected
    assert "status" in tool_result


def test_format_request_filters_sdk_unknown_member_content_blocks(model, model_id, caplog):
    """Test that format_request filters out SDK_UNKNOWN_MEMBER content blocks."""
    messages = [
        {
            "role": "assistant",
            "content": [
                {"text": "Hello"},
                {"SDK_UNKNOWN_MEMBER": {"name": "reasoningContent"}},
                {"text": "World"},
            ],
        }
    ]

    formatted_request = model.format_request(messages)

    content = formatted_request["messages"][0]["content"]
    assert len(content) == 2
    assert content[0] == {"text": "Hello"}
    assert content[1] == {"text": "World"}

    for block in content:
        assert "SDK_UNKNOWN_MEMBER" not in block


@pytest.mark.asyncio
async def test_stream_deepseek_filters_reasoning_content(bedrock_client, alist):
    """Test that DeepSeek models filter reasoningContent from messages during streaming."""
    model = BedrockModel(model_id="us.deepseek.r1-v1:0")

    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {
            "role": "assistant",
            "content": [
                {"text": "Response"},
                {"reasoningContent": {"reasoningText": {"text": "Thinking..."}}},
            ],
        },
    ]

    bedrock_client.converse_stream.return_value = {"stream": []}

    await alist(model.stream(messages))

    # Verify the request was made with filtered messages (no reasoningContent)
    call_args = bedrock_client.converse_stream.call_args[1]
    sent_messages = call_args["messages"]

    assert len(sent_messages) == 2
    assert sent_messages[0]["content"] == [{"text": "Hello"}]
    assert sent_messages[1]["content"] == [{"text": "Response"}]


@pytest.mark.asyncio
async def test_stream_deepseek_skips_empty_messages(bedrock_client, alist):
    """Test that DeepSeek models skip messages that would be empty after filtering reasoningContent."""
    model = BedrockModel(model_id="us.deepseek.r1-v1:0")

    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"reasoningContent": {"reasoningText": {"text": "Only reasoning..."}}}]},
        {"role": "user", "content": [{"text": "Follow up"}]},
    ]

    bedrock_client.converse_stream.return_value = {"stream": []}

    await alist(model.stream(messages))

    # Verify the request was made with only non-empty messages
    call_args = bedrock_client.converse_stream.call_args[1]
    sent_messages = call_args["messages"]

    assert len(sent_messages) == 2
    assert sent_messages[0]["content"] == [{"text": "Hello"}]
    assert sent_messages[1]["content"] == [{"text": "Follow up"}]


def test_format_request_filters_image_content_blocks(model, model_id):
    """Test that format_request filters extra fields from image content blocks."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "image": {
                        "format": "png",
                        "source": {"bytes": b"image_data"},
                        "filename": "test.png",  # Extra field that should be filtered
                        "metadata": {"size": 1024},  # Extra field that should be filtered
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)

    image_block = formatted_request["messages"][0]["content"][0]["image"]
    expected = {"format": "png", "source": {"bytes": b"image_data"}}
    assert image_block == expected
    assert "filename" not in image_block
    assert "metadata" not in image_block


def test_format_request_image_s3_location_only(model, model_id):
    """Test that image with only s3Location is properly formatted."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "image": {
                        "format": "png",
                        "source": {
                            "location": {"type": "s3", "uri": "s3://my-bucket/image.png"},
                        },
                    }
                }
            ],
        }
    ]

    formatted_request = model.format_request(messages)
    image_source = formatted_request["messages"][0]["content"][0]["image"]["source"]

    assert image_source == {"s3Location": {"uri": "s3://my-bucket/image.png"}}


def test_format_request_image_bytes_only(model, model_id):
    """Test that image with only bytes source is properly formatted."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "image": {
                        "format": "png",
                        "source": {"bytes": b"image_data"},
                    }
                }
            ],
        }
    ]

    formatted_request = model.format_request(messages)
    image_source = formatted_request["messages"][0]["content"][0]["image"]["source"]

    assert image_source == {"bytes": b"image_data"}


def test_format_request_audio_bytes_only(model, model_id):
    """Test that inline audio bytes are properly formatted."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "audio": {
                        "format": "wav",
                        "source": {"bytes": b"audio_data"},
                    }
                }
            ],
        }
    ]

    formatted_request = model.format_request(messages)
    audio_block = formatted_request["messages"][0]["content"][0]["audio"]

    assert audio_block == {"format": "wav", "source": {"bytes": b"audio_data"}}


def test_format_request_audio_s3_location(model, model_id):
    """Test that an S3-backed audio block is properly formatted."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "audio": {
                        "format": "wav",
                        "source": {
                            "location": {
                                "type": "s3",
                                "uri": "s3://my-bucket/audio.wav",
                                "bucketOwner": "123456789012",
                            }
                        },
                    }
                }
            ],
        }
    ]

    formatted_request = model.format_request(messages)
    audio_block = formatted_request["messages"][0]["content"][0]["audio"]

    assert audio_block == {
        "format": "wav",
        "source": {
            "s3Location": {
                "uri": "s3://my-bucket/audio.wav",
                "bucketOwner": "123456789012",
            }
        },
    }


def test_format_request_document_s3_location(model, model_id):
    """Test that document with s3Location is properly formatted."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "document": {
                        "name": "report.pdf",
                        "format": "pdf",
                        "source": {
                            "location": {"type": "s3", "uri": "s3://my-bucket/report.pdf"},
                        },
                    }
                },
                {
                    "document": {
                        "name": "report.pdf",
                        "format": "pdf",
                        "source": {
                            "location": {
                                "type": "s3",
                                "uri": "s3://my-bucket/report.pdf",
                                "bucketOwner": "123456789012",
                            },
                        },
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)
    document = formatted_request["messages"][0]["content"][0]["document"]
    document_with_bucket_owner = formatted_request["messages"][0]["content"][1]["document"]

    assert document["source"] == {"s3Location": {"uri": "s3://my-bucket/report.pdf"}}

    assert document_with_bucket_owner["source"] == {
        "s3Location": {"uri": "s3://my-bucket/report.pdf", "bucketOwner": "123456789012"}
    }


def test_format_request_unsupported_location(model, caplog):
    """Test that document with s3Location is properly formatted."""

    caplog.set_level(logging.WARNING, logger="strands.models.bedrock")

    messages = [
        {
            "role": "user",
            "content": [
                {"text": "Hello!"},
                {
                    "document": {
                        "name": "report.pdf",
                        "format": "pdf",
                        "source": {
                            "location": {
                                "type": "other",
                            },
                        },
                    }
                },
                {
                    "video": {
                        "format": "mp4",
                        "source": {
                            "location": {
                                "type": "other",
                            },
                        },
                    }
                },
                {
                    "image": {
                        "format": "png",
                        "source": {
                            "location": {
                                "type": "other",
                            },
                        },
                    }
                },
                {
                    "audio": {
                        "format": "wav",
                        "source": {
                            "location": {
                                "type": "other",
                            },
                        },
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)
    assert len(formatted_request["messages"][0]["content"]) == 1
    assert "Non s3 location sources are not supported by Bedrock | skipping content block" in caplog.text


def test_format_request_video_s3_location(model, model_id):
    """Test that video with s3Location is properly formatted."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "video": {
                        "format": "mp4",
                        "source": {
                            "location": {"type": "s3", "uri": "s3://my-bucket/video.mp4"},
                        },
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)
    video_source = formatted_request["messages"][0]["content"][0]["video"]["source"]

    assert video_source == {"s3Location": {"uri": "s3://my-bucket/video.mp4"}}


@pytest.mark.parametrize("video_format", ["3gp", "3g2", "3gpp"])
def test_format_request_maps_3gp_video_formats(model, model_id, video_format):
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "video": {
                        "format": video_format,
                        "source": {"bytes": b"video_data"},
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)

    video_block = formatted_request["messages"][0]["content"][0]["video"]
    assert video_block == {"format": "three_gp", "source": {"bytes": b"video_data"}}


def test_format_request_filters_document_content_blocks(model, model_id):
    """Test that format_request filters extra fields from document content blocks."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "document": {
                        "name": "test.pdf",
                        "source": {"bytes": b"pdf_data"},
                        "format": "pdf",
                        "extraField": "should be removed",
                        "metadata": {"pages": 10},
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)

    document_block = formatted_request["messages"][0]["content"][0]["document"]
    expected = {"name": "test.pdf", "source": {"bytes": b"pdf_data"}, "format": "pdf"}
    assert document_block == expected
    assert "extraField" not in document_block
    assert "metadata" not in document_block


def test_format_request_filters_nested_reasoning_content(model, model_id):
    """Test deep filtering of nested reasoningText fields."""
    messages = [
        {
            "role": "assistant",
            "content": [
                {
                    "reasoningContent": {
                        "reasoningText": {"text": "thinking...", "signature": "abc123", "extraField": "filtered"}
                    }
                }
            ],
        }
    ]

    formatted_request = model.format_request(messages)
    reasoning_text = formatted_request["messages"][0]["content"][0]["reasoningContent"]["reasoningText"]

    assert reasoning_text == {"text": "thinking...", "signature": "abc123"}


def test_format_request_filters_video_content_blocks(model, model_id):
    """Test that format_request filters extra fields from video content blocks."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "video": {
                        "format": "mp4",
                        "source": {"bytes": b"video_data"},
                        "duration": 120,  # Extra field that should be filtered
                        "resolution": "1080p",  # Extra field that should be filtered
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)

    video_block = formatted_request["messages"][0]["content"][0]["video"]
    expected = {"format": "mp4", "source": {"bytes": b"video_data"}}
    assert video_block == expected
    assert "duration" not in video_block
    assert "resolution" not in video_block


def test_format_request_filters_cache_point_content_blocks(model, model_id):
    """Test that format_request filters extra fields from cachePoint content blocks."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "cachePoint": {
                        "type": "default",
                        "extraField": "should be removed",
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)

    cache_point_block = formatted_request["messages"][0]["content"][0]["cachePoint"]
    expected = {"type": "default"}
    assert cache_point_block == expected
    assert "extraField" not in cache_point_block


def test_format_request_preserves_cache_point_ttl(model, model_id):
    """Test that format_request preserves the ttl field in cachePoint content blocks."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "cachePoint": {
                        "type": "default",
                        "ttl": "1h",
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)

    cache_point_block = formatted_request["messages"][0]["content"][0]["cachePoint"]
    expected = {"type": "default", "ttl": "1h"}
    assert cache_point_block == expected
    assert cache_point_block["ttl"] == "1h"


# https://github.com/strands-agents/harness-sdk/issues/3759
@pytest.mark.parametrize("ttl", [None, ""])
def test_format_request_omits_falsy_cache_point_ttl(model, ttl):
    """Falsy caller TTLs are omitted before Bedrock validates the request."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "cachePoint": {
                        "type": "default",
                        "ttl": ttl,
                    }
                },
            ],
        }
    ]

    tru_cache_point = model.format_request(messages)["messages"][0]["content"][0]["cachePoint"]
    exp_cache_point = {"type": "default"}

    assert tru_cache_point == exp_cache_point


def test_format_request_cache_point_without_ttl(model, model_id):
    """Test that cache points work without ttl field (backward compatibility)."""
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "cachePoint": {
                        "type": "default",
                    }
                },
            ],
        }
    ]

    formatted_request = model.format_request(messages)

    cache_point_block = formatted_request["messages"][0]["content"][0]["cachePoint"]
    expected = {"type": "default"}
    assert cache_point_block == expected
    assert "ttl" not in cache_point_block


def test_config_validation_warns_on_unknown_keys(bedrock_client, captured_warnings):
    """Test that unknown config keys emit a warning."""
    BedrockModel(model_id="test-model", invalid_param="test")

    assert len(captured_warnings) == 1
    assert "Invalid configuration parameters" in str(captured_warnings[0].message)
    assert "invalid_param" in str(captured_warnings[0].message)


def test_update_config_validation_warns_on_unknown_keys(model, captured_warnings):
    """Test that update_config warns on unknown keys."""
    model.update_config(wrong_param="test")

    assert len(captured_warnings) == 1
    assert "Invalid configuration parameters" in str(captured_warnings[0].message)
    assert "wrong_param" in str(captured_warnings[0].message)


def test_tool_choice_supported_no_warning(model, messages, tool_spec, captured_warnings):
    """Test that toolChoice doesn't emit warning for supported providers."""
    tool_choice = {"auto": {}}
    model.format_request(messages, [tool_spec], tool_choice=tool_choice)

    non_deprecation_warnings = [w for w in captured_warnings if not issubclass(w.category, DeprecationWarning)]
    assert len(non_deprecation_warnings) == 0


def test_tool_choice_none_no_warning(model, messages, captured_warnings):
    """Test that None toolChoice doesn't emit warning."""
    model.format_request(messages, tool_choice=None)

    non_deprecation_warnings = [w for w in captured_warnings if not issubclass(w.category, DeprecationWarning)]
    assert len(non_deprecation_warnings) == 0


def test_get_default_model_with_warning_supported_regions_shows_no_warning(captured_warnings):
    """Test _get_default_model_with_warning doesn't warn for any region (global profile works everywhere)."""
    BedrockModel._get_default_model_with_warning("us-west-2")
    BedrockModel._get_default_model_with_warning("eu-west-2")
    assert all("does not support" not in str(w.message) for w in captured_warnings)


def test_get_default_model_returns_global_inference_profile(captured_warnings):
    """Default model id is the global inference profile regardless of region."""
    for region in ("us-east-1", "eu-west-1", "us-gov-west-1", "ap-southeast-1", "ca-central-1"):
        assert BedrockModel._get_default_model_with_warning(region) == DEFAULT_BEDROCK_MODEL_ID
    assert all("does not support" not in str(w.message) for w in captured_warnings)


def test_get_default_model_with_warning_unsupported_region_does_not_warn(captured_warnings):
    """Global inference profile works across all regions, so no region-support warning is emitted."""
    BedrockModel._get_default_model_with_warning("ca-central-1")
    region_warnings = [w for w in captured_warnings if "does not support" in str(w.message)]
    assert len(region_warnings) == 0


def test_get_default_model_with_warning_no_warning_with_custom_model_id(captured_warnings):
    """Test _get_default_model_with_warning doesn't warn when custom model_id provided."""
    model_config = {"model_id": "custom-model"}
    model_id = BedrockModel._get_default_model_with_warning("ca-central-1", model_config)

    assert model_id == "custom-model"
    assert len(captured_warnings) == 0


def test_init_with_unsupported_region_does_not_warn(session_cls, captured_warnings):
    """BedrockModel initialization does not warn for 'unsupported' regions when using the global profile."""
    BedrockModel(region_name="ca-central-1")

    region_warnings = [w for w in captured_warnings if "does not support" in str(w.message)]
    assert len(region_warnings) == 0


def test_init_with_unsupported_region_custom_model_no_warning(session_cls, captured_warnings):
    """Test BedrockModel initialization doesn't warn when custom model_id provided."""
    BedrockModel(region_name="ca-central-1", model_id="custom-model")
    assert len(captured_warnings) == 0


def test_override_default_model_id_uses_the_overriden_value(captured_warnings):
    with unittest.mock.patch("strands.models.bedrock.DEFAULT_BEDROCK_MODEL_ID", "custom-overridden-model"):
        model_id = BedrockModel._get_default_model_with_warning("us-east-1")
        assert model_id == "custom-overridden-model"


def test_default_model_sentinel_triggers_region_prefix_fallback(captured_warnings):
    """When DEFAULT_BEDROCK_MODEL_ID matches the sentinel template, the region-prefix fallback runs."""
    sentinel = "us.anthropic.claude-sonnet-4-6"
    with unittest.mock.patch("strands.models.bedrock.DEFAULT_BEDROCK_MODEL_ID", sentinel):
        model_id = BedrockModel._get_default_model_with_warning("eu-west-1")
        assert model_id == "eu.anthropic.claude-sonnet-4-6"


def test_caller_supplied_model_id_wins_over_global_default(captured_warnings):
    """Caller-supplied model_id in config takes precedence over the global default."""
    model_config = {"model_id": "caller-supplied-model"}
    model_id = BedrockModel._get_default_model_with_warning("us-east-1", model_config)
    assert model_id == "caller-supplied-model"


def test_default_model_sentinel_with_unsupported_region_warns(captured_warnings):
    """When the sentinel matches and the region is unknown, the region-unsupported warning fires."""
    sentinel = "us.anthropic.claude-sonnet-4-6"
    with unittest.mock.patch("strands.models.bedrock.DEFAULT_BEDROCK_MODEL_ID", sentinel):
        BedrockModel._get_default_model_with_warning("ca-central-1")
    region_warnings = [w for w in captured_warnings if "does not support" in str(w.message)]
    assert len(region_warnings) == 1


def test_default_model_id_is_global_inference_profile(captured_warnings):
    model_id = BedrockModel._get_default_model_with_warning("us-east-1")
    assert model_id == "global.anthropic.claude-sonnet-4-6"
    assert model_id == DEFAULT_BEDROCK_MODEL_ID
    assert all("does not support" not in str(w.message) for w in captured_warnings)


def test_custom_model_id_not_overridden_by_region_formatting(session_cls):
    """Test that custom model_id is not overridden by region formatting."""
    custom_model_id = "custom.model.id"

    model = BedrockModel(model_id=custom_model_id)
    model_id = model.get_config().get("model_id")

    assert model_id == custom_model_id


def test_format_request_filters_output_schema(model, messages, model_id):
    """Test that outputSchema is filtered out from tool specs in Bedrock requests."""
    tool_spec_with_output_schema = {
        "description": "Test tool with output schema",
        "name": "test_tool",
        "inputSchema": {"type": "object", "properties": {}},
        "outputSchema": {"type": "object", "properties": {"result": {"type": "string"}}},
    }

    request = model.format_request(messages, [tool_spec_with_output_schema])

    tool_spec = request["toolConfig"]["tools"][0]["toolSpec"]

    # Verify outputSchema is not included
    assert "outputSchema" not in tool_spec

    # Verify other fields are preserved
    assert tool_spec["name"] == "test_tool"
    assert tool_spec["description"] == "Test tool with output schema"
    assert tool_spec["inputSchema"] == {"type": "object", "properties": {}}


@pytest.mark.asyncio
async def test_stream_backward_compatibility_system_prompt(bedrock_client, model, messages, alist):
    """Test that system_prompt is converted to system_prompt_content when system_prompt_content is None."""
    bedrock_client.converse_stream.return_value = {"stream": ["e1", "e2"]}

    system_prompt = "You are a helpful assistant."

    response = model.stream(messages, system_prompt=system_prompt)
    await alist(response)

    # Verify the request was formatted with system_prompt converted to system_prompt_content
    expected_request = {
        "inferenceConfig": {},
        "modelId": "m1",
        "messages": messages,
        "system": [{"text": system_prompt}],
    }
    bedrock_client.converse_stream.assert_called_once_with(**expected_request)


@pytest.mark.asyncio
async def test_citations_content_preserves_tagged_union_structure(bedrock_client, model, alist):
    """Test that citationsContent preserves AWS Bedrock's required tagged union structure for citation locations.

    This test verifies that when messages contain citationsContent with tagged union CitationLocation objects,
    the structure is preserved when sent to AWS Bedrock API. AWS Bedrock expects CitationLocation to be a
    tagged union with exactly one wrapper key (documentChar, documentPage, documentChunk, searchResultLocation, web)
    containing the location fields.
    """
    # Mock the Bedrock response
    bedrock_client.converse_stream.return_value = {"stream": []}

    # Messages with citationsContent using all tagged union CitationLocation types
    messages = [
        {"role": "user", "content": [{"text": "Analyze multiple sources"}]},
        {
            "role": "assistant",
            "content": [
                {
                    "citationsContent": {
                        "citations": [
                            {
                                "location": {"documentChar": {"documentIndex": 0, "start": 150, "end": 300}},
                                "sourceContent": [
                                    {"text": "Employee benefits include health insurance and retirement plans"}
                                ],
                                "title": "Benefits Section",
                            },
                            {
                                "location": {"documentPage": {"documentIndex": 0, "start": 2, "end": 3}},
                                "sourceContent": [{"text": "Vacation policy allows 15 days per year"}],
                                "title": "Vacation Policy",
                            },
                            {
                                "location": {"documentChunk": {"documentIndex": 1, "start": 5, "end": 8}},
                                "sourceContent": [{"text": "Company culture emphasizes work-life balance"}],
                                "title": "Culture Section",
                            },
                            {
                                "location": {
                                    "searchResultLocation": {
                                        "searchResultIndex": 0,
                                        "start": 25,
                                        "end": 150,
                                    }
                                },
                                "sourceContent": [{"text": "Search results show industry best practices"}],
                                "title": "Search Results",
                            },
                            {
                                "location": {
                                    "web": {
                                        "url": "https://example.com/hr-policies",
                                        "domain": "example.com",
                                    }
                                },
                                "sourceContent": [{"text": "External HR policy guidelines"}],
                                "title": "External Reference",
                            },
                        ],
                        "content": [{"text": "Based on multiple sources, the company offers comprehensive benefits."}],
                    }
                }
            ],
        },
    ]

    # Call the public stream method
    await alist(model.stream(messages))

    # Verify the request sent to Bedrock preserves the tagged union structure
    bedrock_client.converse_stream.assert_called_once()
    call_args = bedrock_client.converse_stream.call_args[1]

    # Extract the citationsContent from the formatted messages
    formatted_messages = call_args["messages"]
    citations_content = formatted_messages[1]["content"][0]["citationsContent"]

    # Verify the tagged union structure is preserved for all location types
    expected_citations = [
        {
            "location": {"documentChar": {"documentIndex": 0, "start": 150, "end": 300}},
            "sourceContent": [{"text": "Employee benefits include health insurance and retirement plans"}],
            "title": "Benefits Section",
        },
        {
            "location": {"documentPage": {"documentIndex": 0, "start": 2, "end": 3}},
            "sourceContent": [{"text": "Vacation policy allows 15 days per year"}],
            "title": "Vacation Policy",
        },
        {
            "location": {"documentChunk": {"documentIndex": 1, "start": 5, "end": 8}},
            "sourceContent": [{"text": "Company culture emphasizes work-life balance"}],
            "title": "Culture Section",
        },
        {
            "location": {
                "searchResultLocation": {
                    "searchResultIndex": 0,
                    "start": 25,
                    "end": 150,
                }
            },
            "sourceContent": [{"text": "Search results show industry best practices"}],
            "title": "Search Results",
        },
        {
            "location": {
                "web": {
                    "url": "https://example.com/hr-policies",
                    "domain": "example.com",
                }
            },
            "sourceContent": [{"text": "External HR policy guidelines"}],
            "title": "External Reference",
        },
    ]

    assert citations_content["citations"] == expected_citations, (
        "Citation location tagged union structure was not preserved. "
        "AWS Bedrock requires CitationLocation to have exactly one wrapper key "
        "(documentChar, documentPage, documentChunk, searchResultLocation, or web) "
        "with the location fields nested inside."
    )


@pytest.mark.asyncio
async def test_format_request_with_guardrail_latest_message(model):
    """Test that guardrail_latest_message wraps the latest user message with text and image."""
    model.update_config(
        guardrail_id="test-guardrail",
        guardrail_version="DRAFT",
        guardrail_latest_message=True,
    )

    messages = [
        {"role": "user", "content": [{"text": "First message"}]},
        {"role": "assistant", "content": [{"text": "First response"}]},
        {
            "role": "user",
            "content": [
                {"text": "Look at this image"},
                {"image": {"format": "png", "source": {"bytes": b"fake_image_data"}}},
            ],
        },
    ]

    request = model.format_request(messages)
    formatted_messages = request["messages"]

    # All messages should be in the request
    assert len(formatted_messages) == 3

    # First user message should NOT be wrapped
    assert "text" in formatted_messages[0]["content"][0]
    assert formatted_messages[0]["content"][0]["text"] == "First message"

    # Assistant message should NOT be wrapped
    assert "text" in formatted_messages[1]["content"][0]
    assert formatted_messages[1]["content"][0]["text"] == "First response"

    # Latest user message text should be wrapped
    assert "guardContent" in formatted_messages[2]["content"][0]
    assert formatted_messages[2]["content"][0]["guardContent"]["text"]["text"] == "Look at this image"

    # Latest user message image should also be wrapped
    assert "guardContent" in formatted_messages[2]["content"][1]
    assert formatted_messages[2]["content"][1]["guardContent"]["image"]["format"] == "png"


@pytest.mark.asyncio
async def test_format_request_with_guardrail_latest_message_uses_service_model_formats(model):
    """Test that guardContent image formats are read from the botocore service model."""
    model.client.meta.service_model.shape_for.return_value.enum = ["png", "jpeg", "webp"]
    model.update_config(
        guardrail_id="test-guardrail",
        guardrail_version="DRAFT",
        guardrail_latest_message=True,
    )

    messages = [
        {
            "role": "user",
            "content": [{"image": {"format": "webp", "source": {"bytes": b"fake_image_data"}}}],
        },
    ]

    request = model.format_request(messages)

    assert request["messages"][0]["content"][0]["guardContent"]["image"]["format"] == "webp"
    model.client.meta.service_model.shape_for.assert_called_once_with("GuardrailConverseImageFormat")


@pytest.mark.asyncio
@pytest.mark.parametrize("image_format", ["gif", "webp"])
async def test_format_request_with_guardrail_latest_message_unsupported_image_format(model, image_format, caplog):
    """Test that guardContent does not wrap image formats that Bedrock guardrails reject."""
    caplog.set_level(logging.WARNING, logger="strands.models.bedrock")

    model.update_config(
        guardrail_id="test-guardrail",
        guardrail_version="DRAFT",
        guardrail_latest_message=True,
    )

    messages = [
        {
            "role": "user",
            "content": [
                {"text": "Look at this image"},
                {"image": {"format": image_format, "source": {"bytes": b"fake_image_data"}}},
            ],
        },
    ]

    request = model.format_request(messages)
    formatted_messages = request["messages"]

    # Latest user message text should still be wrapped
    assert "guardContent" in formatted_messages[0]["content"][0]
    assert formatted_messages[0]["content"][0]["guardContent"]["text"]["text"] == "Look at this image"

    # GuardrailConverseImageBlock only accepts png and jpeg, so the image is left unwrapped
    assert "guardContent" not in formatted_messages[0]["content"][1]
    assert formatted_messages[0]["content"][1]["image"]["format"] == image_format
    assert f"image_format=<{image_format}> | format not supported by bedrock guardrails" in caplog.text


@pytest.mark.asyncio
async def test_format_request_with_guardrail_latest_message_after_tool_use(model):
    """Test that guardContent wraps the last user text message even when a toolResult follows it."""
    model.update_config(
        guardrail_id="test-guardrail",
        guardrail_version="DRAFT",
        guardrail_latest_message=True,
    )

    messages = [
        {"role": "user", "content": [{"text": "First message"}]},
        {"role": "assistant", "content": [{"text": "First response"}]},
        {"role": "user", "content": [{"text": "what is the standard deduction?"}]},
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "toolUseId": "tool-1",
                        "name": "knowledge_base",
                        "input": {"query": "standard deduction"},
                    }
                }
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "tool-1",
                        "content": [{"text": "The standard deduction for 2024 is $14,600."}],
                        "status": "success",
                    }
                }
            ],
        },
    ]

    request = model.format_request(messages)
    formatted_messages = request["messages"]

    assert len(formatted_messages) == 5

    # Earlier user message should NOT be wrapped
    assert "text" in formatted_messages[0]["content"][0]
    assert formatted_messages[0]["content"][0]["text"] == "First message"

    # Last user message with text content should be wrapped, even though a toolResult comes after
    assert "guardContent" in formatted_messages[2]["content"][0]
    assert formatted_messages[2]["content"][0]["guardContent"]["text"]["text"] == "what is the standard deduction?"

    # toolResult-only user message should NOT be wrapped
    assert "toolResult" in formatted_messages[4]["content"][0]
    assert "guardContent" not in formatted_messages[4]["content"][0]


@pytest.mark.asyncio
async def test_format_request_with_guardrail_latest_message_wraps_final_user_text(model):
    """Test that guardContent wraps the last user message when it contains text content."""
    model.update_config(
        guardrail_id="test-guardrail",
        guardrail_version="DRAFT",
        guardrail_latest_message=True,
    )

    messages = [
        {"role": "user", "content": [{"text": "First message"}]},
        {"role": "assistant", "content": [{"text": "First response"}]},
        {"role": "user", "content": [{"text": "Tell me about taxes"}]},
    ]

    request = model.format_request(messages)
    formatted_messages = request["messages"]

    assert "guardContent" in formatted_messages[2]["content"][0]
    assert formatted_messages[2]["content"][0]["guardContent"]["text"]["text"] == "Tell me about taxes"


@pytest.mark.asyncio
async def test_format_request_with_guardrail_multiple_sequential_tool_calls(model):
    """Test guardContent with multiple tool calls in sequence (no new user input between)."""
    model.update_config(
        guardrail_id="test-guardrail",
        guardrail_version="DRAFT",
        guardrail_latest_message=True,
    )

    messages = [
        {"role": "user", "content": [{"text": "First question"}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "tool1", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "t1", "content": [{"text": "Result 1"}], "status": "success"}}],
        },
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t2", "name": "tool2", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "t2", "content": [{"text": "Result 2"}], "status": "success"}}],
        },
    ]

    request = model.format_request(messages)
    formatted_messages = request["messages"]

    # Should wrap the first user text message, not the toolResults
    assert "guardContent" in formatted_messages[0]["content"][0]
    assert formatted_messages[0]["content"][0]["guardContent"]["text"]["text"] == "First question"

    # toolResults should not be wrapped
    assert "toolResult" in formatted_messages[2]["content"][0]
    assert "guardContent" not in formatted_messages[2]["content"][0]
    assert "toolResult" in formatted_messages[4]["content"][0]
    assert "guardContent" not in formatted_messages[4]["content"][0]


@pytest.mark.asyncio
async def test_format_request_with_guardrail_image_before_tool_result(model):
    """Test guardContent wraps image content even when toolResult follows."""
    model.update_config(
        guardrail_id="test-guardrail",
        guardrail_version="DRAFT",
        guardrail_latest_message=True,
    )

    messages = [
        {"role": "user", "content": [{"image": {"format": "png", "source": {"bytes": b"fake"}}}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "vision", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "t1", "content": [{"text": "I see a cat"}], "status": "success"}}],
        },
    ]

    request = model.format_request(messages)
    formatted_messages = request["messages"]

    # Image should be wrapped even though toolResult comes after
    assert "guardContent" in formatted_messages[0]["content"][0]
    assert "image" in formatted_messages[0]["content"][0]["guardContent"]


@pytest.mark.asyncio
async def test_format_request_with_guardrail_multiple_tool_results_same_message(model):
    """Test guardContent with multiple parallel tool calls (multiple toolResults in one message)."""
    model.update_config(
        guardrail_id="test-guardrail",
        guardrail_version="DRAFT",
        guardrail_latest_message=True,
    )

    messages = [
        {"role": "user", "content": [{"text": "Question requiring multiple tools"}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "t1", "name": "tool1", "input": {}}},
                {"toolUse": {"toolUseId": "t2", "name": "tool2", "input": {}}},
            ],
        },
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": "t1", "content": [{"text": "Result 1"}], "status": "success"}},
                {"toolResult": {"toolUseId": "t2", "content": [{"text": "Result 2"}], "status": "success"}},
            ],
        },
    ]

    request = model.format_request(messages)
    formatted_messages = request["messages"]

    # Should wrap the question
    assert "guardContent" in formatted_messages[0]["content"][0]
    assert formatted_messages[0]["content"][0]["guardContent"]["text"]["text"] == "Question requiring multiple tools"


def test_cache_strategy_auto_maps_claude_to_anthropic(bedrock_client):
    """Under strategy="auto", a Claude/Anthropic model id resolves to the anthropic strategy."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )
    assert model._cache_strategy == "anthropic"

    model2 = BedrockModel(model_id="anthropic.claude-3-haiku-20240307-v1:0", cache_config=CacheConfig(strategy="auto"))
    assert model2._cache_strategy == "anthropic"


def test_cache_strategy_auto_is_none_for_non_claude(bedrock_client):
    """Under strategy="auto", a model without automatic caching support resolves to None."""
    model = BedrockModel(model_id="amazon.nova-pro-v1:0", cache_config=CacheConfig(strategy="auto"))
    assert model._cache_strategy is None


def test_cache_strategy_is_none_without_cache_config(bedrock_client):
    """A caching-capable model still resolves to no strategy until cache_config turns caching on."""
    model = BedrockModel(model_id="us.anthropic.claude-sonnet-4-20250514-v1:0")
    assert model._cache_strategy is None


def test_inject_cache_point_keeps_only_the_first_of_several_placed_points(bedrock_client):
    """One boundary per message: extras would spend the provider's cache-point budget for nothing."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    cleaned_messages = [
        {
            "role": "user",
            "content": [
                {"text": "durable ask"},
                {"cachePoint": {"type": "default"}},
                {"text": "per-call"},
                {"cachePoint": {"type": "default"}},
                {"text": "more per-call"},
            ],
        }
    ]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [
        {"text": "durable ask"},
        {"cachePoint": {"type": "default"}},
        {"text": "per-call"},
        {"text": "more per-call"},
    ]
    assert tru_content == exp_content


def test_inject_cache_point_applies_ttl_to_the_first_of_several_placed_points(bedrock_client):
    """The surviving point is the first one, so the configured TTL lands on that one."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"))
    cleaned_messages = [
        {
            "role": "user",
            "content": [
                {"text": "durable ask"},
                {"cachePoint": {"type": "default"}},
                {"text": "per-call"},
                {"cachePoint": {"type": "default"}},
                {"text": "more per-call"},
                {"cachePoint": {"type": "default"}},
            ],
        }
    ]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [
        {"text": "durable ask"},
        {"cachePoint": {"type": "default", "ttl": "1h"}},
        {"text": "per-call"},
        {"text": "more per-call"},
    ]
    assert tru_content == exp_content


def test_inject_cache_point_leaves_an_honored_point_after_a_pdf_document(bedrock_client):
    """Only non-PDF documents carry the adjacency restriction."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    pdf = {"document": {"format": "pdf", "name": "d", "source": {"bytes": b"x"}}}
    cleaned_messages = [{"role": "user", "content": [{"text": "ask"}, pdf, {"cachePoint": {"type": "default"}}]}]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [{"text": "ask"}, pdf, {"cachePoint": {"type": "default"}}]
    assert tru_content == exp_content


def test_inject_cache_point_relocates_over_the_adjacent_document_run_only(bedrock_client):
    """Only the run directly preceding the point blocks it; earlier documents stay in the prefix."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    earlier = {"document": {"format": "csv", "name": "earlier", "source": {"bytes": b"x"}}}
    adjacent = {"document": {"format": "csv", "name": "adjacent", "source": {"bytes": b"y"}}}
    cleaned_messages = [
        {
            "role": "user",
            "content": [
                {"text": "analyze these"},
                earlier,
                {"text": "notes"},
                adjacent,
                {"cachePoint": {"type": "default"}},
            ],
        }
    ]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [
        {"text": "analyze these"},
        earlier,
        {"text": "notes"},
        {"cachePoint": {"type": "default"}},
        adjacent,
    ]
    assert tru_content == exp_content


def test_inject_cache_point_does_not_relocate_a_point_a_document_does_not_precede(bedrock_client):
    """The restriction is adjacency: moving further would evict the document from the cached prefix."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    doc = {"document": {"format": "csv", "name": "d", "source": {"bytes": b"x"}}}
    cleaned_messages = [
        {
            "role": "user",
            "content": [{"text": "analyze this"}, doc, {"text": "notes"}, {"cachePoint": {"type": "default"}}],
        }
    ]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [{"text": "analyze this"}, doc, {"text": "notes"}, {"cachePoint": {"type": "default"}}]
    assert tru_content == exp_content


def test_inject_cache_point_replaces_a_leading_caller_point_with_automatic_placement(bedrock_client):
    """Bedrock rejects a cache point with nothing ahead of it: "There is nothing available to cache"."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    cleaned_messages = [{"role": "user", "content": [{"cachePoint": {"type": "default"}}, {"text": "durable ask"}]}]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [{"text": "durable ask"}, {"cachePoint": {"type": "default"}}]
    assert tru_content == exp_content


def test_inject_cache_point_leaves_a_message_that_was_only_a_cache_point_empty(bedrock_client):
    """Re-adding a point to an emptied message would rebuild the request Bedrock just refused."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    cleaned_messages = [{"role": "user", "content": [{"cachePoint": {"type": "default"}}]}]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = []
    assert tru_content == exp_content


def test_inject_cache_point_drops_an_explicit_none_ttl_from_a_caller_point(bedrock_client):
    """botocore refuses ``ttl: None`` outright, so it cannot survive to the request."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    cleaned_messages = [
        {"role": "user", "content": [{"text": "ask"}, {"cachePoint": {"type": "default", "ttl": None}}]}
    ]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [{"text": "ask"}, {"cachePoint": {"type": "default"}}]
    assert tru_content == exp_content


def test_inject_cache_point_drops_an_empty_string_ttl_from_a_caller_point(bedrock_client):
    """Bedrock rejects "" against its TTL enum, so it must not reach the request."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"))
    cleaned_messages = [{"role": "user", "content": [{"text": "ask"}, {"cachePoint": {"type": "default", "ttl": ""}}]}]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [{"text": "ask"}, {"cachePoint": {"type": "default", "ttl": "1h"}}]
    assert tru_content == exp_content


def test_inject_cache_point_applies_the_configured_ttl_over_an_explicit_none(bedrock_client):
    """An explicit None is not a caller TTL, so the configured one still applies."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"))
    cleaned_messages = [
        {"role": "user", "content": [{"text": "ask"}, {"cachePoint": {"type": "default", "ttl": None}}]}
    ]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [{"text": "ask"}, {"cachePoint": {"type": "default", "ttl": "1h"}}]
    assert tru_content == exp_content


def test_inject_cache_point_honors_a_point_in_the_last_user_message(bedrock_client):
    """A caller marks where its reusable prefix ends; moving the point would cache per-call content."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    cleaned_messages = [
        {
            "role": "user",
            "content": [
                {"text": "durable ask"},
                {"cachePoint": {"type": "default"}},
                {"text": "<context-status>rebuilt each call</context-status>"},
            ],
        }
    ]

    model._inject_cache_point(cleaned_messages)

    tru_content = [next(iter(block)) for block in cleaned_messages[0]["content"]]
    exp_content = ["text", "cachePoint", "text"]
    assert tru_content == exp_content


def test_inject_cache_point_still_strips_points_in_earlier_messages(bedrock_client):
    """Points must not accumulate one per turn against the provider's cache-point budget."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    cleaned_messages = [
        {"role": "user", "content": [{"text": "old ask"}, {"cachePoint": {"type": "default"}}]},
        {"role": "assistant", "content": [{"text": "reply"}]},
        {"role": "user", "content": [{"text": "new ask"}, {"cachePoint": {"type": "default"}}]},
    ]

    model._inject_cache_point(cleaned_messages)

    tru_layout = [[next(iter(block)) for block in msg["content"]] for msg in cleaned_messages]
    exp_layout = [["text"], ["text"], ["text", "cachePoint"]]
    assert tru_layout == exp_layout


def test_inject_cache_point_applies_configured_ttl_to_an_honored_point(bedrock_client):
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"))
    cleaned_messages = [
        {"role": "user", "content": [{"text": "ask"}, {"cachePoint": {"type": "default"}}, {"text": "per-call"}]}
    ]

    model._inject_cache_point(cleaned_messages)

    tru_point = cleaned_messages[0]["content"][1]
    exp_point = {"cachePoint": {"type": "default", "ttl": "1h"}}
    assert tru_point == exp_point


def test_inject_cache_point_normalizes_the_ttl_of_a_relocated_point(bedrock_client):
    """The relocation path must normalize too: a caller TTL there is just as capable of a rejection."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="5m"))
    doc = {"document": {"format": "csv", "name": "d", "source": {"bytes": b"x"}}}
    cleaned_messages = [
        {
            "role": "user",
            "content": [
                {"text": "analyze"},
                doc,
                {"cachePoint": {"type": "default", "ttl": "1h"}},
                {"text": "per-call"},
            ],
        }
    ]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [{"text": "analyze"}, {"cachePoint": {"type": "default", "ttl": "5m"}}, doc, {"text": "per-call"}]
    assert tru_content == exp_content


def test_inject_cache_point_normalizes_a_hand_placed_ttl_to_the_configured_one(bedrock_client):
    """A caller TTL can invalidate the request: Bedrock rejects a longer TTL after a shorter one."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"))
    # A trailing block makes the honored POSITION observable: a strip-and-re-append would move the
    # point to the end, so this also fails against the behaviour this PR replaces.
    cleaned_messages = [
        {
            "role": "user",
            "content": [{"text": "ask"}, {"cachePoint": {"type": "default", "ttl": "5m"}}, {"text": "per-call"}],
        }
    ]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [{"text": "ask"}, {"cachePoint": {"type": "default", "ttl": "1h"}}, {"text": "per-call"}]
    assert tru_content == exp_content


def test_inject_cache_point_drops_a_hand_placed_ttl_when_none_is_configured(bedrock_client):
    """With no configured TTL there is nothing to normalize to, so the caller's TTL still goes."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    # A trailing block makes the honored POSITION observable: a strip-and-re-append would move the
    # point to the end, so this also fails against the behaviour this PR replaces.
    cleaned_messages = [
        {
            "role": "user",
            "content": [{"text": "ask"}, {"cachePoint": {"type": "default", "ttl": "1h"}}, {"text": "per-call"}],
        }
    ]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [{"text": "ask"}, {"cachePoint": {"type": "default"}}, {"text": "per-call"}]
    assert tru_content == exp_content


def test_inject_cache_point_relocates_an_honored_point_ahead_of_a_non_pdf_document(bedrock_client):
    """Bedrock rejects a cache point directly preceded by a non-PDF document."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    cleaned_messages = [
        {
            "role": "user",
            "content": [
                {"text": "analyze this"},
                {"document": {"format": "csv", "name": "d", "source": {"bytes": b"x"}}},
                {"cachePoint": {"type": "default"}},
                {"text": "per-call"},
            ],
        }
    ]

    model._inject_cache_point(cleaned_messages)

    tru_content = cleaned_messages[0]["content"]
    exp_content = [
        {"text": "analyze this"},
        {"cachePoint": {"type": "default"}},
        {"document": {"format": "csv", "name": "d", "source": {"bytes": b"x"}}},
        {"text": "per-call"},
    ]
    assert tru_content == exp_content


def test_inject_cache_point_drops_an_honored_point_when_a_document_leads_the_message(bedrock_client):
    """Nothing precedes a leading document, so there is no prefix to cache."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    cleaned_messages = [
        {
            "role": "user",
            "content": [
                {"document": {"format": "csv", "name": "d", "source": {"bytes": b"x"}}},
                {"cachePoint": {"type": "default"}},
            ],
        }
    ]

    model._inject_cache_point(cleaned_messages)

    tru_content = [next(iter(block)) for block in cleaned_messages[0]["content"]]
    exp_content = ["document"]
    assert tru_content == exp_content


def test_inject_cache_point_adds_to_last_user(bedrock_client):
    """Test that _inject_cache_point adds cache point to last user message."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )

    cleaned_messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Hi there!"}]},
        {"role": "user", "content": [{"text": "How are you?"}]},
    ]

    model._inject_cache_point(cleaned_messages)

    assert len(cleaned_messages[2]["content"]) == 2
    assert "cachePoint" in cleaned_messages[2]["content"][-1]
    assert cleaned_messages[2]["content"][-1]["cachePoint"]["type"] == "default"
    assert len(cleaned_messages[1]["content"]) == 1


def test_inject_cache_point_single_user_message(bedrock_client):
    """Test that _inject_cache_point adds cache point to single user message."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )

    cleaned_messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
    ]

    model._inject_cache_point(cleaned_messages)

    assert len(cleaned_messages) == 1
    assert len(cleaned_messages[0]["content"]) == 2
    assert "cachePoint" in cleaned_messages[0]["content"][-1]


def test_inject_cache_point_empty_messages(bedrock_client):
    """Test that _inject_cache_point handles empty messages list."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )

    cleaned_messages = []
    model._inject_cache_point(cleaned_messages)

    assert cleaned_messages == []


def test_inject_cache_point_with_tool_result_last_user(bedrock_client):
    """Test that cache point is added to last user message even when it contains toolResult."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )

    cleaned_messages = [
        {"role": "user", "content": [{"text": "Use the tool"}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "test_tool", "input": {}}}]},
        {"role": "user", "content": [{"toolResult": {"toolUseId": "t1", "content": [{"text": "Result"}]}}]},
    ]

    model._inject_cache_point(cleaned_messages)

    assert len(cleaned_messages[2]["content"]) == 2
    assert "cachePoint" in cleaned_messages[2]["content"][-1]
    assert cleaned_messages[2]["content"][-1]["cachePoint"]["type"] == "default"
    assert len(cleaned_messages[0]["content"]) == 1


def test_inject_cache_point_skipped_for_non_claude(bedrock_client):
    """Test that cache point injection is skipped for non-Claude models."""
    model = BedrockModel(model_id="amazon.nova-pro-v1:0", cache_config=CacheConfig(strategy="auto"))

    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Response"}]},
    ]

    formatted = model._format_bedrock_messages(messages)

    assert len(formatted[0]["content"]) == 1
    assert "cachePoint" not in formatted[0]["content"][0]
    assert len(formatted[1]["content"]) == 1
    assert "cachePoint" not in formatted[1]["content"][0]


def test_format_bedrock_messages_does_not_mutate_original(bedrock_client):
    """Test that _format_bedrock_messages does not mutate original messages."""

    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )

    original_messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Hi there!"}]},
        {"role": "user", "content": [{"text": "How are you?"}]},
    ]

    messages_before = copy.deepcopy(original_messages)
    formatted = model._format_bedrock_messages(original_messages)

    assert original_messages == messages_before
    assert "cachePoint" not in original_messages[2]["content"][-1]
    assert "cachePoint" in formatted[2]["content"][-1]


def test_inject_cache_point_strips_existing_cache_points(bedrock_client):
    """Test that _inject_cache_point strips existing cache points and adds new one at correct position."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )

    # Messages with existing cache points in various positions
    cleaned_messages = [
        {"role": "user", "content": [{"text": "Hello"}, {"cachePoint": {"type": "default"}}]},
        {"role": "assistant", "content": [{"text": "First response"}, {"cachePoint": {"type": "default"}}]},
        {"role": "user", "content": [{"text": "Follow up"}]},
        {"role": "assistant", "content": [{"text": "Second response"}]},
    ]

    model._inject_cache_point(cleaned_messages)

    # All old cache points should be stripped
    assert len(cleaned_messages[0]["content"]) == 1  # first user: only text
    assert len(cleaned_messages[1]["content"]) == 1  # first assistant: only text
    assert len(cleaned_messages[3]["content"]) == 1  # last assistant: only text

    # New cache point should be at end of last user message
    assert len(cleaned_messages[2]["content"]) == 2
    assert "cachePoint" in cleaned_messages[2]["content"][-1]


def test_inject_cache_point_before_non_pdf_document(bedrock_client):
    """Test that cache point is inserted before non-PDF document blocks."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )

    cleaned_messages = [
        {
            "role": "user",
            "content": [
                {"text": "Analyze this file"},
                {"document": {"format": "md", "name": "readme", "source": {"bytes": b"# Hello"}}},
            ],
        },
    ]

    model._inject_cache_point(cleaned_messages)

    assert cleaned_messages[0]["content"] == [
        {"text": "Analyze this file"},
        {"cachePoint": {"type": "default"}},
        {"document": {"format": "md", "name": "readme", "source": {"bytes": b"# Hello"}}},
    ]


def test_inject_cache_point_after_pdf_document(bedrock_client):
    """Test that cache point is appended at end when only PDF documents are present."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )

    cleaned_messages = [
        {
            "role": "user",
            "content": [
                {"text": "Analyze this PDF"},
                {"document": {"format": "pdf", "name": "report", "source": {"bytes": b"%PDF-1.4"}}},
            ],
        },
    ]

    model._inject_cache_point(cleaned_messages)

    assert cleaned_messages[0]["content"] == [
        {"text": "Analyze this PDF"},
        {"document": {"format": "pdf", "name": "report", "source": {"bytes": b"%PDF-1.4"}}},
        {"cachePoint": {"type": "default"}},
    ]


def test_inject_cache_point_mixed_pdf_and_non_pdf_documents(bedrock_client):
    """Test that cache point is inserted before the first non-PDF document in mixed content."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )

    cleaned_messages = [
        {
            "role": "user",
            "content": [
                {"text": "Analyze these files"},
                {"document": {"format": "pdf", "name": "report", "source": {"bytes": b"%PDF-1.4"}}},
                {"document": {"format": "csv", "name": "data", "source": {"bytes": b"a,b,c"}}},
            ],
        },
    ]

    model._inject_cache_point(cleaned_messages)

    assert cleaned_messages[0]["content"] == [
        {"text": "Analyze these files"},
        {"document": {"format": "pdf", "name": "report", "source": {"bytes": b"%PDF-1.4"}}},
        {"cachePoint": {"type": "default"}},
        {"document": {"format": "csv", "name": "data", "source": {"bytes": b"a,b,c"}}},
    ]


def test_inject_cache_point_before_the_first_of_several_non_pdf_documents(bedrock_client):
    """A cache point after any of them would be directly preceded by a document, which Bedrock rejects."""
    _ = bedrock_client
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )
    first = {"document": {"format": "csv", "name": "first", "source": {"bytes": b"a,b,c"}}}
    second = {"document": {"format": "csv", "name": "second", "source": {"bytes": b"d,e,f"}}}

    cleaned_messages = [{"role": "user", "content": [{"text": "Analyze these files"}, first, second]}]

    model._inject_cache_point(cleaned_messages)

    assert cleaned_messages[0]["content"] == [
        {"text": "Analyze these files"},
        {"cachePoint": {"type": "default"}},
        first,
        second,
    ]


def test_inject_cache_point_skipped_when_leading_non_pdf_document(bedrock_client):
    """Test that no cache point is injected when a non-PDF document is the first block.

    A leading cache point has no prefix to cache and Bedrock rejects it with a ValidationException,
    so injection is skipped for that message.
    """
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )

    cleaned_messages = [
        {
            "role": "user",
            "content": [
                {"document": {"format": "csv", "name": "data", "source": {"bytes": b"a,b,c"}}},
                {"text": "Analyze this file"},
            ],
        },
    ]

    model._inject_cache_point(cleaned_messages)

    assert cleaned_messages[0]["content"] == [
        {"document": {"format": "csv", "name": "data", "source": {"bytes": b"a,b,c"}}},
        {"text": "Analyze this file"},
    ]


def test_inject_cache_point_anthropic_strategy_skips_model_check(bedrock_client):
    """Test that anthropic strategy injects cache point without model support check."""
    model = BedrockModel(
        model_id="arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6",
        cache_config=CacheConfig(strategy="anthropic"),
    )

    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Response"}]},
    ]

    formatted = model._format_bedrock_messages(messages)

    assert len(formatted[0]["content"]) == 2
    assert "cachePoint" in formatted[0]["content"][-1]
    assert formatted[0]["content"][-1]["cachePoint"]["type"] == "default"
    assert len(formatted[1]["content"]) == 1


def test_inject_cache_point_auto_strategy_resolves_to_anthropic_for_claude(bedrock_client):
    """Test that auto strategy resolves to anthropic strategy for Claude models."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0", cache_config=CacheConfig(strategy="auto")
    )

    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
        {"role": "assistant", "content": [{"text": "Response"}]},
    ]

    formatted = model._format_bedrock_messages(messages)

    assert len(formatted[0]["content"]) == 2
    assert "cachePoint" in formatted[0]["content"][-1]
    assert len(formatted[1]["content"]) == 1


# Cache-point placement ahead of per-call trailing content. A point landing after per-call content
# writes a new entry every request and never reads one, which total token counts do not reveal, so
# only these placement assertions catch it.


def _content_keys(content: list[dict]) -> list[str]:
    return [next(iter(block)) for block in content]


def _document_block(fmt: str = "csv") -> dict:
    return {"document": {"format": fmt, "name": "d", "source": {"bytes": b"a,b"}}}


def test_dynamic_trailing_blocks_keeps_the_cache_point_ahead_of_per_call_content(bedrock_client):
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    messages = [{"role": "user", "content": [{"text": "durable ask"}, {"text": "PER-CALL"}]}]

    formatted = model._format_bedrock_messages(messages, dynamic_trailing_blocks=1)

    assert _content_keys(formatted[0]["content"]) == ["text", "cachePoint", "text"]


def test_dynamic_trailing_blocks_covers_every_block_of_a_multi_block_tail(bedrock_client):
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    messages = [{"role": "user", "content": [{"text": "durable"}, {"text": "STATUS"}, {"text": "INJECTED"}]}]

    formatted = model._format_bedrock_messages(messages, dynamic_trailing_blocks=2)

    assert _content_keys(formatted[0]["content"]) == ["text", "cachePoint", "text", "text"]


def test_no_dynamic_trailing_blocks_appends_the_cache_point_at_the_end(bedrock_client):
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    messages = [{"role": "user", "content": [{"text": "durable ask"}]}]

    formatted = model._format_bedrock_messages(messages, dynamic_trailing_blocks=0)

    assert _content_keys(formatted[0]["content"]) == ["text", "cachePoint"]


def test_dynamic_trailing_blocks_skips_the_cache_point_when_every_block_is_per_call(bedrock_client):
    # Nothing durable ahead of the boundary, so there is no prefix worth caching.
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    messages = [{"role": "user", "content": [{"text": "PER-CALL"}]}]

    formatted = model._format_bedrock_messages(messages, dynamic_trailing_blocks=1)

    assert _content_keys(formatted[0]["content"]) == ["text"]


def test_dynamic_trailing_blocks_steps_back_over_a_non_pdf_document(bedrock_client):
    # Bedrock rejects a point directly after a non-PDF document.
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    messages = [{"role": "user", "content": [{"text": "a"}, _document_block(), {"text": "PER-CALL"}]}]

    formatted = model._format_bedrock_messages(messages, dynamic_trailing_blocks=1)

    assert _content_keys(formatted[0]["content"]) == ["text", "cachePoint", "document", "text"]


def test_dynamic_trailing_blocks_are_dropped_when_a_document_leads_the_message(bedrock_client):
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    messages = [{"role": "user", "content": [_document_block(), {"text": "PER-CALL"}]}]

    formatted = model._format_bedrock_messages(messages, dynamic_trailing_blocks=1)

    assert "cachePoint" not in _content_keys(formatted[0]["content"])


def test_dynamic_trailing_blocks_keeps_a_pdf_document_in_the_cached_prefix(bedrock_client):
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    messages = [{"role": "user", "content": [{"text": "a"}, _document_block("pdf"), {"text": "PER-CALL"}]}]

    formatted = model._format_bedrock_messages(messages, dynamic_trailing_blocks=1)

    assert _content_keys(formatted[0]["content"]) == ["text", "document", "cachePoint", "text"]


def test_dynamic_trailing_blocks_carries_the_configured_ttl(bedrock_client):
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"))
    messages = [{"role": "user", "content": [{"text": "durable"}, {"text": "PER-CALL"}]}]

    formatted = model._format_bedrock_messages(messages, dynamic_trailing_blocks=1)

    assert formatted[0]["content"][1] == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_dynamic_trailing_blocks_emits_no_cache_point_without_cache_config(bedrock_client):
    model = BedrockModel()
    messages = [{"role": "user", "content": [{"text": "durable"}, {"text": "PER-CALL"}]}]

    formatted = model._format_bedrock_messages(messages, dynamic_trailing_blocks=1)

    assert "cachePoint" not in _content_keys(formatted[0]["content"])


def test_find_last_user_text_message_index_no_user_messages(bedrock_client):
    """Test _find_last_user_text_message_index returns None when no user text messages exist."""
    model = BedrockModel(model_id="test-model")

    messages = [
        {"role": "assistant", "content": [{"text": "hello"}]},
    ]

    assert model._find_last_user_text_message_index(messages) is None


def test_find_last_user_text_message_index_only_tool_results(bedrock_client):
    """Test _find_last_user_text_message_index returns None when user messages only have toolResult."""
    model = BedrockModel(model_id="test-model")

    messages = [
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "t1", "content": [{"text": "result"}]}}],
        },
    ]

    assert model._find_last_user_text_message_index(messages) is None


def test_find_last_user_text_message_index_returns_last_text_message(bedrock_client):
    """Test _find_last_user_text_message_index returns the index of the last user message with text."""
    model = BedrockModel(model_id="test-model")

    messages = [
        {"role": "user", "content": [{"text": "First question"}]},
        {"role": "assistant", "content": [{"text": "Response"}]},
        {"role": "user", "content": [{"text": "Second question"}]},
    ]

    assert model._find_last_user_text_message_index(messages) == 2


def test_find_last_user_text_message_index_skips_tool_result_messages(bedrock_client):
    """Test _find_last_user_text_message_index skips toolResult-only user messages."""
    model = BedrockModel(model_id="test-model")

    messages = [
        {"role": "user", "content": [{"text": "Question"}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "tool", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "t1", "content": [{"text": "Result"}]}}],
        },
    ]

    assert model._find_last_user_text_message_index(messages) == 0


def test_find_last_user_text_message_index_finds_image_message(bedrock_client):
    """Test _find_last_user_text_message_index finds user messages with image content."""
    model = BedrockModel(model_id="test-model")

    messages = [
        {"role": "user", "content": [{"image": {"format": "png", "source": {"bytes": b"fake"}}}]},
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "vision", "input": {}}}]},
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "t1", "content": [{"text": "Result"}]}}],
        },
    ]

    assert model._find_last_user_text_message_index(messages) == 0


def test_find_last_user_text_message_index_empty_messages(bedrock_client):
    """Test _find_last_user_text_message_index returns None for empty message list."""
    model = BedrockModel(model_id="test-model")

    assert model._find_last_user_text_message_index([]) is None


def test_guardrail_latest_message_disabled_does_not_wrap(model):
    """Test that guardContent wrapping is skipped when guardrail_latest_message is not set."""
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
    ]

    request = model.format_request(messages)
    formatted = request["messages"][0]["content"][0]

    assert "text" in formatted
    assert "guardContent" not in formatted


@pytest.mark.asyncio
async def test_non_streaming_citations_with_missing_optional_fields(bedrock_client, model, alist):
    """Test that convert_non_streaming_to_streaming handles citations missing optional fields.

    Nova grounding returns citations with only url/domain but no title field. The conversion
    should not crash with KeyError when optional fields like title, location, or sourceContent
    are missing from the citation response.
    """
    # Simulate a non-streaming response with citations missing the 'title' field
    # This is what Nova grounding returns: url+domain in location, no title
    non_streaming_response = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "citationsContent": {
                            "content": [{"text": "Top shoe brands include Nike and Adidas."}],
                            "citations": [
                                {
                                    "location": {
                                        "web": {
                                            "url": "https://example.com/shoes",
                                            "domain": "example.com",
                                        }
                                    },
                                },
                            ],
                        }
                    }
                ],
            }
        },
        "stopReason": "end_turn",
        "usage": {"inputTokens": 10, "outputTokens": 20},
    }

    events = list(model.convert_non_streaming_to_streaming(non_streaming_response))

    # Should have: messageStart, contentBlockDelta (text + citation), contentBlockStop, messageStop, metadata
    citation_deltas = [
        e for e in events if "contentBlockDelta" in e and "citation" in e.get("contentBlockDelta", {}).get("delta", {})
    ]
    assert len(citation_deltas) == 1

    citation = citation_deltas[0]["contentBlockDelta"]["delta"]["citation"]
    # title should NOT be present since the source didn't have it
    assert "title" not in citation
    # location should be present
    assert "location" in citation
    # sourceContent should NOT be present since the source didn't have it
    assert "sourceContent" not in citation


@pytest.mark.asyncio
async def test_non_streaming_citations_with_all_fields_present(bedrock_client, model, alist):
    """Test that convert_non_streaming_to_streaming correctly includes all fields when present."""
    non_streaming_response = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "citationsContent": {
                            "content": [{"text": "Nike is a top shoe brand."}],
                            "citations": [
                                {
                                    "title": "Top Shoe Brands",
                                    "location": {
                                        "web": {
                                            "url": "https://example.com/shoes",
                                            "domain": "example.com",
                                        }
                                    },
                                    "sourceContent": [{"text": "Nike is a leading brand"}],
                                },
                            ],
                        }
                    }
                ],
            }
        },
        "stopReason": "end_turn",
        "usage": {"inputTokens": 10, "outputTokens": 20},
    }

    events = list(model.convert_non_streaming_to_streaming(non_streaming_response))

    citation_deltas = [
        e for e in events if "contentBlockDelta" in e and "citation" in e.get("contentBlockDelta", {}).get("delta", {})
    ]
    assert len(citation_deltas) == 1

    citation = citation_deltas[0]["contentBlockDelta"]["delta"]["citation"]
    assert citation["title"] == "Top Shoe Brands"
    assert citation["location"] == {"web": {"url": "https://example.com/shoes", "domain": "example.com"}}
    assert citation["sourceContent"] == [{"text": "Nike is a leading brand"}]


@pytest.mark.asyncio
async def test_non_streaming_citations_with_only_location(bedrock_client, model, alist):
    """Test citations with only location field (no title, no sourceContent)."""
    non_streaming_response = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "citationsContent": {
                            "citations": [
                                {
                                    "location": {
                                        "web": {
                                            "url": "https://example.com",
                                            "domain": "example.com",
                                        }
                                    },
                                },
                            ],
                        }
                    }
                ],
            }
        },
        "stopReason": "end_turn",
        "usage": {"inputTokens": 5, "outputTokens": 10},
    }

    events = list(model.convert_non_streaming_to_streaming(non_streaming_response))

    citation_deltas = [
        e for e in events if "contentBlockDelta" in e and "citation" in e.get("contentBlockDelta", {}).get("delta", {})
    ]
    assert len(citation_deltas) == 1

    citation = citation_deltas[0]["contentBlockDelta"]["delta"]["citation"]
    assert citation["location"] == {"web": {"url": "https://example.com", "domain": "example.com"}}
    assert "title" not in citation
    assert "sourceContent" not in citation


def test_non_streaming_reasoning_content_with_reasoning_text(bedrock_client, model):
    """Test that convert_non_streaming_to_streaming handles reasoningContent with reasoningText."""
    non_streaming_response = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "reasoningContent": {
                            "reasoningText": {
                                "text": "Let me think about this...",
                                "signature": "sig-abc123",
                            }
                        }
                    }
                ],
            }
        },
        "stopReason": "end_turn",
        "usage": {"inputTokens": 10, "outputTokens": 20},
    }

    events = list(model.convert_non_streaming_to_streaming(non_streaming_response))

    reasoning_deltas = [
        event
        for event in events
        if "contentBlockDelta" in event and "reasoningContent" in event.get("contentBlockDelta", {}).get("delta", {})
    ]
    assert len(reasoning_deltas) == 2

    assert reasoning_deltas[0]["contentBlockDelta"]["delta"]["reasoningContent"] == {
        "text": "Let me think about this..."
    }
    assert reasoning_deltas[1]["contentBlockDelta"]["delta"]["reasoningContent"] == {"signature": "sig-abc123"}


def test_non_streaming_reasoning_content_without_signature(bedrock_client, model):
    """Test that convert_non_streaming_to_streaming handles reasoningContent without a signature."""
    non_streaming_response = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "reasoningContent": {
                            "reasoningText": {
                                "text": "Let me think about this...",
                            }
                        }
                    }
                ],
            }
        },
        "stopReason": "end_turn",
        "usage": {"inputTokens": 10, "outputTokens": 20},
    }

    events = list(model.convert_non_streaming_to_streaming(non_streaming_response))

    reasoning_deltas = [
        event
        for event in events
        if "contentBlockDelta" in event and "reasoningContent" in event.get("contentBlockDelta", {}).get("delta", {})
    ]
    assert len(reasoning_deltas) == 1
    assert reasoning_deltas[0]["contentBlockDelta"]["delta"]["reasoningContent"] == {
        "text": "Let me think about this..."
    }


def test_non_streaming_reasoning_content_with_empty_reasoning_text(bedrock_client, model):
    """Test that convert_non_streaming_to_streaming handles reasoningText without text or signature."""
    non_streaming_response = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "reasoningContent": {
                            "reasoningText": {}
                        }
                    }
                ],
            }
        },
        "stopReason": "end_turn",
        "usage": {"inputTokens": 5, "outputTokens": 10},
    }

    events = list(model.convert_non_streaming_to_streaming(non_streaming_response))

    reasoning_deltas = [
        event
        for event in events
        if "contentBlockDelta" in event and "reasoningContent" in event.get("contentBlockDelta", {}).get("delta", {})
    ]
    assert len(reasoning_deltas) == 0


def test_non_streaming_reasoning_content_with_redacted_content(bedrock_client, model):
    """Test that convert_non_streaming_to_streaming handles reasoningContent with redactedContent."""
    non_streaming_response = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "reasoningContent": {
                            "redactedContent": b"redacted-bytes",
                        }
                    }
                ],
            }
        },
        "stopReason": "end_turn",
        "usage": {"inputTokens": 5, "outputTokens": 10},
    }

    events = list(model.convert_non_streaming_to_streaming(non_streaming_response))

    reasoning_deltas = [
        event
        for event in events
        if "contentBlockDelta" in event and "reasoningContent" in event.get("contentBlockDelta", {}).get("delta", {})
    ]
    assert len(reasoning_deltas) == 1
    assert reasoning_deltas[0]["contentBlockDelta"]["delta"]["reasoningContent"] == {
        "redactedContent": b"redacted-bytes"
    }


class TestCountTokens:
    """Tests for BedrockModel.count_tokens native token counting."""

    @pytest.fixture(autouse=True)
    def clean_cache(self):
        _clear_skip_count_tokens_cache()
        yield
        _clear_skip_count_tokens_cache()

    @pytest.fixture
    def model_with_client(self, bedrock_client, model_id):
        _ = bedrock_client
        return BedrockModel(model_id=model_id, use_native_token_count=True)

    @pytest.fixture
    def messages(self):
        return [{"role": "user", "content": [{"text": "hello"}]}]

    @pytest.fixture
    def tool_specs(self):
        return [
            {
                "name": "test_tool",
                "description": "A test tool",
                "inputSchema": {"json": {"type": "object", "properties": {}}},
            }
        ]

    @pytest.mark.asyncio
    async def test_native_count_tokens_success(self, model_with_client, bedrock_client, messages):
        bedrock_client.count_tokens.return_value = {"inputTokens": 42}

        result = await model_with_client.count_tokens(messages=messages)

        assert result == 42
        bedrock_client.count_tokens.assert_called_once()
        call_kwargs = bedrock_client.count_tokens.call_args[1]
        assert "input" in call_kwargs
        assert "converse" in call_kwargs["input"]

    @pytest.mark.asyncio
    async def test_native_count_tokens_with_system_prompt(self, model_with_client, bedrock_client, messages):
        bedrock_client.count_tokens.return_value = {"inputTokens": 55}

        result = await model_with_client.count_tokens(messages=messages, system_prompt="Be helpful.")

        assert result == 55
        call_kwargs = bedrock_client.count_tokens.call_args[1]
        assert call_kwargs["input"]["converse"]["system"] == [{"text": "Be helpful."}]
        assert "toolConfig" not in call_kwargs["input"]["converse"]

    @pytest.mark.asyncio
    async def test_native_count_tokens_with_tool_specs(self, model_with_client, bedrock_client, messages, tool_specs):
        bedrock_client.count_tokens.return_value = {"inputTokens": 100}

        result = await model_with_client.count_tokens(messages=messages, tool_specs=tool_specs)

        assert result == 100
        call_kwargs = bedrock_client.count_tokens.call_args[1]
        assert "toolConfig" in call_kwargs["input"]["converse"]

    @pytest.mark.asyncio
    async def test_native_count_tokens_with_system_prompt_content(self, model_with_client, bedrock_client, messages):
        bedrock_client.count_tokens.return_value = {"inputTokens": 60}

        result = await model_with_client.count_tokens(
            messages=messages,
            system_prompt_content=[{"text": "Be helpful."}, {"text": "Be concise."}],
        )

        assert result == 60
        call_kwargs = bedrock_client.count_tokens.call_args[1]
        assert call_kwargs["input"]["converse"]["system"] == [{"text": "Be helpful."}, {"text": "Be concise."}]

    @pytest.mark.asyncio
    async def test_native_count_tokens_strips_inference_config(self, model_with_client, bedrock_client, messages):
        bedrock_client.count_tokens.return_value = {"inputTokens": 10}
        model_with_client.update_config(max_tokens=100)

        await model_with_client.count_tokens(messages=messages)

        call_kwargs = bedrock_client.count_tokens.call_args[1]
        converse = call_kwargs["input"]["converse"]
        assert "inferenceConfig" not in converse
        assert "additionalModelRequestFields" not in converse
        assert "guardrailConfig" not in converse

    @pytest.mark.asyncio
    async def test_fallback_on_api_error(self, model_with_client, bedrock_client, messages):
        bedrock_client.count_tokens.side_effect = ClientError(
            {"Error": {"Code": "ValidationException", "Message": "Unsupported"}},
            "CountTokens",
        )

        result = await model_with_client.count_tokens(messages=messages)

        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_fallback_on_generic_exception(self, model_with_client, bedrock_client, messages):
        bedrock_client.count_tokens.side_effect = RuntimeError("Connection failed")

        result = await model_with_client.count_tokens(messages=messages)

        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_fallback_on_none_input_tokens(self, model_with_client, bedrock_client, messages):
        bedrock_client.count_tokens.return_value = {}

        result = await model_with_client.count_tokens(messages=messages)

        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_fallback_logs_debug(self, model_with_client, bedrock_client, messages, caplog):
        bedrock_client.count_tokens.side_effect = RuntimeError("API down")

        with caplog.at_level(logging.DEBUG, logger="strands.models.bedrock"):
            await model_with_client.count_tokens(messages=messages)

        assert any("native token counting failed" in record.message for record in caplog.records)

    @pytest.mark.asyncio
    async def test_caches_model_id_when_count_tokens_unsupported(self, bedrock_client, messages):
        model = BedrockModel(model_id="unsupported-cache-test-model", use_native_token_count=True)
        bedrock_client.count_tokens.side_effect = ClientError(
            {"Error": {"Code": "ValidationException", "Message": "The provided model doesn't support counting tokens"}},
            "CountTokens",
        )

        # First call: hits API, gets error, caches
        await model.count_tokens(messages=messages)
        assert bedrock_client.count_tokens.call_count == 1

        # Second call: skips API entirely
        await model.count_tokens(messages=messages)
        assert bedrock_client.count_tokens.call_count == 1

    @pytest.mark.asyncio
    async def test_caches_model_id_when_access_denied(self, bedrock_client, messages):
        model = BedrockModel(model_id="access-denied-cache-test-model", use_native_token_count=True)
        bedrock_client.count_tokens.side_effect = ClientError(
            {
                "Error": {
                    "Code": "AccessDeniedException",
                    "Message": "User: arn:aws:sts::123456789012:assumed-role/role is not authorized"
                    " to perform: bedrock:CountTokens",
                }
            },
            "CountTokens",
        )

        # First call: hits API, gets error, caches
        await model.count_tokens(messages=messages)
        bedrock_client.count_tokens.assert_called_once()

        # Reset mock to clearly verify second call doesn't hit the API
        bedrock_client.count_tokens.reset_mock()

        # Second call: skips API entirely due to caching
        result = await model.count_tokens(messages=messages)
        bedrock_client.count_tokens.assert_not_called()
        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_access_denied_logs_warning_with_full_error(
        self, model_with_client, bedrock_client, messages, caplog
    ):
        error_message = (
            "User: arn:aws:sts::123456789012:assumed-role/role is not authorized to perform: bedrock:CountTokens"
        )
        bedrock_client.count_tokens.side_effect = ClientError(
            {"Error": {"Code": "AccessDeniedException", "Message": error_message}},
            "CountTokens",
        )

        with caplog.at_level(logging.WARNING, logger="strands.models.bedrock"):
            await model_with_client.count_tokens(messages=messages)

        warning_records = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warning_records) == 1
        assert "bedrock:CountTokens permission denied" in warning_records[0].message
        assert error_message in warning_records[0].message

    @pytest.mark.asyncio
    async def test_does_not_cache_model_id_for_other_errors(self, bedrock_client, messages):
        model = BedrockModel(model_id="transient-error-test-model", use_native_token_count=True)
        bedrock_client.count_tokens.side_effect = RuntimeError("Transient network error")

        await model.count_tokens(messages=messages)
        assert bedrock_client.count_tokens.call_count == 1

        # Second call should still attempt the API
        await model.count_tokens(messages=messages)
        assert bedrock_client.count_tokens.call_count == 2

    @pytest.mark.asyncio
    async def test_skip_native_api_when_use_native_token_count_false(self, bedrock_client, model_id, messages):
        _ = bedrock_client
        model = BedrockModel(model_id=model_id, use_native_token_count=False)

        result = await model.count_tokens(messages=messages)

        bedrock_client.count_tokens.assert_not_called()
        assert isinstance(result, int)
        assert result >= 0

    @pytest.mark.asyncio
    async def test_skip_native_api_by_default(self, bedrock_client, model_id, messages):
        _ = bedrock_client
        model = BedrockModel(model_id=model_id)

        result = await model.count_tokens(messages=messages)

        bedrock_client.count_tokens.assert_not_called()
        assert isinstance(result, int)
        assert result >= 0


def test_inject_cache_point_with_ttl(bedrock_client):
    """Test that _inject_cache_point includes TTL when cache_config has ttl set."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto", ttl="5m"),
    )

    cleaned_messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
    ]

    model._inject_cache_point(cleaned_messages)

    cache_point = cleaned_messages[0]["content"][-1]["cachePoint"]
    assert cache_point["type"] == "default"
    assert cache_point["ttl"] == "5m"


def test_inject_cache_point_without_ttl(bedrock_client):
    """Test that _inject_cache_point omits TTL when cache_config has no ttl."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto"),
    )

    cleaned_messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
    ]

    model._inject_cache_point(cleaned_messages)

    cache_point = cleaned_messages[0]["content"][-1]["cachePoint"]
    assert cache_point["type"] == "default"
    assert "ttl" not in cache_point


def test_format_request_cache_tools_config_with_ttl(model, messages, model_id, tool_spec, cache_type):
    """Test that CacheToolsConfig propagates type and ttl into toolConfig cachePoint."""
    model.update_config(cache_tools=CacheToolsConfig(type=cache_type, ttl="5m"))

    tru_request = model.format_request(messages, tool_specs=[tool_spec])

    exp_cache_point = {"cachePoint": {"type": cache_type, "ttl": "5m"}}
    assert tru_request["toolConfig"]["tools"][-1] == exp_cache_point


def test_format_request_cache_tools_config_without_ttl(model, messages, model_id, tool_spec, cache_type):
    """Test that CacheToolsConfig without ttl produces a cachePoint with only type."""
    model.update_config(cache_tools=CacheToolsConfig(type=cache_type))

    tru_request = model.format_request(messages, tool_specs=[tool_spec])

    exp_cache_point = {"cachePoint": {"type": cache_type}}
    assert tru_request["toolConfig"]["tools"][-1] == exp_cache_point


def test_format_request_cache_tools_string_backward_compat(model, messages, model_id, tool_spec, cache_type):
    """Test that passing cache_tools as a string still produces a cachePoint with only type."""
    with pytest.warns(DeprecationWarning, match="cache_tools is deprecated"):
        model.update_config(cache_tools=cache_type)

        tru_request = model.format_request(messages, tool_specs=[tool_spec])

    exp_cache_point = {"cachePoint": {"type": cache_type}}
    assert tru_request["toolConfig"]["tools"][-1] == exp_cache_point


def test_format_request_cache_tools_emits_deprecation_warning(model, messages, tool_spec):
    """cache_tools is deprecated in favor of CacheConfig(tools_ttl=...); setting it warns."""
    with pytest.warns(DeprecationWarning, match="cache_tools is deprecated. Use CacheConfig"):
        model.update_config(cache_tools="default")


def test_format_request_tools_ttl_true_derives_from_shared_ttl(bedrock_client, messages, tool_spec):
    """tools_ttl=True mirrors system_prompt_ttl: it derives the tools section duration from cache_config.ttl."""
    _ = bedrock_client
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto", ttl="1h", tools_ttl=True),
    )

    tru_point = model.format_request(messages, tool_specs=[tool_spec])["toolConfig"]["tools"][-1]

    assert tru_point == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_format_request_tools_ttl_string_sets_the_section_duration(bedrock_client, messages, tool_spec):
    """A tools_ttl string sets the tools section's own duration rather than deriving from the shared ttl."""
    _ = bedrock_client
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto", ttl="1h", tools_ttl="5m"),
    )

    tru_point = model.format_request(messages, tool_specs=[tool_spec])["toolConfig"]["tools"][-1]

    assert tru_point == {"cachePoint": {"type": "default", "ttl": "5m"}}


def test_format_request_tools_ttl_string_stands_the_system_point_down(bedrock_client, messages, tool_spec):
    """A shorter tools_ttl leaves the auto system cache point at the provider default."""
    _ = bedrock_client
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto", ttl="1h", tools_ttl="5m"),
    )

    request = model.format_request(messages, tool_specs=[tool_spec], system_prompt_content=[{"text": "static"}])

    assert request["toolConfig"]["tools"][-1] == {"cachePoint": {"type": "default", "ttl": "5m"}}
    assert {"cachePoint": {"type": "default"}} in request["system"]


def test_format_request_tools_ttl_true_without_shared_ttl_stays_untimed(bedrock_client, messages, tool_spec):
    """With nothing to derive from, tools_ttl=True still caches the tools but at the provider default."""
    _ = bedrock_client
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto", tools_ttl=True),
    )

    tru_point = model.format_request(messages, tool_specs=[tool_spec])["toolConfig"]["tools"][-1]

    assert tru_point == {"cachePoint": {"type": "default"}}


def test_format_request_tools_ttl_false_disables_the_tools_cache_point(bedrock_client, messages, tool_spec):
    """tools_ttl=False disables tool caching even when the shared ttl is set."""
    _ = bedrock_client
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto", ttl="1h", tools_ttl=False),
    )

    tru_request = model.format_request(messages, tool_specs=[tool_spec])

    assert not any("cachePoint" in tool for tool in tru_request["toolConfig"]["tools"])


def test_format_request_tools_ttl_defaults_to_off(bedrock_client, messages, tool_spec):
    """tools_ttl defaults to None (unset), so cache_config alone does not cache the tools yet."""
    _ = bedrock_client
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto", ttl="1h"),
    )

    tru_request = model.format_request(messages, tool_specs=[tool_spec])

    assert not any("cachePoint" in tool for tool in tru_request["toolConfig"]["tools"])


def test_format_request_tools_ttl_is_off_for_a_model_without_caching(bedrock_client, messages, tool_spec):
    """tools_ttl only reaches the wire under an active anthropic strategy, matching the tools point rule."""
    _ = bedrock_client
    model = BedrockModel(
        model_id="amazon.nova-pro-v1:0",
        cache_config=CacheConfig(strategy="auto", ttl="1h", tools_ttl=True),
    )

    tru_request = model.format_request(messages, tool_specs=[tool_spec])

    assert not any("cachePoint" in tool for tool in tru_request["toolConfig"]["tools"])


def test_format_request_tools_ttl_takes_precedence_over_deprecated_cache_tools(bedrock_client, messages, tool_spec):
    """An explicitly set tools_ttl wins over the deprecated cache_tools when both are set."""
    _ = bedrock_client
    with pytest.warns(DeprecationWarning, match="cache_tools is deprecated"):
        model = BedrockModel(
            model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
            cache_config=CacheConfig(strategy="auto", ttl="1h", tools_ttl="5m"),
            cache_tools=CacheToolsConfig(ttl="1h"),
        )

    tru_point = model.format_request(messages, tool_specs=[tool_spec])["toolConfig"]["tools"][-1]

    assert tru_point == {"cachePoint": {"type": "default", "ttl": "5m"}}


def test_format_request_tools_ttl_false_overrides_deprecated_cache_tools(bedrock_client, messages, tool_spec):
    """tools_ttl=False disables tool caching even when the deprecated cache_tools is set."""
    _ = bedrock_client
    with pytest.warns(DeprecationWarning, match="cache_tools is deprecated"):
        model = BedrockModel(
            model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
            cache_config=CacheConfig(strategy="auto", ttl="1h", tools_ttl=False),
            cache_tools=CacheToolsConfig(ttl="1h"),
        )

    tru_request = model.format_request(messages, tool_specs=[tool_spec])

    assert not any("cachePoint" in tool for tool in tru_request["toolConfig"]["tools"])


def test_format_request_auto_skips_tools_cache_point_for_a_model_without_caching(bedrock_client, messages, tool_spec):
    """cache_tools follows the resolved strategy: auto on a non-Anthropic model emits no tools cache point.

    Regression guard for https://github.com/strands-agents/harness-sdk/issues/4168.
    """
    _ = bedrock_client
    with pytest.warns(DeprecationWarning, match="cache_tools is deprecated"):
        model = BedrockModel(
            model_id="amazon.nova-pro-v1:0",
            cache_config=CacheConfig(strategy="auto"),
            cache_tools=CacheToolsConfig(ttl="1h"),
        )

    tru_request = model.format_request(messages, tool_specs=[tool_spec])

    assert not any("cachePoint" in tool for tool in tru_request["toolConfig"]["tools"])


def test_format_request_auto_keeps_tools_cache_point_for_a_claude_model(bedrock_client, messages, tool_spec):
    """cache_config resolving to anthropic leaves the deprecated cache_tools point in place."""
    _ = bedrock_client
    with pytest.warns(DeprecationWarning, match="cache_tools is deprecated"):
        model = BedrockModel(
            model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
            cache_config=CacheConfig(strategy="auto"),
            cache_tools=CacheToolsConfig(ttl="1h"),
        )

    tru_point = model.format_request(messages, tool_specs=[tool_spec])["toolConfig"]["tools"][-1]

    assert tru_point == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_format_request_auto_cache_tools_inherits_shared_ttl_for_a_claude_model(bedrock_client, messages, tool_spec):
    """A cache_tools point with no ttl of its own still inherits cache_config.ttl under an active strategy."""
    _ = bedrock_client
    with pytest.warns(DeprecationWarning, match="cache_tools is deprecated"):
        model = BedrockModel(
            model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
            cache_config=CacheConfig(strategy="auto", ttl="1h"),
            cache_tools=CacheToolsConfig(),
        )

    tru_point = model.format_request(messages, tool_specs=[tool_spec])["toolConfig"]["tools"][-1]

    assert tru_point == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_format_request_applies_the_configured_ttl_to_a_system_cache_point(bedrock_client, messages):
    """Bedrock rejects a TTL that exceeds an earlier checkpoint's, so a configured ttl that reached the
    message cache point but not the system point ahead of it would emit an invalid request.
    """
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"))
    system_blocks = [{"text": "durable system prompt"}, {"cachePoint": {"type": "default"}}]

    tru_system = model.format_request(messages, system_prompt_content=system_blocks)["system"]

    exp_system = [{"text": "durable system prompt"}, {"cachePoint": {"type": "default", "ttl": "1h"}}]
    assert tru_system == exp_system


def test_format_request_falls_through_an_empty_system_cache_point_ttl_to_the_configured_one(bedrock_client, messages):
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"))
    system_blocks = [{"text": "s"}, {"cachePoint": {"type": "default", "ttl": ""}}]

    tru_point = model.format_request(messages, system_prompt_content=system_blocks)["system"][1]

    exp_point = {"cachePoint": {"type": "default", "ttl": "1h"}}
    assert tru_point == exp_point


def test_format_request_leaves_a_system_cache_point_ttl_the_caller_wrote(bedrock_client, messages):
    """Two conflicting TTLs are the caller's to reconcile; only an absent one is filled in."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"))
    system_blocks = [{"text": "s"}, {"cachePoint": {"type": "default", "ttl": "5m"}}]

    tru_point = model.format_request(messages, system_prompt_content=system_blocks)["system"][1]

    exp_point = {"cachePoint": {"type": "default", "ttl": "5m"}}
    assert tru_point == exp_point


def test_format_request_leaves_a_system_cache_point_alone_when_no_ttl_is_configured(bedrock_client, messages):
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"))
    system_blocks = [{"text": "s"}, {"cachePoint": {"type": "default"}}]

    tru_point = model.format_request(messages, system_prompt_content=system_blocks)["system"][1]

    exp_point = {"cachePoint": {"type": "default"}}
    assert tru_point == exp_point


def test_format_request_leaves_a_system_cache_point_alone_for_a_model_without_caching(bedrock_client, messages):
    """A config that never reaches the wire must not reach the system point either."""
    _ = bedrock_client
    model = BedrockModel(model_id="meta.llama3-70b-instruct-v1:0", cache_config=CacheConfig(ttl="1h"))
    system_blocks = [{"text": "s"}, {"cachePoint": {"type": "default"}}]

    tru_point = model.format_request(messages, system_prompt_content=system_blocks)["system"][1]

    exp_point = {"cachePoint": {"type": "default"}}
    assert tru_point == exp_point


def test_format_request_does_not_mutate_the_system_blocks_the_caller_owns(bedrock_client, messages):
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"))
    cache_point = {"type": "default"}
    system_blocks = [{"text": "s"}, {"cachePoint": cache_point}]

    tru_point = model.format_request(messages, system_prompt_content=system_blocks)["system"][1]

    assert tru_point == {"cachePoint": {"type": "default", "ttl": "1h"}}
    assert cache_point == {"type": "default"}


def test_format_request_leaves_a_system_cache_point_alone_behind_a_shorter_tools_ttl(
    bedrock_client, messages, tool_spec
):
    """Bedrock rejects a TTL longer than an earlier checkpoint's, so filling the configured ttl in behind a
    shorter tools TTL would trade one rejected request for another.
    """
    _ = bedrock_client
    model = BedrockModel(
        cache_config=CacheConfig(strategy="anthropic", ttl="1h"), cache_tools=CacheToolsConfig(ttl="5m")
    )
    system_blocks = [{"text": "s"}, {"cachePoint": {"type": "default"}}]

    tru_request = model.format_request(messages, tool_specs=[tool_spec], system_prompt_content=system_blocks)

    assert tru_request["toolConfig"]["tools"][-1] == {"cachePoint": {"type": "default", "ttl": "5m"}}
    assert tru_request["system"][1] == {"cachePoint": {"type": "default"}}


def test_format_request_fills_the_configured_ttl_into_an_untimed_tools_cache_point(bedrock_client, messages, tool_spec):
    """The tools point is first in Bedrock's order, so an untimed one takes the provider default that a
    configured ttl on a later checkpoint would exceed. Filling it in keeps every checkpoint in step.
    """
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"), cache_tools="default")
    system_blocks = [{"text": "s"}, {"cachePoint": {"type": "default"}}]

    tru_request = model.format_request(messages, tool_specs=[tool_spec], system_prompt_content=system_blocks)

    assert tru_request["toolConfig"]["tools"][-1] == {"cachePoint": {"type": "default", "ttl": "1h"}}
    assert tru_request["system"][1] == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_format_request_fills_the_configured_ttl_into_an_untimed_cache_tools_config(
    bedrock_client, messages, tool_spec
):
    """A CacheToolsConfig without a TTL is untimed just like the bare string, so it inherits the same fill-in."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"), cache_tools=CacheToolsConfig())

    tru_point = model.format_request(messages, tool_specs=[tool_spec])["toolConfig"]["tools"][-1]

    assert tru_point == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_format_request_fills_an_empty_cache_tools_ttl_rather_than_shipping_it(bedrock_client, messages, tool_spec):
    """A falsy TTL is not a TTL, so an empty one is filled in rather than sent as "", which Bedrock rejects."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"), cache_tools=CacheToolsConfig(ttl=""))

    tru_point = model.format_request(messages, tool_specs=[tool_spec])["toolConfig"]["tools"][-1]

    assert tru_point == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_format_request_leaves_a_tools_cache_point_ttl_the_caller_wrote(bedrock_client, messages, tool_spec):
    """A TTL the caller wrote on cache_tools is theirs; only an absent one is filled in."""
    _ = bedrock_client
    model = BedrockModel(
        cache_config=CacheConfig(strategy="anthropic", ttl="1h"), cache_tools=CacheToolsConfig(ttl="5m")
    )

    tru_point = model.format_request(messages, tool_specs=[tool_spec])["toolConfig"]["tools"][-1]

    assert tru_point == {"cachePoint": {"type": "default", "ttl": "5m"}}


def test_format_request_leaves_a_tools_cache_point_alone_for_a_model_without_caching(
    bedrock_client, messages, tool_spec
):
    """A config that never reaches the wire must not reach the tools point either."""
    _ = bedrock_client
    model = BedrockModel(
        model_id="meta.llama3-70b-instruct-v1:0", cache_config=CacheConfig(ttl="1h"), cache_tools="default"
    )

    tru_request = model.format_request(messages, tool_specs=[tool_spec])

    assert not any("cachePoint" in tool for tool in tru_request["toolConfig"]["tools"])


def test_format_request_leaves_a_tools_cache_point_alone_for_an_empty_configured_ttl(
    bedrock_client, messages, tool_spec
):
    """An empty configured ttl is unconfigured, so it does not fill the tools point in."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl=""), cache_tools="default")

    tru_point = model.format_request(messages, tool_specs=[tool_spec])["toolConfig"]["tools"][-1]

    assert tru_point == {"cachePoint": {"type": "default"}}


def test_format_request_leaves_a_tools_cache_point_alone_when_no_ttl_is_configured(bedrock_client, messages, tool_spec):
    """Without a configured ttl there is nothing to inherit, so a bare cache_tools stays untimed."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic"), cache_tools="default")

    tru_point = model.format_request(messages, tool_specs=[tool_spec])["toolConfig"]["tools"][-1]

    assert tru_point == {"cachePoint": {"type": "default"}}


def test_format_request_applies_the_configured_ttl_behind_a_matching_tools_ttl(bedrock_client, messages, tool_spec):
    _ = bedrock_client
    model = BedrockModel(
        cache_config=CacheConfig(strategy="anthropic", ttl="1h"), cache_tools=CacheToolsConfig(ttl="1h")
    )
    system_blocks = [{"text": "s"}, {"cachePoint": {"type": "default"}}]

    tru_request = model.format_request(messages, tool_specs=[tool_spec], system_prompt_content=system_blocks)

    assert tru_request["system"][1] == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_format_request_applies_the_configured_ttl_when_the_request_carries_no_tools(bedrock_client, messages):
    """No tool specs means no tools checkpoint ahead of the system one, so nothing constrains the fill-in."""
    _ = bedrock_client
    model = BedrockModel(
        cache_config=CacheConfig(strategy="anthropic", ttl="1h"), cache_tools=CacheToolsConfig(ttl="5m")
    )
    system_blocks = [{"text": "s"}, {"cachePoint": {"type": "default"}}]

    tru_point = model.format_request(messages, system_prompt_content=system_blocks)["system"][1]

    assert tru_point == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_format_request_drops_an_empty_system_cache_point_ttl_when_none_is_configured(bedrock_client, messages):
    """A falsy TTL is not a TTL: Bedrock validates ttl against an enum and rejects "".

    The fill-in does not apply here, so normalizing is the only thing standing between a caller's empty
    TTL and a rejected request.
    """
    _ = bedrock_client
    model = BedrockModel()
    system_blocks = [{"text": "s"}, {"cachePoint": {"type": "default", "ttl": ""}}]

    tru_point = model.format_request(messages, system_prompt_content=system_blocks)["system"][1]

    assert tru_point == {"cachePoint": {"type": "default"}}


def test_format_request_drops_an_empty_system_cache_point_ttl_behind_a_shorter_tools_ttl(
    bedrock_client, messages, tool_spec
):
    """The fill-in stands down behind a shorter tools TTL, but the caller's empty TTL still must not ship."""
    _ = bedrock_client
    model = BedrockModel(
        cache_config=CacheConfig(strategy="anthropic", ttl="1h"), cache_tools=CacheToolsConfig(ttl="5m")
    )
    system_blocks = [{"text": "s"}, {"cachePoint": {"type": "default", "ttl": ""}}]

    tru_request = model.format_request(messages, tool_specs=[tool_spec], system_prompt_content=system_blocks)

    assert tru_request["toolConfig"]["tools"][-1] == {"cachePoint": {"type": "default", "ttl": "5m"}}
    assert tru_request["system"][1] == {"cachePoint": {"type": "default"}}


def test_format_request_drops_a_null_system_cache_point_ttl(bedrock_client, messages):
    """botocore rejects a null ttl before the request is even sent, so it is dropped like an empty one."""
    _ = bedrock_client
    model = BedrockModel()
    system_blocks = [{"text": "s"}, {"cachePoint": {"type": "default", "ttl": None}}]

    tru_point = model.format_request(messages, system_prompt_content=system_blocks)["system"][1]

    assert tru_point == {"cachePoint": {"type": "default"}}


def test_format_request_does_not_mutate_a_system_cache_point_it_normalizes(bedrock_client, messages):
    """The caller owns the block, so dropping their empty TTL must not reach back into their own dict."""
    _ = bedrock_client
    model = BedrockModel()
    cache_point = {"type": "default", "ttl": ""}
    system_blocks = [{"text": "s"}, {"cachePoint": cache_point}]

    tru_point = model.format_request(messages, system_prompt_content=system_blocks)["system"][1]

    assert tru_point == {"cachePoint": {"type": "default"}}
    assert cache_point == {"type": "default", "ttl": ""}


def test_format_request_passes_an_empty_system_cache_point_through(bedrock_client, messages):
    """An off-type cache point is the provider's to reject, not something to raise on while formatting."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"))
    system_blocks = [{"text": "s"}, {"cachePoint": None}]

    tru_system = model.format_request(messages, system_prompt_content=system_blocks)["system"]

    assert tru_system == [{"text": "s"}, {"cachePoint": None}]


def test_format_request_applies_the_configured_ttl_to_every_system_cache_point(bedrock_client, messages):
    """Every checkpoint has to move together; a TTL on only the first would leave the rest behind it."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl="1h"))
    system_blocks = [
        {"text": "a"},
        {"cachePoint": {"type": "default"}},
        {"text": "b"},
        {"cachePoint": {"type": "default"}},
    ]

    tru_system = model.format_request(messages, system_prompt_content=system_blocks)["system"]

    exp_system = [
        {"text": "a"},
        {"cachePoint": {"type": "default", "ttl": "1h"}},
        {"text": "b"},
        {"cachePoint": {"type": "default", "ttl": "1h"}},
    ]
    assert tru_system == exp_system


def test_format_request_treats_an_empty_configured_ttl_as_unconfigured(bedrock_client, messages):
    """An empty TTL is not a TTL, so it must not reach the wire for the Bedrock enum to reject."""
    _ = bedrock_client
    model = BedrockModel(cache_config=CacheConfig(strategy="anthropic", ttl=""))
    system_blocks = [{"text": "s"}, {"cachePoint": {"type": "default"}}]

    tru_point = model.format_request(messages, system_prompt_content=system_blocks)["system"][1]

    exp_point = {"cachePoint": {"type": "default"}}
    assert tru_point == exp_point


def test_format_request_auto_appends_system_cache_point(bedrock_client, messages):
    """Auto mode appends a cachePoint after the system prompt for a Claude model.

    Regression guard for https://github.com/strands-agents/harness-sdk/issues/3144.
    """
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto"),
    )

    tru_request = model.format_request(messages, system_prompt_content=[{"text": "you are helpful"}])

    assert tru_request["system"] == [
        {"text": "you are helpful"},
        {"cachePoint": {"type": "default"}},
    ]


def test_format_request_auto_system_cache_point_honors_ttl(bedrock_client, messages):
    """Auto mode carries cache_config.ttl into the appended system cache point."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto", ttl="1h"),
    )

    tru_request = model.format_request(messages, system_prompt_content=[{"text": "static"}])

    assert tru_request["system"][-1] == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_format_request_auto_skips_system_cache_point_when_empty(bedrock_client, messages):
    """Auto mode does not inject a system cache point when the system prompt is empty."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto"),
    )

    tru_request = model.format_request(messages)

    assert tru_request["system"] == []


def test_format_request_auto_skips_system_cache_point_for_non_claude(bedrock_client, messages):
    """Auto mode does not inject a system cache point when the model has no auto strategy."""
    model = BedrockModel(
        model_id="amazon.nova-pro-v1:0",
        cache_config=CacheConfig(strategy="auto"),
    )

    tru_request = model.format_request(messages, system_prompt_content=[{"text": "static"}])

    assert tru_request["system"] == [{"text": "static"}]


def test_format_request_auto_preserves_caller_placed_system_cache_point(bedrock_client, messages):
    """Auto mode does not double-append when the caller already placed a trailing cachePoint."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto"),
    )

    system_blocks = [{"text": "static"}, {"cachePoint": {"type": "default", "ttl": "1h"}}]
    tru_request = model.format_request(messages, system_prompt_content=system_blocks)

    assert tru_request["system"] == [
        {"text": "static"},
        {"cachePoint": {"type": "default", "ttl": "1h"}},
    ]


def test_format_request_no_cache_config_leaves_system_untouched(bedrock_client, messages):
    """With no cache_config, the system prompt is passed through unchanged."""
    model = BedrockModel(model_id="us.anthropic.claude-sonnet-4-20250514-v1:0")

    tru_request = model.format_request(messages, system_prompt_content=[{"text": "static"}])

    assert tru_request["system"] == [{"text": "static"}]


def test_format_request_anthropic_strategy_appends_system_cache_point(bedrock_client, messages):
    """Explicit anthropic strategy also appends a system cache point, mirroring auto."""
    model = BedrockModel(
        model_id="arn:aws:bedrock:us-east-1:123:application-inference-profile/abc",
        cache_config=CacheConfig(strategy="anthropic"),
    )

    tru_request = model.format_request(messages, system_prompt_content=[{"text": "static"}])

    assert tru_request["system"][-1] == {"cachePoint": {"type": "default"}}


def test_format_request_auto_does_not_inject_system_cache_point_when_opted_out(bedrock_client, messages):
    """system_prompt_ttl=False disables only the auto-injected system point."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto", system_prompt_ttl=False),
    )

    tru_request = model.format_request(messages, system_prompt_content=[{"text": "static"}])

    assert tru_request["system"] == [{"text": "static"}]


def test_format_request_auto_honors_a_caller_placed_system_cache_point_anywhere(bedrock_client, messages):
    """A caller point anywhere in the system prefix is honored; no second point is appended."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto"),
    )

    system_blocks = [{"text": "static"}, {"cachePoint": {"type": "default"}}, {"text": "trailing"}]
    tru_request = model.format_request(messages, system_prompt_content=system_blocks)

    assert tru_request["system"] == [
        {"text": "static"},
        {"cachePoint": {"type": "default"}},
        {"text": "trailing"},
    ]


def test_format_request_auto_leaves_a_single_point_for_the_deprecated_cache_prompt(bedrock_client, messages):
    """The deprecated cache_prompt appends a point, so honor-anywhere must not add a second one."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto"),
        cache_prompt="default",
    )

    with pytest.warns(UserWarning, match="cache_prompt is deprecated"):
        tru_request = model.format_request(messages, system_prompt_content=[{"text": "static"}])

    assert tru_request["system"] == [{"text": "static"}, {"cachePoint": {"type": "default"}}]


def test_format_request_auto_stands_the_system_cache_point_down_behind_a_shorter_tools_ttl(
    bedrock_client, messages, tool_spec
):
    """The auto-injected system point must not land a longer TTL behind a shorter tools checkpoint.

    Guards the bare-inject path: writing cache_config.ttl onto the point at injection time would leave a
    longer TTL behind the 5m tools point and trip Bedrock's non-increasing rule.
    """
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto", ttl="1h"),
        cache_tools=CacheToolsConfig(ttl="5m"),
    )

    tru_request = model.format_request(messages, tool_specs=[tool_spec], system_prompt_content=[{"text": "static"}])

    assert tru_request["toolConfig"]["tools"][-1] == {"cachePoint": {"type": "default", "ttl": "5m"}}
    assert tru_request["system"] == [{"text": "static"}, {"cachePoint": {"type": "default"}}]


def test_format_request_auto_system_prompt_ttl_string_sets_the_section_duration(bedrock_client, messages):
    """A system_prompt_ttl string sets the system section's own duration rather than deriving from the shared ttl."""
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto", system_prompt_ttl="1h"),
    )

    tru_request = model.format_request(messages, system_prompt_content=[{"text": "static"}])

    assert tru_request["system"][-1] == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_format_request_auto_system_prompt_ttl_string_is_honored_behind_a_differing_tools_ttl(
    bedrock_client, messages, tool_spec
):
    """An explicit system_prompt_ttl string is honored verbatim, unlike a derived TTL which stands down.

    Mirrors the TS systemPromptTTL contract: the caller owns cross-section ordering when they set the string.
    """
    model = BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
        cache_config=CacheConfig(strategy="auto", ttl="5m", system_prompt_ttl="1h"),
        cache_tools=CacheToolsConfig(ttl="5m"),
    )

    tru_request = model.format_request(messages, tool_specs=[tool_spec], system_prompt_content=[{"text": "static"}])

    assert tru_request["toolConfig"]["tools"][-1] == {"cachePoint": {"type": "default", "ttl": "5m"}}
    assert tru_request["system"][-1] == {"cachePoint": {"type": "default", "ttl": "1h"}}


def test_nova_model_converts_json_to_text_in_tool_result(bedrock_client):
    """Nova models should convert JSON content blocks to text in tool results."""
    model = BedrockModel(model_id="us.amazon.nova-pro-v1:0")
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "content": [{"json": {"key": "value", "number": 42}}],
                        "toolUseId": "tool123",
                    }
                }
            ],
        }
    ]

    formatted_request = model.format_request(messages)
    tool_result = formatted_request["messages"][0]["content"][0]["toolResult"]

    assert len(tool_result["content"]) == 1
    assert "text" in tool_result["content"][0]
    assert "json" not in tool_result["content"][0]
    assert tool_result["content"][0]["text"] == '{"key": "value", "number": 42}'


def test_nova_model_converts_mixed_json_and_text_in_tool_result(bedrock_client):
    """Nova models should convert JSON blocks while preserving text blocks."""
    model = BedrockModel(model_id="amazon.nova-lite-v1:0")
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "content": [
                            {"text": "Some text output"},
                            {"json": {"status": "ok"}},
                        ],
                        "toolUseId": "tool456",
                    }
                }
            ],
        }
    ]

    formatted_request = model.format_request(messages)
    tool_result = formatted_request["messages"][0]["content"][0]["toolResult"]

    assert len(tool_result["content"]) == 2
    assert tool_result["content"][0] == {"text": "Some text output"}
    assert tool_result["content"][1] == {"text": '{"status": "ok"}'}


def test_claude_model_preserves_json_in_tool_result(bedrock_client):
    """Claude models should preserve JSON content blocks as-is."""
    model = BedrockModel(model_id="us.anthropic.claude-sonnet-4-20250514-v1:0")
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "content": [{"json": {"key": "value"}}],
                        "toolUseId": "tool789",
                    }
                }
            ],
        }
    ]

    formatted_request = model.format_request(messages)
    tool_result = formatted_request["messages"][0]["content"][0]["toolResult"]

    assert len(tool_result["content"]) == 1
    assert "json" in tool_result["content"][0]
    assert tool_result["content"][0]["json"] == {"key": "value"}


def test_nova_model_handles_nested_json_in_tool_result(bedrock_client):
    """Nova models should handle deeply nested JSON structures."""
    model = BedrockModel(model_id="us.amazon.nova-pro-v1:0")
    nested_json = {
        "results": [
            {"id": 1, "data": {"nested": True}},
            {"id": 2, "data": {"nested": False}},
        ],
        "metadata": {"total": 2},
    }
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "content": [{"json": nested_json}],
                        "toolUseId": "tool_nested",
                    }
                }
            ],
        }
    ]

    formatted_request = model.format_request(messages)
    tool_result = formatted_request["messages"][0]["content"][0]["toolResult"]

    assert "text" in tool_result["content"][0]
    import json

    parsed = json.loads(tool_result["content"][0]["text"])
    assert parsed == nested_json


def test_should_convert_json_to_text_nova_variants(bedrock_client):
    """All Nova model ID variants should trigger JSON-to-text conversion."""
    nova_ids = [
        "amazon.nova-pro-v1:0",
        "us.amazon.nova-pro-v1:0",
        "amazon.nova-lite-v1:0",
        "amazon.nova-micro-v1:0",
    ]
    for model_id in nova_ids:
        model = BedrockModel(model_id=model_id)
        assert model._should_convert_json_to_text(), f"{model_id} should convert JSON to text"

    non_nova_ids = [
        "us.anthropic.claude-sonnet-4-20250514-v1:0",
        "amazon.titan-text-v1",
        "us.meta.llama3-1-70b-instruct-v1:0",
    ]
    for model_id in non_nova_ids:
        model = BedrockModel(model_id=model_id)
        assert not model._should_convert_json_to_text(), f"{model_id} should NOT convert JSON to text"


class _FakeEventStream:
    """Stand-in for botocore's ``EventStream``: iterable, closable, one chunk per gate release."""

    def __init__(self, chunks, gate=None, on_chunk=None):
        self.chunks = list(chunks)
        self.gate = gate
        self.on_chunk = on_chunk
        self.emitted = []
        self.closed = False

    def __iter__(self):
        for chunk in self.chunks:
            if self.gate is not None:
                self.gate.wait()
                self.gate.clear()

            self.emitted.append(chunk)
            if self.on_chunk is not None:
                self.on_chunk(chunk)

            yield chunk

    def close(self):
        self.closed = True


async def _wait_until(predicate, timeout=5.0):
    deadline = time.time() + timeout
    while not predicate():
        assert time.time() < deadline, "condition was not met before the timeout"
        await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_stream_cancel_signal_closes_event_stream(bedrock_client, model, messages):
    """A cancellation signal closes the Bedrock event stream instead of reading it to the end."""
    gate = threading.Event()
    event_stream = _FakeEventStream([{"chunk": index} for index in range(5)], gate=gate)
    bedrock_client.converse_stream.return_value = {"stream": event_stream}
    cancel_signal = threading.Event()

    chunks = []
    gate.set()
    async for chunk in model.stream(messages, cancel_signal=cancel_signal):
        chunks.append(chunk)
        cancel_signal.set()
        gate.set()

    await _wait_until(lambda: event_stream.closed)

    assert chunks == [{"chunk": 0}]
    # The chunk read at the cancellation boundary is dropped; the rest is never read.
    assert event_stream.emitted == [{"chunk": 0}, {"chunk": 1}]


@pytest.mark.asyncio
async def test_stream_cancel_signal_stops_in_flight_producer(bedrock_client, model, messages, alist):
    """Cancelling mid-transfer stops the producer rather than draining the response."""
    cancel_signal = threading.Event()
    event_stream = _FakeEventStream(
        [{"chunk": index} for index in range(100)],
        on_chunk=lambda chunk: cancel_signal.set() if chunk == {"chunk": 5} else None,
    )
    bedrock_client.converse_stream.return_value = {"stream": event_stream}

    chunks = await alist(model.stream(messages, cancel_signal=cancel_signal))

    assert event_stream.closed
    assert event_stream.emitted == [{"chunk": index} for index in range(6)]
    # The caller stops at or before the last chunk the producer forwarded.
    assert len(chunks) <= 5
    assert chunks == [{"chunk": index} for index in range(len(chunks))]


@pytest.mark.asyncio
async def test_stream_cancel_signal_returns_promptly_when_producer_stalls(bedrock_client, model, messages):
    """A stalled producer does not hold up the caller: the stream ends without waiting for it."""
    gate = threading.Event()
    event_stream = _FakeEventStream([{"chunk": 0}, {"chunk": 1}], gate=gate)
    bedrock_client.converse_stream.return_value = {"stream": event_stream}
    cancel_signal = threading.Event()

    chunks = []

    async def consume():
        async for chunk in model.stream(messages, cancel_signal=cancel_signal):
            chunks.append(chunk)
            cancel_signal.set()

    gate.set()
    await asyncio.wait_for(consume(), timeout=10)

    assert chunks == [{"chunk": 0}]
    # The worker thread is still blocked in the transport, so the caller returned without it.
    assert not event_stream.closed

    gate.set()
    await _wait_until(lambda: event_stream.closed)


@pytest.mark.asyncio
async def test_next_stream_event_consumer_cancellation_cancels_queue_get():
    """Cancelling the consumer mid-race also cancels the internal ``queue.get()`` task."""
    queue = asyncio.Queue()
    cancel_poll = asyncio.get_running_loop().create_future()

    consumer = asyncio.create_task(_next_stream_event(queue, cancel_poll))
    await asyncio.sleep(0.01)  # let the consumer block in asyncio.wait
    getter = next((task for task in asyncio.all_tasks() if task.get_coro().__qualname__ == "Queue.get"), None)
    assert getter is not None, "consumer did not create a queue.get() task"

    consumer.cancel()
    with pytest.raises(asyncio.CancelledError):
        await consumer

    await asyncio.wait([getter], timeout=1)
    assert getter.cancelled()

    cancel_poll.cancel()


@pytest.mark.asyncio
async def test_suppress_task_exception_skips_cancelled_task():
    """The done-callback tolerates a cancelled task, where ``Task.exception()`` would raise."""
    task = asyncio.create_task(asyncio.sleep(1))
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    _suppress_task_exception(task)


@pytest.mark.asyncio
async def test_stream_cancel_signal_consumes_detached_task_exception(bedrock_client, model, messages):
    """A worker that fails after the caller detached it does not report to the event loop."""
    gate = threading.Event()
    cancel_signal = threading.Event()

    def on_chunk(chunk):
        if chunk == {"chunk": 1}:
            raise RuntimeError("producer failed after cancellation")

    event_stream = _FakeEventStream([{"chunk": 0}, {"chunk": 1}], gate=gate, on_chunk=on_chunk)
    bedrock_client.converse_stream.return_value = {"stream": event_stream}

    captured: list[dict] = []
    asyncio.get_running_loop().set_exception_handler(lambda _loop, context: captured.append(context))

    chunks = []
    gate.set()
    async for chunk in model.stream(messages, cancel_signal=cancel_signal):
        chunks.append(chunk)
        cancel_signal.set()

    # Release the worker before asserting so a failure reports instead of hanging at exit.
    gate.set()
    assert chunks == [{"chunk": 0}]

    # The detached worker now fails; its exception must be consumed, not reported to the loop.
    await asyncio.sleep(0.2)
    assert not captured, f"detached task exception was not consumed: {captured}"
