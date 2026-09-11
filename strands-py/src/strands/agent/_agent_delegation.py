"""AgentDelegation plugin — enforces delegation semantics for tool routing.

When a tool is configured with ``delegate=True``, this plugin ensures:

1. The delegation tool is the only tool called in the turn (single-call constraint)
2. The agent loop exits immediately after a successful delegation (via end_turn)
3. The delegation tool's content blocks become the final assistant message
4. Streaming events from the delegate agent are surfaced natively in the parent stream
"""

from __future__ import annotations

import json as json_module
import logging
import weakref
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import TYPE_CHECKING, cast

from .._middleware.stages import ExecuteToolContext, ExecuteToolStage
from .._middleware.types import MiddlewareNext
from ..hooks import (
    AfterToolCallEvent,
    AfterToolsEvent,
    BeforeModelCallEvent,
    BeforeToolsEvent,
    HookOrder,
)
from ..plugins import Plugin
from ..types._events import AgentAsToolStreamEvent, ToolResultEvent, TypedEvent
from ..types.content import ContentBlock
from ..types.tools import ToolResult
from ._agent_as_tool import _AgentAsTool

if TYPE_CHECKING:
    from .agent import Agent

logger = logging.getLogger(__name__)


@dataclass
class _DelegationState:
    """Per-agent state tracked across the delegation lifecycle within a single invocation."""

    tool_use_count: int = 0
    """Number of tool use blocks in the current batch."""

    tool_use_id: str | None = None
    """Tool use ID of the delegation tool that succeeded."""


def _is_delegation_tool(agent: Agent, tool_name: str) -> bool:
    """Check whether a tool registered on the agent is a delegation AgentAsTool."""
    tool = agent.tool_registry.registry.get(tool_name) or agent.tool_registry.dynamic_tools.get(tool_name)
    return isinstance(tool, _AgentAsTool) and tool.delegate


def _to_content_blocks(tool_result: ToolResult) -> list[ContentBlock]:
    """Convert ToolResult content into ContentBlocks for an assistant message.

    JSON blocks are serialized to text (matching TS's ``toContentBlocks``).
    """
    raw_content = tool_result.get("content", [])
    result: list[ContentBlock] = []
    for block in raw_content:
        if "json" in block:
            result.append({"text": json_module.dumps(block["json"])})
        else:
            result.append(cast(ContentBlock, block))
    return result


class AgentDelegation(Plugin):
    """Plugin that enforces delegation semantics for tool routing.

    Automatically registered on every agent. Acts as a no-op when no delegation tools fire.
    Implements single-call constraint, early loop exit, and result transformation.

    Example:
        ```python
        from strands import Agent

        specialist = Agent(name="specialist", description="Handles billing")
        orchestrator = Agent(
            tools=[specialist.as_tool(delegate=True)],
            # AgentDelegation is auto-registered — no manual setup needed
        )
        ```
    """

    name = "strands:agent-delegation"

    def __init__(self) -> None:
        super().__init__()
        self._state: weakref.WeakKeyDictionary[Agent, _DelegationState] = weakref.WeakKeyDictionary()

    def init_agent(self, agent: Agent) -> None:
        """Register hooks and middleware for delegation enforcement."""
        # Delegation is incompatible with stateful models — early exit would leave
        # an unclosed function call on the server.
        if agent.model.stateful:
            has_delegation_tool = any(
                isinstance(tool, _AgentAsTool) and tool.delegate for tool in agent.tool_registry.registry.values()
            )
            if has_delegation_tool:
                raise ValueError(
                    "Delegation tools (delegate=True) are not supported with stateful models. "
                    "Stateful models manage conversation state server-side, and delegation's early loop exit "
                    "would leave unclosed function calls on the server."
                )

        agent.add_hook(self._on_before_tools, BeforeToolsEvent)
        agent.add_hook(self._on_after_tool_call, AfterToolCallEvent)
        agent.add_hook(self._on_after_tools, AfterToolsEvent, order=HookOrder.SDK_LAST)
        agent.add_hook(self._on_before_model_call, BeforeModelCallEvent)

        agent._middleware_registry.add_middleware(ExecuteToolStage, self._handle_tool_execution)

    # --- Hooks ---

    def _on_before_tools(self, event: BeforeToolsEvent) -> None:
        """Initialize batch state; cancel if a delegate is mixed with other tools."""
        agent = event.agent
        if agent.model.stateful:
            return

        message = event.message
        content = message.get("content", [])
        tool_use_blocks = [block for block in content if isinstance(block, dict) and "toolUse" in block]

        self._state[agent] = _DelegationState(tool_use_count=len(tool_use_blocks))

        has_delegation = any(_is_delegation_tool(agent, block["toolUse"]["name"]) for block in tool_use_blocks)
        if has_delegation and len(tool_use_blocks) > 1:
            event.cancel = (
                "This tool call was not executed. A delegation tool must be the only "
                "tool called in a turn. Retry with a single delegation tool call or "
                "use only non-delegation tools."
            )

    def _on_before_model_call(self, event: BeforeModelCallEvent) -> None:
        """Clear stale delegation state when the loop continues past a delegation batch."""
        self._state.pop(event.agent, None)

    def _on_after_tool_call(self, event: AfterToolCallEvent) -> None:
        """Mark tool_use_id on delegation success; clear on error or retry-swap."""
        if event.agent.model.stateful:
            return

        if not isinstance(event.selected_tool, _AgentAsTool) or not event.selected_tool.delegate:
            state = self._state.get(event.agent)
            if state is not None and state.tool_use_id == event.tool_use.get("toolUseId"):
                state.tool_use_id = None
            return

        state = self._state.get(event.agent)
        if state is None:
            return

        if event.result.get("status") == "error":
            state.tool_use_id = None
            return

        state.tool_use_id = event.tool_use.get("toolUseId")

    def _on_after_tools(self, event: AfterToolsEvent) -> None:
        """Set end_turn to delegation content blocks when delegation succeeded with meaningful content.

        This hook runs at ``HookOrder.SDK_LAST`` (100) so no hook can invalidate the tool
        result after this hook commits end_turn; mutating a committed tool result's status
        is not a supported pattern.
        """
        if event.agent.model.stateful:
            return

        state = self._state.get(event.agent)
        if state is None or not state.tool_use_id:
            return

        # Verify the tool result is still successful in the committed message.
        message = event.message
        content = message.get("content", [])
        result_block = None
        for block in content:
            if not isinstance(block, dict) or "toolResult" not in block:
                continue
            tool_result = block["toolResult"]
            if tool_result.get("toolUseId") == state.tool_use_id:
                result_block = tool_result
                break

        if result_block is None or result_block.get("status") == "error":
            state.tool_use_id = None
            return

        # Skip delegation when the parent expects structured output.
        has_structured_output = any(
            getattr(t, "tool_type", None) == "structured_output"
            for t in event.agent.tool_registry.dynamic_tools.values()
        )
        if has_structured_output:
            logger.debug(
                "tool_use_id=<%s> | parent requires structured output, skipping delegation",
                state.tool_use_id,
            )
            return

        # Skip delegation when the tool result has no content
        end_turn_content = _to_content_blocks(result_block)
        if not end_turn_content or all(block.get("text", None) == "" for block in end_turn_content):
            logger.debug(
                "tool_use_id=<%s> | delegation produced blank content, skipping end_turn",
                state.tool_use_id,
            )
            return

        event.end_turn = end_turn_content

    # --- Middleware ---

    async def _handle_tool_execution(
        self,
        context: ExecuteToolContext,
        next_fn: MiddlewareNext,
    ) -> AsyncGenerator[TypedEvent, None]:
        """ExecuteToolStage middleware: enforce delegation constraints and unwrap events."""
        agent = cast("Agent", context.agent)

        # Non-delegation tools pass through unchanged.
        if not isinstance(context.tool, _AgentAsTool) or not context.tool.delegate:
            async for event in next_fn(context):
                yield event
            return

        # Stateful model: skip delegation, execute as a normal tool.
        if agent.model.stateful:
            logger.debug(
                "tool_use_id=<%s> | stateful model, skipping delegation and running as a normal tool",
                context.tool_use["toolUseId"],
            )
            async for event in next_fn(context):
                yield event
            return

        # Enforce single-call constraint.
        state = self._state.get(agent)
        if state and state.tool_use_count > 1:
            yield ToolResultEvent(
                {
                    "toolUseId": context.tool_use["toolUseId"],
                    "status": "error",
                    "content": [
                        {
                            "text": (
                                "Delegation failed: a delegation tool must be the only tool "
                                "called in a turn. Retry with a single delegation tool call "
                                "or use only non-delegation tools."
                            )
                        }
                    ],
                }
            )
            return

        # Stream the delegation tool, unwrapping inner agent events as native events.
        async for event in next_fn(context):
            if isinstance(event, ToolResultEvent):
                yield event
            elif isinstance(event, AgentAsToolStreamEvent):
                inner_data = event.get("tool_stream_event", {}).get("data")
                if inner_data is not None:
                    yield TypedEvent(inner_data)
                else:
                    yield event
            else:
                yield event
