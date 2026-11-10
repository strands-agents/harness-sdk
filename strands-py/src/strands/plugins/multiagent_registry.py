"""MultiAgentPlugin registry for managing plugins attached to a multi-agent orchestrator.

This module provides the _MultiAgentPluginRegistry class for tracking and managing
plugins that have been initialized with an orchestrator instance.
"""

import logging
import weakref
from typing import TYPE_CHECKING

from ._discovery import call_init_method
from .multiagent_plugin import MultiAgentPlugin

if TYPE_CHECKING:
    from ..multiagent.base import MultiAgentBase

logger = logging.getLogger(__name__)


class _MultiAgentPluginRegistry:
    """Registry for managing plugins attached to a multi-agent orchestrator.

    The _MultiAgentPluginRegistry tracks plugins that have been initialized with an
    orchestrator, providing methods to add plugins and invoke their initialization.

    The registry handles:
    1. Calling the plugin's init_multi_agent() method for custom initialization
    2. Auto-registering discovered @hook decorated methods with the orchestrator

    Example:
        ```python
        registry = _MultiAgentPluginRegistry(orchestrator)

        class MyPlugin(MultiAgentPlugin):
            name = "my-plugin"

            @hook
            def on_event(self, event: BeforeNodeCallEvent):
                pass  # Auto-registered by registry

            def init_multi_agent(self, orchestrator: MultiAgentBase) -> None:
                # Custom logic
                pass

        plugin = MyPlugin()
        registry.add_and_init(plugin)
        ```
    """

    def __init__(self, orchestrator: "MultiAgentBase") -> None:
        """Initialize a plugin registry with an orchestrator reference.

        Args:
            orchestrator: The orchestrator instance that plugins will be initialized with.
        """
        self._orchestrator_ref = weakref.ref(orchestrator)
        self._plugins: dict[str, MultiAgentPlugin] = {}

    @property
    def _orchestrator(self) -> "MultiAgentBase":
        """Return the orchestrator, raising ReferenceError if it has been garbage collected."""
        orchestrator = self._orchestrator_ref()
        if orchestrator is None:
            raise ReferenceError("Orchestrator has been garbage collected")
        return orchestrator

    def add_and_init(self, plugin: MultiAgentPlugin) -> None:
        """Add and initialize a plugin with the orchestrator.

        This method:
        1. Registers the plugin in the registry
        2. Calls the plugin's init_multi_agent method for custom initialization
        3. Auto-registers all discovered @hook methods with the orchestrator's hook registry

        Handles both sync and async init_multi_agent implementations automatically.

        Args:
            plugin: The plugin to add and initialize.

        Raises:
            ValueError: If a plugin with the same name is already registered.
        """
        if plugin.name in self._plugins:
            raise ValueError(f"plugin_name=<{plugin.name}> | plugin already registered")

        logger.debug("plugin_name=<%s> | registering and initializing multi-agent plugin", plugin.name)
        self._plugins[plugin.name] = plugin

        # Call user's init_multi_agent for custom initialization
        call_init_method(plugin.init_multi_agent, self._orchestrator)

        # Auto-register discovered hooks with the orchestrator
        self._register_hooks(plugin)

    def _register_hooks(self, plugin: MultiAgentPlugin) -> None:
        """Register all discovered hooks from the plugin with the orchestrator.

        Uses orchestrator.add_hook() so that the orchestrator can track
        registrations through its public API.

        Args:
            plugin: The plugin whose hooks should be registered.
        """
        for hook_callback in plugin.hooks:
            event_types = getattr(hook_callback, "_hook_event_types", [])
            for event_type in event_types:
                self._orchestrator.add_hook(hook_callback, event_type)
                logger.debug(
                    "plugin=<%s>, hook=<%s>, event_type=<%s> | registered hook",
                    plugin.name,
                    getattr(hook_callback, "__name__", repr(hook_callback)),
                    event_type.__name__,
                )
