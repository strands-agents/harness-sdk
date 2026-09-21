"""Types in the :func:`strands_harness.create_harness` signature.

Mirrors the SDK's ``strands.types.agent``: data shapes are ``TypedDict(total=False)`` named
``*Config``, closed vocabularies are ``Literal`` aliases, and a param that accepts several shapes
gets an ``*Option`` alias. Where an option *is* an SDK field, the SDK type is reused so a wrapper
around ``create_harness`` can be typed the same way.
"""

from __future__ import annotations

from typing import Literal

from strands.experimental.context_manager import ContextManager, ContextManagerConfig
from strands.memory import MemoryStore
from strands.models import Model, ModelRouter
from typing_extensions import TypedDict

Effort = Literal["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]
"""Reasoning effort for the resolved model.

``"auto"`` picks the provider's recommended level (``"high"`` everywhere it applies); ``"off"``
disables reasoning (the provider's ``none``, or no thinking block where there is no such level).
The other levels are validated against the resolved provider and, on Bedrock, the model family.
"""

BuiltinToolName = Literal[
    "shell",
    "read",
    "write",
    "edit",
    "web_fetch",
    "web_search",
    "programmatic_tool_caller",
    "subagent",
]
"""Names accepted in ``builtin_tools``; ``web_search`` is the provider's native search where it has one."""

BuiltinPluginName = Literal["todos", "environment"]
"""Names accepted in ``builtin_plugins``."""


WebFetchTransport = Literal["curl", "direct"]
"""How ``web_fetch`` makes its request: ``curl`` inside the agent's sandbox, or ``direct`` from the process."""


class WebFetchConfig(TypedDict, total=False):
    """Per-tool configuration for ``web_fetch``.

    Attributes:
        model: Summarizer model for fetched pages (also reused for memory extraction). A
            ``provider/name`` string, a ``Model``, or a ``ModelRouter``; omit for the provider's
            small model.
        transport: ``"curl"`` (the default) runs the request as ``curl`` inside the agent's
            ``sandbox``, so the sandbox's network controls apply; ``"direct"`` issues it from the
            harness process with the standard library, bypassing the sandbox.
    """

    model: Model | ModelRouter | str
    transport: WebFetchTransport


class ReadConfig(TypedDict, total=False):
    """Per-tool configuration for ``read``.

    Attributes:
        media: Return images and binary documents as viewable media. Defaults to whether the
            agent's model accepts media blocks; set ``False`` to always describe them in text.
    """

    media: bool


class ShellConfig(TypedDict, total=False):
    """Per-tool configuration for ``shell``.

    Attributes:
        description: Tool description shown to the model; omit for the SDK's default.
    """

    description: str


class ProgrammaticToolCallerConfig(TypedDict, total=False):
    """Per-tool configuration for ``programmatic_tool_caller``.

    Attributes:
        allowed_tools: Names of the agent's other tools the code may call; omit for all of them.
        timeout: Wall-clock bound in seconds for one run, tool calls included; ``None`` for no bound.
    """

    allowed_tools: list[str] | None
    timeout: float | None


class SubagentConfig(TypedDict, total=False):
    """Per-tool configuration for ``subagent``.

    Attributes:
        max_depth: How many levels of delegation a child may itself open (default 2).
    """

    max_depth: int


BuiltinToolsConfig = TypedDict(
    "BuiltinToolsConfig",
    {
        "*": bool,
        "read": bool | ReadConfig,
        "shell": bool | ShellConfig,
        "read": bool,
        "write": bool,
        "edit": bool,
        "web_fetch": bool | WebFetchConfig,
        "web_search": bool | Literal["exa"],
        "programmatic_tool_caller": bool | ProgrammaticToolCallerConfig,
        "subagent": bool | SubagentConfig,
    },
    total=False,
)
BuiltinToolsConfig.__doc__ = """Edits to the harness's default built-in tool set.

A mapping is applied on top of the defaults: ``False`` disables a tool, ``True`` enables it, and a
per-tool config object enables and configures it. The ``"*"`` key (default ``True``) selects the
default set as the starting point; write ``False`` to start from nothing and enable tools one by one.

Attributes:
    *: Start from the default set (``True``, the default) or from nothing (``False``).
    shell: Run shell commands; a :class:`ShellConfig` also sets its description.
    read: Read files.
    write: Write files.
    edit: Edit files in place.
    web_fetch: Fetch and summarize web pages; a :class:`WebFetchConfig` also picks the summarizer.
    web_search: Search the web. On its own this is the provider's native search, and nothing where
        the provider has none; ``"exa"`` falls back to Exa's hosted search there, a third party that
        sees the queries (keyless; ``EXA_API_KEY`` lifts its rate limit).
    programmatic_tool_caller: Orchestrate tools from code; a :class:`ProgrammaticToolCallerConfig`
        also narrows the callable tools and bounds a run.
    subagent: Delegate to sub-agents; a :class:`SubagentConfig` also bounds delegation depth.
"""


class SessionConfig(TypedDict, total=False):
    """Session persistence settings for ``session=``.

    Attributes:
        id: Session id; sanitized to ``[a-z0-9_-]``. Omit to mint a fresh short id per agent.
        dir: Directory the session (and offloaded context) is stored under. Default
            ``./.agent/sessions``.
    """

    id: str
    dir: str


class MemoryConfig(TypedDict, total=False):
    """Long-term memory settings for ``memory=``.

    Attributes:
        dir: Directory of the harness's file-backed memory store. Default ``./.agent/memory``.
        stores: Memory stores to manage under the harness's memory policy instead of the file store.
    """

    dir: str
    stores: list[MemoryStore]


ContextManagerStrategy = Literal["auto", "agentic"]
"""Named context-management strategies.

Defined locally because the SDK moves this alias between modules across releases
(``strands.agent.agent`` in 1.55, ``strands._context_manager`` in 1.56); the literal
values are the stable contract.
"""

ContextManagerOption = ContextManagerStrategy | ContextManagerConfig | ContextManager | Literal[False] | None
"""What ``context_manager=`` accepts.

A strategy name (``"auto"`` or ``"agentic"``), a :class:`ContextManagerConfig` mapping
(``ContextManager(**config)``), a ready ``ContextManager`` instance, or ``False``/``None`` to
turn context management off.
"""

__all__ = [
    "BuiltinPluginName",
    "BuiltinToolName",
    "BuiltinToolsConfig",
    "ContextManagerConfig",
    "ContextManagerOption",
    "Effort",
    "MemoryConfig",
    "ProgrammaticToolCallerConfig",
    "SessionConfig",
    "ReadConfig",
    "ShellConfig",
    "SubagentConfig",
    "WebFetchConfig",
    "WebFetchTransport",
]
