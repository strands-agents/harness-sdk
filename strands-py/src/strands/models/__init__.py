"""SDK model providers.

This package includes an abstract base Model class along with concrete implementations for specific providers.
"""

from typing import Any

from . import bedrock, model, routing
from .bedrock import BedrockModel
from .model import BaseModelConfig, CacheConfig, CacheToolsConfig, Model
from .routing import (
    CandidateInput,
    ClassifierStrategy,
    FallbackStrategy,
    ModelRouter,
    RoutingAttempt,
    RoutingCandidate,
    RoutingContext,
    RoutingStrategy,
)

__all__ = [
    "bedrock",
    "model",
    "routing",
    "BaseModelConfig",
    "BedrockModel",
    "CacheConfig",
    "CacheToolsConfig",
    "CandidateInput",
    "ClassifierStrategy",
    "FallbackStrategy",
    "Model",
    "ModelRouter",
    "RoutingAttempt",
    "RoutingCandidate",
    "RoutingContext",
    "RoutingStrategy",
]


def __getattr__(name: str) -> Any:
    """Lazy load model implementations only when accessed.

    This defers the import of optional dependencies until actually needed.
    """
    if name == "AnthropicModel":
        from .anthropic import AnthropicModel

        return AnthropicModel
    if name == "GeminiModel":
        from .gemini import GeminiModel

        return GeminiModel
    if name == "LiteLLMModel":
        from .litellm import LiteLLMModel

        return LiteLLMModel
    if name == "LlamaAPIModel":
        from .llamaapi import LlamaAPIModel

        return LlamaAPIModel
    if name == "LlamaCppModel":
        from .llamacpp import LlamaCppModel

        return LlamaCppModel
    if name == "MistralModel":
        from .mistral import MistralModel

        return MistralModel
    if name == "OllamaModel":
        from .ollama import OllamaModel

        return OllamaModel
    if name == "OpenAIModel":
        from .openai import OpenAIModel

        return OpenAIModel
    if name == "OpenAIResponsesModel":
        from .openai_responses import OpenAIResponsesModel

        return OpenAIResponsesModel
    if name == "SageMakerAIModel":
        from .sagemaker import SageMakerAIModel

        return SageMakerAIModel
    if name == "WriterModel":
        from .writer import WriterModel

        return WriterModel
    raise AttributeError(f"cannot import name '{name}' from '{__name__}' ({__file__})")
