"""Session resume: an agent rebuilt on a session continues the conversation, tool calls included."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from recording import Recording, check_invariants
from strands import Agent

Build = Callable[..., Agent]
Check = Callable[[Agent, str], bool]
Record = Callable[[Agent], Recording]

_TESTING = "You are an automated integration test. Do exactly what is asked and nothing else."


async def test_recalls_the_first_agents_codeword_and_keeps_calling_tools_from_an_agent_rebuilt_on_the_session(
    work_dir: Path, build_agent: Build, record_agent: Record, tool_succeeded: Check
) -> None:
    session = {"id": "resume"}
    first = build_agent(session=session)
    first_recording = record_agent(first)
    await first.invoke_async(
        f"{_TESTING} Remember this codeword for later: QUOKKA-58. "
        "Then use the shell tool to run `echo ready` and reply with its output."
    )

    second = build_agent(session=session)
    second_recording = record_agent(second)
    saved = work_dir / "codeword.txt"
    await second.invoke_async(
        f"{_TESTING} Use the write tool to save the codeword I asked you to remember, and nothing else, to {saved}."
    )

    check_invariants(first_recording, first)
    check_invariants(second_recording, second)
    assert tool_succeeded(first, "shell")
    tru_history = second_recording.loop_calls[0].messages[:-1]
    exp_history = [{"role": message["role"], "content": message["content"]} for message in first.messages]
    assert tru_history == exp_history
    assert saved.read_text().strip() == "QUOKKA-58"
