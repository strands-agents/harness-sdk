"""Shared test helpers for Monty-backed tool tests."""

from unittest.mock import AsyncMock, MagicMock


class FakeMontyError(Exception):
    """Stand-in for Monty errors in tests.

    The real MontyError/MontyRuntimeError are Rust-backed types that cannot be
    instantiated directly in Python.
    """

    def display(self) -> str:
        return str(self.args[0]) if self.args else ""


def mock_session(value: object = None, dump: bytes = b"session-dump") -> MagicMock:
    session = MagicMock()
    session.feed_run = AsyncMock(return_value=value)
    session.dump = AsyncMock(return_value=dump)
    session.load_session = AsyncMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=False)
    return session


def mock_pool(session: MagicMock) -> MagicMock:
    pool = MagicMock()
    pool.checkout = MagicMock(return_value=session)
    pool.__aenter__ = AsyncMock(return_value=pool)
    pool.__aexit__ = AsyncMock(return_value=False)
    return pool


def make_monty_patch(session: MagicMock) -> MagicMock:
    pool = mock_pool(session)
    monty = MagicMock()
    monty.__aenter__ = AsyncMock(return_value=pool)
    monty.__aexit__ = AsyncMock(return_value=False)
    return monty
