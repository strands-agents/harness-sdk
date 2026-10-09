"""Tests for the ``stop`` tool.

The stop tool calls ``agent.cancel(message=..., after_current_tools=True)``. Tests
exercise that call, input validation, and metadata rather than running a full
event loop end-to-end (that is covered by
:mod:`tests.strands.event_loop.test_event_loop`).
"""

from unittest.mock import Mock

import pytest

from strands.experimental.tools.stop import make_stop, stop
from strands.types.tools import ToolContext


def _tool_context() -> ToolContext:
    """Build a ToolContext whose agent records ``cancel`` calls."""
    return ToolContext(
        tool_use={"name": "stop", "toolUseId": "id", "input": {}},
        agent=Mock(),
        invocation_state={},
    )


class TestStopBehavior:
    """The tool requests a deferred cancel and returns the message the model sees."""

    @pytest.mark.asyncio
    async def test_requests_deferred_cancel_with_default_message(self):
        ctx = _tool_context()
        result = await stop(tool_context=ctx)
        assert result == "Agent loop stopped."
        ctx.agent.cancel.assert_called_once_with("Agent loop stopped.", after_current_tools=True)

    @pytest.mark.asyncio
    async def test_requests_deferred_cancel_with_provided_message(self):
        ctx = _tool_context()
        result = await stop(tool_context=ctx, message="all done")
        assert result == "all done"
        ctx.agent.cancel.assert_called_once_with("all done", after_current_tools=True)

    @pytest.mark.asyncio
    async def test_does_not_touch_invocation_state(self):
        ctx = _tool_context()
        await stop(tool_context=ctx, message="bye")
        assert ctx.invocation_state == {}

    @pytest.mark.asyncio
    async def test_empty_message_falls_back_to_default(self):
        # Kept symmetric with the TS side: an empty string falls back to the
        # default so the loop's final assistant turn is never blank.
        ctx = _tool_context()
        result = await stop(tool_context=ctx, message="")
        assert result == "Agent loop stopped."
        ctx.agent.cancel.assert_called_once_with("Agent loop stopped.", after_current_tools=True)


class TestInputValidation:
    """The tool validates the ``message`` argument at the tool boundary."""

    @pytest.mark.asyncio
    async def test_rejects_oversized_message(self):
        oversized = "x" * 4097
        with pytest.raises(ValueError, match="exceeds the maximum"):
            await stop(tool_context=_tool_context(), message=oversized)

    @pytest.mark.asyncio
    async def test_accepts_message_at_length_cap(self):
        at_cap = "x" * 4096
        result = await stop(tool_context=_tool_context(), message=at_cap)
        assert result == at_cap

    @pytest.mark.asyncio
    async def test_rejects_non_string_message(self):
        with pytest.raises(ValueError, match="must be a string"):
            await stop(tool_context=_tool_context(), message=123)  # type: ignore[arg-type]

    @pytest.mark.asyncio
    async def test_does_not_cancel_when_validation_fails(self):
        ctx = _tool_context()
        with pytest.raises(ValueError):
            await stop(tool_context=ctx, message="x" * 10000)
        ctx.agent.cancel.assert_not_called()

    @pytest.mark.asyncio
    async def test_configurable_max_message_length_relaxes_cap(self):
        big_stop = make_stop(max_message_length=10_000)
        message = "x" * 8000
        result = await big_stop(tool_context=_tool_context(), message=message)
        assert result == message

    @pytest.mark.asyncio
    async def test_configurable_max_message_length_still_enforces_new_cap(self):
        big_stop = make_stop(max_message_length=10_000)
        with pytest.raises(ValueError, match="exceeds the maximum of 10000"):
            await big_stop(tool_context=_tool_context(), message="x" * 10_001)

    def test_rejects_non_positive_max_message_length(self):
        with pytest.raises(ValueError, match="positive integer"):
            make_stop(max_message_length=0)
        with pytest.raises(ValueError, match="positive integer"):
            make_stop(max_message_length=-1)


class TestToolMetadata:
    """Tests for tool names, descriptions, and input schema."""

    def test_custom_name(self):
        assert make_stop(name="finish").tool_name == "finish"

    def test_custom_description(self):
        assert make_stop(description="custom desc").tool_spec["description"] == "custom desc"

    def test_schema_excludes_context(self):
        props = stop.tool_spec["inputSchema"]["json"]["properties"]
        assert "message" in props
        assert "tool_context" not in props

    def test_message_is_optional(self):
        required = stop.tool_spec["inputSchema"]["json"].get("required", [])
        assert "message" not in required
