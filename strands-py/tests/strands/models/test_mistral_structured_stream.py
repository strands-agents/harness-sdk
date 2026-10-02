"""Structured requests use Mistral's non-streaming response contract."""

import json

import httpx
import pytest
from pydantic import BaseModel

from strands.models.mistral import MistralModel


class Output(BaseModel):
    """Requested structured response."""

    value: str


@pytest.mark.asyncio
@pytest.mark.parametrize("configured_stream", [True, False, None])
async def test_structured_output_uses_non_streaming_request(configured_stream):
    """Native Mistral parsing receives JSON even on a streaming-configured model."""
    requests = []

    def respond(request):
        payload = json.loads(request.content)
        requests.append(payload)
        if payload.get("stream"):
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text="data: [DONE]\n\n")
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={
                "id": "completion-test",
                "object": "chat.completion",
                "created": 1,
                "model": "mistral-small-latest",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call-test",
                                    "type": "function",
                                    "function": {"name": "extract_output", "arguments": '{"value":"ok"}'},
                                }
                            ],
                        },
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http_client:
        model = MistralModel(
            model_id="mistral-small-latest",
            stream=configured_stream,
            client_args={"api_key": "offline-test", "async_client": http_client},
        )
        events = [
            event async for event in model.structured_output(Output, [{"role": "user", "content": [{"text": "hi"}]}])
        ]

    assert events == [{"output": Output(value="ok")}]
    assert len(requests) == 1
    assert requests[0].get("stream", False) is False
    assert requests[0]["tool_choice"] == "any"
    assert model.get_config()["stream"] is configured_stream
