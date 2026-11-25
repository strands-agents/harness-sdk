"""The ``context_manager="lsp"`` option: language server context on top of the ``"auto"`` strategies.

Broad code reads (more than one file, a whole file, or a long range) are offloaded as they arrive and only their
skeleton stays in context, while targeted reads of part of one file arrive in full. ``retrieve_context`` returns exact
lines (``path`` with ``line_range``) and definitions (``symbol``), and an experimental relevance strategy offloads old
results about unrelated files near a full window. When the language server can't start, the harness falls back to
``"auto"`` and says so, rather than failing construction.
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

TARGETED_LINES = 200
"""Lines of one file a read may hold and still arrive in full: a targeted read, usually made to edit the code."""

GUIDANCE = (
    "Reading code: use the read tool, not shell commands such as cat, sed or grep -A, to read source files. A"
    " whole-file read of a large code file returns its skeleton: imports and signatures with line ranges. Then read"
    " the lines you need with read(path, offset, limit), or one definition with"
    ' retrieve_context(symbol="<name>", path="<file>"). Tool results may be shortened to save context; follow any'
    " instructions in them to see more. Use the shell to search, run code and run tests."
)
"""What the system prompt tells the agent when the language server is active, so it reads code the way the
skeletons expect instead of working around them."""

GUIDANCE_WITHOUT_SHELL = (
    "Reading code: a whole-file read of a large code file returns its skeleton: imports and signatures with line"
    " ranges. Then read the lines you need with read(path, offset, limit), get one definition with"
    ' retrieve_context(symbol="<name>", path="<file>"), or search the workspace with'
    ' retrieve_context(pattern="<regex>", path="<directory>"). Tool results may be shortened to save context;'
    " follow any instructions in them to see more."
)
"""The guidance for an agent with no shell tool, which searches through ``retrieve_context`` instead."""

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
        plugins: Plugins the option adds.
        guidance: Added to the harness's system prompt when the language server is active; None on fallback.
        status: What ran, for ``agent.state``: ``{"requested": "lsp", "active": "lsp" | "auto", "reason": ...}``.
        close: Shuts the language server down, or None when none started.
    """

    context_manager: ContextManager | Literal["auto"]
    tools: list[Any] = field(default_factory=list)
    plugins: list[Any] = field(default_factory=list)
    guidance: str | None = None
    status: dict[str, str] = field(default_factory=dict)
    close: Callable[[], None] | None = None


def resolve_lsp_context(
    root: Path | str,
    read_tool: str = "read",
    shell_tool: str = "shell",
    sandbox: Sandbox | None = None,
    *,
    has_shell: bool = True,
) -> LspContext:
    """Start the language server in ``root`` and build the context pipeline around it, or fall back to ``"auto"``.

    Args:
        root: Workspace root the language server indexes.
        read_tool: Name of the tool that reads files, through ``path``, ``offset`` and ``limit`` inputs.
        shell_tool: Name of the shell tool; code its read-only commands print is offloaded like a read.
        sandbox: The agent's sandbox. The language server reads the local filesystem, so any sandbox other than the
            local environment falls back to ``"auto"``.
        has_shell: Whether the agent has the shell tool; picks the guidance the system prompt gets.

    Returns:
        The context manager and tools to use, and a record of which one is active.
    """
    if sandbox is not None and not isinstance(sandbox, NotASandboxLocalEnvironment):
        return _fallback(f"the language server reads local files, but the agent runs in {type(sandbox).__name__}")
    try:
        from strands.vended_plugins.language_server import (
            CodeSkeletonStrategy,
            LspStrategy,
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
        CodeSkeletonStrategy(
            client, root, read_tools=(read_tool,), shell_tools=(shell_tool,), targeted_lines=TARGETED_LINES
        ),
        LspStrategy(client, root),
        *_auto_strategies(),
    ]
    manager = ContextManager(strategies=strategies, stash={"retrieval_tool": False})
    logger.info("root=<%s>, command=<%s> | language server context manager active", root, command[0])
    return LspContext(
        context_manager=manager,
        tools=[workspace_retrieval_tool(manager, WorkspaceSearch(client, root))],
        status={"requested": "lsp", "active": "lsp"},
        close=client.close,
        guidance=GUIDANCE if has_shell else GUIDANCE_WITHOUT_SHELL,
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
