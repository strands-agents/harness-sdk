"""Model resolution from ``provider/name`` strings, with per-provider reasoning config.

Consumers pass a ready ``Model`` instance, a ``"provider/name"`` string, a bare Bedrock model
id, or ``None`` for the harness default. Every provider uses its real model ids directly. The
``effort`` level is mapped to each provider's own request fields here, so the caller sets one
value regardless of provider.

Prompt caching is requested via ``caching`` and reaches the provider one of two ways: the harness
configures Bedrock and Anthropic direct (cache points plus cached tool definitions), while OpenAI,
Gemini, bedrock-mantle, and litellm cache automatically server-side (Gemini on models 2.5 and
newer; litellm through its OpenAI-compatible backend). Only a pre-built ``Model`` or ``ModelRouter``
instance can't be honored (its provider is unknown), so a warning is logged.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Callable
from typing import Any, NamedTuple

from strands.models import Model, ModelRouter

from strands_harness import defaults
from strands_harness.types.agent import Effort

logger = logging.getLogger(__name__)

_ANTHROPIC_MAX_TOKENS = 32_000
# Claude calls the search directly (not from code execution), so results come back as citations
# and the tool works on every Claude model, not only those with programmatic tool calling.
_ANTHROPIC_WEB_SEARCH = {"type": "web_search_20260318", "name": "web_search", "allowed_callers": ["direct"]}

# Claude's real max_tokens ceiling by tier, verified live against Bedrock Converse. Applied on
# Bedrock and Anthropic-direct only — other Bedrock-hosted model families aren't known to need
# this. Matched as a substring so any Bedrock region/vendor prefix in front of it doesn't matter.
_CLAUDE_MAX_TOKENS = {
    "claude-opus-": 128_000,
    "claude-sonnet-": 128_000,
    "claude-haiku-": 64_000,
    "claude-fable-": 128_000,
}
_CLAUDE_MAX_TOKENS_BY_VERSION = (
    ("claude-opus-4-5", 64_000),
    ("claude-opus-4.5", 64_000),
    ("claude-sonnet-4-5", 64_000),
    ("claude-sonnet-4.5", 64_000),
)


def _claude_max_tokens(model_id: str) -> int | None:
    pinned = next((tokens for needle, tokens in _CLAUDE_MAX_TOKENS_BY_VERSION if needle in model_id), None)
    if pinned is not None:
        return pinned
    return next((tokens for needle, tokens in _CLAUDE_MAX_TOKENS.items() if needle in model_id), None)


# Small, fast model per provider for the web_fetch summarizer. Keyed by the main agent's provider
# so the summarizer shares its credentials. Kept byte-identical with ``_WEB_FETCH_MODELS`` in the
# TypeScript ``models.ts``.
_WEB_FETCH_MODELS = {
    "bedrock": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "bedrock-mantle": "openai.gpt-5.6-luna",
    "anthropic": "claude-haiku-4-5-20251001",
    "openai": "gpt-5.6-luna",
    "google": "gemini-3.5-flash",
}

# Cross-region inference profile prefixes stripped from a Bedrock model id before matching its
# provider family. Kept byte-identical with ``models.ts``.
# Providers whose endpoint can be repointed by an env var. A non-default endpoint publishes its
# own model list, so the vended small summarizer is not guaranteed to exist on it.
_CUSTOM_ENDPOINT_VARS = {"anthropic": "ANTHROPIC_BASE_URL", "openai": "OPENAI_BASE_URL"}

_BEDROCK_REGION_PREFIXES = ("global.", "apac.", "us.", "eu.", "au.", "jp.")


# Reasoning levels each provider's API accepts. The harness validates against the resolved
# provider's set so an unsupported level fails here rather than as a request error.
_ANTHROPIC_LEVELS = ("low", "medium", "high", "xhigh", "max")
_OPENAI_LEVELS = ("minimal", "low", "medium", "high", "xhigh", "none")
_BEDROCK_GPT_LEVELS = ("none", "low", "medium", "high", "xhigh", "max")
_BEDROCK_GPT_OSS_LEVELS = ("low", "medium", "high")
_BEDROCK_QWEN_LEVELS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
_BEDROCK_XAI_LEVELS = ("low", "medium", "high", "xhigh")
_GOOGLE_LEVELS = ("minimal", "low", "medium", "high")

_ADAPTIVE_THINKING_SINCE = {"opus": (4, 6), "sonnet": (4, 6)}
_EXTENDED_THINKING_SINCE = {"opus": (4, 5), "sonnet": (4, 5), "haiku": (4, 5)}
_CLAUDE_ID = re.compile(
    r"claude-(?:(\d{1,2})(?:[-.](\d{1,2}))?-)?(opus|sonnet|haiku|fable|mythos)"
    r"(?:[-.](\d{1,2}))?(?:[-.](\d{1,2}))?(?!\d)"
)
_EXTENDED_THINKING_BUDGETS = {"low": 2_048, "medium": 8_192, "high": 16_384, "xhigh": 32_768, "max": 49_152}


def _claude_thinking_mode(model_id: str) -> str | None:
    match = _CLAUDE_ID.search(model_id)
    if match is None:
        return "adaptive"
    lead_major, lead_minor, family, major, minor = match.groups()
    if major is None and lead_major is None:
        takes_adaptive = family not in _EXTENDED_THINKING_SINCE or family in _ADAPTIVE_THINKING_SINCE
        return "adaptive" if takes_adaptive else "extended"
    version = (int(major), int(minor or 0)) if major is not None else (int(lead_major), int(lead_minor or 0))
    if family not in _EXTENDED_THINKING_SINCE:
        return "adaptive"
    if version >= _ADAPTIVE_THINKING_SINCE.get(family, (99, 99)):
        return "adaptive"
    return "extended" if version >= _EXTENDED_THINKING_SINCE[family] else None


def _claude_thinking(effort: str) -> dict:
    return {
        "thinking": {"type": "adaptive", "display": "summarized"},
        "output_config": {"effort": effort},
    }


def _claude_extended_thinking(effort: str, max_tokens: int) -> dict:
    return {"thinking": {"type": "enabled", "budget_tokens": min(_EXTENDED_THINKING_BUDGETS[effort], max_tokens - 1)}}


def _claude_thinking_block(model_id: str, effort: str, max_tokens: int) -> dict:
    if _claude_thinking_mode(model_id) == "extended":
        return _claude_extended_thinking(effort, max_tokens)
    return _claude_thinking(effort)


def _bedrock_family(model_id: str) -> str:
    prefix = next((prefix for prefix in _BEDROCK_REGION_PREFIXES if model_id.startswith(prefix)), "")
    return model_id[len(prefix) :]


def _bedrock_levels(model_id: str) -> tuple[str, ...]:
    family = _bedrock_family(model_id)
    if family.startswith("anthropic."):
        return _ANTHROPIC_LEVELS if _claude_thinking_mode(family) is not None else ()
    if family.startswith("openai.gpt-5.6-") or family == "openai.gpt-6-astra":
        return _BEDROCK_GPT_LEVELS
    if family.startswith("openai.gpt-oss-"):
        return _BEDROCK_GPT_OSS_LEVELS
    if family.startswith("qwen."):
        return _BEDROCK_QWEN_LEVELS
    if family.startswith("xai."):
        return _BEDROCK_XAI_LEVELS
    return ()


def _bedrock_effort(model_id: str, effort: Effort) -> str | None:
    levels = _bedrock_levels(model_id)
    if levels:
        return _effort(effort, "high", levels, f"Bedrock model {model_id}")
    _check_effort(effort)
    if effort in ("auto", "off"):
        return None
    raise ValueError(f"Effort {effort!r} is not supported by Bedrock model {model_id}. Pass 'auto' or 'off'.")


def _bedrock_thinking(model_id: str, effort: str | None) -> dict | None:
    if effort is None:
        return None
    family = _bedrock_family(model_id)
    if family.startswith("anthropic."):
        return _claude_thinking_block(family, effort, _claude_max_tokens(model_id) or _ANTHROPIC_MAX_TOKENS)
    if family.startswith("openai.gpt-5.6-") or family == "openai.gpt-6-astra":
        return {"reasoning": {"effort": effort}}
    if family.startswith("openai.gpt-oss-"):
        return {"reasoning_effort": effort}
    if family.startswith("qwen."):
        return {"reasoning_effort": effort}
    if family.startswith("xai."):
        return {"reasoning_effort": effort}
    return None


def _bedrock(model_id: str, effort: str | None, web_search: bool, caching: bool) -> Model:
    from strands.models import BedrockModel, CacheConfig

    thinking = _bedrock_thinking(model_id, effort)
    extra: dict[str, Any] = {} if thinking is None else {"additional_request_fields": thinking}
    max_tokens = _claude_max_tokens(model_id)
    if max_tokens is not None:
        extra["max_tokens"] = max_tokens
    if caching:
        # The SDK injects cache points for Anthropic model ids on Bedrock (a no-op for others).
        # Tools are stable across turns, so cache them too.
        extra["cache_config"] = CacheConfig(strategy="auto", tools_ttl=True)
    return BedrockModel(model_id=model_id, **extra)


def _anthropic(model_id: str, effort: str | None, web_search: bool, caching: bool) -> Model:
    from strands.models import CacheConfig
    from strands.models.anthropic import AnthropicModel

    max_tokens = _claude_max_tokens(model_id) or _ANTHROPIC_MAX_TOKENS
    extra: dict[str, Any] = {} if effort is None else {"params": _claude_thinking_block(model_id, effort, max_tokens)}
    if web_search:
        extra["anthropic_tools"] = [_ANTHROPIC_WEB_SEARCH]
    if caching:
        # Caches the tool definitions plus a cache point on the last user message; the system
        # prompt is cached automatically. Mirrors the Bedrock builder.
        extra["cache_config"] = CacheConfig(strategy="auto", tools_ttl=True)
    return AnthropicModel(model_id=model_id, max_tokens=max_tokens, **extra)


def _openai(model_id: str, effort: str | None, web_search: bool, caching: bool) -> Model:
    # ``caching`` is unused: OpenAI caches server-side with no opt-in.
    from strands.models.openai_responses import OpenAIResponsesModel

    params: dict[str, Any] = {}
    if effort is not None:
        params["reasoning"] = {"effort": effort}
    # The Responses API merges built-in tools carried in ``params`` with the agent's function tools.
    if web_search:
        params["tools"] = [{"type": "web_search"}]
    return OpenAIResponsesModel(model_id=model_id, **({"params": params} if params else {}))


def _bedrock_mantle(model_id: str, effort: str | None, _web_search: bool, caching: bool) -> Model:
    # ``caching`` is unused: Mantle caches server-side automatically.
    from strands.models.openai_responses import BedrockMantleConfig, OpenAIResponsesModel

    params: dict[str, Any] = {} if effort is None else {"reasoning": {"effort": effort}}
    return OpenAIResponsesModel(
        model_id=model_id, bedrock_mantle_config=BedrockMantleConfig(), **({"params": params} if params else {})
    )


def _gemini(model_id: str, effort: str | None, web_search: bool, caching: bool) -> Model:
    # ``caching`` is unused: Gemini caches implicitly server-side (models 2.5 and newer).
    from google.genai import types as genai_types
    from strands.models.gemini import GeminiModel

    extra: dict[str, Any] = {}
    if effort is not None:
        extra["params"] = {"thinking_config": {"thinking_level": effort}}
    # ``gemini_tools`` is appended alongside function declarations, so search coexists with tools.
    if web_search:
        extra["gemini_tools"] = [genai_types.Tool(google_search=genai_types.GoogleSearch())]
    return GeminiModel(model_id=model_id, **extra)


def _ollama(model_id: str, effort: str | None, web_search: bool, caching: bool) -> Model:
    from strands.models.ollama import OllamaModel

    # OLLAMA_API_KEY mirrors the TS builder, which sends it as a bearer token (for proxied hosts).
    api_key = os.environ.get("OLLAMA_API_KEY")
    client_args = {"headers": {"Authorization": f"Bearer {api_key}"}} if api_key else None
    return OllamaModel(
        host=os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434"),
        ollama_client_args=client_args,
        model_id=model_id,
    )


def _litellm(model_id: str, effort: str | None, web_search: bool, caching: bool) -> Model:
    # ``caching`` is unused: LiteLLM caches server-side via its OpenAI-compatible backend.
    from strands.models.litellm import LiteLLMModel

    api_key = os.environ.get("LITELLM_API_KEY")
    api_base = os.environ.get("LITELLM_BASE_URL")
    client_args = {
        **({"api_key": api_key} if api_key else {}),
        **({"api_base": api_base} if api_base else {}),
    }
    return LiteLLMModel(client_args=client_args, model_id=model_id)


class Provider(NamedTuple):
    """How one model provider is built and what reasoning/search/caching it supports.

    ``web_search`` is enabled through model config on the providers whose SDK exposes a
    non-clobbering seam for it (OpenAI Responses ``params.tools`` for OpenAI, Gemini
    ``gemini_tools``, and Anthropic ``anthropic_tools``). Bedrock Converse and Mantle have no
    compatible mechanism.

    ``caching`` marks providers where prompt caching is in effect when requested, whether or not
    the harness configures anything: Bedrock and Anthropic direct (the harness sets cache points and tool caching)
    plus OpenAI, Gemini, bedrock-mantle, and litellm (automatic server-side). Only a pre-built
    ``Model`` instance can't be honored (its provider is unknown), so the factory warns there.
    """

    build: Callable[[str, str | None, bool, bool], Model]
    recommended_thinking: str | None
    thinking_levels: tuple[str, ...]
    web_search: bool
    caching: bool


_PROVIDERS = {
    "bedrock": Provider(_bedrock, "high", _ANTHROPIC_LEVELS, web_search=False, caching=True),
    "bedrock-mantle": Provider(_bedrock_mantle, "high", _OPENAI_LEVELS, web_search=False, caching=True),
    "anthropic": Provider(_anthropic, "high", _ANTHROPIC_LEVELS, web_search=True, caching=True),
    "openai": Provider(_openai, "high", _OPENAI_LEVELS, web_search=True, caching=True),
    "google": Provider(_gemini, "high", _GOOGLE_LEVELS, web_search=True, caching=True),
    "ollama": Provider(_ollama, None, (), web_search=False, caching=False),
    "litellm": Provider(_litellm, None, (), web_search=False, caching=True),
}


EFFORT_LEVELS: tuple[Effort, ...] = ("auto", "off", "minimal", "low", "medium", "high", "xhigh", "max")


def _check_effort(effort: object) -> None:
    if effort in EFFORT_LEVELS:
        return
    raise ValueError(f"Unknown effort {effort!r}. Choose one of: {', '.join(EFFORT_LEVELS)}.")


def _effort(
    effort: Effort,
    recommended: str | None,
    levels: tuple[str, ...],
    subject: str = "this provider",
) -> str | None:
    """Map ``effort`` onto the provider's ``levels``; ``"off"`` is ``None`` where the provider has no ``none``."""
    _check_effort(effort)
    if effort == "off":
        return "none" if "none" in levels else None
    if effort == "auto":
        return recommended
    if effort in levels:
        return effort
    supported = [level for level in levels if level != "none"]
    detail = (
        f"Supported levels: {', '.join(supported)} (or 'auto', 'off')."
        if supported
        else "It supports no reasoning levels; pass 'auto' or 'off'."
    )
    raise ValueError(f"Effort {effort!r} is not supported by {subject}. {detail}")


def _split_provider(model: str) -> tuple[str, str]:
    """Split a ``"provider/name"`` string (or a bare Bedrock id) into ``(provider, name)``."""
    provider_name, sep, name = model.partition("/")
    if not sep:
        return "bedrock", model
    return provider_name, name


def _require_or_warn(explicit: bool, error: str, warning: str) -> None:
    """Raise ``error`` when a feature was requested explicitly but can't be honored; otherwise
    (the feature is on only by default) log ``warning`` and let the caller build without it."""
    if explicit:
        raise ValueError(error)
    logger.warning(warning)


def _has_web_search(provider_name: str) -> bool:
    provider = _PROVIDERS.get(provider_name)
    return provider is not None and provider.web_search


def supports_web_search(model: Model | ModelRouter | str | None) -> bool:
    """Whether native web search can be enabled for ``model``.

    A ``Model`` or ``ModelRouter`` instance has an unknown provider, so this is ``False``; the
    caller configures search on the instance directly. ``None`` resolves to the default model.
    """
    if isinstance(model, (Model, ModelRouter)):
        return False
    provider_name, _ = _split_provider(model or defaults.DEFAULT_MODEL)
    return _has_web_search(provider_name)


def supports_thinking(model: Model | str | None) -> bool:
    if isinstance(model, Model):
        return True
    provider_name, name = _split_provider(model or defaults.DEFAULT_MODEL)
    if provider_name == "bedrock":
        return bool(_bedrock_levels(name))
    if provider_name == "anthropic":
        return _claude_thinking_mode(name) is not None
    provider = _PROVIDERS.get(provider_name)
    return provider is not None and bool(provider.thinking_levels)


def _supports_media(model: Model | ModelRouter | str | None) -> bool:
    """Whether ``model`` accepts image and document blocks in a tool result.

    OpenAI-family models on Bedrock Converse reject both outright ("This model doesn't support the
    image field for user messages"), which fails the whole turn rather than degrading, so ``read``
    describes those files in text instead.

    A ``ModelRouter`` may switch models mid-conversation, so every candidate has to accept media for
    the tool to keep emitting it: one rejecting candidate is enough to fail a turn. A ``BedrockModel``
    instance is resolved through its configured ``model_id``; any other instance has an unknown
    provider and is assumed capable. Pass ``builtin_tools={"read": {"media": False}}`` to override.
    """
    from strands.models import BedrockModel

    if isinstance(model, ModelRouter):
        return all(_supports_media(candidate.model) for candidate in model.candidates)
    if isinstance(model, BedrockModel):
        model_id = (model.get_config() or {}).get("model_id")
        return _supports_media(model_id) if isinstance(model_id, str) else True
    if isinstance(model, Model):
        return True
    provider_name, name = _split_provider(model or defaults.DEFAULT_MODEL)
    if provider_name == "bedrock":
        return not _bedrock_family(name).startswith("openai.")
    return True


def resolve_model(
    model: Model | ModelRouter | str | None,
    default: str,
    effort: Effort = "auto",
    web_search: bool = False,
    caching: bool = False,
    caching_explicit: bool = False,
) -> Model | ModelRouter:
    """Resolve the ``model`` argument into a model or router instance.

    A passed-in ``Model`` or ``ModelRouter`` instance is used verbatim: its provider is unknown, so
    ``effort`` (when not ``"auto"``) and ``caching`` are ignored with a logged warning and never
    raise. For a ``provider/name`` string, ``effort`` is validated against the provider (and Bedrock
    model family); ``caching`` on a provider without it raises when explicit (``caching_explicit``)
    and otherwise warns and builds without it. ``web_search`` turns on the model's native search and
    is only passed for models that have one (``supports_web_search``).
    """
    _check_effort(effort)
    if isinstance(model, (Model, ModelRouter)):
        instance = "a pre-built Model instance or ModelRouter"
        if effort != "auto":
            logger.warning("effort=%r not applied to %s; configure reasoning on the instance", effort, instance)
        if caching:
            logger.warning("prompt caching not applied to %s; configure it on the instance", instance)
        return model
    if model is None:
        model = default

    provider_name, name = _split_provider(model)

    provider = _PROVIDERS.get(provider_name)
    if provider is None:
        supported = ", ".join(sorted(_PROVIDERS))
        raise ValueError(
            f"Unknown model provider {provider_name!r} in {model!r}. Supported providers: {supported}. "
            "Pass a strands.models.Model instance for anything else."
        )

    if caching and not provider.caching:
        supported = ", ".join(p for p, cfg in _PROVIDERS.items() if cfg.caching)
        _require_or_warn(
            caching_explicit,
            f"Provider {provider_name!r} does not support prompt caching. "
            f"Providers with caching: {supported}. Pass caching=False, "
            "or switch to a supported provider.",
            f"provider=<{provider_name}> | prompt caching not supported by this provider; continuing without it",
        )
    unsupported_caching = provider_name == "bedrock" and _bedrock_family(name).startswith("anthropic.claude-3-haiku-")
    if caching and unsupported_caching:
        _require_or_warn(
            caching_explicit,
            f"Model {provider_name}/{name} does not support prompt caching. Pass caching=False.",
            f"model=<{provider_name}/{name}> | prompt caching not supported by this model; continuing without it",
        )
    levels = provider.thinking_levels
    recommended = provider.recommended_thinking
    subject = "this provider"
    if provider_name == "anthropic" and _claude_thinking_mode(name) is None:
        levels, recommended, subject = (), None, f"model {name}"
    level = (
        _bedrock_effort(name, effort) if provider_name == "bedrock" else _effort(effort, recommended, levels, subject)
    )
    native_search = web_search and _has_web_search(provider_name)
    return provider.build(name, level, native_search, caching and provider.caching and not unsupported_caching)


def _bedrock_web_fetch_model(name: str) -> str | None:
    """Small Bedrock summarizer id for a Bedrock main model ``name``, or ``None`` if the family is
    unidentifiable.

    Bedrock hosts models from several providers, so the summarizer follows the main model's family.
    An Anthropic-on-Bedrock model (an ``anthropic.`` prefix, after any cross-region prefix like
    ``us.``) gets Anthropic Haiku; an OpenAI-on-Bedrock model (an ``openai.`` prefix) gets the OpenAI
    small model hosted on Bedrock (``openai.`` + the OpenAI-provider summarizer), carrying the main
    model's cross-region prefix because those ids are only served through an inference profile.
    Either way the summarizer shares the main model's provider. Any other family is unidentifiable
    and returns ``None`` so the caller can reuse the main model rather than guess.
    """
    family = _bedrock_family(name)
    if family.startswith("anthropic."):
        return _WEB_FETCH_MODELS["bedrock"]
    if family.startswith("openai."):
        prefix = name[: len(name) - len(family)]
        return f"{prefix}openai.{_WEB_FETCH_MODELS['openai']}"
    return None


def resolve_web_fetch_model(
    main_model: Model | ModelRouter | str | None,
    web_fetch_model: Model | ModelRouter | str | None,
) -> Model:
    """Resolve the model the web_fetch summarizer runs on.

    An explicit ``web_fetch_model`` (a ``Model`` or ``ModelRouter`` instance, or ``"provider/name"``
    string) wins. With none set, pick the small fast model for the main agent's provider so the
    summarizer shares its credentials; when the main model is a ``Model`` instance (provider unknown),
    reuse it as the summarizer. A router uses its concrete default model because auxiliary calls are
    outside the primary agent invocation and cannot share its routing decision. On Bedrock the
    summarizer follows the main model's family (Anthropic-on-Bedrock gets Haiku, OpenAI-on-Bedrock gets
    the OpenAI small model); a Bedrock family we can't identify reuses the main model and logs a warning
    rather than guessing. Thinking is never applied: summarizing a page is a fast task.

    ``caching`` is deliberately not forwarded: the single message carries the per-call prompt before
    the page body, so every fetch would write a cache entry no later call can read.
    """
    if isinstance(web_fetch_model, ModelRouter):
        return web_fetch_model.default_model
    if isinstance(web_fetch_model, Model):
        return web_fetch_model
    if web_fetch_model is not None:
        return _concrete_model(resolve_model(web_fetch_model, web_fetch_model, effort="off"))

    if isinstance(main_model, ModelRouter):
        return main_model.default_model
    if isinstance(main_model, Model):
        return main_model
    main = main_model if main_model is not None else defaults.DEFAULT_MODEL
    provider_name, name = _split_provider(main)
    if provider_name == "bedrock":
        small = _bedrock_web_fetch_model(name)
        if small is None:
            logger.warning(
                f"model=<{main}> | could not identify the Bedrock model family for the web_fetch "
                "summarizer; reusing the main model. Set builtin_tools={'web_fetch': {'model': ...}} to choose a "
                "smaller one."
            )
            return _concrete_model(resolve_model(main, main, effort="off"))
    elif (base_url_var := _CUSTOM_ENDPOINT_VARS.get(provider_name)) and os.environ.get(base_url_var):
        logger.warning(
            f"model=<{main}> | {base_url_var} points provider <{provider_name}> at a non-default "
            "endpoint, which serves its own model list, so the vended summarizer may not exist "
            "there; reusing the main model. Pass web_fetch_model to choose a smaller one."
        )
        return _concrete_model(resolve_model(main, main, effort="off"))
    else:
        small = _WEB_FETCH_MODELS.get(provider_name)
    if small is None:
        if provider_name in ("ollama", "litellm"):
            logger.warning(
                f"model=<{main}> | no separate web_fetch summarizer is configured for provider "
                f"<{provider_name}>; reusing the main model. Set builtin_tools={{'web_fetch': {{'model': ...}}}} "
                "to choose another model."
            )
            return _concrete_model(resolve_model(main, main, effort="off"))
        raise ValueError(
            f"No default web_fetch model for provider {provider_name!r}. "
            "Set builtin_tools={'web_fetch': {'model': ...}} explicitly, or disable web_fetch via builtin_tools."
        )
    return _concrete_model(resolve_model(f"{provider_name}/{small}", small, effort="off"))


def _concrete_model(model: Model | ModelRouter) -> Model:
    return model.default_model if isinstance(model, ModelRouter) else model
