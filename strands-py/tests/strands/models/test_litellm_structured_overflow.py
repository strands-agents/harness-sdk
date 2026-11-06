"""Structured calls use the same overflow exception as ordinary model calls."""

from unittest.mock import AsyncMock, patch

import pytest
from litellm.exceptions import ContextWindowExceededError
from pydantic import BaseModel

from strands.models.litellm import LiteLLMModel
from strands.types.exceptions import ContextWindowOverflowException


class Output(BaseModel):
    """Object result."""

    value: int


@pytest.mark.asyncio
@pytest.mark.parametrize("supports_schema", [True, False])
async def test_structured_output_maps_provider_overflow(supports_schema: bool) -> None:
    """Provider failures are normalized on both structured response paths."""
    error = ContextWindowExceededError(message="context length exceeded", model="test", llm_provider="openai")
    model = LiteLLMModel(model_id="openai/gpt-4o")
    with (
        patch("strands.models.litellm.supports_response_schema", return_value=supports_schema),
        patch("strands.models.litellm.litellm.acompletion", AsyncMock(side_effect=error)),
        pytest.raises(ContextWindowOverflowException) as caught,
    ):
        _ = [
            event
            async for event in model.structured_output(Output, [{"role": "user", "content": [{"text": "Get value"}]}])
        ]
    assert caught.value.__cause__ is error


@pytest.mark.asyncio
@pytest.mark.parametrize("supports_schema", [True, False])
async def test_structured_output_preserves_other_provider_errors(supports_schema: bool) -> None:
    """Unrelated failures retain their original identity."""
    error = RuntimeError("transport failure")
    model = LiteLLMModel(model_id="openai/gpt-4o")
    with (
        patch("strands.models.litellm.supports_response_schema", return_value=supports_schema),
        patch("strands.models.litellm.litellm.acompletion", AsyncMock(side_effect=error)),
        pytest.raises(RuntimeError) as caught,
    ):
        _ = [
            event
            async for event in model.structured_output(Output, [{"role": "user", "content": [{"text": "Get value"}]}])
        ]
    assert caught.value is error
