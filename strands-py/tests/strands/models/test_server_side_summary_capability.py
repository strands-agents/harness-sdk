"""Providers whose APIs have no server-side summary turn the capability off unless the caller sets it."""

import unittest.mock

import pytest

from strands.models import ModelCapabilities, ModelInfo
from strands.models.litellm import LiteLLMModel
from strands.models.openai import OpenAIModel
from strands.models.openai_responses import OpenAIResponsesModel


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
    ],
)
def test_providers_without_server_side_summary_turn_it_off_for_listed_models(make_model):
    assert make_model().model_info.capabilities.server_side_summary is False
    override = ModelInfo(capabilities=ModelCapabilities(server_side_summary=True))
    assert make_model(model_info=override).model_info.capabilities.server_side_summary is True
