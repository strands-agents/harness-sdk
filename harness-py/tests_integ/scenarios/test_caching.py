"""Prompt caching per request: after the first turn, every request re-reads the previous one from cache."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path

import pytest
from recording import ModelCall, Recording, check_invariants
from strands import Agent, tool
from strands.models import BedrockModel

Build = Callable[..., Agent]
Record = Callable[[Agent], Recording]

_TESTING = "You are an automated integration test. Do exactly what is asked and nothing else."

# Pushes the cacheable prefix (system prompt and tool specs) over every model's minimum cacheable size.
_STABLE_PREFIX = ("You are an automated integration test agent operating under a fixed protocol. " * 8 + "\n") * 40

# With cache points a request re-reads nearly all of the previous request (measured: 0.98 or more).
_MIN_READ_FRACTION = 0.9

# A fresh agent shares the system prompt and tool specs with the first one, not its first message (measured: 0.95).
_MIN_FRESH_READ_FRACTION = 0.8


@tool
def fetch_page(page: int) -> str:
    """Fetches one page of the manual."""
    # Each page is about 1,200 tokens, so the conversation soon outweighs the fixed prefix: a request
    # can only re-read most of the previous one if the messages are cached too.
    return "\n".join(
        f"Page {page}, line {line}: step {page * 100 + line} of the assembly, torque {line % 7 + 3} Nm."
        for line in range(45)
    )


def _cache_read(call: ModelCall) -> int:
    return call.usage.get("cacheReadInputTokens", 0)


def _cached(call: ModelCall) -> int:
    """The tokens ``call`` left in the cache: what it re-read plus what it wrote."""
    return _cache_read(call) + call.usage.get("cacheWriteInputTokens", 0)


def _prompt_tokens(call: ModelCall) -> int:
    # Providers count cached tokens inside inputTokens or beside them; the total holds either way.
    return call.usage["totalTokens"] - call.usage["outputTokens"]


async def test_reads_most_of_the_previous_request_from_cache_on_every_request_after_the_first_turn(
    work_dir: Path, build_agent: Build, record_agent: Record
) -> None:
    # Unique to this run, so nothing it reads from the cache was left there by an earlier run.
    instructions = f"Run {uuid.uuid4().hex}.\n{_STABLE_PREFIX}"
    agent = build_agent(instructions=instructions, tools=[fetch_page], builtin_plugins=["environment"])
    caching = agent.model.model_info.capabilities.prompt_caching
    if caching not in ("cache_points", "auto"):
        pytest.skip(f"the SDK places no cache points for this model (prompt_caching={caching!r})")
    recording = record_agent(agent)

    async def turn(page: int) -> None:
        await agent.invoke_async(
            f"{_TESTING} Call fetch_page with page {page}, then reply with exactly the word: done."
        )

    await turn(1)
    first_turn_calls = len(recording.loop_calls)
    for page in (2, 3, 4):
        await turn(page)

    check_invariants(recording, agent)
    calls = recording.loop_calls
    usage = [call.usage for call in calls]
    if caching == "cache_points":
        misses = [
            index
            for index in range(first_turn_calls, len(calls))
            if _cache_read(calls[index]) < _MIN_READ_FRACTION * _prompt_tokens(calls[index - 1])
            or _cache_read(calls[index]) < _cached(calls[index - 1])
        ]
        assert len(misses) <= 1, f"requests {misses} missed the cache; usage of each request: {usage}"

        # A second conversation can share only what has its own cache point: on Bedrock, the system prompt and tools.
        if isinstance(agent.model, BedrockModel):
            fresh = build_agent(instructions=instructions, tools=[fetch_page], builtin_plugins=["environment"])
            fresh_recording = record_agent(fresh)
            await fresh.invoke_async(f"{_TESTING} Reply with exactly the word: ready.")

            check_invariants(fresh_recording, fresh)
            first = fresh_recording.loop_calls[0]
            assert _cache_read(first) >= _MIN_FRESH_READ_FRACTION * _cached(calls[0]), (
                f"usage of the fresh agent's first request: {first.usage}; of the first agent's: {calls[0].usage}"
            )
    else:
        assert _cache_read(calls[-1]) > 0, f"usage of each request: {usage}"
