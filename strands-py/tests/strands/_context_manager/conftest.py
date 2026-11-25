"""Fixtures shared by the context-manager tests."""

import pytest

from strands._context_manager.archive import Archive
from strands.storage.in_memory_storage import InMemoryStorage


@pytest.fixture
def storage() -> InMemoryStorage:
    return InMemoryStorage()


@pytest.fixture
def archive(storage: InMemoryStorage) -> Archive:
    return Archive(storage, "test-session", "test-agent")
