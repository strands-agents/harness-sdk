"""End-to-end tests for ContextInjector against a real Agent + event loop.

These verify the ephemerality contract: the injected text reaches the model for one call but
never enters the agent's durable conversation history.
"""

import json
from unittest.mock import AsyncMock

import httpx
import openai
import pytest
from openai.types.chat import ChatCompletion, ChatCompletionChunk

from strands import Agent
from strands.models.litellm import LiteLLMModel
from strands.models.openai import OpenAIModel
from strands.vended_plugins.context_injector import ContextInjector
from tests.fixtures.mocked_model_provider import MockedModelProvider
from tests.fixtures.say_tool import say


def _texts(messages):
    """Flatten all text blocks across a conversation into one string."""
    return " ".join(block["text"] for message in messages for block in message["content"] if "text" in block)


@pytest.fixture
def model():
    return MockedModelProvider([{"role": "assistant", "content": [{"text": "Hello!"}]}])


@pytest.fixture
def model_seen(model):
    """Capture the messages the model actually receives, wrapping the mock's stream()."""
    seen: list[list] = []
    original_stream = model.stream

    def stream(messages, *args, **kwargs):
        seen.append([dict(message) for message in messages])
        return original_stream(messages, *args, **kwargs)

    model.stream = stream
    return seen


@pytest.fixture
def trailing_blocks_seen(model):
    """Capture the ``dynamic_trailing_blocks`` each model call receives, wrapping the mock's stream()."""
    seen: list[int] = []
    original_stream = model.stream

    def stream(messages, *args, **kwargs):
        seen.append(kwargs.get("dynamic_trailing_blocks", 0))
        return original_stream(messages, *args, **kwargs)

    model.stream = stream
    return seen


def test_injected_text_reaches_model_but_not_durable_history(model, model_seen):
    agent = Agent(
        model=model,
        callback_handler=None,
        plugins=[ContextInjector(lambda context: "<ctx>EPHEMERAL</ctx>")],
    )

    agent("what is the weather?")

    # (a) The model saw the injected block folded into the user message.
    assert len(model_seen) == 1
    assert "<ctx>EPHEMERAL</ctx>" in _texts(model_seen[0])
    assert "what is the weather?" in _texts(model_seen[0])

    # (b) The durable conversation never contains the injected text.
    assert "<ctx>EPHEMERAL</ctx>" not in _texts(agent.messages)
    assert "what is the weather?" in _texts(agent.messages)


def test_dynamic_trailing_blocks_reaches_the_model(model, trailing_blocks_seen):
    """The boundary is only useful if it survives the whole chain down to the provider call."""
    agent = Agent(
        model=model,
        callback_handler=None,
        plugins=[ContextInjector(lambda context: "<ctx>EPHEMERAL</ctx>")],
    )

    agent("what is the weather?")

    assert trailing_blocks_seen == [1]


def test_no_dynamic_trailing_blocks_reaches_the_model_without_injection(model, trailing_blocks_seen):
    """An ordinary call reaches the provider with exactly the arguments it received before."""
    agent = Agent(model=model, callback_handler=None)

    agent("what is the weather?")

    assert trailing_blocks_seen == [0]


@pytest.mark.parametrize("model_class", [OpenAIModel, LiteLLMModel])
@pytest.mark.parametrize("stream", [True, False])
@pytest.mark.asyncio
async def test_every_turn_injection_preserves_tool_result_adjacency(model_class, stream, monkeypatch, agenerator):
    """Exercise real adapters against a strict Chat Completions boundary, without credentials."""
    requests = []

    async def completion(**request):
        messages = request["messages"]
        requests.append(messages)
        pending = set()
        for message in messages:
            if pending:
                if message["role"] != "tool" or message.get("tool_call_id") not in pending:
                    raise openai.BadRequestError(
                        "An assistant message with 'tool_calls' must be followed by tool messages "
                        "responding to each 'tool_call_id'.",
                        response=httpx.Response(400, request=httpx.Request("POST", "https://example.test")),
                        body=None,
                    )
                pending.remove(message["tool_call_id"])
            pending.update(tool_call["id"] for tool_call in message.get("tool_calls", []))
        assert not pending

        is_tool_call = len(requests) % 2 == 1
        content = (
            {
                "tool_calls": [
                    {
                        "id": f"call_{len(requests)}",
                        "type": "function",
                        "function": {"name": "say", "arguments": '{"input": "world"}'},
                        **({"index": 0} if stream else {}),
                    }
                ]
            }
            if is_tool_call
            else {"content": "DONE"}
        )
        finish_reason = "tool_calls" if is_tool_call else "stop"
        metadata = {"id": "completion", "created": 0, "model": "test-model"}
        if stream:
            return agenerator(
                [
                    ChatCompletionChunk(
                        **metadata,
                        object="chat.completion.chunk",
                        choices=[{"index": 0, "delta": content, "finish_reason": None}],
                    ),
                    ChatCompletionChunk(
                        **metadata,
                        object="chat.completion.chunk",
                        choices=[{"index": 0, "delta": {}, "finish_reason": finish_reason}],
                    ),
                ]
            )
        return ChatCompletion(
            **metadata,
            object="chat.completion",
            choices=[{"index": 0, "message": {"role": "assistant", **content}, "finish_reason": finish_reason}],
            usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        )

    if model_class is LiteLLMModel:
        monkeypatch.setattr("strands.models.litellm.litellm.acompletion", completion)
        model = model_class(model_id="test-model", stream=stream)
    else:
        client = AsyncMock()
        client.chat.completions.create.side_effect = completion
        model = model_class(model_id="test-model", stream=stream, client=client)

    agent = Agent(
        model=model,
        tools=[say],
        callback_handler=None,
        plugins=[ContextInjector(lambda context: "<ctx>EPHEMERAL</ctx>", trigger="everyTurn")],
    )

    for prompt in ["Say hello", "Say hello again"]:
        result = await agent.invoke_async(prompt)
        assert result.message["content"] == [{"text": "DONE"}]
        assert "EPHEMERAL" not in json.dumps(agent.messages)

    tru_roles = [[message["role"] for message in request] for request in requests]
    exp_roles = [
        ["user"],
        ["user", "assistant", "tool", "user"],
        ["user", "assistant", "tool", "assistant", "user"],
        ["user", "assistant", "tool", "assistant", "user", "assistant", "tool", "user"],
    ]
    assert tru_roles == exp_roles
    assert all("EPHEMERAL" in json.dumps(request[-1]["content"]) for request in requests)
