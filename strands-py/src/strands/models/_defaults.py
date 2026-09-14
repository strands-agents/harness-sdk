"""Default model metadata lookup tables.

Provides context window limits for known model IDs across all providers.
Values sourced from provider documentation and
https://github.com/BerriAI/litellm/blob/litellm_internal_staging/model_prices_and_context_window.json

Applied to providers with well-known, fixed model IDs: Bedrock, Anthropic, OpenAI,
OpenAI Responses, Gemini, and Mistral. Providers that use local/custom model IDs
(Ollama, LlamaCpp, SageMaker) or proxy to other providers with their own prefixed
ID format (LiteLLM) are excluded — their context windows depend on deployment config,
not a static table.
"""

import logging
from collections.abc import Mapping
from typing import TypeVar

logger = logging.getLogger(__name__)

_C = TypeVar("_C", bound=Mapping[str, object])

# Default context window limit (in tokens) when the model does not report one.
DEFAULT_CONTEXT_WINDOW_LIMIT = 200_000

# Context window limits (in tokens) for known model IDs.
#
# Best-effort lookup table — unknown models return None and callers
# fall back gracefully (e.g. proactive compression is disabled).
# Users can always override with an explicit context_window_limit in their model config.
#
# For Bedrock models with cross-region prefixes (e.g. us., eu., global.),
# get_context_window_limit strips prefixes before lookup so only the base model ID is needed here.
_CONTEXT_WINDOW_LIMITS: dict[str, int] = {
    # Anthropic (direct API)
    "claude-sonnet-4-6": 1_000_000,
    "claude-sonnet-4-20250514": 1_000_000,
    "claude-sonnet-4-5": 200_000,
    "claude-sonnet-4-5-20250929": 200_000,
    "claude-opus-4-6": 1_000_000,
    "claude-opus-4-6-20260205": 1_000_000,
    "claude-opus-4-7": 1_000_000,
    "claude-opus-4-7-20260416": 1_000_000,
    "claude-opus-4-8": 1_000_000,
    "claude-opus-5": 1_000_000,
    "claude-fable-5": 1_000_000,
    "claude-sonnet-5": 1_000_000,
    "claude-opus-4-5": 200_000,
    "claude-opus-4-5-20251101": 200_000,
    "claude-opus-4-20250514": 200_000,
    "claude-opus-4-1": 200_000,
    "claude-opus-4-1-20250805": 200_000,
    "claude-haiku-4-5": 200_000,
    "claude-haiku-4-5-20251001": 200_000,
    "claude-3-7-sonnet-20250219": 200_000,
    "claude-3-5-sonnet-20241022": 200_000,
    "claude-3-5-sonnet-20240620": 200_000,
    "claude-3-5-haiku-20241022": 200_000,
    "claude-3-opus-20240229": 200_000,
    "claude-3-haiku-20240307": 200_000,
    # Bedrock Anthropic (base model IDs — cross-region prefixes stripped by get_context_window_limit)
    "anthropic.claude-sonnet-4-6": 1_000_000,
    "anthropic.claude-sonnet-4-20250514-v1:0": 1_000_000,
    "anthropic.claude-sonnet-4-5-20250929-v1:0": 200_000,
    "anthropic.claude-opus-4-6-v1": 1_000_000,
    "anthropic.claude-opus-4-7": 1_000_000,
    "anthropic.claude-opus-4-8": 1_000_000,
    "anthropic.claude-opus-5": 1_000_000,
    "anthropic.claude-fable-5": 1_000_000,
    "anthropic.claude-sonnet-5": 1_000_000,
    "anthropic.claude-opus-4-5-20251101-v1:0": 200_000,
    "anthropic.claude-opus-4-20250514-v1:0": 200_000,
    "anthropic.claude-opus-4-1-20250805-v1:0": 200_000,
    "anthropic.claude-haiku-4-5-20251001-v1:0": 200_000,
    "anthropic.claude-haiku-4-5@20251001": 200_000,
    "anthropic.claude-3-7-sonnet-20250219-v1:0": 200_000,
    "anthropic.claude-3-7-sonnet-20240620-v1:0": 200_000,
    "anthropic.claude-3-5-sonnet-20241022-v2:0": 200_000,
    "anthropic.claude-3-5-sonnet-20240620-v1:0": 200_000,
    "anthropic.claude-3-5-haiku-20241022-v1:0": 200_000,
    "anthropic.claude-3-opus-20240229-v1:0": 200_000,
    "anthropic.claude-3-haiku-20240307-v1:0": 200_000,
    "anthropic.claude-3-sonnet-20240229-v1:0": 200_000,
    "anthropic.claude-mythos-preview": 1_000_000,
    # Bedrock Amazon Nova
    "amazon.nova-pro-v1:0": 300_000,
    "amazon.nova-lite-v1:0": 300_000,
    "amazon.nova-micro-v1:0": 128_000,
    "amazon.nova-premier-v1:0": 1_000_000,
    "amazon.nova-2-lite-v1:0": 1_000_000,
    "amazon.nova-2-pro-preview-20251202-v1:0": 1_000_000,
    # OpenAI
    "gpt-6-astra": 1_050_000,
    "gpt-5.6": 1_050_000,
    "gpt-5.6-sol": 1_050_000,
    "gpt-5.6-terra": 1_050_000,
    "gpt-5.6-luna": 1_050_000,
    "gpt-5.5": 1_050_000,
    "gpt-5.5-pro": 1_050_000,
    "gpt-5.4": 1_050_000,
    "gpt-5.4-pro": 1_050_000,
    "gpt-5.4-mini": 272_000,
    "gpt-5.4-nano": 272_000,
    "gpt-5.2": 272_000,
    "gpt-5.2-pro": 272_000,
    "gpt-5.1": 272_000,
    "gpt-5": 272_000,
    "gpt-5-mini": 272_000,
    "gpt-5-nano": 272_000,
    "gpt-5-pro": 128_000,
    "gpt-4.1": 1_047_576,
    "gpt-4.1-mini": 1_047_576,
    "gpt-4.1-nano": 1_047_576,
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "gpt-4-turbo": 128_000,
    "o3": 200_000,
    "o3-mini": 200_000,
    "o3-pro": 200_000,
    "o4-mini": 200_000,
    "o1": 200_000,
    # Google Gemini
    "gemini-2.5-flash": 1_048_576,
    "gemini-2.5-flash-lite": 1_048_576,
    "gemini-2.5-pro": 1_048_576,
    "gemini-2.0-flash": 1_048_576,
    "gemini-2.0-flash-lite": 1_048_576,
    "gemini-3-pro-preview": 1_048_576,
    "gemini-3-flash-preview": 1_048_576,
    "gemini-3.6-flash": 1_048_576,
    "gemini-3.5-flash": 1_048_576,
    "gemini-3.5-flash-lite": 1_048_576,
    "gemini-3.1-flash-lite": 1_048_576,
    "gemini-3.1-pro-preview": 1_048_576,
    "gemini-3.1-flash-lite-preview": 1_048_576,
    # Mistral
    "mistral-large-latest": 262_144,
    "mistral-large-2512": 262_144,
    "mistral-large-3": 262_144,
    "mistral-medium-latest": 131_072,
    "mistral-medium-2505": 131_072,
    "mistral-small-latest": 131_072,
    "mistral-small-3-2-2506": 131_072,
}


def get_context_window_limit(model_id: str) -> int | None:
    """Look up the context window limit for a model ID.

    For Bedrock model IDs with prefixes (e.g. ``us.anthropic.claude-sonnet-4-6``),
    prefixes are stripped as a fallback if the direct lookup fails.

    Args:
        model_id: The model ID to look up.

    Returns:
        The context window limit in tokens, or None if not found.
    """
    direct = _CONTEXT_WINDOW_LIMITS.get(model_id)
    if direct is not None:
        return direct

    # Fallback: strip prefixes before each dot and retry (handles nested cross-region prefixes and ARNs)
    stripped = model_id
    while (dot_index := stripped.find(".")) != -1:
        stripped = stripped[dot_index + 1 :]
        result = _CONTEXT_WINDOW_LIMITS.get(stripped)
        if result is not None:
            logger.debug(
                "model_id=<%s>, stripped_id=<%s> | resolved context window limit via prefix strip", model_id, stripped
            )
            return result

    return None


def resolve_config_metadata(config: _C, model_id: str) -> _C:
    """Resolve model metadata fields on a config dict from built-in lookup tables.

    When ``context_window_limit`` is not explicitly set, looks it up from the built-in table.
    Explicit values pass through unchanged. Returns a new dict only when resolution adds a field;
    otherwise returns the original config to avoid unnecessary allocation.

    Args:
        config: The stored model config dict.
        model_id: The model ID to look up.

    Returns:
        The config with resolved metadata, or the original config if nothing to resolve.
    """
    if "context_window_limit" in config:
        return config

    limit = get_context_window_limit(model_id)
    if limit is None:
        return config

    return {**config, "context_window_limit": limit}  # type: ignore[return-value]
