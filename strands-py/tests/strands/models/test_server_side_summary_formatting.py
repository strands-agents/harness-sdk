"""A server-side summary reaches the wire as a compaction block only through the provider that wrote it."""

import json
import unittest.mock

import pytest

from strands.models.anthropic import AnthropicModel
from strands.models.gemini import GeminiModel
from strands.models.litellm import LiteLLMModel
from strands.models.llamacpp import LlamaCppModel
from strands.models.mistral import MistralModel
from strands.models.ollama import OllamaModel
from strands.models.openai import OpenAIModel
from strands.models.openai_responses import OpenAIResponsesModel
from strands.models.sagemaker import SageMakerAIModel
from strands.models.writer import WriterModel

SIGNATURE = "OPAQUE-SIGNATURE"


def _history(provider: str) -> list:
    server_side = {"provider": provider, "signature": SIGNATURE}
    return [
        {"role": "assistant", "content": [{"text": "SUMMARY TEXT", "metadata": {"serverSideSummary": server_side}}]},
        {"role": "user", "content": [{"text": "next"}]},
    ]


def _assert_plain_text(request: object) -> None:
    wire = json.dumps(request, default=str)
    assert "SUMMARY TEXT" in wire
    assert SIGNATURE not in wire
    assert "serverSideSummary" not in wire
    assert "compaction" not in wire


def _bedrock(messages: list) -> object:
    with unittest.mock.patch("strands.models.bedrock.boto3.Session"):
        from strands.models.bedrock import BedrockModel

        return BedrockModel(model_id="m").format_request(messages)


@pytest.mark.parametrize(
    "format_messages",
    [
        pytest.param(_bedrock, id="bedrock"),
        pytest.param(
            lambda messages: GeminiModel(model_id="m", client_args={"api_key": "k"})._format_request_content(messages),
            id="gemini",
        ),
        pytest.param(OpenAIModel.format_request_messages, id="openai"),
        pytest.param(OpenAIResponsesModel._format_request_messages, id="openai_responses"),
        pytest.param(LiteLLMModel.format_request_messages, id="litellm"),
        pytest.param(
            lambda messages: MistralModel(model_id="m", api_key="k")._format_request_messages(messages), id="mistral"
        ),
        pytest.param(
            lambda messages: OllamaModel(host=None, model_id="m")._format_request_messages(messages), id="ollama"
        ),
        pytest.param(
            lambda messages: WriterModel(model_id="m", client_args={"api_key": "k"})._format_request_messages(messages),
            id="writer",
        ),
        pytest.param(lambda messages: LlamaCppModel()._format_messages(messages), id="llamacpp"),
        pytest.param(
            lambda messages: [
                SageMakerAIModel.format_request_message_content(block)
                for message in messages
                for block in message["content"]
            ],
            id="sagemaker",
        ),
    ],
)
def test_other_providers_send_only_the_text(format_messages):
    _assert_plain_text(format_messages(_history("anthropic")))


def test_anthropic_sends_only_the_text_of_a_summary_another_provider_wrote():
    with unittest.mock.patch("strands.models.anthropic.anthropic.AsyncAnthropic"):
        model = AnthropicModel(model_id="m", max_tokens=1)

    _assert_plain_text(model.format_request(_history("openai")))
