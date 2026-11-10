"""End-to-end test for MemoryManager injection against a real Agent + event loop.

Uses a hand-written in-memory store and a mocked model (no external services). Verifies the
ephemerality contract: retrieved memory reaches the model for one call but never enters the
agent's durable conversation history.
"""

from typing import Any

import pytest

from strands import Agent
from strands.memory import MemoryEntry, MemoryManager
from strands.memory.types import SearchOptions
from tests.fixtures.mocked_model_provider import MockedModelProvider


class _FakeStore:
    """Minimal read-only MemoryStore whose ``search`` returns a fixed entry."""

    name = "kb"
    description = "knowledge base"
    max_search_results = None
    writable = False
    extraction = None

    async def search(self, query: str, options: SearchOptions | None = None) -> list[MemoryEntry]:
        return [MemoryEntry(content="user prefers dark mode")]


def _texts(messages: list[dict]) -> str:
    return " ".join(block["text"] for message in messages for block in message["content"] if "text" in block)


@pytest.fixture
def model() -> MockedModelProvider:
    return MockedModelProvider([{"role": "assistant", "content": [{"text": "Hello!"}]}])


@pytest.fixture
def model_seen(model: MockedModelProvider) -> list[list[dict]]:
    """Capture the messages the model actually receives, wrapping the mock's stream()."""
    seen: list[list[dict]] = []
    original_stream = model.stream

    def stream(messages: list[dict], *args: Any, **kwargs: Any) -> Any:
        seen.append([dict(message) for message in messages])
        return original_stream(messages, *args, **kwargs)

    model.stream = stream  # type: ignore[method-assign]
    return seen


def test_memory_injection_reaches_model_but_not_durable_history(
    model: MockedModelProvider, model_seen: list[list[dict]]
) -> None:
    agent = Agent(
        model=model,
        callback_handler=None,
        plugins=[MemoryManager(stores=[_FakeStore()], injection=True)],
    )

    agent("what are my preferences?")

    # (a) The model saw the retrieved memory folded into the user message.
    assert len(model_seen) == 1
    assert "user prefers dark mode" in _texts(model_seen[0])
    assert "<memory>" in _texts(model_seen[0])
    assert "what are my preferences?" in _texts(model_seen[0])

    # (b) The durable conversation never contains the injected memory block.
    assert "user prefers dark mode" not in _texts(agent.messages)
    assert "<memory>" not in _texts(agent.messages)
    assert "what are my preferences?" in _texts(agent.messages)
