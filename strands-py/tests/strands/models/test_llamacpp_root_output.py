"""Native llama.cpp structured output accepts Pydantic root models."""

import json
from typing import Any

import httpx
import pytest
from pydantic import BaseModel, RootModel, ValidationError

from strands.models.llamacpp import LlamaCppModel


class ObjectOutput(BaseModel):
    """Named-field control."""

    value: int


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("output_model", "payload", "expected"),
    [
        (RootModel[list[int]], [1, 2], [1, 2]),
        (RootModel[list[int]], [], []),
        (RootModel[bool], False, False),
        (RootModel[int | None], None, None),
        (RootModel[str], "hello", "hello"),
        (RootModel[int], 7, 7),
        (ObjectOutput, {"value": 3}, {"value": 3}),
    ],
)
async def test_native_structured_output(output_model: type[BaseModel], payload: Any, expected: Any) -> None:
    """Parse real SSE through the provider with the model's own schema."""
    requests: list[dict[str, Any]] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        content = json.dumps(payload)
        events = [
            {"choices": [{"delta": {"content": content}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        ]
        sse = "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=sse)

    model = LlamaCppModel()
    await model.client.aclose()
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond), base_url=model.base_url) as client:
        model.client = client
        events = [
            event
            async for event in model.structured_output(
                output_model, [{"role": "user", "content": [{"text": "Return the value"}]}]
            )
        ]
    assert requests[0]["json_schema"] == output_model.model_json_schema()
    assert events[-1]["output"].model_dump() == expected
    assert any("contentBlockDelta" in event for event in events)


@pytest.mark.asyncio
async def test_root_output_still_validates() -> None:
    """Invalid values do not bypass Pydantic validation."""

    def respond(request: httpx.Request) -> httpx.Response:
        event = {"choices": [{"delta": {"content": '["not-an-integer"]'}, "finish_reason": "stop"}]}
        return httpx.Response(200, content=f"data: {json.dumps(event)}\n\ndata: [DONE]\n\n")

    model = LlamaCppModel()
    await model.client.aclose()
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond), base_url=model.base_url) as client:
        model.client = client
        with pytest.raises(ValidationError):
            _ = [
                event
                async for event in model.structured_output(
                    RootModel[list[int]], [{"role": "user", "content": [{"text": "Return a list"}]}]
                )
            ]
