"""
Aggregates all providers for testing all providers in one go.
"""

import os
from collections.abc import Callable

import requests
from pytest import mark

from strands.models import BedrockModel, Model
from strands.models.anthropic import AnthropicModel
from strands.models.bedrock import DEFAULT_BEDROCK_MODEL_ID
from strands.models.bedrock_invoke import BedrockInvokeModel
from strands.models.gemini import GeminiModel
from strands.models.litellm import LiteLLMModel
from strands.models.llamaapi import LlamaAPIModel
from strands.models.mistral import MistralModel
from strands.models.ollama import OllamaModel
from strands.models.openai import OpenAIModel
from strands.models.writer import WriterModel

try:
    from strands.models.openai_responses import OpenAIResponsesModel

    _openai_responses_available = True
except ImportError:
    _openai_responses_available = False


class ProviderInfo:
    """Provider-based info for providers that require an APIKey via environment variables."""

    def __init__(
        self,
        id: str,
        factory: Callable[[], Model],
        environment_variable: str | None = None,
    ) -> None:
        self.id = id
        self.model_factory = factory
        self.mark = mark.skipif(
            environment_variable is not None and environment_variable not in os.environ,
            reason=f"{environment_variable} environment variable missing",
        )

    def create_model(self) -> Model:
        return self.model_factory()


class OllamaProviderInfo(ProviderInfo):
    """Special case ollama as it's dependent on the server being available."""

    def __init__(self):
        super().__init__(
            id="ollama", factory=lambda: OllamaModel(host="http://localhost:11434", model_id="llama3.3:70b")
        )

        is_server_available = False
        try:
            is_server_available = requests.get("http://localhost:11434").ok
        except requests.exceptions.ConnectionError:
            pass

        self.mark = mark.skipif(
            not is_server_available,
            reason="Local Ollama endpoint not available at localhost:11434",
        )


anthropic = ProviderInfo(
    id="anthropic",
    environment_variable="ANTHROPIC_API_KEY",
    factory=lambda: AnthropicModel(
        client_args={
            "api_key": os.getenv("ANTHROPIC_API_KEY"),
        },
        model_id="claude-sonnet-4-6",
        max_tokens=512,
    ),
)
bedrock = ProviderInfo(id="bedrock", factory=lambda: BedrockModel())
bedrock_invoke_streaming = ProviderInfo(
    id="bedrock_invoke_streaming",
    factory=lambda: BedrockInvokeModel(model_id=DEFAULT_BEDROCK_MODEL_ID, streaming=True),
)
bedrock_invoke_non_streaming = ProviderInfo(
    id="bedrock_invoke_non_streaming",
    factory=lambda: BedrockInvokeModel(model_id=DEFAULT_BEDROCK_MODEL_ID, streaming=False),
)
cohere = ProviderInfo(
    id="cohere",
    environment_variable="COHERE_API_KEY",
    factory=lambda: OpenAIModel(
        client_args={
            "base_url": "https://api.cohere.com/compatibility/v1",
            "api_key": os.getenv("COHERE_API_KEY"),
        },
        model_id="command-a-03-2025",
        params={"stream_options": None},
    ),
)
litellm = ProviderInfo(
    id="litellm", factory=lambda: LiteLLMModel(model_id="bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0")
)
llama = ProviderInfo(
    id="llama",
    environment_variable="LLAMA_API_KEY",
    factory=lambda: LlamaAPIModel(
        model_id="Llama-4-Maverick-17B-128E-Instruct-FP8",
        client_args={
            "api_key": os.getenv("LLAMA_API_KEY"),
        },
    ),
)
mistral = ProviderInfo(
    id="mistral",
    environment_variable="MISTRAL_API_KEY",
    factory=lambda: MistralModel(
        model_id="mistral-medium-latest",
        api_key=os.getenv("MISTRAL_API_KEY"),
        stream=True,
        temperature=0.7,
        max_tokens=1000,
        top_p=0.9,
    ),
)
openai = ProviderInfo(
    id="openai",
    environment_variable="OPENAI_API_KEY",
    factory=lambda: OpenAIModel(
        model_id="gpt-4o",
        client_args={
            "api_key": os.getenv("OPENAI_API_KEY"),
        },
    ),
)
if _openai_responses_available:
    openai_responses = ProviderInfo(
        id="openai_responses",
        environment_variable="OPENAI_API_KEY",
        factory=lambda: OpenAIResponsesModel(
            model_id="gpt-4o",
            client_args={
                "api_key": os.getenv("OPENAI_API_KEY"),
            },
        ),
    )
else:
    openai_responses = None
writer = ProviderInfo(
    id="writer",
    environment_variable="WRITER_API_KEY",
    factory=lambda: WriterModel(
        model_id="palmyra-x4",
        client_args={"api_key": os.getenv("WRITER_API_KEY", "")},
        stream_options={"include_usage": True},
    ),
)
gemini = ProviderInfo(
    id="gemini",
    environment_variable="GOOGLE_API_KEY",
    factory=lambda: GeminiModel(
        client_args={"api_key": os.getenv("GOOGLE_API_KEY")},
        model_id="gemini-2.5-flash",
        params={"temperature": 0.7},
    ),
)

ollama = OllamaProviderInfo()


all_providers = [
    provider
    for provider in [
        bedrock,
        bedrock_invoke_streaming,
        bedrock_invoke_non_streaming,
        anthropic,
        cohere,
        gemini,
        llama,
        litellm,
        mistral,
        openai,
        openai_responses,
        writer,
    ]
    if provider is not None
]
