"""Plugin base class for extending agent functionality.

This module defines the Plugin base class, which provides a composable way to
add behavior changes to agents through automatic hook and tool registration.
"""

from abc import ABC, abstractmethod
from collections.abc import Awaitable
from typing import TYPE_CHECKING

from ..hooks.registry import HookCallback
from ..tools.decorator import DecoratedFunctionTool
from ._discovery import discover_hooks, discover_tools

if TYPE_CHECKING:
    from ..agent import Agent


class Plugin(ABC):
    """Base class for objects that extend agent functionality.

    Plugins provide a composable way to add behavior changes to agents.
    They support automatic discovery and registration of methods decorated
    with @hook and @tool decorators.

    Attributes:
        name: A stable string identifier for the plugin (must be provided by subclass)
        hooks: Hooks attached to the agent, auto-discovered from @hook decorated methods during __init__
        tools: Tools attached to the agent, auto-discovered from @tool decorated methods during __init__

    Example using decorators (recommended):
        ```python
        from strands.plugins import Plugin, hook
        from strands.hooks import BeforeModelCallEvent
        from strands import tool

        class MyPlugin(Plugin):
            name = "my-plugin"

            @hook
            def on_model_call(self, event: BeforeModelCallEvent):
                print(f"Model called: {event}")

            @tool
            def my_tool(self, param: str) -> str:
                '''A tool that does something.'''
                return f"Result: {param}"
        ```

        Note: Decorated methods are registered in declaration order, with parent
        class methods registered before child class methods. If a child overrides
        a parent's decorated method, only the child's version is registered.

    Example with custom initialization:
        ```python
        class MyPlugin(Plugin):
            name = "my-plugin"

            def init_agent(self, agent: Agent) -> None:
                # Custom initialization logic - no super() needed
                # Decorated hooks/tools are auto-registered by the plugin registry
                agent.add_hook(self.custom_hook)

            def custom_hook(self, event: BeforeModelCallEvent):
                print(event)
        ```
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """A stable string identifier for the plugin."""
        ...

    def __init__(self) -> None:
        """Initialize the plugin and discover decorated methods.

        Scans the class for methods decorated with @hook and @tool and stores
        references for later registration when the plugin is attached to an agent.

        Uses a guard to prevent double-discovery when used with multiple inheritance
        (e.g., a class that inherits from both Plugin and MultiAgentPlugin).
        """
        if not hasattr(self, "_hooks"):
            self._hooks: list[HookCallback] = discover_hooks(self, self.name)
        if not hasattr(self, "_tools"):
            self._tools: list[DecoratedFunctionTool] = discover_tools(self, self.name)

    @property
    def hooks(self) -> list[HookCallback]:
        """List of hooks the plugin provides, auto-discovered from @hook decorated methods."""
        return self._hooks

    @property
    def tools(self) -> list[DecoratedFunctionTool]:
        """List of tools the plugin provides, auto-discovered from @tool decorated methods."""
        return self._tools

    def init_agent(self, agent: "Agent") -> None | Awaitable[None]:
        """Initialize the agent instance.

        Override this method to add custom initialization logic. Decorated
        hooks and tools are automatically registered by the plugin registry.

        Args:
            agent: The agent instance to initialize.
        """
        return None
