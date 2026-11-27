"""Tests for provenance tags on provider-signed reasoning and the models that take them back."""

import pytest

from strands.models import ModelCapabilities, ModelInfo
from strands.models._model_proxy import ModelProxy
from strands.models.anthropic import AnthropicModel
from strands.models.bedrock import BedrockModel
from strands.models.gemini import GeminiModel
from strands.models.openai_responses import OpenAIResponsesModel


def _tag(provider: str, model_id: str = "m") -> dict:
    return {"provider": provider, "modelId": model_id, "data": {}}


def _delta(reasoning: dict) -> dict:
    return {"contentBlockDelta": {"contentBlockIndex": 2, "delta": {"reasoningContent": reasoning}}}


@pytest.mark.parametrize(
    ("model_id", "tagged"),
    [
        ("us.anthropic.claude-haiku-4-5-20251001-v1:0", True),
        ("us.amazon.nova-pro-v1:0", False),
        ("arn:aws:x", False),
    ],
)
def test_bedrock_tags_signed_reasoning_only_for_a_model_id_naming_claude(model_id, tagged):
    model = BedrockModel(model_id=model_id, region_name="us-west-2")

    event = model._tag_reasoning(_delta({"signature": "sig"}))

    assert event == (
        _delta({"signature": "sig", "providerData": _tag("anthropic", model_id)})
        if tagged
        else _delta({"signature": "sig"})
    )


@pytest.mark.parametrize("event", [_delta({"text": "plain"}), {"contentBlockDelta": {"delta": {"text": "hi"}}}, {}])
def test_bedrock_leaves_reasoning_without_a_signature_untagged(event):
    model = BedrockModel(model_id="us.anthropic.claude-x", region_name="us-west-2")

    assert model._tag_reasoning(event) is event


@pytest.mark.parametrize(
    ("model", "accepts"),
    [
        (lambda: AnthropicModel(model_id="claude-x", max_tokens=10, client_args={"api_key": "x"}), {"anthropic"}),
        (lambda: BedrockModel(model_id="us.anthropic.claude-x", region_name="us-west-2"), {"anthropic"}),
        (
            lambda: BedrockModel(
                model_id="arn:aws:bedrock:us-west-2:1:application-inference-profile/abc", region_name="us-west-2"
            ),
            {"anthropic"},
        ),
        (
            lambda: BedrockModel(
                model_id="arn:aws:bedrock:us-west-2::foundation-model/meta.llama3-x", region_name="us-west-2"
            ),
            set(),
        ),
        (lambda: BedrockModel(model_id="us.amazon.nova-pro-v1:0", region_name="us-west-2"), set()),
        (
            lambda: BedrockModel(
                model_id="us.amazon.nova-pro-v1:0",
                region_name="us-west-2",
                model_info=ModelInfo(capabilities=ModelCapabilities(reasoning_provider="anthropic")),
            ),
            {"anthropic"},
        ),
        (lambda: GeminiModel(model_id="gemini-x", client_args={"api_key": "x"}), {"google"}),
        (lambda: OpenAIResponsesModel(model_id="m"), {"openai_responses"}),
    ],
)
def test_each_model_reports_the_reasoning_provider_it_takes_back(model, accepts):
    reasoning_provider = model().model_info.capabilities.reasoning_provider

    assert ({reasoning_provider} - {None}) == accepts


def test_proxy_keeps_signed_reasoning_from_another_vendor_out_of_a_claude_request():
    gemini = {"reasoningContent": {"reasoningText": {"text": "", "signature": "g"}, "providerData": _tag("google")}}
    claude = {"reasoningContent": {"reasoningText": {"text": "t", "signature": "c"}, "providerData": _tag("anthropic")}}
    legacy = {"reasoningContent": {"reasoningText": {"text": "t", "signature": "old"}}}
    messages = [
        {"role": "user", "content": [{"text": "go"}]},
        {"role": "assistant", "content": [gemini, claude, legacy, {"text": "ok"}]},
    ]

    sent, _ = ModelProxy(BedrockModel(model_id="us.anthropic.claude-x", region_name="us-west-2"))._prepare(messages)

    assert sent[1]["content"] == [claude, legacy, {"text": "ok"}]


def test_proxy_sends_a_claude_signed_blocks_text_but_not_its_signature_to_gemini():
    claude = {"reasoningContent": {"reasoningText": {"text": "t", "signature": "c"}, "providerData": _tag("anthropic")}}
    messages = [
        {"role": "user", "content": [{"text": "go"}]},
        {"role": "assistant", "content": [claude, {"text": "ok"}]},
    ]

    sent, _ = ModelProxy(GeminiModel(model_id="gemini-x", client_args={"api_key": "x"}))._prepare(messages)

    assert sent[1]["content"] == [{"reasoningContent": {"reasoningText": {"text": "t"}}}, {"text": "ok"}]
