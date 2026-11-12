"""Fixtures shared by the context-manager tests."""

import pytest

from strands._context_manager.stash import Stash
from strands.storage.in_memory_storage import InMemoryStorage


@pytest.fixture
def storage() -> InMemoryStorage:
    """The storage a stash is rooted at."""
    return InMemoryStorage()


@pytest.fixture
def stash(storage: InMemoryStorage) -> Stash:
    """A stash over in-memory storage."""
    return Stash(storage, "test-session", "test-agent")
