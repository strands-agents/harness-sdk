"""The requested structured model overrides ordinary response-format settings."""

import json

import httpx
import openai
import pytest
from pydantic import BaseModel

from strands.models.openai import OpenAIModel


class Output(BaseModel):
    """Requested structured response."""

    value: str


@pytest.mark.asyncio
@pytest.mark.parametrize("configured_format", [{"type": "json_object"}, {"type": "text"}, None])
async def test_structured_output_overrides_configured_response_format(configured_format):
    """Native OpenAI parsing uses the requested model without duplicate keywords."""
    requests = []

    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "created": 1,
                "model": "gpt-4o",
                "choices": [
                    {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": '{"value":"ok"}'}}
                ],
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http_client:
        async with openai.AsyncOpenAI(api_key="offline-test", http_client=http_client) as client:
            model = OpenAIModel(
                client=client,
                model_id="gpt-4o",
                params={"response_format": configured_format, "temperature": 0, "max_tokens": 20},
            )
            events = [
                event
                async for event in model.structured_output(Output, [{"role": "user", "content": [{"text": "hi"}]}])
            ]

    assert events == [{"output": Output(value="ok")}]
    assert len(requests) == 1
    assert requests[0]["response_format"]["type"] == "json_schema"
    assert requests[0]["response_format"]["json_schema"]["schema"]["properties"] == {
        "value": {"title": "Value", "type": "string"}
    }
    assert requests[0]["temperature"] == 0
    assert requests[0]["max_tokens"] == 20
    assert model.get_config()["params"]["response_format"] == configured_format
