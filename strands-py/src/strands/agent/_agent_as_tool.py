"""Agent-as-tool adapter.

This module provides the _AgentAsTool class that wraps an Agent as a tool
so it can be passed to another agent's tool list.
"""

from __future__ import annotations

import copy
import logging
import threading
from typing import TYPE_CHECKING, Any

from typing_extensions import override

from ..agent.state import AgentState
from ..types._events import AgentAsToolStreamEvent, ToolInterruptEvent, ToolResultEvent
from ..types.content import Messages
from ..types.interrupt import InterruptResponseContent
from ..types.tools import AgentTool, ToolGenerator, ToolResultContent, ToolSpec, ToolUse

if TYPE_CHECKING:
    from .agent import Agent

logger = logging.getLogger(__name__)

DELEGATION_DESCRIPTION_SUFFIX = (
    " Calling this tool will return its response directly to the user as the final answer."
    " It should be the only tool called in the turn."
)


class _AgentAsTool(AgentTool):
    """Adapter that exposes an Agent as a tool for use by other agents.

    The tool accepts a single ``input`` string parameter, invokes the wrapped
    agent, and returns the text response.

    Example:
        ```python
        from strands import Agent

        researcher = Agent(name="researcher", description="Finds information")

        # Use via convenience method (default: fresh conversation each call)
        tool = researcher.as_tool()

        # Preserve context across invocations
        tool = researcher.as_tool(preserve_context=True)

        # Delegation: sub-agent's response becomes the final answer
        tool = researcher.as_tool(delegate=True)

        writer = Agent(name="writer", tools=[tool])
        writer("Write about AI agents")
        ```
    """

    def __init__(
        self,
        agent: Agent,
        *,
        name: str,
        description: str | None = None,
        preserve_context: bool = False,
        delegate: bool = False,
    ) -> None:
        r"""Initialize the agent-as-tool adapter.

        Args:
            agent: The agent to wrap as a tool.
            name: Tool name. Must match the pattern ``[a-zA-Z0-9_\\-]{1,64}``.
            description: Tool description. Defaults to the agent's description, or a
                generic description if the agent has no description set.
            preserve_context: Whether to preserve the agent's conversation history across
                invocations. When False, the agent's messages and state are reset to the
                values they had at construction time before each call, ensuring every
                invocation starts from the same baseline regardless of any external
                interactions with the agent. Defaults to False.
            delegate: When True, the orchestrator treats this tool's result as the final
                response and exits without an additional model call. The tool's description
                is automatically suffixed with an instruction telling the model that this
                tool should be the only tool called in the turn. Defaults to False.
        """
        super().__init__()
        self._agent = agent
        self._tool_name = name
        self._delegate = delegate
        self._description = (
            description or agent.description or f"Use the {name} agent as a tool by providing a natural language input"
        )
        if delegate:
            self._description += DELEGATION_DESCRIPTION_SUFFIX
        self._preserve_context = preserve_context

        # When preserve_context=False, we snapshot the agent's initial state so we can
        # restore it before each invocation. This mirrors GraphNode.reset_executor_state().
        self._initial_messages: Messages = []
        self._initial_state: AgentState = AgentState()
        # Serialize access so _reset_agent_state + stream_async are atomic.
        # threading.Lock (not asyncio.Lock) because run_async() may create
        # separate event loops in different threads.
        self._lock = threading.Lock()

        if not preserve_context:
            if getattr(agent, "_session_manager", None) is not None:
                raise ValueError(
                    "preserve_context=False cannot be used with an agent that has a session manager. "
                    "The session manager persists conversation history externally, which conflicts with "
                    "resetting the agent's state between invocations."
                )
            self._initial_messages = copy.deepcopy(agent.messages)
            self._initial_state = AgentState(agent.state.get())

    @property
    def agent(self) -> Agent:
        """The wrapped agent instance."""
        return self._agent

    @property
    def delegate(self) -> bool:
        """Get whether this tool uses delegation semantics."""
        return self._delegate

    @property
    def tool_name(self) -> str:
        """Get the tool name."""
        return self._tool_name

    @property
    def tool_spec(self) -> ToolSpec:
        """Get the tool specification."""
        return {
            "name": self._tool_name,
            "description": self._description,
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "input": {
                            "type": "string",
                            "description": "The input to send to the agent tool.",
                        },
                    },
                    "required": ["input"],
                }
            },
        }

    @property
    def tool_type(self) -> str:
        """Get the tool type."""
        return "agent"

    @override
    async def stream(self, tool_use: ToolUse, invocation_state: dict[str, Any], **kwargs: Any) -> ToolGenerator:
        """Invoke the wrapped agent via streaming and yield events.

        Intermediate agent events are wrapped in AgentAsToolStreamEvent so the caller
        can distinguish sub-agent progress from regular tool events. The final
        AgentResult is yielded as a ToolResultEvent.

        When the sub-agent encounters a hook interrupt (e.g. from BeforeToolCallEvent),
        the interrupts are propagated to the parent agent via ToolInterruptEvent. On
        resume, interrupt responses are forwarded to the sub-agent automatically.

        Args:
            tool_use: The tool use request containing the input parameter.
            invocation_state: Context for the tool invocation.
            **kwargs: Additional keyword arguments.

        Yields:
            AgentAsToolStreamEvent for intermediate events, ToolInterruptEvent if the
            sub-agent is interrupted, or ToolResultEvent with the final response.
        """
        tool_input = tool_use["input"]
        if isinstance(tool_input, dict):
            prompt = tool_input.get("input", "")
        elif isinstance(tool_input, str):
            prompt = tool_input
        else:
            logger.warning("tool_name=<%s> | unexpected input type: %s", self._tool_name, type(tool_input))
            prompt = str(tool_input)

        tool_use_id = tool_use["toolUseId"]

        # Serialize access to the underlying agent. _reset_agent_state() mutates
        # the agent before stream_async acquires its own lock, so a concurrent
        # call would corrupt an in-flight invocation.
        if not self._lock.acquire(blocking=False):
            logger.warning(
                "tool_name=<%s>, tool_use_id=<%s> | agent is already processing a request",
                self._tool_name,
                tool_use_id,
            )
            yield ToolResultEvent(
                {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": [{"text": f"Agent '{self._tool_name}' is already processing a request"}],
                }
            )
            return

        try:
            # Determine if we are resuming the sub-agent from an interrupt.
            if self._is_sub_agent_interrupted():
                prompt = self._build_interrupt_responses()
                logger.debug(
                    "tool_name=<%s>, tool_use_id=<%s> | resuming sub-agent from interrupt",
                    self._tool_name,
                    tool_use_id,
                )
            elif not self._preserve_context:
                self._reset_agent_state(tool_use_id)

            logger.debug("tool_name=<%s>, tool_use_id=<%s> | invoking agent", self._tool_name, tool_use_id)

            # Forward the parent's cancellation signal so cancelling the parent also cancels
            # the sub-agent. Passed as the sub-agent's external signal: the sub-agent links it
            # into its own event and never clears the parent's. A framework-supplied tool
            # context (background execution) carries the signal scoped to that call instead.
            tool_context = kwargs.get("_tool_context")
            cancel_signal = (
                tool_context.cancel_signal
                if tool_context is not None
                else getattr(invocation_state.get("agent"), "cancel_signal", None)
            )

            result = None
            async for event in self._agent.stream_async(prompt, cancel_signal=cancel_signal):
                if "result" in event:
                    result = event["result"]
                else:
                    yield AgentAsToolStreamEvent(tool_use, event, self)

            if result is None:
                yield ToolResultEvent(
                    {
                        "toolUseId": tool_use_id,
                        "status": "error",
                        "content": [{"text": "Agent did not produce a result"}],
                    }
                )
                return

            # Propagate sub-agent interrupts to the parent agent.
            if result.stop_reason == "interrupt" and result.interrupts:
                yield ToolInterruptEvent(tool_use, list(result.interrupts))
                return

            if result.stop_reason == "cancelled":
                yield ToolResultEvent(
                    {
                        "toolUseId": tool_use_id,
                        "status": "error",
                        "content": [{"text": f"Agent '{self._tool_name}' cancelled"}],
                    }
                )
                return

            if result.structured_output:
                yield ToolResultEvent(
                    {
                        "toolUseId": tool_use_id,
                        "status": "success",
                        "content": [{"json": result.structured_output.model_dump(mode="json")}],
                    }
                )
            elif self._delegate:
                # Copy content blocks verbatim; falls back to str(result) minus trailing \n.
                content = result.message.get("content", [])
                tool_result_content: list[ToolResultContent] = []
                for block in content:
                    if isinstance(block, dict):
                        if "text" in block:
                            tool_result_content.append(ToolResultContent(text=block["text"]))
                        elif "json" in block:
                            tool_result_content.append(ToolResultContent(json=block["json"]))
                        elif "citationsContent" in block:
                            cited = [
                                inner["text"]
                                for inner in block["citationsContent"].get("content", [])
                                if isinstance(inner, dict) and "text" in inner
                            ]
                            if cited:
                                tool_result_content.append(ToolResultContent(text="\n".join(cited)))
                if not tool_result_content:
                    tool_result_content = [ToolResultContent(text=str(result).rstrip("\n"))]
                yield ToolResultEvent(
                    {
                        "toolUseId": tool_use_id,
                        "status": "success",
                        "content": tool_result_content,
                    }
                )
            else:
                yield ToolResultEvent(
                    {
                        "toolUseId": tool_use_id,
                        "status": "success",
                        "content": [{"text": str(result)}],
                    }
                )

        except Exception as e:
            logger.warning(
                "tool_name=<%s>, tool_use_id=<%s> | agent invocation failed: %s",
                self._tool_name,
                tool_use_id,
                e,
            )
            yield ToolResultEvent(
                {
                    "toolUseId": tool_use_id,
                    "status": "error",
                    "content": [{"text": f"Agent error: {e}"}],
                }
            )
        finally:
            self._lock.release()

    def _reset_agent_state(self, tool_use_id: str) -> None:
        """Reset the wrapped agent to its initial state.

        Restores messages and state to the values captured at construction time.
        This mirrors the pattern used by ``GraphNode.reset_executor_state()``.

        Args:
            tool_use_id: Tool use ID for logging context.
        """
        logger.debug(
            "tool_name=<%s>, tool_use_id=<%s> | resetting agent to initial state",
            self._tool_name,
            tool_use_id,
        )
        self._agent.messages = copy.deepcopy(self._initial_messages)
        self._agent.state = AgentState(self._initial_state.get())

    def _is_sub_agent_interrupted(self) -> bool:
        """Check whether the wrapped agent is in an activated interrupt state."""
        return self._agent._interrupt_state.activated

    def _build_interrupt_responses(self) -> list[InterruptResponseContent]:
        """Build interrupt response payloads from the sub-agent's interrupt state.

        The parent agent's ``_interrupt_state.resume()`` sets ``.response`` on the shared
        ``Interrupt`` objects (registered by the executor), so we re-package them in the
        format expected by ``Agent.stream_async``.

        Returns:
            List of interrupt response content blocks for resuming the sub-agent.
        """
        return [
            {"interruptResponse": {"interruptId": interrupt.id, "response": interrupt.response}}
            for interrupt in self._agent._interrupt_state.interrupts.values()
            if interrupt.response is not None
        ]

    @override
    def get_display_properties(self) -> dict[str, str]:
        """Get properties for UI display."""
        properties = super().get_display_properties()
        properties["Agent"] = getattr(self._agent, "name", "unknown")
        return properties
