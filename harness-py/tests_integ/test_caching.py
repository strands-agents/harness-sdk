"""Prompt-caching regression check: a real multi-turn agent keeps reading its cached prefix.

The harness enables caching by default. This pins that the default wiring actually caches end to end, so a
change that silently disables it (a flipped default, a broken ``caching`` -> ``resolve_model``
handoff, a provider flag regression) fails here instead of shipping as a quiet cost/latency loss.
The default injector plugins (``todos``, ``environment``) are enabled so the configuration matches
the real default that first surfaced the caching/injection interaction.

The signal is wire-level and no offline test can observe it: cumulative cache reads reported by the
model must grow turn over turn. With caching off they stay flat at zero, so the margin is large and
the assertions are robust against the model's non-determinism. Reads (not writes) are the signal
because Bedrock's prompt cache persists server-side for a few minutes, so a warm prefix from an
earlier run can make the first turn read rather than write — but every turn still re-reads the
cached prefix, so cumulative reads grow either way.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from strands import Agent
from strands.agent import AgentResult

Build = Callable[..., Agent]

_TESTING = "You are an automated integration test. Do exactly what is asked and nothing else."

# A large, byte-stable prefix pushes the cacheable region (system prompt + tool schemas) over the
# model's minimum-cacheable-prefix size. Below it Bedrock declines to write a cache point and the
# whole check would pass vacuously with zero caching. Only the size and its stability across turns
# matter, not the content.
_STABLE_PREFIX = ("You are an automated integration test agent operating under a fixed protocol. " * 8 + "\n") * 40

# Single-word answers keep the turns cheap and deterministic and give the model no reason to call a
# tool, so each turn is one clean model call whose cache usage is easy to reason about.
_TURNS = (
    "Reply with exactly the word: apple. Nothing else.",
    "Reply with exactly the word: banana. Nothing else.",
    "Reply with exactly the word: cherry. Nothing else.",
)


def _cache_read(result: AgentResult) -> int:
    return result.metrics.accumulated_usage.get("cacheReadInputTokens", 0)


async def test_caching_reads_grow_across_turns(work_dir: Path, build_agent: Build) -> None:
    agent = build_agent(instructions=_STABLE_PREFIX, builtin_plugins=["todos", "environment"])
    # A rendered todo makes the todos injector fold real content into every turn, so the run
    # exercises the injector-plus-caching path rather than an empty, no-op injection.
    agent.state.set(
        "todos",
        [{"content": "Answer each question", "activeForm": "Answering each question", "status": "in_progress"}],
    )

    reads = []
    for turn in _TURNS:
        result = await agent.invoke_async(f"{_TESTING} {turn}")
        reads.append(_cache_read(result))

    # Cumulative reads must end non-zero (the prefix was cached and read back) and grow on every turn
    # (each later turn re-reads the cached prefix). With caching off they stay flat at zero.
    assert reads[-1] > 0, f"prompt cache was never read back across {len(_TURNS)} turns: {reads}"
    assert all(reads[turn] > reads[turn - 1] for turn in range(1, len(reads))), (
        f"cumulative cache reads did not grow every turn: {reads}"
    )
