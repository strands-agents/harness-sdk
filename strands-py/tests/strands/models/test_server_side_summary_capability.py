"""Providers that do not implement ``summarize`` report server-side summary as off unless the caller sets it."""

import unittest.mock

import pytest

from strands.models import Model, ModelCapabilities, ModelInfo
from strands.models.gemini import GeminiModel
from strands.models.litellm import LiteLLMModel
from strands.models.llamaapi import LlamaAPIModel
from strands.models.llamacpp import LlamaCppModel
from strands.models.mistral import MistralModel
from strands.models.ollama import OllamaModel
from strands.models.openai import OpenAIModel
from strands.models.openai_responses import OpenAIResponsesModel
from strands.models.writer import WriterModel

MODEL_ID = "claude-sonnet-5-5"


def _sagemaker_model(**config):
    with unittest.mock.patch("strands.models.sagemaker.boto3"):
        from strands.models.sagemaker import SageMakerAIModel

        return SageMakerAIModel(
            endpoint_config={"endpoint_name": "e", "region_name": "us-east-1", **config},
            payload_config={"max_tokens": 1},
        )


def _bedrock_model(**config):
    with unittest.mock.patch("strands.models.bedrock.boto3.Session"):
        from strands.models.bedrock import BedrockModel

        return BedrockModel(**config)


@pytest.mark.parametrize(
    "make_model",
    [
        pytest.param(
            lambda **config: _bedrock_model(model_id="us.anthropic.claude-sonnet-5-5-v1:0", **config), id="bedrock"
        ),
        pytest.param(
            lambda **config: OpenAIModel(model_id="claude-sonnet-5-5", client_args={"api_key": "k"}, **config),
            id="openai",
        ),
        pytest.param(
            lambda **config: OpenAIResponsesModel(model_id="claude-sonnet-5-5", client_args={"api_key": "k"}, **config),
            id="openai_responses",
        ),
        pytest.param(
            lambda **config: LiteLLMModel(model_id="bedrock/us.anthropic.claude-sonnet-5-5-v1:0", **config),
            id="litellm",
        ),
        pytest.param(
            lambda **config: GeminiModel(model_id=MODEL_ID, client_args={"api_key": "k"}, **config), id="gemini"
        ),
        pytest.param(
            lambda **config: LlamaAPIModel(model_id=MODEL_ID, client_args={"api_key": "k"}, **config), id="llamaapi"
        ),
        pytest.param(lambda **config: LlamaCppModel(model_id=MODEL_ID, **config), id="llamacpp"),
        pytest.param(_sagemaker_model, id="sagemaker"),
        pytest.param(lambda **config: MistralModel(model_id=MODEL_ID, api_key="k", **config), id="mistral"),
        pytest.param(lambda **config: OllamaModel(host=None, model_id=MODEL_ID, **config), id="ollama"),
        pytest.param(
            lambda **config: WriterModel(model_id=MODEL_ID, client_args={"api_key": "k"}, **config), id="writer"
        ),
    ],
)
def test_providers_without_server_side_summary_turn_it_off_for_listed_models(make_model):
    assert make_model().model_info.capabilities.server_side_summary is not True
    override = ModelInfo(capabilities=ModelCapabilities(server_side_summary=True))
    assert make_model(model_info=override).model_info.capabilities.server_side_summary is True


class _CustomModel(Model):
    def __init__(self, **config):
        self.config = {"model_id": MODEL_ID, **config}

    def update_config(self, **model_config):
        self.config.update(model_config)

    def get_config(self):
        return self.config

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        yield {}


class _CustomSummarizingModel(_CustomModel):
    async def summarize(self, messages, **kwargs):
        return {"summary": {"text": "s"}}


def test_custom_provider_without_summarize_reports_server_side_summary_off():
    assert _CustomModel().model_info.capabilities.server_side_summary is False
    override = ModelInfo(capabilities=ModelCapabilities(server_side_summary=True))
    assert _CustomModel(model_info=override).model_info.capabilities.server_side_summary is True


def test_custom_provider_with_summarize_keeps_shared_server_side_summary():
    assert _CustomSummarizingModel().model_info.capabilities.server_side_summary is True
    override = ModelInfo(capabilities=ModelCapabilities(server_side_summary=False))
    assert _CustomSummarizingModel(model_info=override).model_info.capabilities.server_side_summary is False
