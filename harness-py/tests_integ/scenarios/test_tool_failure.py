"""Tool failure: a tool that fails once is retried by the model and its second result is used."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from recording import Recording, check_invariants
from strands import Agent, tool

Build = Callable[..., Agent]
Record = Callable[[Agent], Recording]

_TESTING = "You are an automated integration test. Do exactly what is asked and nothing else."


async def test_retries_a_tool_that_failed_transiently_and_answers_from_its_second_result(
    work_dir: Path, build_agent: Build, record_agent: Record
) -> None:
    calls = []

    @tool
    def fetch_codeword() -> str:
        """Fetches the codeword from a remote service."""
        calls.append("fetch_codeword")
        if len(calls) == 1:
            raise RuntimeError("Transient network error, retry the call.")
        return "The codeword is WOMBAT-41."

    agent = build_agent(tools=[fetch_codeword])
    recording = record_agent(agent)

    result = await agent.invoke_async(f"{_TESTING} Call fetch_codeword and reply with the codeword it returns.")

    check_invariants(recording, agent, allowed_tool_errors=("fetch_codeword",))
    assert len(calls) >= 2
    assert "WOMBAT-41" in str(result)
