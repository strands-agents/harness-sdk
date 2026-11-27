"""Switching models mid-conversation keeps or drops earlier reasoning as each model needs.

Signed reasoning reaches only models of the vendor that signed it; any other model gets its text and the conversation
continues. Each test runs a tool turn on one model, switches ``agent.model``, and runs another tool turn.
"""

import os
import unittest.mock

import pytest

from strands import Agent, tool
from strands.models import BedrockModel, Model
from strands.models.anthropic import AnthropicModel
from strands.models.gemini import GeminiModel
from tests_integ.models import providers

THINKING = {"thinking": {"type": "enabled", "budget_tokens": 1024}}


@tool
def add(a: int, b: int) -> int:
    """Add two integers.

    Args:
        a: The first integer.
        b: The second integer.
    """
    return a + b


def bedrock_claude(model_id: str = "us.anthropic.claude-haiku-4-5-20251001-v1:0") -> BedrockModel:
    return BedrockModel(model_id=model_id, max_tokens=4096, additional_request_fields=THINKING)


def anthropic_claude() -> AnthropicModel:
    return AnthropicModel(
        client_args={"api_key": os.getenv("ANTHROPIC_API_KEY")},
        model_id="claude-haiku-4-5",
        max_tokens=4096,
        params=THINKING,
    )


def gemini() -> GeminiModel:
    return GeminiModel(
        client_args={"api_key": os.getenv("GOOGLE_API_KEY")},
        model_id="gemini-2.5-flash",
        params={"thinking_config": {"include_thoughts": True}},
    )


def openai_responses() -> Model:
    from strands.models.openai_responses import OpenAIResponsesModel

    return OpenAIResponsesModel(model_id="gpt-5-mini", client_args={"api_key": os.getenv("OPENAI_API_KEY")})


def _reasoning_sent(model: Model, agent: Agent, prompt: str) -> list[dict]:
    """Run ``prompt`` on ``model`` and return the reasoning blocks the model received in its first call."""
    agent.model = model
    with unittest.mock.patch.object(model, "stream", wraps=model.stream) as stream:
        result = agent(prompt)
    assert "142" in str(result)
    messages = stream.call_args_list[0].args[0]
    return [
        block["reasoningContent"] for message in messages for block in message["content"] if "reasoningContent" in block
    ]


def _signed(reasoning: list[dict]) -> bool:
    return any(block.get("reasoningText", {}).get("signature") for block in reasoning)


def _first_turn(model: Model) -> Agent:
    agent = Agent(model=model, tools=[add], callback_handler=None)
    agent("Think first, then use the add tool to compute 17 + 25.")
    return agent


SECOND_TURN = "Now use the add tool to add 100 to that result, then reply with the number."

needs_anthropic = providers.anthropic.mark
needs_gemini = providers.gemini.mark
needs_openai = providers.openai_responses.mark if providers.openai_responses else pytest.mark.skip("no openai")


@pytest.mark.parametrize(
    ("first", "second"),
    [
        pytest.param(
            bedrock_claude, lambda: bedrock_claude("us.anthropic.claude-sonnet-4-5-20250929-v1:0"), id="haiku-to-sonnet"
        ),
        pytest.param(bedrock_claude, anthropic_claude, id="bedrock-to-anthropic", marks=needs_anthropic),
        pytest.param(anthropic_claude, bedrock_claude, id="anthropic-to-bedrock", marks=needs_anthropic),
    ],
)
def test_claude_reasoning_carries_across_claude_models_and_endpoints(first, second):
    agent = _first_turn(first())
    assert any(
        block.get("reasoningContent", {}).get("providerData", {}).get("provider") == "anthropic"
        for block in agent.messages[1]["content"]
    )

    assert _signed(_reasoning_sent(second(), agent, SECOND_TURN))


@pytest.mark.parametrize(
    ("first", "second"),
    [
        pytest.param(bedrock_claude, gemini, id="bedrock-claude-to-gemini", marks=needs_gemini),
        pytest.param(gemini, bedrock_claude, id="gemini-to-bedrock-claude", marks=needs_gemini),
        pytest.param(bedrock_claude, openai_responses, id="bedrock-claude-to-openai-responses", marks=needs_openai),
        pytest.param(openai_responses, bedrock_claude, id="openai-responses-to-bedrock-claude", marks=needs_openai),
    ],
)
def test_switching_vendors_keeps_the_conversation_going_without_foreign_signatures(first, second):
    agent = _first_turn(first())

    assert not _signed(_reasoning_sent(second(), agent, SECOND_TURN))


def test_reasoning_signed_by_another_vendor_never_reaches_claude():
    """Before tagging, a Gemini signature replayed to Claude failed with ``Invalid signature in thinking block``."""
    gemini_signed = {
        "reasoningText": {"text": "I will add the numbers.", "signature": "c2lnbmVkLWJ5LWdlbWluaQ=="},
        "providerData": {"provider": "google", "modelId": "gemini", "data": {}},
    }
    messages = [
        {"role": "user", "content": [{"text": "Use the add tool to compute 17 + 25."}]},
        {
            "role": "assistant",
            "content": [
                {"reasoningContent": gemini_signed},
                {"toolUse": {"toolUseId": "t1", "name": "add", "input": {"a": 17, "b": 25}}},
            ],
        },
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "t1", "status": "success", "content": [{"text": "42"}]}}],
        },
    ]
    agent = Agent(model=bedrock_claude(), tools=[add], messages=messages, callback_handler=None)

    reasoning = _reasoning_sent(agent.model, agent, SECOND_TURN)

    assert reasoning == [{"reasoningText": {"text": "I will add the numbers."}}]


@needs_openai
def test_openai_responses_reasoning_survives_a_round_trip_through_claude():
    agent = _first_turn(openai_responses())
    _reasoning_sent(bedrock_claude(), agent, SECOND_TURN)

    back = openai_responses()
    agent.model = back
    with unittest.mock.patch.object(back, "stream", wraps=back.stream) as stream:
        assert "143" in str(agent("Use the add tool to add 1 to the last result, then reply with the number."))
    sent = stream.call_args_list[0].args[0]
    assert any(
        block.get("reasoningContent", {}).get("providerData", {}).get("provider") == "openai_responses"
        for message in sent
        for block in message["content"]
    )
