"""Shared utility for discovering decorated methods on plugin instances.

This module provides helper functions used by both Plugin and MultiAgentPlugin
to scan for @hook (and optionally @tool) decorated methods, and shared registry
utilities for plugin initialization and hook registration.
"""

import inspect
import logging
from collections.abc import Awaitable, Callable
from typing import Any, cast

from .._async import run_async
from ..hooks.registry import HookCallback
from ..tools.decorator import DecoratedFunctionTool

logger = logging.getLogger(__name__)


def _discover_methods(instance: object, plugin_name: str, predicate: Callable[[object], bool], label: str) -> list[Any]:
    """Scan an instance's class hierarchy for methods matching a predicate.

    Walks the MRO in reverse so parent class methods come first, but child
    overrides win (only the child's version is included).

    Args:
        instance: The plugin instance to scan.
        plugin_name: The plugin name (used for debug logging).
        predicate: Function that returns True for attributes to collect.
        label: Label for debug logging (e.g., "hook", "tool").

    Returns:
        List of matching bound methods/descriptors in declaration order.
    """
    results: list[Any] = []
    seen: set[str] = set()

    for cls in reversed(type(instance).__mro__):
        for attr_name in cls.__dict__:
            if attr_name in seen:
                continue
            seen.add(attr_name)

            try:
                bound = getattr(instance, attr_name)
            except Exception:
                continue

            if predicate(bound):
                results.append(bound)
                logger.debug("plugin=<%s>, %s=<%s> | discovered", plugin_name, label, attr_name)

    return results


def discover_hooks(instance: object, plugin_name: str) -> list[HookCallback]:
    """Scan an instance's class hierarchy for @hook decorated methods.

    Args:
        instance: The plugin instance to scan.
        plugin_name: The plugin name (used for debug logging).

    Returns:
        List of bound hook callback methods in declaration order.
    """
    return _discover_methods(
        instance,
        plugin_name,
        predicate=lambda bound: hasattr(bound, "_hook_event_types") and callable(bound),
        label="hook",
    )


def discover_tools(instance: object, plugin_name: str) -> list[DecoratedFunctionTool]:
    """Scan an instance's class hierarchy for @tool decorated methods.

    Args:
        instance: The plugin instance to scan.
        plugin_name: The plugin name (used for debug logging).

    Returns:
        List of DecoratedFunctionTool instances in declaration order.
    """
    return _discover_methods(
        instance,
        plugin_name,
        predicate=lambda bound: isinstance(bound, DecoratedFunctionTool),
        label="tool",
    )


def call_init_method(init_method: Callable[..., Any], target: Any) -> None:
    """Call a plugin's init method, handling both sync and async implementations.

    Args:
        init_method: The init_agent or init_multi_agent method to call.
        target: The agent or orchestrator instance to pass to the init method.
    """
    if inspect.iscoroutinefunction(init_method):
        async_init = cast(Callable[..., Awaitable[None]], init_method)
        run_async(lambda: async_init(target))
    else:
        init_method(target)
