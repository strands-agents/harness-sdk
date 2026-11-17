"""Fixtures shared by the context-manager tests."""

import pytest

from strands._context_manager.stash import Stash
from strands.storage.in_memory_storage import InMemoryStorage


@pytest.fixture
def storage() -> InMemoryStorage:
    return InMemoryStorage()


@pytest.fixture
def stash(storage: InMemoryStorage) -> Stash:
    return Stash(storage, "test-session", "test-agent")
