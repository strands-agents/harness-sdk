"""Fixtures for the context graph test suite.

The absence of network is a property of the suite, not the discipline of whoever writes a test. The
guard below fails the test on the first outbound socket use, so a double that quietly grew a boto
client is caught by the suite instead of by a slow, flaky failure in CI.

The guard is installed per test and removed on teardown, even though it is built once per session:
a session-scoped patch would outlive this package and break sibling suites that legitimately open
local sockets.
"""

import socket
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from .stubs import FakeBedrockEmbedder, StubMatcher


class NetworkUsedError(AssertionError):
    """Raised when a test in this package attempts to reach the network."""


@pytest.fixture(scope="session")
def network_guard() -> Callable[[Any], Any]:
    """Build the replacement for every outbound connect attempt.

    Returns:
        A callable that always raises :class:`NetworkUsedError`, naming the address it was handed.
    """

    def _fail(*args: Any, **_kwargs: Any) -> Any:
        # Bound methods arrive as (self, address); module functions as (address,).
        address = args[1] if len(args) > 1 else (args[0] if args else None)
        raise NetworkUsedError(
            f"the context graph suite makes zero network calls, but something tried to reach {address!r}"
        )

    return _fail


@pytest.fixture(autouse=True)
def no_network(network_guard: Callable[[Any], Any], monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Block every outbound connection for the duration of a test.

    ``connect`` is the chokepoint rather than the socket constructor: constructing a socket costs
    nothing and some local machinery does it, while connecting is unambiguously network use.
    """
    monkeypatch.setattr(socket.socket, "connect", network_guard, raising=True)
    monkeypatch.setattr(socket.socket, "connect_ex", network_guard, raising=True)
    monkeypatch.setattr(socket, "create_connection", network_guard, raising=True)
    yield


@pytest.fixture
def stub_matcher() -> StubMatcher:
    """A matcher double that scores every description ``0.0`` until a test says otherwise."""
    return StubMatcher()


@pytest.fixture
def fake_embedder() -> FakeBedrockEmbedder:
    """An embedder double that records the ``(purpose, text)`` pair of every call."""
    return FakeBedrockEmbedder()
