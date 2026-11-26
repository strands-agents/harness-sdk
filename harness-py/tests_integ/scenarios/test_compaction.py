"""Compaction mid-conversation: older turns are summarized and the provider keeps accepting requests."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from recording import ModelCall, Recording, check_invariants
from strands import Agent, tool

Build = Callable[..., Agent]
Record = Callable[[Agent], Recording]

_TESTING = "You are an automated integration test. Do exactly what is asked and nothing else."


@tool
def fetch_report(part: int) -> str:
    """Fetches one part of the quarterly report."""
    # Large enough that the context manager offloads each result to a fixed-size preview.
    return "\n".join(
        f"Report {part}, row {row}: revenue {part * 1000 + row} and costs {row % 9 + 40}, both flat."
        for row in range(250)
    )


def _prompt_tokens(call: ModelCall) -> int:
    usage = call.usage
    return usage["inputTokens"] + usage.get("cacheReadInputTokens", 0) + usage.get("cacheWriteInputTokens", 0)


async def test_summarizes_mid_conversation_keeps_the_provider_accepting_requests_and_still_recalls_the_codeword(
    work_dir: Path, build_agent: Build, record_agent: Record
) -> None:
    agent = build_agent(tools=[fetch_report])
    recording = record_agent(agent)

    await agent.invoke_async(
        f'{_TESTING} Remember this codeword for later: OCELOT-93. Then call fetch_report with part 1 and reply "ok".'
    )
    # Sized from the first turn's real usage so that the third report crosses the summarization threshold
    # (85% of the window) by half a report, whatever the model's tokenizer.
    first_turn = recording.loop_calls
    request, after_report = _prompt_tokens(first_turn[0]), _prompt_tokens(first_turn[-1])
    agent.model.update_config(context_window_limit=int((request + 2.5 * (after_report - request)) / 0.85))

    await agent.invoke_async(f'{_TESTING} Call fetch_report with part 2 and reply "ok".')
    await agent.invoke_async(f'{_TESTING} Call fetch_report with part 3 and reply "ok".')
    result = await agent.invoke_async(f"{_TESTING} Reply with the codeword I asked you to remember.")

    # A model that summarizes server-side makes no summary request of its own.
    server_side = agent.model.model_info.capabilities.server_side_summary is True
    check_invariants(recording, agent, prefix_breaks=1, auxiliary_calls=0 if server_side else 1)
    assert "[Summarized: " in str(recording.loop_calls[-1].messages)
    assert "OCELOT-93" in str(result)
