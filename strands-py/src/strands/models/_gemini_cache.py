"""Managed CachedContent lifecycle for the Gemini model provider.

Gemini's native ``CachedContent`` is a server-side, billed prefix cache keyed by an opaque resource
name. This module turns a ``CacheConfig`` into that resource: it resolves a content-derived identity,
reuses an existing cache with the same identity, and otherwise creates one holding the static prefix
(system instruction + tools). Identity is a fingerprint of the prefix, never session state, so any
caller sending the same prefix - across sessions or processes - shares one resource.

The cache is opt-in: a bare or absent ``CacheConfig`` never creates a billed resource.
"""

import hashlib
import json
import logging
import re
import warnings
from typing import Any

from google import genai

from ._validation import _cache_config_fields_set
from .model import CacheConfig

logger = logging.getLogger(__name__)

# CacheConfig fields Gemini's managed caching actually consumes. The rest (strategy, tools_ttl) warn
# when set, via warn_on_cache_config_not_supported.
_SUPPORTED_FIELDS = frozenset({"ttl", "system_prompt_ttl", "cache_key"})

# Gemini caps display_name at 128 characters; a longer cache_key is hashed to fit.
_DISPLAY_NAME_MAX = 128

# Fallback TTL when neither system_prompt_ttl nor ttl names a duration.
_DEFAULT_TTL_SECONDS = 3600

# Length of the content-fingerprint identity; 16 hex chars (64 bits) avoids collisions within a
# caller's cache namespace while keeping display names short.
_FINGERPRINT_LENGTH = 16

_DURATION_PATTERN = re.compile(r"^(\d+(?:\.\d+)?)(s|m|h|d)?$")
_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}

# caches.create failures that mean the prefix cannot be cached (too small, or model unsupported)
# rather than a genuine request error. Wording is not guaranteed stable, so matching stays narrow and
# the raw error is always logged at debug.
_UNCACHEABLE_STATUSES = frozenset({"INVALID_ARGUMENT", "FAILED_PRECONDITION"})
_UNCACHEABLE_PHRASES = ("too small", "minimum", "cached content is too small", "token count")


def should_engage_managed(cache_config: CacheConfig) -> bool:
    """Whether a ``CacheConfig`` opts into managed ``CachedContent`` rather than implicit-only caching.

    Managed caching creates a billed resource, so it engages only when the caller set a field Gemini
    can honor (``ttl``, a ``system_prompt_ttl`` duration, or ``cache_key``) to a non-default value and
    did not disable the system-prompt cache. Setting only an unsupported field (e.g. ``strategy`` or
    ``tools_ttl``) warns and is ignored rather than silently creating a resource, and a bare
    ``CacheConfig()`` leaves today's behavior unchanged.

    Args:
        cache_config: The provider's configured cache settings.

    Returns:
        True when managed caching should be attempted.
    """
    if cache_config.system_prompt_ttl is False:
        return False
    return bool(_cache_config_fields_set(cache_config) & _SUPPORTED_FIELDS)


def resolve_ttl(cache_config: CacheConfig) -> str | None:
    """Resolve the ``CachedContent`` TTL as the API's ``"<N>s"`` form, or None to disable caching.

    Precedence: an explicit ``system_prompt_ttl`` string, then ``ttl``, then a one-hour default. A
    non-positive or unparseable duration disables managed caching - an instantly-expired resource is
    worse than none.

    Args:
        cache_config: The provider's configured cache settings.

    Returns:
        The TTL as ``"<N>s"``, or None to fall back to implicit caching.
    """
    source = cache_config.system_prompt_ttl if isinstance(cache_config.system_prompt_ttl, str) else cache_config.ttl
    seconds = _DEFAULT_TTL_SECONDS if source is None else _duration_to_seconds(source)
    if seconds is None or seconds <= 0:
        return None
    return f"{seconds}s"


def resolve_display_name(
    cache_config: CacheConfig,
    model_id: str,
    system_prompt: str | None,
    tools: list[Any] | None,
    tool_config: "genai.types.ToolConfig | None",
) -> str | None:
    """Resolve the ``display_name`` identifying a reusable prefix, or None to opt out of caching.

    An explicit ``cache_key`` is the identity (hashed only when it exceeds the 128-char display-name
    cap); an empty ``cache_key`` opts out. With no ``cache_key``, identity is a content fingerprint
    over the static prefix (model, system prompt, tools, tool config) so any caller sending the same
    prefix reuses one resource. The tool config is part of the identity because it is baked into the
    created resource: two calls that share tools but force different tool choices must not collapse to
    one cache, or the forced choice would be silently served from the other's baked config. Session
    identity never contributes.

    Args:
        cache_config: The provider's configured cache settings.
        model_id: The Gemini model id the prefix targets.
        system_prompt: The system instruction cached as part of the prefix.
        tools: The formatted Gemini tools cached as part of the prefix.
        tool_config: The tool config cached as part of the prefix.

    Returns:
        The display name to look up or create under, or None to fall back to implicit caching.
    """
    if cache_config.cache_key is not None:
        if cache_config.cache_key == "":
            return None
        if len(cache_config.cache_key) <= _DISPLAY_NAME_MAX:
            return cache_config.cache_key
        return _hash(cache_config.cache_key)

    prefix = f"{model_id}\n{system_prompt or ''}\n{_tools_fingerprint(tools)}\n{_tool_config_fingerprint(tool_config)}"
    return _hash(prefix)[:_FINGERPRINT_LENGTH]


async def find_cached_content(caches: "genai.caches.AsyncCaches", display_name: str) -> str | None:
    """Return the newest existing ``CachedContent`` resource name matching ``display_name``, or None.

    ``caches.list()`` has no server-side ``display_name`` filter, so this scans and filters
    client-side, breaking ties toward the newest ``create_time`` so a fresh resource supersedes a
    nearly-expired one.

    Args:
        caches: The async caches client.
        display_name: The identity to match.

    Returns:
        The matching resource name, or None when none exists.
    """
    matches = []
    async for cached in await caches.list():
        if cached.display_name == display_name and cached.name:
            matches.append(cached)

    if not matches:
        return None

    newest = max(matches, key=_create_time_key)
    return newest.name


async def resolve_cached_content(
    caches: "genai.caches.AsyncCaches",
    *,
    cache_config: CacheConfig,
    model_id: str,
    system_prompt: str | None,
    tools: list[Any] | None,
    tool_config: "genai.types.ToolConfig | None",
    force_create: bool = False,
) -> str | None:
    """Resolve the managed ``CachedContent`` resource name to attach, or None for implicit caching.

    A straight sequence of early returns: bail unless the config opts into managed caching and there
    is a prefix to cache, resolve TTL and identity, reuse an existing resource with the same identity,
    and otherwise create one holding the static prefix (system + tools).

    Args:
        caches: The async caches client.
        cache_config: The provider's configured cache settings.
        model_id: The Gemini model id the prefix targets.
        system_prompt: The system instruction to cache.
        tools: The formatted Gemini tools to cache.
        tool_config: The tool config to cache alongside the tools.
        force_create: Skip the lookup and always create, used when recovering from an expired cache.

    Returns:
        The resource name to attach, or None to fall back to implicit caching.
    """
    if not should_engage_managed(cache_config):
        return None

    if not system_prompt and not tools:
        logger.debug("no system prompt or tools to cache | using implicit caching")
        return None

    ttl = resolve_ttl(cache_config)
    if ttl is None:
        return None

    display_name = resolve_display_name(cache_config, model_id, system_prompt, tools, tool_config)
    if display_name is None:
        return None

    if not force_create:
        existing = await find_cached_content(caches, display_name)
        if existing is not None:
            logger.debug("display_name=<%s>, cached_content=<%s> | reusing cached content", display_name, existing)
            return existing

    return await _create_or_implicit(
        caches,
        model=model_id,
        system_instruction=system_prompt,
        tools=tools,
        tool_config=tool_config,
        ttl=ttl,
        display_name=display_name,
    )


async def _create_or_implicit(
    caches: "genai.caches.AsyncCaches",
    *,
    model: str,
    system_instruction: str | None,
    tools: list[Any] | None,
    tool_config: "genai.types.ToolConfig | None",
    ttl: str,
    display_name: str,
) -> str | None:
    """Create a ``CachedContent`` for the static prefix, or return None when the prefix is uncacheable.

    Isolates the one create call so its failure branch stays out of the resolver's control flow. An
    "uncacheable" failure (prefix too small, or model unsupported) warns once and falls back to
    implicit caching; any other error propagates so a real request error is never swallowed.

    Args:
        caches: The async caches client.
        model: The Gemini model id the prefix targets.
        system_instruction: The system instruction to cache.
        tools: The formatted Gemini tools to cache.
        tool_config: The tool config to cache alongside the tools.
        ttl: The cache TTL in ``"<N>s"`` form.
        display_name: The identity to create under.

    Returns:
        The created resource name, or None to fall back to implicit caching.
    """
    config = genai.types.CreateCachedContentConfig(
        system_instruction=system_instruction,
        tools=tools,
        tool_config=tool_config,
        ttl=ttl,
        display_name=display_name,
    )
    try:
        created = await caches.create(model=model, config=config)
    except genai.errors.ClientError as error:
        logger.debug("display_name=<%s>, error=<%s> | cached content create failed", display_name, error)
        if _is_uncacheable(error):
            warnings.warn(
                f"Gemini declined to cache the prompt prefix for display_name={display_name!r} "
                "(prefix too small or model unsupported); proceeding with implicit caching.",
                stacklevel=2,
            )
            return None
        raise

    logger.debug("display_name=<%s>, cached_content=<%s> | created cached content", display_name, created.name)
    return created.name


def _duration_to_seconds(duration: str) -> int | None:
    """Convert a duration such as ``"5m"``/``"1h"``/``"300s"``/``"2d"`` to whole seconds.

    A bare number is treated as seconds; fractional values floor to whole seconds.

    Args:
        duration: The duration string to parse.

    Returns:
        The duration in whole seconds, or None when it cannot be parsed.
    """
    match = _DURATION_PATTERN.match(duration.strip())
    if match is None:
        return None
    amount = float(match.group(1))
    unit = match.group(2) or "s"
    return int(amount * _UNIT_SECONDS[unit])


def _hash(value: str) -> str:
    """Return the hex sha256 of ``value``."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _tools_fingerprint(tools: list[Any] | None) -> str:
    """Stable serialization of formatted Gemini tools for the identity fingerprint.

    Args:
        tools: The formatted Gemini tools, or None.

    Returns:
        A deterministic string; empty when there are no tools.
    """
    if not tools:
        return ""
    serialized = []
    for tool in tools:
        if hasattr(tool, "to_json_dict"):
            serialized.append(json.dumps(tool.to_json_dict(), sort_keys=True))
        else:
            serialized.append(repr(tool))
    return "\n".join(serialized)


def _tool_config_fingerprint(tool_config: "genai.types.ToolConfig | None") -> str:
    """Stable serialization of the tool config for the identity fingerprint.

    Args:
        tool_config: The tool config baked into the resource, or None.

    Returns:
        A deterministic string; empty when there is no tool config.
    """
    if tool_config is None:
        return ""
    if hasattr(tool_config, "to_json_dict"):
        return json.dumps(tool_config.to_json_dict(), sort_keys=True)
    return repr(tool_config)


def _create_time_key(cached: "genai.types.CachedContent") -> float:
    """Sort key placing the newest ``create_time`` last; missing times sort oldest."""
    return cached.create_time.timestamp() if cached.create_time else 0.0


def _is_uncacheable(error: "genai.errors.ClientError") -> bool:
    """Whether a ``caches.create`` error means the prefix is too small or the model unsupported.

    Matches narrowly on the documented failure statuses plus a token-size phrase; anything else (for
    example a malformed tool schema) is left to propagate.

    Args:
        error: The client error raised by ``caches.create``.

    Returns:
        True when the failure means the prefix simply cannot be cached.
    """
    if error.status not in _UNCACHEABLE_STATUSES:
        return False
    message = (error.message or "").lower()
    return any(phrase in message for phrase in _UNCACHEABLE_PHRASES)


def _is_missing_cache(error: "genai.errors.ClientError") -> bool:
    """Whether a generate error means the referenced ``cached_content`` no longer exists.

    A ``CachedContent`` can expire (TTL) or be deleted between resolve and generate; the server then
    rejects the request that references it.

    Args:
        error: The client error raised while generating.

    Returns:
        True when the referenced cache is gone.
    """
    if error.status == "NOT_FOUND" or error.code == 404:
        return True
    message = (error.message or "").lower()
    return "cachedcontent" in message.replace(" ", "") and ("not found" in message or "does not exist" in message)
