"""Large tool output: the result stays out of the requests and the model reaches inside it by reference."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from recording import Recording, check_invariants
from strands import Agent, tool

Build = Callable[..., Agent]
Check = Callable[[Agent, str], bool]
Record = Callable[[Agent], Recording]

_TESTING = "You are an automated integration test. Do exactly what is asked and nothing else."

# The codeword sits mid-log: the preview of an offloaded result keeps the head and the tail.
_LOG = "\n".join(
    "CODEWORD: NARWHAL-26" if line == 1000 else f"entry {line}: heartbeat ok, nothing to report."
    for line in range(2000)
)


@tool
def fetch_log() -> str:
    """Fetches the full service log."""
    return _LOG


async def test_keeps_a_huge_tool_result_out_of_the_requests_yet_lets_the_model_find_a_line_inside_it(
    work_dir: Path, build_agent: Build, record_agent: Record, tool_succeeded: Check
) -> None:
    # Without the programmatic tool caller, the only way into an offloaded result is its reference.
    agent = build_agent(tools=[fetch_log], builtin_tools={"programmatic_tool_caller": False})
    recording = record_agent(agent)

    result = await agent.invoke_async(
        f'{_TESTING} Call fetch_log. One line of the log starts with "CODEWORD:". Reply with that line. '
        "The log is long, so search it for that pattern rather than reading it whole."
    )

    check_invariants(recording, agent)
    assert "NARWHAL-26" in str(result)
    assert tool_succeeded(agent, "retrieve_context")
    assert max(len(str(call.messages)) for call in recording.calls) < len(_LOG) / 4
