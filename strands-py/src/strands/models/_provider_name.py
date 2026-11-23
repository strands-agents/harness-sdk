"""Name the provider and model a model instance calls, for per-model usage records.

Internal: the names are derived from the vended model classes until a model reports its provider itself.
"""

import os
import re
from typing import Any
from urllib.parse import urlparse

# Keyed by class path, so no optional provider SDK is imported to decide.
_PROVIDER_NAMES = {
    "strands.models.anthropic.AnthropicModel": "anthropic",
    "strands.models.bedrock.BedrockModel": "bedrock",
    "strands.models.gemini.GeminiModel": "google",
    "strands.models.litellm.LiteLLMModel": "litellm",
    "strands.models.llamaapi.LlamaAPIModel": "llamaapi",
    "strands.models.llamacpp.LlamaCppModel": "llamacpp",
    "strands.models.mistral.MistralModel": "mistral",
    "strands.models.ollama.OllamaModel": "ollama",
    "strands.models.openai.OpenAIModel": "openai",
    "strands.models.openai_responses.OpenAIResponsesModel": "openai",
    "strands.models.sagemaker.SageMakerAIModel": "sagemaker",
    "strands.models.writer.WriterModel": "writer",
}
_BEDROCK_HOSTS = re.compile(r"bedrock-mantle\.[a-z0-9-]+\.api\.aws|bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com")
_ANTHROPIC_CLIENTS = {
    "AsyncAnthropic": "anthropic",
    "AsyncAnthropicBedrock": "bedrock",
    "AsyncAnthropicBedrockMantle": "bedrock",
}


def _model_key(model: Any) -> tuple[str | None, str | None]:
    """Return the provider name and model id a model's usage is recorded under; ``None`` for what is not known.

    It never raises, since it runs in the model call path on models whose config can be anything.
    """
    try:
        provider_name = _provider_name(model)
    except Exception:
        provider_name = None
    # A SageMaker config has no model id; the endpoint name tells its endpoints apart.
    id_key = "endpoint_name" if provider_name == "sagemaker" else "model_id"
    try:
        config = model.get_config()
        model_id = config.get(id_key) if isinstance(config, dict) else getattr(config, id_key, None)
    except Exception:
        model_id = None
    return provider_name, model_id if isinstance(model_id, str) else None


def _provider_name(model: Any) -> str | None:
    """Name the provider by the first vended class in the model's MRO, so a subclass keeps its parent's name."""
    paths = (f"{cls.__module__}.{cls.__name__}" for cls in type(model).__mro__)
    name = next((_PROVIDER_NAMES[path] for path in paths if path in _PROVIDER_NAMES), None)
    if name == "openai":
        return _openai_provider_name(model)
    if name == "anthropic":
        client_classes = (cls.__name__ for cls in type(model.client).__mro__)
        return next((_ANTHROPIC_CLIENTS[cls] for cls in client_classes if cls in _ANTHROPIC_CLIENTS), None)
    return name


def _openai_provider_name(model: Any) -> str | None:
    """Name an OpenAI-class model by its endpoint; a base URL other than OpenAI's or Bedrock's may be any vendor."""
    if model._bedrock_mantle_config is not None:
        return "bedrock"
    if model._custom_client is not None:
        base_url = model._custom_client.base_url
    else:
        base_url = model.client_args.get("base_url") or os.environ.get("OPENAI_BASE_URL")
    host = "api.openai.com" if base_url is None else urlparse(str(base_url)).hostname or ""
    if host == "api.openai.com":
        return "openai"
    return "bedrock" if _BEDROCK_HOSTS.fullmatch(host) else None
