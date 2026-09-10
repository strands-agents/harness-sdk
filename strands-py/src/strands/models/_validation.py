"""Configuration validation utilities for model providers."""

import dataclasses
import re
import warnings
from collections.abc import Collection, Mapping
from typing import Any

from typing_extensions import get_type_hints

from ..types.content import ContentBlock
from ..types.tools import ToolChoice
from .model import CacheConfig

# Matches AWS region identifiers such as us-east-1, ap-southeast-1, and us-gov-east-1.
# ``\A``/``\Z`` anchor the whole string (``$`` would allow a trailing newline) and ``[0-9]``
# keeps digits ASCII (``\d`` also matches Unicode digits), so the pattern is self-anchored
# and safe regardless of which match method a caller uses.
_VALID_REGION = re.compile(r"\A[a-z]{2}(-[a-z]+)+-[0-9]+\Z")


def validate_region(region: str) -> str:
    """Validate an AWS region before it is interpolated into a service endpoint URL.

    Providers that build an endpoint URL by interpolating a region (e.g.
    ``https://bedrock-mantle.{region}.api.aws``) must call this first. Without it, a
    malformed region containing URL control characters (``@``, ``:``, ``/``, ``#``) can
    re-point a signed request to a non-AWS host, exfiltrating credentials.

    Args:
        region: The AWS region identifier to validate.

    Returns:
        The validated region, so callers can validate and assign in one expression.

    Raises:
        ValueError: If ``region`` is not a well-formed AWS region identifier.
    """
    if not isinstance(region, str) or not _VALID_REGION.fullmatch(region):
        raise ValueError(f"invalid AWS region: {region!r}")
    return region


def validate_config_keys(config_dict: Mapping[str, Any], config_class: type) -> None:
    """Validate that config keys match the TypedDict fields.

    Args:
        config_dict: Dictionary of configuration parameters
        config_class: TypedDict class to validate against
    """
    valid_keys = set(get_type_hints(config_class).keys())
    provided_keys = set(config_dict.keys())
    invalid_keys = provided_keys - valid_keys

    if invalid_keys:
        warnings.warn(
            f"Invalid configuration parameters: {sorted(invalid_keys)}."
            f"\nValid parameters are: {sorted(valid_keys)}."
            f"\n"
            f"\nSee https://github.com/strands-agents/harness-sdk/issues/815",
            stacklevel=4,
        )


def warn_on_tool_choice_not_supported(tool_choice: ToolChoice | None) -> None:
    """Emits a warning if a tool choice is provided but not supported by the provider.

    Args:
        tool_choice: the tool_choice provided to the provider
    """
    if tool_choice:
        warnings.warn(
            "A ToolChoice was provided to this provider but is not supported and will be ignored",
            stacklevel=4,
        )


def _cache_config_fields_set(cache_config: CacheConfig) -> set[str]:
    """Return the names of cache_config fields the caller set to a non-default value."""
    return {
        field.name for field in dataclasses.fields(cache_config) if getattr(cache_config, field.name) != field.default
    }


def warn_on_cache_config_not_supported(
    cache_config: CacheConfig | None,
    provider: str,
    *,
    supported: Collection[str],
    stacklevel: int = 4,
) -> None:
    """Warn once about supplied cache_config fields a provider does not support.

    Args:
        cache_config: The provider's configured cache settings, if any. ``None`` is a no-op, so callers
            can pass an unset config directly without guarding it.
        provider: Human-readable provider name for the warning message.
        supported: Names of ``CacheConfig`` fields the provider applies; the rest are the no-ops.
        stacklevel: Frames to skip so the warning points at the caller. Defaults to 4, correct when a
            mapper one frame below ``format_request`` invokes this.
    """
    if cache_config is None:
        return
    unsupported = sorted(field for field in _cache_config_fields_set(cache_config) if field not in supported)
    if unsupported:
        warnings.warn(
            f"cache_config fields {unsupported} have no effect on {provider}, which does not support them; "
            "they will be ignored.",
            stacklevel=stacklevel,
        )


def _warn_on_deprecated_cache_tools(config_dict: Mapping[str, Any], *, stacklevel: int = 4) -> None:
    """Warn that the model-level ``cache_tools`` option is deprecated.

    Args:
        config_dict: The model configuration being set.
        stacklevel: Frames to skip so the warning points at the caller rather than the SDK internals.
            Providers pass the depth for their own call site, which differs by how deeply the warning
            is nested below the public entry point.
    """
    if config_dict.get("cache_tools"):
        warnings.warn(
            "cache_tools is deprecated. Use CacheConfig(tools_ttl=...) instead.",
            DeprecationWarning,
            stacklevel=stacklevel,
        )


def _has_location_source(content: ContentBlock) -> bool:
    """Check if a content block contains a location source.

    Providers need to explicitly define an implementation to support content locations.

    Args:
        content: Content block to check.

    Returns:
        True if the content block contains an location source, False otherwise.
    """
    if "image" in content:
        return "location" in content["image"].get("source", {})
    if "document" in content:
        return "location" in content["document"].get("source", {})
    if "video" in content:
        return "location" in content["video"].get("source", {})
    return False
