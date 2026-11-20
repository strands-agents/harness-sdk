"""Lifecycle tests for the shared ToolWatcher class state.

The watcher keeps process-global state so a single watchdog Observer can
serve every registry. These tests pin the other half of that contract: a
registration must not outlive the registry it serves.
"""

import gc
import weakref
from unittest.mock import MagicMock, patch

import pytest

from strands.tools.registry import ToolRegistry
from strands.tools.watcher import ToolWatcher


@pytest.fixture
def watched_dir(monkeypatch, tmp_path):
    """Give each test private class state, a real watched directory, and an inert Observer."""
    monkeypatch.setattr(ToolWatcher, "_shared_observer", None)
    monkeypatch.setattr(ToolWatcher, "_watched_dirs", set())
    monkeypatch.setattr(ToolWatcher, "_observer_started", False)
    monkeypatch.setattr(ToolWatcher, "_registry_handlers", {})
    monkeypatch.setattr(ToolRegistry, "get_tools_dirs", lambda self: [tmp_path])
    with patch("strands.tools.watcher.Observer"):
        yield str(tmp_path)


def test_discarded_registry_releases_its_watcher_registration(watched_dir):
    registry = ToolRegistry()
    watcher = ToolWatcher(registry)
    ref = weakref.ref(registry)

    # While the watcher (and its agent) is alive, the registration is live.
    assert ToolWatcher._registry_handlers[watched_dir]

    del watcher, registry
    gc.collect()

    assert ref() is None
    assert not ToolWatcher._registry_handlers.get(watched_dir)


def test_master_handler_stops_dispatching_into_a_discarded_registry(watched_dir):
    registry = ToolRegistry()
    watcher = ToolWatcher(registry)
    master = ToolWatcher.MasterChangeHandler(watched_dir)
    event = MagicMock()
    event.src_path = f"{watched_dir}/sample_tool.py"

    with patch.object(ToolRegistry, "reload_tool") as reload:
        master.on_modified(event)
        assert reload.call_count == 1

    del watcher, registry
    gc.collect()

    with patch.object(ToolRegistry, "reload_tool") as reload:
        master.on_modified(event)
        reload.assert_not_called()
