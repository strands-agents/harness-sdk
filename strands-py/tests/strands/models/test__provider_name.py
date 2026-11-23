"""Tests for the provider name and model id a model's usage is recorded under."""

import importlib
import types
import unittest.mock

import anthropic
import openai
import pytest

from strands.models._provider_name import _model_key
from strands.models.anthropic import AnthropicModel
from strands.models.litellm import LiteLLMModel
from strands.models.openai import OpenAIModel
from strands.models.openai_responses import OpenAIResponsesModel
from strands.models.sagemaker import SageMakerAIModel
from tests.fixtures.mocked_model_provider import MockedModelProvider


@pytest.fixture(autouse=True)
def openai_env(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)


@pytest.mark.filterwarnings("ignore:LlamaAPIModel is deprecated:DeprecationWarning")
@pytest.mark.parametrize(
    ("class_path", "exp_provider_name"),
    [
        ("strands.models.bedrock.BedrockModel", "bedrock"),
        ("strands.models.gemini.GeminiModel", "google"),
        ("strands.models.litellm.LiteLLMModel", "litellm"),
        ("strands.models.llamaapi.LlamaAPIModel", "llamaapi"),
        ("strands.models.llamacpp.LlamaCppModel", "llamacpp"),
        ("strands.models.mistral.MistralModel", "mistral"),
        ("strands.models.ollama.OllamaModel", "ollama"),
        ("strands.models.writer.WriterModel", "writer"),
    ],
)
def test_model_key_names_the_provider_of_each_vended_class_and_of_its_subclasses(class_path, exp_provider_name):
    module_name, class_name = class_path.rsplit(".", 1)
    vended_class = getattr(importlib.import_module(module_name), class_name)

    class Subclass(vended_class):
        pass

    for model_class in (vended_class, Subclass):
        model = object.__new__(model_class)
        model.get_config = lambda: {"model_id": "model-a"}

        assert _model_key(model) == (exp_provider_name, "model-a")


@pytest.mark.parametrize(
    ("model", "exp_model_key"),
    [
        (lambda: OpenAIModel(model_id="gpt-a"), ("openai", "gpt-a")),
        (lambda: OpenAIResponsesModel(model_id="gpt-a"), ("openai", "gpt-a")),
        (
            lambda: OpenAIModel(client_args={"base_url": "https://api.openai.com/v1"}, model_id="gpt-a"),
            ("openai", "gpt-a"),
        ),
        (lambda: OpenAIModel(client=openai.AsyncOpenAI(), model_id="gpt-a"), ("openai", "gpt-a")),
        (lambda: OpenAIModel(client_args={"base_url": "https://llm.example.com/v1"}, model_id="m"), (None, "m")),
        (lambda: OpenAIResponsesModel(client_args={"base_url": "http://localhost:8000"}, model_id="m"), (None, "m")),
        (
            lambda: OpenAIModel(client=openai.AsyncOpenAI(base_url="https://llm.example.com/v1"), model_id="m"),
            (None, "m"),
        ),
        (lambda: OpenAIModel(client=object(), model_id="m"), (None, "m")),
        (
            lambda: OpenAIResponsesModel(model_id="openai.gpt-a", bedrock_mantle_config={"region": "us-east-1"}),
            ("bedrock", "openai.gpt-a"),
        ),
        (
            lambda: OpenAIModel(
                model_id="openai.gpt-a", bedrock_mantle_config={"endpoint": "bedrock-runtime", "region": "us-east-1"}
            ),
            ("bedrock", "openai.gpt-a"),
        ),
        (
            lambda: OpenAIResponsesModel(
                client=openai.AsyncOpenAI(base_url="https://bedrock-mantle.us-east-1.api.aws/v1"),
                model_id="openai.gpt-a",
            ),
            ("bedrock", "openai.gpt-a"),
        ),
        (
            lambda: OpenAIModel(
                client_args={"base_url": "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"},
                model_id="openai.gpt-a",
            ),
            ("bedrock", "openai.gpt-a"),
        ),
        (
            lambda: OpenAIModel(
                client_args={"base_url": "https://bedrock-runtime-fips.us-east-1.amazonaws.com/openai/v1"},
                model_id="openai.gpt-a",
            ),
            ("bedrock", "openai.gpt-a"),
        ),
        (
            lambda: OpenAIModel(client_args={"base_url": "https://bedrock-mantle.example.com/v1"}, model_id="m"),
            (None, "m"),
        ),
        (lambda: LiteLLMModel(client_args={"base_url": "https://llm.example.com"}, model_id="a/b"), ("litellm", "a/b")),
        (
            lambda: AnthropicModel(client_args={"api_key": "k"}, model_id="claude-a", max_tokens=1),
            ("anthropic", "claude-a"),
        ),
        (
            lambda: AnthropicModel(
                client=anthropic.AsyncAnthropicBedrock(aws_region="us-west-2"),
                model_id="anthropic.claude-a",
                max_tokens=1,
            ),
            ("bedrock", "anthropic.claude-a"),
        ),
        pytest.param(
            lambda: AnthropicModel(
                client=anthropic.AsyncAnthropicBedrockMantle(aws_region="us-west-2"),
                model_id="anthropic.claude-a",
                max_tokens=1,
            ),
            ("bedrock", "anthropic.claude-a"),
            marks=pytest.mark.skipif(
                not hasattr(anthropic, "AsyncAnthropicBedrockMantle"),
                reason="anthropic before 0.91 has no Mantle client",
            ),
        ),
        (lambda: AnthropicModel(client=object(), model_id="claude-a", max_tokens=1), (None, "claude-a")),
        (lambda: MockedModelProvider([]), (None, None)),
        (lambda: None, (None, None)),
    ],
    ids=[
        "openai",
        "openai-responses",
        "openai-explicit-default-base-url",
        "openai-default-client",
        "openai-custom-base-url",
        "openai-responses-custom-base-url",
        "openai-client-with-custom-base-url",
        "openai-client-without-base-url",
        "openai-responses-on-mantle",
        "openai-on-bedrock-runtime",
        "openai-responses-client-with-mantle-base-url",
        "openai-with-bedrock-runtime-base-url",
        "openai-with-bedrock-runtime-fips-base-url",
        "openai-with-a-bedrock-lookalike-base-url",
        "litellm-is-not-openai",
        "anthropic",
        "anthropic-on-bedrock-client",
        "anthropic-on-mantle-client",
        "anthropic-on-unknown-client",
        "custom-model",
        "no-model",
    ],
)
def test_model_key_names_a_model_by_the_endpoint_it_calls(model, exp_model_key):
    tru_model_key = _model_key(model())

    assert tru_model_key == exp_model_key


def test_model_key_names_no_provider_for_openai_base_url_set_in_the_environment(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://llm.example.com/v1")

    assert _model_key(OpenAIModel(model_id="m")) == (None, "m")


@pytest.mark.parametrize(
    "get_config",
    [
        unittest.mock.Mock(side_effect=RuntimeError("no config")),
        lambda: None,
        lambda: ["model_id"],
        lambda: {},
        lambda: {"model_id": 7},
        lambda: {"model_id": None},
    ],
    ids=["raises", "none", "list", "no-model-id", "int-model-id", "none-model-id"],
)
def test_model_key_never_raises_on_a_config_it_cannot_read(get_config):
    model = OpenAIModel(model_id="gpt-a")
    model.get_config = get_config

    assert _model_key(model) == ("openai", None)


def test_model_key_records_a_sagemaker_model_under_its_endpoint_name():
    class Subclass(SageMakerAIModel):
        pass

    for model_class in (SageMakerAIModel, Subclass):
        model = model_class(
            endpoint_config={"endpoint_name": "endpoint-a"},
            payload_config={"max_tokens": 1},
            boto_session=unittest.mock.Mock(),
        )

        assert _model_key(model) == ("sagemaker", "endpoint-a")


def test_model_key_reads_the_model_id_of_a_config_object():
    model = OpenAIModel(model_id="gpt-a")
    model.get_config = lambda: types.SimpleNamespace(model_id="gpt-b")

    assert _model_key(model) == ("openai", "gpt-b")


def test_model_key_names_no_provider_when_naming_it_raises():
    model = OpenAIModel(model_id="gpt-a")
    del model._bedrock_mantle_config

    assert _model_key(model) == (None, "gpt-a")
