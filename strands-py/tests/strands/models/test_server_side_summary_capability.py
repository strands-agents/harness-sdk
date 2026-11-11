"""Which providers report a server-side summary, and what the summarize strategy stores for them."""

import unittest.mock

import pytest

from strands import Agent
from strands._context_manager.strategies.offload import Offload
from strands._context_manager.types import ContextState
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
from strands.types.content import ContentBlock, Message, Messages

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
    assert make_model().model_info.capabilities.server_side_summary is False
    override = ModelInfo(capabilities=ModelCapabilities(server_side_summary=True))
    assert make_model(model_info=override).model_info.capabilities.server_side_summary is True


class _ListedIdModel(Model):
    """A custom provider whose model id is listed with a server-side summary but that does not override summarize."""

    def __init__(self):
        self.requests: list[Messages] = []

    def update_config(self, **model_config):
        pass

    def get_config(self):
        return {"model_id": MODEL_ID}

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.requests.append(messages)
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": "a summary"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


@pytest.mark.asyncio
async def test_custom_provider_with_a_listed_id_stores_its_summary_as_text():
    model = _ListedIdModel()
    assert model.model_info.capabilities.server_side_summary is True
    messages: Messages = [
        Message(role="user", content=[ContentBlock(text="task")]),
        Message(role="assistant", content=[ContentBlock(text="old1")]),
        Message(role="user", content=[ContentBlock(text="old2")]),
        Message(role="assistant", content=[ContentBlock(text="old3")]),
        Message(role="user", content=[ContentBlock(text="recent")]),
    ]
    tokens = await model.count_tokens(messages[1:4])
    agent = Agent(model=model, messages=messages, callback_handler=None)
    strategy = Offload.summarize("*").when(utilization=0.8, preserve_recent=1)

    assert await strategy.apply(ContextState(messages=agent.messages, agent=agent, utilization=0.9)) is True
    await agent.invoke_async("next")

    marker = f"[Summarized: 3 messages, ~{tokens:,} tokens]\n\na summary"
    without_tracking_ids = [{k: v for k, v in message.items() if k != "tracking_id"} for message in agent.messages[:3]]
    assert without_tracking_ids == [
        Message(role="user", content=[ContentBlock(text="task")]),
        Message(role="assistant", content=[ContentBlock(text=marker)]),
        Message(role="user", content=[ContentBlock(text="recent")]),
    ]
    sent_blocks = [block for request in model.requests for message in request for block in message["content"]]
    assert not any("summary" in block for block in sent_blocks)
