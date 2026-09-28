"""Shared prompt-caching translation for OpenAI model providers.

OpenAI caches prompt prefixes automatically server-side and routes reads on a caller-supplied
``prompt_cache_key``. It exposes no cache-point placement knobs, so of ``CacheConfig`` only
``cache_key`` (and, when it already names a valid retention literal, ``ttl``) maps onto the request.
"""

import warnings
from typing import Any

from ..agent.agent_metadata import AgentMetadata
from ._validation import warn_on_cache_config_not_supported
from .model import CacheConfig

# OpenAI's prompt_cache_retention accepts only these literals. ttl maps through only on an exact
# match - the SDK never guesses a conversion from an arbitrary duration string.
#
# prompt_cache_retention is deprecated in openai 2.54.0 in favor of prompt_cache_options.ttl, whose only
# accepted value today is "30m" - so "24h"/"in_memory" remain expressible only through this field.
_RETENTION_LITERALS = frozenset({"in_memory", "24h"})


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
    request: dict[str, Any], cache_config: CacheConfig | None, agent_metadata: AgentMetadata | None = None
) -> None:
    """Map a ``CacheConfig`` onto an OpenAI request in place.

    An explicit value already present in ``request`` (carried in from the user's ``params``) always
    wins; this fills in only what ``params`` did not set. ``strategy`` and ``system_prompt_ttl`` are
    accepted but have no effect, and a ``ttl`` that is not an OpenAI retention literal is ignored;
    each such no-op is surfaced through ``warnings.warn`` (deduped per call site by the standard
    library's default filter), matching the config-validation warnings in ``_validation.py``.

    The prompt-cache routing key resolves as: the configured ``cache_key`` wins when set to a string,
    ``cache_key=False`` opts out; otherwise it falls back to ``strands-<session_id>`` when the agent
    carries a session id. A falsy result (empty or None) emits no key.

    Args:
        request: The request dict being assembled; mutated in place.
        cache_config: The provider's configured cache settings, if any.
        agent_metadata: The invoking agent's metadata, used to derive a routing key when one is unset.
    """
    if cache_config is None:
        return

    cache_key = _resolve_cache_key(cache_config, agent_metadata)
    if cache_key and "prompt_cache_key" not in request:
        request["prompt_cache_key"] = cache_key

    if cache_config.ttl is not None and "prompt_cache_retention" not in request:
        if cache_config.ttl in _RETENTION_LITERALS:
            request["prompt_cache_retention"] = cache_config.ttl
        else:
            warnings.warn(
                f"cache_config.ttl={cache_config.ttl!r} is not an openai retention value "
                "('in_memory' or '24h') and will be ignored",
                stacklevel=4,
            )

    warn_on_cache_config_not_supported(cache_config, "OpenAI", supported={"cache_key", "ttl"})
