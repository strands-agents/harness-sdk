"""Normalizers for the ``*Option`` unions ``create_harness`` accepts; each returns the resolved
``*Config``/instance/None."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from typing import Any

from strands.memory import MemoryManager
from strands.models import Model, ModelRouter
from strands.session import SessionManager

from strands_harness import defaults
from strands_harness.types.agent import (
    BuiltinToolName,
    MemoryConfig,
    ProgrammaticToolCallerConfig,
    ReadConfig,
    SessionConfig,
    ShellConfig,
    SubagentConfig,
    WebFetchConfig,
)


def _sanitize_session_id(session_id: str) -> str:
    return re.sub(r"[^a-z0-9_-]", "-", session_id.strip().lower()) or "default"


# ``shell``'s factory also accepts ``name`` (would break selection by built-in name) and ``sandbox``
# (the harness's tools read the agent-level ``sandbox=`` at call time); neither is exposed.
_BUILTIN_TOOL_CONFIG_KEYS: dict[str, frozenset[str]] = {
    "read": frozenset(ReadConfig.__annotations__),
    "shell": frozenset(ShellConfig.__annotations__),
    "web_fetch": frozenset(WebFetchConfig.__annotations__),
    "programmatic_tool_caller": frozenset(ProgrammaticToolCallerConfig.__annotations__),
    "subagent": frozenset(SubagentConfig.__annotations__),
}


# Config keys whose ``None`` is a value in ``types.agent`` (every tool allowed, no time bound) rather
# than "unset"; ``None`` under any other key is dropped so the factory default applies.
_NULLABLE_BUILTIN_TOOL_CONFIG_KEYS = frozenset({"allowed_tools", "timeout"})


def _check_builtin_tool_config_value(tool: str, key: str, value: object) -> None:
    # Keys are unique across tools, so the shape is per key: what ``config.py`` enforces for JSON, plus model
    # instances.
    if value is None:
        return
    non_blank_str = isinstance(value, str) and bool(value.strip())
    number = isinstance(value, (int, float)) and not isinstance(value, bool)
    expected, accepted = {
        "model": (
            "a Model, ModelRouter or 'provider/name' string",
            isinstance(value, (Model, ModelRouter)) or non_blank_str,
        ),
        "description": ("a non-empty string", non_blank_str),
        "transport": ("'curl' or 'direct'", value in ("curl", "direct")),
        "allowed_tools": (
            "a list of tool names",
            isinstance(value, list) and all(isinstance(item, str) and item.strip() for item in value),
        ),
        "timeout": ("a positive number of seconds", number and math.isfinite(value) and value > 0),
        "media": ("a bool", isinstance(value, bool)),
        "max_depth": ("a non-negative int", isinstance(value, int) and not isinstance(value, bool) and value >= 0),
    }[key]
    if not accepted:
        raise ValueError(f"builtin_tools[{tool!r}][{key!r}] must be {expected}, got {value!r}.")


def _check_builtin_tool_name(name: object) -> None:
    if name not in defaults.BUILTIN_TOOL_NAMES:
        available = ", ".join(defaults.BUILTIN_TOOL_NAMES)
        raise ValueError(f"Unknown built-in tool {name!r}. Available: {available}.")


def _normalize_builtin_tools(
    value: Sequence[str] | Mapping[str, Any] | None,
) -> dict[BuiltinToolName, Any]:
    """Normalize ``builtin_tools`` to ``{name: True | False | cfg}`` over every built-in name.

    A list pins exactly the names given (``[]`` = none). A mapping edits the harness's default set:
    ``False`` removes a tool, ``True`` adds it, a config dict adds and configures it (the keys in
    ``_BUILTIN_TOOL_CONFIG_KEYS``), and ``"exa"`` opts ``web_search`` into its third-party fallback;
    ``"*"`` (default ``True``) is the starting set, written ``False`` to start from nothing. ``None`` is
    The harness's default set. Unknown names, unknown config keys and other values raise. The result is what
    subagents receive, so they never see a list or ``"*"``.
    """
    if value is None:
        return {name: name in defaults.DEFAULT_BUILTIN_TOOLS for name in defaults.BUILTIN_TOOL_NAMES}
    if isinstance(value, Mapping):
        start = value.get("*", True)
        if not isinstance(start, bool):
            raise ValueError(f"builtin_tools['*'] must be a bool, got {start!r}.")
        normalized: dict[BuiltinToolName, Any] = {
            name: start and name in defaults.DEFAULT_BUILTIN_TOOLS for name in defaults.BUILTIN_TOOL_NAMES
        }
        for name, setting in value.items():
            if name == "*":
                continue
            _check_builtin_tool_name(name)
            if name == "web_search":
                if not (isinstance(setting, bool) or setting == "exa"):
                    raise ValueError(f"builtin_tools['web_search'] must be a bool or 'exa', got {setting!r}.")
                normalized[name] = setting
                continue
            config_keys = _BUILTIN_TOOL_CONFIG_KEYS.get(name)
            if isinstance(setting, Mapping):
                if config_keys is None:
                    raise ValueError(f"Built-in tool {name!r} takes no config; pass True or False.")
                unknown = sorted(set(setting) - config_keys)
                if unknown:
                    raise ValueError(
                        f"Unknown {name} config keys: {', '.join(unknown)}. Allowed: {', '.join(sorted(config_keys))}."
                    )
                for key, config_value in setting.items():
                    _check_builtin_tool_config_value(name, key, config_value)
                normalized[name] = {
                    key: config_value
                    for key, config_value in setting.items()
                    if config_value is not None or key in _NULLABLE_BUILTIN_TOOL_CONFIG_KEYS
                }
            elif isinstance(setting, bool):
                normalized[name] = setting
            else:
                raise ValueError(f"builtin_tools[{name!r}] must be a bool or a config mapping, got {setting!r}.")
        return normalized
    if isinstance(value, (str, bool)) or not isinstance(value, Sequence):
        raise ValueError(
            f"builtin_tools must be a list of names or a mapping of name to bool/config, got {value!r}; "
            "[] turns every built-in off."
        )
    names = list(value)
    for name in names:
        _check_builtin_tool_name(name)
    return {name: name in names for name in defaults.BUILTIN_TOOL_NAMES}


def _session_config(value: bool | SessionConfig | SessionManager | None) -> SessionConfig | SessionManager | None:
    """Normalize ``session`` to a ``SessionConfig`` (on), a ``SessionManager`` (used verbatim) or ``None`` (off)."""
    if value is None or value is False:
        return None
    if value is True:
        return {}
    if isinstance(value, SessionManager):
        return value
    shape = "a bool, a SessionConfig mapping, a SessionManager instance, or None"
    if isinstance(value, str):
        raise ValueError(
            f'session must be {shape}, not a string ({value!r}); "auto" is no longer a value, the default is True.'
        )
    if not isinstance(value, Mapping):
        raise ValueError(f"session must be {shape}, got {value!r}.")
    unknown = sorted(str(key) for key in value if key not in {"id", "dir"})
    if unknown:
        raise ValueError(f"session contains unknown keys: {', '.join(unknown)}. Allowed: dir, id.")
    for key in ("id", "dir"):
        if key in value and not isinstance(value[key], str):
            raise ValueError(f"session[{key!r}] must be a str, got {value[key]!r}.")
        if key in value and not value[key].strip():
            raise ValueError(f"session.{key} must be a non-empty string.")
    return value


def _memory_config(value: bool | MemoryConfig | MemoryManager | None) -> MemoryConfig | MemoryManager | None:
    """Normalize ``memory`` to a ``MemoryConfig`` (on), a ``MemoryManager`` (used verbatim) or ``None`` (off)."""
    if value is None or value is False:
        return None
    if value is True:
        return {}
    if isinstance(value, MemoryManager):
        return value
    shape = "a bool, a MemoryConfig mapping, a MemoryManager instance, or None"
    if isinstance(value, str):
        raise ValueError(
            f'memory must be {shape}, not a string ({value!r}); "auto" is no longer a value, the default is True.'
        )
    if not isinstance(value, Mapping):
        raise ValueError(f"memory must be {shape}, got {value!r}.")
    unknown = sorted(str(key) for key in value if key not in {"dir", "stores"})
    if unknown:
        raise ValueError(f"memory contains unknown keys: {', '.join(unknown)}. Allowed: dir, stores.")
    if "dir" in value and not isinstance(value["dir"], str):
        raise ValueError(f"memory['dir'] must be a str, got {value['dir']!r}.")
    if "dir" in value and not value["dir"].strip():
        raise ValueError("memory.dir must be a non-empty string.")
    if "stores" not in value:
        return value
    stores = value["stores"]
    # The SDK ``MemoryStore`` protocol is not ``runtime_checkable``, so check its ``name`` + ``search`` members.
    if (
        isinstance(stores, str)
        or not isinstance(stores, Sequence)
        or not all(isinstance(getattr(s, "name", None), str) and callable(getattr(s, "search", None)) for s in stores)
    ):
        raise ValueError(f"memory.stores must be a sequence of MemoryStore instances, got {stores!r}.")
    # ``resolve_memory`` treats only a ``list`` as many stores; any other accepted sequence is normalized.
    return {**value, "stores": list(stores)}  # type: ignore[typeddict-item]


def _builtin_tool_config(builtin_tools: Mapping[str, Any], name: str) -> dict[str, Any]:
    """The config ``name`` was enabled with in normalized ``builtin_tools``; ``{}`` for a bool setting."""
    setting = builtin_tools.get(name)
    return dict(setting) if isinstance(setting, Mapping) else {}
