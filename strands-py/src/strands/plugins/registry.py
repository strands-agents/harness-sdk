"""Plugin registry for managing plugins attached to an agent.

This module provides the _PluginRegistry class for tracking and managing
plugins that have been initialized with an agent instance.
"""

import logging
import weakref
from typing import TYPE_CHECKING

from ._discovery import call_init_method
from .plugin import Plugin

if TYPE_CHECKING:
    from ..agent import Agent

logger = logging.getLogger(__name__)


class _PluginRegistry:
    """Registry for managing plugins attached to an agent.

    The _PluginRegistry tracks plugins that have been initialized with an agent,
    providing methods to add plugins and invoke their initialization.

    The registry handles:
    1. Calling the plugin's init_agent() method for custom initialization
    2. Auto-registering discovered @hook decorated methods with the agent
    3. Auto-registering discovered @tool decorated methods with the agent

    Example:
        ```python
        registry = _PluginRegistry(agent)

        class MyPlugin(Plugin):
            name = "my-plugin"

            @hook
            def on_event(self, event: BeforeModelCallEvent):
                pass  # Auto-registered by registry

            def init_agent(self, agent: Agent) -> None:
                # Custom logic only - no super() needed
                pass

        plugin = MyPlugin()
        registry.add_and_init(plugin)
        ```
    """

    def __init__(self, agent: "Agent") -> None:
        """Initialize a plugin registry with an agent reference.

        Args:
            agent: The agent instance that plugins will be initialized with.
        """
        self._agent_ref = weakref.ref(agent)
        self._plugins: dict[str, Plugin] = {}

    @property
    def _agent(self) -> "Agent":
        """Return the agent, raising ReferenceError if it has been garbage collected."""
        agent = self._agent_ref()
        if agent is None:
            raise ReferenceError("Agent has been garbage collected")
        return agent

    def add_and_init(self, plugin: Plugin) -> None:
        """Add and initialize a plugin with the agent.

        This method:
        1. Registers the plugin in the registry
        2. Calls the plugin's init_agent method for custom initialization
        3. Auto-registers all discovered @hook methods with the agent's hook registry
        4. Auto-registers all discovered @tool methods with the agent's tool registry

        Handles both sync and async init_agent implementations automatically.

        Args:
            plugin: The plugin to add and initialize.

        Raises:
            ValueError: If a plugin with the same name is already registered.
        """
        if plugin.name in self._plugins:
            raise ValueError(f"plugin_name=<{plugin.name}> | plugin already registered")

        logger.debug("plugin_name=<%s> | registering and initializing plugin", plugin.name)
        self._plugins[plugin.name] = plugin

        # Call user's init_agent for custom initialization
        call_init_method(plugin.init_agent, self._agent)

        # Auto-register discovered hooks with the agent
        self._register_hooks(plugin)

        # Auto-register discovered tools with the agent's tool registry
        self._register_tools(plugin)

    def _register_hooks(self, plugin: Plugin) -> None:
        """Register all discovered hooks from the plugin with the agent.

        Uses agent.add_hook() rather than the hook registry directly, so that
        the agent can track registrations through its public API.

        Args:
            plugin: The plugin whose hooks should be registered.
        """
        for hook_callback in plugin.hooks:
            event_types = getattr(hook_callback, "_hook_event_types", [])
            for event_type in event_types:
                self._agent.add_hook(hook_callback, event_type)
                logger.debug(
                    "plugin=<%s>, hook=<%s>, event_type=<%s> | registered hook",
                    plugin.name,
                    getattr(hook_callback, "__name__", repr(hook_callback)),
                    event_type.__name__,
                )

    def _register_tools(self, plugin: Plugin) -> None:
        """Register all discovered tools from the plugin with the agent.

        Args:
            plugin: The plugin whose tools should be registered.
        """
        if plugin.tools:
            self._agent.tool_registry.process_tools(list(plugin.tools))
            for tool in plugin.tools:
                logger.debug(
                    "plugin=<%s>, tool=<%s> | registered tool",
                    plugin.name,
                    tool.tool_name,
                )
