"""
Tests for the SDK tool watcher module.
"""

import threading
import time
from unittest.mock import MagicMock, patch

import pytest

from strands.tools.registry import ToolRegistry
from strands.tools.watcher import ToolWatcher


@pytest.fixture
def reset_shared_watcher_state():
    """Give each test a clean slate of ToolWatcher's shared class state, restored after."""
    saved = (
        ToolWatcher._shared_observer,
        set(ToolWatcher._watched_dirs),
        ToolWatcher._observer_started,
        dict(ToolWatcher._registry_handlers),
    )
    ToolWatcher._shared_observer = None
    ToolWatcher._watched_dirs = set()
    ToolWatcher._observer_started = False
    ToolWatcher._registry_handlers = {}
    yield
    (
        ToolWatcher._shared_observer,
        ToolWatcher._watched_dirs,
        ToolWatcher._observer_started,
        ToolWatcher._registry_handlers,
    ) = saved


@patch("strands.tools.watcher.Observer")
def test_start_is_thread_safe_under_concurrent_construction(mock_observer_cls, reset_shared_watcher_state):
    """Constructing many ToolWatchers from concurrent threads must start the shared observer exactly once."""
    mock_observer_cls.return_value = MagicMock()
    # start() sleeps so the read-then-set window is wide, making the race reproduce reliably.
    mock_observer_cls.return_value.start.side_effect = lambda: time.sleep(0.05)
    thread_count = 8
    barrier = threading.Barrier(thread_count)
    errors: list[BaseException] = []

    def build_watcher() -> None:
        barrier.wait()  # line every thread up so their start() calls actually overlap
        try:
            ToolWatcher(ToolRegistry())
        except BaseException as exc:  # pragma: no cover - failure path only
            errors.append(exc)

    threads = [threading.Thread(target=build_watcher) for _ in range(thread_count)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    assert ToolWatcher._shared_observer.start.call_count == 1
    assert ToolWatcher._observer_started is True


def test_tool_watcher_initialization():
    """Test that the handler initializes with the correct tool registry."""
    tool_registry = ToolRegistry()
    watcher = ToolWatcher(tool_registry)
    assert watcher.tool_registry == tool_registry


@pytest.mark.parametrize(
    "test_case",
    [
        # Regular Python file - should reload
        {
            "description": "Python file",
            "src_path": "/path/to/test_tool.py",
            "is_directory": False,
            "should_reload": True,
            "expected_tool_name": "test_tool",
        },
        # Non-Python file - should not reload
        {
            "description": "Non-Python file",
            "src_path": "/path/to/test_tool.txt",
            "is_directory": False,
            "should_reload": False,
        },
        # __init__.py file - should not reload
        {
            "description": "Init file",
            "src_path": "/path/to/__init__.py",
            "is_directory": False,
            "should_reload": False,
        },
        # Directory path - should not reload
        {
            "description": "Directory path",
            "src_path": "/path/to/tools_directory",
            "is_directory": True,
            "should_reload": False,
        },
        # Python file marked as directory - should still reload
        {
            "description": "Python file marked as directory",
            "src_path": "/path/to/test_tool2.py",
            "is_directory": True,
            "should_reload": True,
            "expected_tool_name": "test_tool2",
        },
    ],
)
@patch.object(ToolRegistry, "reload_tool")
def test_on_modified_cases(mock_reload_tool, test_case):
    """Test various cases for the on_modified method."""
    tool_registry = ToolRegistry()
    watcher = ToolWatcher(tool_registry)

    # Create a mock event with the specified properties
    event = MagicMock()
    event.src_path = test_case["src_path"]
    if "is_directory" in test_case:
        event.is_directory = test_case["is_directory"]

    # Call the on_modified method
    watcher.tool_change_handler.on_modified(event)

    # Verify the expected behavior
    if test_case["should_reload"]:
        mock_reload_tool.assert_called_once_with(test_case["expected_tool_name"])
    else:
        mock_reload_tool.assert_not_called()


@patch.object(ToolRegistry, "reload_tool", side_effect=Exception("Test error"))
def test_on_modified_error_handling(mock_reload_tool):
    """Test that on_modified handles errors during tool reloading."""
    tool_registry = ToolRegistry()
    watcher = ToolWatcher(tool_registry)

    # Create a mock event with a Python file path
    event = MagicMock()
    event.src_path = "/path/to/test_tool.py"

    # Call the on_modified method - should not raise an exception
    watcher.tool_change_handler.on_modified(event)

    # Verify that reload_tool was called
    mock_reload_tool.assert_called_once_with("test_tool")
