"""This module provides handlers for formatting and displaying events from the agent."""

from collections.abc import Callable
from typing import Any


class PrintingCallbackHandler:
    """Handler for streaming text output and tool invocations to stdout."""

    def __init__(self, verbose_tool_use: bool = True) -> None:
        """Initialize handler.

        Args:
            verbose_tool_use: Print out verbose information about tool calls.
        """
        self.tool_count = 0
        self._verbose_tool_use = verbose_tool_use

    def __call__(self, **kwargs: Any) -> None:
        """Stream text output and tool invocations to stdout.

        Args:
            **kwargs: Callback event data including:
                - reasoningText (Optional[str]): Reasoning text to print if provided.
                - data (str): Text content to stream.
                - complete (bool): Whether this is the final chunk of a response.
                - event (dict): ModelStreamChunkEvent.
        """
        reasoningText = kwargs.get("reasoningText", False)
        data = kwargs.get("data", "")
        complete = kwargs.get("complete", False)
        tool_use = kwargs.get("event", {}).get("contentBlockStart", {}).get("start", {}).get("toolUse")

        if reasoningText:
            print(reasoningText, end="")

        if data:
            print(data, end="" if not complete else "\n")

        if tool_use:
            self.tool_count += 1
            if self._verbose_tool_use:
                tool_name = tool_use["name"]
                print(f"\nTool #{self.tool_count}: {tool_name}")

        if complete and data:
            print("\n")


class CompositeCallbackHandler:
    """Class-based callback handler that combines multiple callback handlers.

    This handler allows multiple callback handlers to be invoked for the same events,
    enabling different processing or output formats for the same stream data.
    """

    def __init__(self, *handlers: Callable) -> None:
        """Initialize handler."""
        self.handlers = handlers

    def __call__(self, **kwargs: Any) -> None:
        """Invoke all handlers in the chain."""
        for handler in self.handlers:
            handler(**kwargs)


def null_callback_handler(**_kwargs: Any) -> None:
    """Callback handler that discards all output.

    Args:
        **_kwargs: Event data (ignored).
    """
    return None
