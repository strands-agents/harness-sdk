"""The ``context_manager="lsp"`` option: language server context on top of the ``"auto"`` strategies.

Large code reads arrive as skeletons, ``grep -n`` and ``sed -n`` results carry the symbols and definitions they touch,
``retrieve_context`` also finds definitions and greps the workspace, and an experimental relevance strategy offloads
old reads of unrelated files near a full window. When the language server
can't start, the harness falls back to ``"auto"`` and says so, rather than failing construction.
"""

from __future__ import annotations

import logging
import shutil
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from strands.experimental.context_manager import ContextManager, ContextStrategy, Offload
from strands.sandbox import Sandbox
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment

logger = logging.getLogger(__name__)

LSP_COMMAND = ["pyright-langserver", "--stdio"]
"""The language server the option starts: pyright, installed with the ``strands-harness[lsp]`` extra."""

STATE_KEY = "context_manager"
"""The ``agent.state`` key that records which context manager the ``"lsp"`` option ended up running."""

# The strategies ContextManager("auto") runs; "auto" itself can't be listed inside ``strategies``.
_AUTO_TRUNCATE_THRESHOLD = 1_500
_AUTO_TRUNCATE_PREVIEW_TOKENS = 750
_AUTO_SUMMARIZE_UTILIZATION = "85%"
_AUTO_SUMMARIZE_PRESERVE_RECENT = 4


@dataclass
class LspContext:
    """What the ``"lsp"`` option resolved to.

    Attributes:
        context_manager: The context manager to pass to the agent: the language server pipeline, or ``"auto"``.
        tools: Tools the pipeline adds; its ``retrieve_context`` replaces the built-in one.
        plugins: Plugins the option adds: the shell-result enricher.
        status: What ran, for ``agent.state``: ``{"requested": "lsp", "active": "lsp" | "auto", "reason": ...}``.
        close: Shuts the language server down, or None when none started.
    """

    context_manager: ContextManager | Literal["auto"]
    tools: list[Any] = field(default_factory=list)
    plugins: list[Any] = field(default_factory=list)
    status: dict[str, str] = field(default_factory=dict)
    close: Callable[[], None] | None = None


def resolve_lsp_context(
    root: Path | str, read_tool: str = "read", shell_tool: str = "shell", sandbox: Sandbox | None = None
) -> LspContext:
    """Start the language server in ``root`` and build the context pipeline around it, or fall back to ``"auto"``.

    Args:
        root: Workspace root the language server indexes.
        read_tool: Name of the tool that reads files, through ``path``, ``offset`` and ``limit`` inputs.
        shell_tool: Name of the shell tool; a command that prints a whole code file is outlined like a read.
        sandbox: The agent's sandbox. The language server reads the local filesystem, so any sandbox other than the
            local environment falls back to ``"auto"``.

    Returns:
        The context manager and tools to use, and a record of which one is active.
    """
    if sandbox is not None and not isinstance(sandbox, NotASandboxLocalEnvironment):
        return _fallback(f"the language server reads local files, but the agent runs in {type(sandbox).__name__}")
    try:
        from strands.vended_plugins.language_server import (
            CodeFetchEnricher,
            LspStrategy,
            SkeletonStrategy,
            StdioLspClient,
            WorkspaceSearch,
            workspace_retrieval_tool,
        )
    except ImportError as error:
        return _fallback(f"the installed strands-agents has no language server support ({error})")

    command = _server_command(LSP_COMMAND)
    try:
        client = StdioLspClient(command, root)
    except Exception as error:
        return _fallback(f"{type(error).__name__}: {error}")

    strategies: list[ContextStrategy | str] = [
        SkeletonStrategy(client, root, read_tools=(read_tool,), shell_tools=(shell_tool,), symbol_lookup=True),
        LspStrategy(client, root),
        *_auto_strategies(),
    ]
    manager = ContextManager(strategies=strategies, stash={"retrieval_tool": False})
    logger.info("root=<%s>, command=<%s> | language server context manager active", root, command[0])
    return LspContext(
        context_manager=manager,
        tools=[workspace_retrieval_tool(manager, WorkspaceSearch(client, root))],
        plugins=[CodeFetchEnricher(client, root, shell_tools=(shell_tool,))],
        status={"requested": "lsp", "active": "lsp"},
        close=client.close,
    )


def _server_command(command: list[str]) -> list[str]:
    """``command`` with its binary found on PATH, or next to this interpreter when its environment isn't activated."""
    if shutil.which(command[0]) is not None:
        return command
    beside_interpreter = Path(sys.executable).parent / command[0]
    if shutil.which(beside_interpreter) is not None:
        return [str(beside_interpreter), *command[1:]]
    return command


def _auto_strategies() -> list[ContextStrategy]:
    return [
        Offload.truncate("tool_results", {"preview_tokens": _AUTO_TRUNCATE_PREVIEW_TOKENS}).when(
            block_threshold=_AUTO_TRUNCATE_THRESHOLD
        ),
        Offload.summarize("*").when(
            context_utilization=_AUTO_SUMMARIZE_UTILIZATION, preserve_recent=_AUTO_SUMMARIZE_PRESERVE_RECENT
        ),
    ]


def _fallback(reason: str) -> LspContext:
    logger.warning("reason=<%s> | language server context manager unavailable, falling back to auto", reason)
    return LspContext(context_manager="auto", status={"requested": "lsp", "active": "auto", "reason": reason})
