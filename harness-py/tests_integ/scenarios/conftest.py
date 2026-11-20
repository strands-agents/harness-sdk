"""Shared setup for the live scenarios: every one records its model calls and checks the common invariants."""

from __future__ import annotations

from collections.abc import Callable, Iterator

import pytest
from recording import Recording, record
from strands import Agent


@pytest.fixture
def record_agent(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Callable[[Agent], Recording]]:
    """``record`` that also dumps each recording as a transcript; pytest shows the printed path when a test fails."""
    recordings: list[Recording] = []

    def _record(agent: Agent) -> Recording:
        recordings.append(record(agent))
        return recordings[-1]

    yield _record
    directory = tmp_path_factory.mktemp("recordings")
    for index, recording in enumerate(recordings):
        recording.dump(directory / f"recording-{index}.json")
    print(f"model-call transcripts: {directory}")
