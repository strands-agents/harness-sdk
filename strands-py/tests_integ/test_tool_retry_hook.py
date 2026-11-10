#!/usr/bin/env python3
"""Integration tests for tool retry hook mechanism.

Tests that setting AfterToolCallEvent.retry=True causes tool re-execution.
Uses direct tool invocation to test the executor-level retry, not model behavior.
"""

from strands import Agent, tool
from strands.hooks import AfterToolCallEvent


def test_tool_retry_hook_causes_reexecution():
    """Test that setting retry=True on AfterToolCallEvent causes tool re-execution.

    Verifies:
    1. Tool is called again when retry=True
    2. Hook receives AfterToolCallEvent for BOTH attempts
    3. Same tool_use_id is used (proves executor retry, not model re-calling)
    """
    state = {"call_count": 0}

    @tool(name="flaky_tool")
    def flaky_tool(message: str) -> str:
        """A tool that fails once then succeeds.

        Args:
            message: A message to include in the response.
        """
        state["call_count"] += 1
        if state["call_count"] == 1:
            raise RuntimeError("First call fails")
        return f"Success on attempt {state['call_count']}"

    hook_calls: list[dict] = []

    def retry_on_first_error(event: AfterToolCallEvent) -> None:
        tool_use_id = str(event.tool_use.get("toolUseId", ""))
        hook_calls.append(
            {
                "tool_use_id": tool_use_id,
                "status": event.result.get("status"),
                "attempt": state["call_count"],
            }
        )

        # Retry once on error
        if event.result.get("status") == "error" and state["call_count"] == 1:
            event.retry = True

    agent = Agent(tools=[flaky_tool])
    agent.hooks.add_callback(AfterToolCallEvent, retry_on_first_error)

    # Direct tool invocation bypasses model - tests executor retry mechanism
    result = agent.tool.flaky_tool(message="test")

    # Tool was called twice (1 failure + 1 success)
    assert state["call_count"] == 2

    # Hook received AfterToolCallEvent for BOTH attempts
    assert len(hook_calls) == 2
    assert hook_calls[0]["status"] == "error"
    assert hook_calls[0]["attempt"] == 1
    assert hook_calls[1]["status"] == "success"
    assert hook_calls[1]["attempt"] == 2

    # Both calls used the same tool_use_id (executor retry, not new model call)
    assert hook_calls[0]["tool_use_id"] == hook_calls[1]["tool_use_id"]

    assert result["status"] == "success"
