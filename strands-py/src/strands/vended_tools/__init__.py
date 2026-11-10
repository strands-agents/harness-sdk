"""Built-in tools for commands, files, HTTP, taking notes, pausing, and multi-agent delegation.

The :func:`make_shell`, :func:`make_edit`, and :func:`make_write` factories
produce sandbox-routed tools that either bind to a
:class:`~strands.sandbox.base.Sandbox` at creation (as the built-in Docker/SSH
sandboxes do when vending tools) or read the sandbox from the agent at call
time. Each :data:`shell` call runs in a fresh shell, so state does not persist
between calls. The :data:`sleep` tool pauses execution for a bounded,
cancellable duration.

The :data:`edit` tool replaces an exact, unique string in a text file; it
pairs with the ``read`` and ``write`` tools. The older :data:`file_editor`
tool is retained for compatibility but is deprecated; Docker/SSH sandboxes
still vend it alongside ``read``/``write`` for continuity. Calling
:func:`make_file_editor` emits a :class:`DeprecationWarning`.

The :data:`write` tool creates or overwrites a text file with the full provided
content; pair with the companion ``read`` and ``edit`` vended tools for the
focused file-editing surface.

The :data:`http_request` tool makes raw HTTP calls; use
:func:`make_http_request` to supply a pre-configured ``httpx.AsyncClient``
with custom timeouts, redirects, authentication, or proxies.
The :data:`web_fetch` tool fetches an HTTP(S) URL and by default returns an
analyst's answer to a prompt about the page content (``mode='agentic'``); use
``make_web_fetch(mode='markdown')`` for clean markdown output. It
requires the optional ``web-fetch`` extra (``pip install 'strands-agents[web-fetch]'``)
and is imported lazily, so accessing it without that extra raises :class:`ImportError`.

The :data:`python_repl` tool runs Python through the agent's sandbox; use :func:`make_python_repl`
to bind a sandbox or choose the interpreter. Each call runs in a fresh process,
so in-memory state does not persist between calls.

The :func:`make_a2a_client` factory creates a tool that discovers and sends messages to remote A2A-protocol
agents. Supply the required ``allowed_endpoints`` list — each entry is either a bare URL string or a
``(url, ClientConfig)`` tuple.
It requires the optional ``a2a`` extra (``pip install 'strands-agents[a2a]'``)
and is imported lazily, so accessing it without that extra raises :class:`ImportError`.

The :data:`notebook` tool gives an agent a session-scoped scratchpad backed by
:attr:`~strands.Agent.state`; use :func:`make_notebook` to supply a custom
tool name, description, or memory caps.

The :data:`handoff_to_user` tool pauses the agent loop and surfaces a message to
the user for human-in-the-loop input; use :func:`make_handoff_to_user` to supply
a custom tool name or description.

The :data:`stop` tool lets the model gracefully end the agent loop with an
optional final message; use :func:`make_stop` to supply a custom tool name,
description, or message length cap. It is a cooperative stop: sibling tools
in the same batch still run to completion, then the loop exits with
``stop_reason == "cancelled"``.

The :func:`make_subagent` factory produces a ``subagent`` delegation tool that runs a
self-contained task in an isolated child agent and returns a final report.
Authority-mode axes let the developer pin what the model can configure on each child.

The :data:`swarm` tool spins up a handoff-based team of sub-agents at runtime and runs
it as a :class:`~strands.multiagent.Swarm`; use :func:`make_swarm` to supply presets,
a custom tool name or description, or a cap on agents per call.

The :data:`graph` tool runs a directed acyclic graph of sub-agents at runtime as a
:class:`~strands.multiagent.graph.Graph`; use :func:`make_graph` to supply presets,
a custom tool name or description, or caps on nodes and edges per call.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import (
        edit, graph, handoff_to_user, http_request, notebook, read, shell, sleep, stop, web_fetch
    )

    agent = Agent(tools=[edit, graph, handoff_to_user, http_request, notebook, read, shell, sleep, stop, web_fetch])
    ```
"""

import warnings
from typing import Any

from ._bash import _RENAME_RATIONALE, make_bash  # noqa: F401  deprecated tool, kept importable until v2.0.0
from .edit import edit, make_edit
from .file_editor import file_editor, make_file_editor
from .graph import graph, make_graph
from .handoff_to_user import HANDOFF_INTERRUPT_NAME, handoff_to_user, make_handoff_to_user
from .http_request import http_request, make_http_request
from .mcp_router import make_mcp_router
from .notebook import make_notebook, notebook
from .python_repl import make_python_repl, python_repl
from .read import make_read, read
from .shell import make_shell, shell
from .sleep import make_sleep, sleep
from .stop import make_stop, stop
from .subagent import make_subagent, subagent
from .swarm import make_swarm, swarm
from .write import make_write, write


def __getattr__(name: str) -> Any:
    # ``bash`` is a tool instance rather than a function, so it cannot carry the
    # @deprecated decorator that ``make_bash`` uses; resolve it here instead.
    if name == "bash":
        warnings.warn(
            f"bash is deprecated and will be removed in v2.0.0. Use shell instead. {_RENAME_RATIONALE}",
            DeprecationWarning,
            stacklevel=2,
        )
        from ._bash import bash

        return bash
    # web_fetch pulls the optional ``web-fetch`` extra, so it is lazy-loaded to keep
    # the base import free of those dependencies.
    if name in ("make_web_fetch", "web_fetch"):
        from .web_fetch import make_web_fetch, web_fetch

        if name == "web_fetch":
            return web_fetch
        return make_web_fetch
    # a2a_client pulls the optional ``a2a`` extra, so it is lazy-loaded to keep
    # the base import free of those dependencies.
    if name == "make_a2a_client":
        from .a2a_client import make_a2a_client

        return make_a2a_client
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "HANDOFF_INTERRUPT_NAME",
    "edit",
    "file_editor",
    "graph",
    "handoff_to_user",
    "http_request",
    "make_edit",
    "make_file_editor",
    "make_graph",
    "make_handoff_to_user",
    "make_http_request",
    "make_mcp_router",
    "make_notebook",
    "make_python_repl",
    "make_read",
    "make_shell",
    "make_sleep",
    "make_stop",
    "make_subagent",
    "make_swarm",
    "make_write",
    "notebook",
    "python_repl",
    "read",
    "shell",
    "sleep",
    "stop",
    "subagent",
    "swarm",
    "write",
]
