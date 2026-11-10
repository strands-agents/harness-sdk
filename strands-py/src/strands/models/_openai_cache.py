"""Shared prompt-caching translation for OpenAI model providers.

OpenAI caches prompt prefixes automatically server-side and routes reads on a caller-supplied
``prompt_cache_key``. This helper maps routing and retention settings; the Responses provider
also places explicit message checkpoints on models that support them.
"""

import warnings
from typing import Any

from ..agent.agent_metadata import AgentMetadata
from ._validation import warn_on_cache_config_not_supported
from .model import CacheConfig

# OpenAI's prompt_cache_retention accepts only these literals. ttl maps through only on an exact
# match - the SDK never guesses a conversion from an arbitrary duration string.
_RETENTION_LITERALS = frozenset({"in_memory", "24h"})

# Minimum cache lifetimes that prompt_cache_options.ttl and prompt_cache_breakpoint.ttl accept on
# models that take cache points (GPT-5.6 and later); older models use prompt_cache_retention instead.
CACHE_LIFETIMES = frozenset({"30m", "12h"})


def _resolve_cache_key(cache_config: CacheConfig, agent_metadata: AgentMetadata | None) -> str | None:
    """Resolve the prompt-cache routing key: configured value wins, else derive from the session.

    Returns the configured ``cache_key`` when it names one; ``cache_key=False`` is an explicit opt-out
    (no key). Left unset, it derives ``strands-<session_id>`` when the agent carries a session id, else None.
    """
    if cache_config.cache_key is False:
        return None
    if cache_config.cache_key is not None:
        return cache_config.cache_key
    if agent_metadata is not None and agent_metadata.session_id is not None:
        return f"strands-{agent_metadata.session_id}"
    return None


def apply_cache_config(
    request: dict[str, Any],
    cache_config: CacheConfig | None,
    agent_metadata: AgentMetadata | None = None,
    *,
    supports_message_caching: bool = False,
) -> None:
    """Map a ``CacheConfig`` onto an OpenAI request in place.

    An explicit value already present in ``request`` (carried in from the user's ``params``) always
    wins; this fills in only what ``params`` did not set. On models that take cache points, a ``ttl``
    naming a cache lifetime (``"30m"``/``"12h"``) becomes the default ``prompt_cache_options.ttl``;
    otherwise a ``ttl`` naming a retention literal maps to ``prompt_cache_retention``. Any other
    ``ttl``, a ``messages_ttl`` string that is not a cache lifetime, and fields with no effect are
    surfaced through ``warnings.warn`` (deduped per call site by the standard library's default
    filter), matching the config-validation warnings in ``_validation.py``.

    The prompt-cache routing key resolves as: the configured ``cache_key`` wins when set to a string,
    ``cache_key=False`` opts out; otherwise it falls back to ``strands-<session_id>`` when the agent
    carries a session id. A falsy result (empty or None) emits no key.

    Args:
        request: The request dict being assembled; mutated in place.
        cache_config: The provider's configured cache settings, if any.
        agent_metadata: The invoking agent's metadata, used to derive a routing key when one is unset.
        supports_message_caching: Whether the caller implements the message-checkpoint opt-out.
    """
    if cache_config is None:
        return

    cache_key = _resolve_cache_key(cache_config, agent_metadata)
    if cache_key and "prompt_cache_key" not in request:
        request["prompt_cache_key"] = cache_key

    if supports_message_caching and cache_config.ttl in CACHE_LIFETIMES:
        request["prompt_cache_options"] = {"ttl": cache_config.ttl, **request.get("prompt_cache_options", {})}
    elif cache_config.ttl is not None and "prompt_cache_retention" not in request:
        if cache_config.ttl in _RETENTION_LITERALS:
            request["prompt_cache_retention"] = cache_config.ttl
        else:
            warnings.warn(
                f"cache_config.ttl={cache_config.ttl!r} is not an openai retention value ('in_memory' or '24h') "
                "or, on models that take cache points, cache lifetime ('30m' or '12h') and will be ignored",
                stacklevel=4,
            )

    messages_ttl = cache_config.messages_ttl
    if supports_message_caching and isinstance(messages_ttl, str) and messages_ttl not in CACHE_LIFETIMES:
        warnings.warn(
            f"cache_config.messages_ttl={messages_ttl!r} is not an openai cache lifetime ('30m' or '12h') "
            "and will be ignored",
            stacklevel=4,
        )

    supported = {"cache_key", "ttl"}
    if supports_message_caching:
        # strategy selects message checkpoints ("auto" and "anthropic" both place them).
        supported.update({"messages_ttl", "strategy"})
    warn_on_cache_config_not_supported(cache_config, "OpenAI", supported=supported)
