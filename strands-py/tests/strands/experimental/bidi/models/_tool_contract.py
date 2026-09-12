"""Shared conformance assertions for bidi provider tool groups."""

from strands.experimental.bidi.types.events import BidiToolUsesCompleteEvent
from strands.types._events import ToolUseStreamEvent
from strands.types.tools import ToolUse


def assert_tool_group_contract(events: list, expected_tool_uses: list[ToolUse]) -> None:
    """Assert the provider-independent receive contract for one executable tool group."""
    stream_indexes = [index for index, event in enumerate(events) if isinstance(event, ToolUseStreamEvent)]
    completion_indexes = [index for index, event in enumerate(events) if isinstance(event, BidiToolUsesCompleteEvent)]

    assert len(stream_indexes) == len(expected_tool_uses)
    assert len(completion_indexes) == 1
    assert max(stream_indexes) < completion_indexes[0]

    completion = events[completion_indexes[0]]
    assert completion.tool_uses == expected_tool_uses
    assert completion.message == {
        "role": "assistant",
        "content": [{"toolUse": tool_use} for tool_use in expected_tool_uses],
    }
