"""Tool watcher for hot reloading tools during development.

This module provides functionality to watch tool directories for changes and automatically reload tools when they are
modified.
"""

import logging
from pathlib import Path
from typing import Any

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .registry import ToolRegistry

logger = logging.getLogger(__name__)


class ToolWatcher:
    """Watches tool directories for changes and reloads tools when they are modified."""

    # This class uses class variables for the observer and handlers because watchdog allows only one Observer instance
    # per directory. Using class variables ensures that all ToolWatcher instances share a single Observer, with the
    # MasterChangeHandler routing file system events to the appropriate individual handlers for each registry. This
    # design pattern avoids conflicts when multiple tool registries are watching the same directories.

    _shared_observer = None
    _watched_dirs: set[str] = set()
    _observer_started = False
    _registry_handlers: dict[str, dict[int, "ToolWatcher.ToolChangeHandler"]] = {}

    def __init__(self, tool_registry: ToolRegistry) -> None:
        """Initialize a tool watcher for the given tool registry.

        Args:
            tool_registry: The tool registry to report changes.
        """
        self.tool_registry = tool_registry
        self.start()

    class ToolChangeHandler(FileSystemEventHandler):
        """Handler for tool file changes."""

        def __init__(self, tool_registry: ToolRegistry) -> None:
            """Initialize a tool change handler.

            Args:
                tool_registry: The tool registry to update when tools change.
            """
            self.tool_registry = tool_registry

        def on_modified(self, event: Any) -> None:
            """Reload tool if file modification detected.

            Args:
                event: The file system event that triggered this handler.
            """
            if event.src_path.endswith(".py"):
                tool_path = Path(event.src_path)
                tool_name = tool_path.stem

                if tool_name not in ["__init__"]:
                    logger.debug("tool_name=<%s> | tool change detected", tool_name)
                    try:
                        self.tool_registry.reload_tool(tool_name)
                    except Exception as e:
                        logger.error("tool_name=<%s>, exception=<%s> | failed to reload tool", tool_name, str(e))

    class MasterChangeHandler(FileSystemEventHandler):
        """Master handler that delegates to all registered handlers."""

        def __init__(self, dir_path: str) -> None:
            """Initialize a master change handler for a specific directory.

            Args:
                dir_path: The directory path to watch.
            """
            self.dir_path = dir_path

        def on_modified(self, event: Any) -> None:
            """Delegate file modification events to all registered handlers.

            Args:
                event: The file system event that triggered this handler.
            """
            if event.src_path.endswith(".py"):
                tool_path = Path(event.src_path)
                tool_name = tool_path.stem

                if tool_name not in ["__init__"]:
                    # Delegate to all registered handlers for this directory
                    for handler in ToolWatcher._registry_handlers.get(self.dir_path, {}).values():
                        try:
                            handler.on_modified(event)
                        except Exception as e:
                            logger.error("exception=<%s> | handler error", str(e))

    def start(self) -> None:
        """Start watching all tools directories for changes."""
        # Initialize shared observer if not already done
        if ToolWatcher._shared_observer is None:
            ToolWatcher._shared_observer = Observer()

        # Create handler for this instance
        self.tool_change_handler = self.ToolChangeHandler(self.tool_registry)
        registry_id = id(self.tool_registry)

        # Get tools directories to watch
        tools_dirs = self.tool_registry.get_tools_dirs()

        for tools_dir in tools_dirs:
            dir_str = str(tools_dir)

            # Initialize the registry handlers dict for this directory if needed
            if dir_str not in ToolWatcher._registry_handlers:
                ToolWatcher._registry_handlers[dir_str] = {}

            # Store this handler with its registry id
            ToolWatcher._registry_handlers[dir_str][registry_id] = self.tool_change_handler

            # Schedule or update the master handler for this directory
            if dir_str not in ToolWatcher._watched_dirs:
                # First time seeing this directory, create a master handler
                master_handler = self.MasterChangeHandler(dir_str)
                ToolWatcher._shared_observer.schedule(master_handler, dir_str, recursive=False)
                ToolWatcher._watched_dirs.add(dir_str)
                logger.debug("tools_dir=<%s> | started watching tools directory", tools_dir)
            else:
                # Directory already being watched, just log it
                logger.debug("tools_dir=<%s> | directory already being watched", tools_dir)

        # Start the observer if not already started
        if not ToolWatcher._observer_started:
            ToolWatcher._shared_observer.start()
            ToolWatcher._observer_started = True
            logger.debug("tool directory watching initialized")
