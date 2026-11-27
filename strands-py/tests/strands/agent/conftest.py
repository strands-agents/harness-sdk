"""Fixtures for agent tests."""

from unittest.mock import AsyncMock

import pytest


@pytest.fixture
def mock_sleep(monkeypatch):
    """Mock retry waits to avoid delays in tests and track requested delays."""
    sleep_calls = []

    async def _mock_sleep(delay, _cancel_signal):
        sleep_calls.append(delay)

    mock = AsyncMock(side_effect=_mock_sleep)
    monkeypatch.setattr("strands.event_loop._retry._wait_for_retry_delay", mock)

    # Return both the mock and the sleep_calls list for verification
    mock.sleep_calls = sleep_calls
    return mock
