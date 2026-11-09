"""End-to-end tests for ContextInjector against a real Agent + event loop.

These verify the injected-block contract: the injected text is stored as an ``injected`` block in the
agent's conversation, and a model without temporary messages receives only the latest one, as text.
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


def test_injected_text_reaches_model_as_text_and_history_as_an_injected_block(model, model_seen):
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

    # (b) The conversation keeps it as an injected block, never as text.
    assert "<ctx>EPHEMERAL</ctx>" not in _texts(agent.messages)
    assert agent.messages[0]["content"] == [
        {"text": "what is the weather?"},
        {"injected": {"text": "<ctx>EPHEMERAL</ctx>", "source": "strands:context-injector"}},
    ]


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
        assert "EPHEMERAL" not in _texts(agent.messages)

    tru_roles = [[message["role"] for message in request] for request in requests]
    exp_roles = [
        ["user"],
        ["user", "assistant", "tool", "user"],
        ["user", "assistant", "tool", "assistant", "user"],
        ["user", "assistant", "tool", "assistant", "user", "assistant", "tool", "user"],
    ]
    assert tru_roles == exp_roles
    assert all("EPHEMERAL" in json.dumps(request[-1]["content"]) for request in requests)
    assert all(json.dumps(request).count("EPHEMERAL") == 1 for request in requests)


def test_injection_writes_with_the_agentic_context_manager(model, model_seen):
    agent = Agent(
        model=model,
        callback_handler=None,
        context_manager="agentic",
        plugins=[ContextInjector(lambda context: "<now>T1</now>")],
    )

    agent("hello")

    assert "<now>T1</now>" in _texts(model_seen[0])
    assert {"injected": {"text": "<now>T1</now>", "source": "strands:context-injector"}} in agent.messages[0]["content"]


def test_injected_block_is_saved_and_restored_by_file_session_manager(model, tmp_path):
    from strands.session.file_session_manager import FileSessionManager

    agent = Agent(
        model=model,
        callback_handler=None,
        session_manager=FileSessionManager(session_id="s", storage_dir=str(tmp_path)),
        plugins=[ContextInjector(lambda context: "<ctx>A</ctx>")],
    )
    agent("hello")

    restored = Agent(
        model=MockedModelProvider([]),
        callback_handler=None,
        session_manager=FileSessionManager(session_id="s", storage_dir=str(tmp_path)),
    )

    assert restored.messages[0]["content"] == [
        {"text": "hello"},
        {"injected": {"text": "<ctx>A</ctx>", "source": "strands:context-injector"}},
    ]


def test_a_later_middleware_editing_the_call_copy_leaves_history_unchanged(model):
    from strands.middleware import InvokeModelStage

    agent = Agent(
        model=model,
        callback_handler=None,
        plugins=[ContextInjector(lambda context: "<ctx>A</ctx>")],
    )

    def redact(context):
        context.messages[-1]["content"][-1]["injected"]["text"] = "[redacted]"
        return context

    agent.add_middleware(InvokeModelStage.Input, redact)
    agent("hello")

    assert agent.messages[0]["content"][-1] == {
        "injected": {"text": "<ctx>A</ctx>", "source": "strands:context-injector"}
    }


def test_deprecated_structured_output_drops_injected_blocks_of_earlier_user_messages(model):
    from pydantic import BaseModel

    class Out(BaseModel):
        value: str

    agent = Agent(model=model, callback_handler=None, plugins=[ContextInjector(lambda context: "<ctx>A</ctx>")])
    agent("hello")
    seen: list = []

    async def structured_output(output_model, messages, **kwargs):
        seen.append(messages)
        yield {"output": Out(value="x")}

    model.structured_output = structured_output
    with pytest.warns(DeprecationWarning):
        agent.structured_output(Out, "again")

    # Formatters other than Bedrock and Anthropic raise on an injected block.
    assert not any("injected" in block for message in seen[0] for block in message["content"])
    assert "<ctx>A</ctx>" not in _texts(seen[0])
