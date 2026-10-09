"""Native LiteLLM structured output preserves configured request parameters."""

from typing import Any
from unittest.mock import patch

import litellm
import pytest
from pydantic import BaseModel

from strands.models import CacheConfig
from strands.models.litellm import LiteLLMModel


class Output(BaseModel):
    """Simple object result."""

    value: int


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({"temperature": 0.0}, {"temperature": 0.0}),
        ({"max_tokens": 42, "stop": ["END"]}, {"max_tokens": 42, "stop": ["END"]}),
        ({"api_base": "http://localhost:1234/v1"}, {"api_base": "http://localhost:1234/v1"}),
        ({}, {}),
        ({"stream": True, "stream_options": {"include_usage": True}}, {}),
        ({"response_format": {"type": "text"}}, {}),
    ],
)
async def test_native_structured_output_preserves_params(params: dict[str, Any], expected: dict[str, Any]) -> None:
    """Use LiteLLM's actual local mock-response path, not a fake completion."""
    calls: list[dict[str, Any]] = []
    complete = litellm.acompletion

    async def record(**kwargs: Any) -> Any:
        calls.append(kwargs)
        return await complete(**kwargs)

    model = LiteLLMModel(model_id="openai/gpt-4o", params=params, client_args={"mock_response": '{"value":7}'})
    with patch("strands.models.litellm.litellm.acompletion", record):
        events = [
            event
            async for event in model.structured_output(
                Output, [{"role": "user", "content": [{"text": "Get value"}]}], system_prompt="Return JSON"
            )
        ]
    assert events[-1]["output"].value == 7
    for key, value in expected.items():
        assert calls[0].get(key) == value
    assert calls[0].get("stream", False) is False
    assert "stream_options" not in calls[0]
    assert calls[0]["response_format"] is Output
    assert calls[0]["messages"][0]["role"] == "system"
    assert model.get_config()["params"] == params


@pytest.mark.asyncio
async def test_native_structured_output_preserves_cache_config() -> None:
    """Explicit cache routing still applies to a structured request."""
    calls: list[dict[str, Any]] = []
    complete = litellm.acompletion

    async def record(**kwargs: Any) -> Any:
        calls.append(kwargs)
        return await complete(**kwargs)

    model = LiteLLMModel(
        model_id="openai/gpt-4o",
        cache_config=CacheConfig(cache_key="tenant-42"),
        client_args={"mock_response": '{"value":7}'},
    )
    with patch("strands.models.litellm.litellm.acompletion", record):
        events = [
            event
            async for event in model.structured_output(Output, [{"role": "user", "content": [{"text": "Get value"}]}])
        ]
    assert events[-1]["output"].value == 7
    assert calls[0].get("prompt_cache_key") == "tenant-42"
