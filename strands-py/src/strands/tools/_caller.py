"""Support direct tool calls through agent.

Example:
    ```
    agent = Agent(tools=[my_tool])
    agent.tool.my_tool()
    ```
"""

import json
import random
import weakref
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from .._async import run_async
from ..tools.executors._executor import ToolExecutor
from ..types._events import ToolInterruptEvent
from ..types.content import ContentBlock, Message
from ..types.exceptions import ConcurrencyException
from ..types.tools import ToolResult, ToolUse

if TYPE_CHECKING:
    from ..agent import Agent
    from ..experimental.bidi.agent import BidiAgent


class _ToolCaller:
    """Call tool as a function."""

    def __init__(self, agent: "Agent | BidiAgent") -> None:
        """Initialize instance.

        Args:
            agent: Agent reference that will accept tool results.
        """
        # WARNING: Do not add any other member variables or methods as this could result in a name conflict with
        #          agent tools and thus break their execution.
        self._agent_ref = weakref.ref(agent)

    @property
    def _agent(self) -> "Agent | BidiAgent":
        """Return the agent, raising ReferenceError if it has been garbage collected."""
        agent = self._agent_ref()
        if agent is None:
            raise ReferenceError("Agent has been garbage collected")
        return agent

    def __getattr__(self, name: str) -> Callable[..., Any]:
        """Call tool as a function.

        This method enables the method-style interface (e.g., `agent.tool.tool_name(param="value")`).
        It matches underscore-separated names to hyphenated tool names (e.g., 'some_thing' matches 'some-thing').

        Args:
            name: The name of the attribute (tool) being accessed.

        Returns:
            A function that when called will execute the named tool.

        Raises:
            AttributeError: If no tool with the given name exists or if multiple tools match the given name.
        """

        def caller(
            user_message_override: str | None = None,
            record_direct_tool_call: bool | None = None,
            **kwargs: Any,
        ) -> Any:
            """Call a tool directly by name.

            Args:
                user_message_override: Optional custom message to record instead of default
                record_direct_tool_call: Whether to record direct tool calls in message history. Overrides class
                    attribute if provided.
                **kwargs: Keyword arguments to pass to the tool.

            Returns:
                The result returned by the tool.

            Raises:
                AttributeError: If the tool doesn't exist.
            """
            if self._agent._interrupt_state.activated:
                raise RuntimeError("cannot directly call tool during interrupt")

            if record_direct_tool_call is not None:
                should_record_direct_tool_call = record_direct_tool_call
            else:
                should_record_direct_tool_call = self._agent.record_direct_tool_call

            should_lock = should_record_direct_tool_call

            from ..agent import Agent  # Locally imported to avoid circular reference

            agent = self._agent
            acquired_lock = False
            if should_lock:
                if isinstance(agent, Agent):
                    acquired_lock = agent._concurrency.try_acquire_lock()
                    if not acquired_lock:
                        raise ConcurrencyException(
                            "Direct tool call cannot be made while the agent is in the middle of an invocation. "
                            "Set record_direct_tool_call=False to allow direct tool calls during agent invocation."
                        )
                elif agent._started:
                    raise ConcurrencyException(
                        "Direct tool call cannot be recorded while the bidirectional agent is running. "
                        "Set record_direct_tool_call=False to allow direct tool calls during an active session."
                    )

            try:
                normalized_name = self._find_normalized_tool_name(name)

                # Create unique tool ID and set up the tool request
                tool_id = f"tooluse_{name}_{random.randint(100000000, 999999999)}"
                tool_use: ToolUse = {
                    "toolUseId": tool_id,
                    "name": normalized_name,
                    "input": kwargs.copy(),
                }
                tool_results: list[ToolResult] = []
                invocation_state = kwargs

                async def acall() -> ToolResult:
                    async for event in ToolExecutor._stream(agent, tool_use, tool_results, invocation_state):
                        if isinstance(event, ToolInterruptEvent):
                            agent._interrupt_state.deactivate()
                            raise RuntimeError("cannot raise interrupt in direct tool call")

                    tool_result = tool_results[0]

                    if should_record_direct_tool_call:
                        # Create a record of this tool execution in the message history
                        await self._record_tool_execution(tool_use, tool_result, user_message_override)

                    return tool_result

                tool_result = run_async(acall)

                # TODO: https://github.com/strands-agents/harness-sdk/issues/1311
                if isinstance(agent, Agent):
                    agent.conversation_manager.apply_management(agent)

                return tool_result

            finally:
                if acquired_lock and isinstance(agent, Agent):
                    agent._concurrency.release_lock()

        return caller

    def _find_normalized_tool_name(self, name: str) -> str:
        """Lookup the tool represented by name, replacing characters with underscores as necessary."""
        tool_registry = self._agent.tool_registry.registry

        if tool_registry.get(name):
            return name

        # If the desired name contains underscores, it might be a placeholder for characters that can't be
        # represented as python identifiers but are valid as tool names, such as dashes. In that case, find
        # all tools that can be represented with the normalized name
        if "_" in name:
            filtered_tools = [
                tool_name for (tool_name, tool) in tool_registry.items() if tool_name.replace("-", "_") == name
            ]

            # The registry itself defends against similar names, so we can just take the first match
            if filtered_tools:
                return filtered_tools[0]

        raise AttributeError(f"Tool '{name}' not found")

    async def _record_tool_execution(
        self,
        tool: ToolUse,
        tool_result: ToolResult,
        user_message_override: str | None,
    ) -> None:
        """Record a tool execution in the message history.

        Creates a sequence of messages that represent the tool execution:

        1. A user message describing the tool call
        2. An assistant message with the tool use
        3. A user message with the tool result
        4. An assistant message acknowledging the tool call

        Args:
            tool: The tool call information.
            tool_result: The result returned by the tool.
            user_message_override: Optional custom message to include.
        """
        # Filter tool input parameters to only include those defined in tool spec
        filtered_input = self._filter_tool_parameters_for_recording(tool["name"], tool["input"])

        # Create user message describing the tool call
        input_parameters = json.dumps(filtered_input, default=lambda o: f"<<non-serializable: {type(o).__qualname__}>>")

        user_msg_content: list[ContentBlock] = [
            {"text": (f"agent.tool.{tool['name']} direct tool call.\nInput parameters: {input_parameters}\n")}
        ]

        # Add override message if provided
        if user_message_override:
            user_msg_content.insert(0, {"text": f"{user_message_override}\n"})

        # Create filtered tool use for message history
        filtered_tool: ToolUse = {
            "toolUseId": tool["toolUseId"],
            "name": tool["name"],
            "input": filtered_input,
        }

        # Create the message sequence
        user_msg: Message = {
            "role": "user",
            "content": user_msg_content,
        }
        tool_use_msg: Message = {
            "role": "assistant",
            "content": [{"toolUse": filtered_tool}],
        }
        tool_result_msg: Message = {
            "role": "user",
            "content": [{"toolResult": tool_result}],
        }
        assistant_msg: Message = {
            "role": "assistant",
            "content": [{"text": f"agent.tool.{tool['name']} was called."}],
        }

        # Add to message history
        await self._agent._append_messages(user_msg, tool_use_msg, tool_result_msg, assistant_msg)

    def _filter_tool_parameters_for_recording(self, tool_name: str, input_params: dict[str, Any]) -> dict[str, Any]:
        """Filter input parameters to only include those defined in the tool specification.

        Args:
            tool_name: Name of the tool to get specification for
            input_params: Original input parameters

        Returns:
            Filtered parameters containing only those defined in tool spec
        """
        all_tools_config = self._agent.tool_registry.get_all_tools_config()
        tool_spec = all_tools_config.get(tool_name)

        if not tool_spec or "inputSchema" not in tool_spec:
            return input_params.copy()

        properties = tool_spec["inputSchema"]["json"]["properties"]
        return {k: v for k, v in input_params.items() if k in properties}
