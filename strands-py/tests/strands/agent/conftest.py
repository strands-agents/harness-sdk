"""Fixtures for agent tests."""

import asyncio
from unittest.mock import AsyncMock

import pytest


@pytest.fixture
def mock_sleep(monkeypatch):
    """Mock asyncio.sleep to avoid delays in tests and track sleep calls."""
    sleep_calls = []

    async def _mock_sleep(delay):
        sleep_calls.append(delay)

    mock = AsyncMock(side_effect=_mock_sleep)
    monkeypatch.setattr(asyncio, "sleep", mock)

    # Return both the mock and the sleep_calls list for verification
    mock.sleep_calls = sleep_calls
    return mock
