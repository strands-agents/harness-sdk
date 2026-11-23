"""The harness's default ``subagent`` tool: the SDK's vended subagent with a builder that rebuilds the
child through ``create_harness``."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Any

from strands.experimental.context_manager import ContextManager
from strands.multiagent import AgentSpec, Choice, Fixed
from strands.tools.mcp import MCPClient
from strands.tools.tools import AgentTool
from strands.vended_tools.subagent import make_subagent
from strands.vended_tools.subagent.types import GENERALIST

from strands_harness import defaults
from strands_harness.memory import resolve_memory

if TYPE_CHECKING:
    from strands import Agent

_DESCRIPTION = (
    "Delegate a self-contained task to a subagent that runs in its own context and returns a "
    "final report. Reach for this when a subtask would otherwise flood your context with "
    "intermediate work and you only need its conclusion. Do not poll for progress or redo its work."
)
_CONTEXT_MODES = ["none", "all", "no_tools"]


def build_default_subagent(
    build_agent: Callable[..., Agent],
    parent_config: dict[str, Any],
    *,
    memory: bool = True,
    max_depth: int = defaults.DEFAULT_SUBAGENT_MAX_DEPTH,
) -> AgentTool:
    """The ``subagent`` tool the harness wires by default.

    The builder rebuilds the child through ``build_agent`` (``create_harness``, injected to avoid
    importing ``agent.py``) from ``parent_config`` (the parent's ``create_harness`` keyword arguments,
    ``builtin_tools`` normalized to ``{name: True | False | cfg}``). The model picks from the parent's
    built-in and named consumer tools; the child always keeps the parent's MCP clients. ``memory``
    shares the parent's store(s) read-only; ``False`` builds delegates with no memory.
    """
    parent_tools = parent_config.get("tools") or []
    # Only named tools can join the selectable set; the SDK also accepts unnamed forms (lists, dicts).
    consumer_by_name = {t.tool_name: t for t in parent_tools if hasattr(t, "tool_name")}
    mcp_clients = [t for t in parent_tools if isinstance(t, MCPClient)]
    parent_builtin: dict[str, Any] = dict(parent_config["builtin_tools"])

    def builder(spec: AgentSpec) -> Agent:
        child_config = dict(parent_config)
        if isinstance(child_config.get("context_manager"), ContextManager):
            # A ContextManager instance carries per-agent state (stash, retrieval bookkeeping), so a
            # delegate must not share the parent's. Fall back to the default strategy for children.
            child_config["context_manager"] = defaults.DEFAULT_CONTEXT_MANAGER
        if spec.instructions is not None:
            child_config["instructions"] = spec.instructions
        if spec.tools is not None:
            # A selected built-in keeps its parent config; web_search isn't selectable (the child resolves it
            # for its own model) and carries over as-is.
            child_config["builtin_tools"] = {
                name: setting if name == "web_search" or name in spec.tools else False
                for name, setting in parent_builtin.items()
            }
            consumer = [consumer_by_name[t] for t in spec.tools if t in consumer_by_name]
            child_config["tools"] = [*consumer, *mcp_clients]
        if spec.model is not None:
            child_config["model"] = spec.model
        # Recall-only manager: the delegate searches shared memory but never writes.
        parent_memory = child_config.get("memory")
        if memory and isinstance(parent_memory, Mapping):
            child_config["memory"] = resolve_memory(
                stores=parent_memory.get("stores"),
                memory_dir=parent_memory.get("dir") or defaults.DEFAULT_MEMORY_DIR,
                writable=False,
            )
        else:
            child_config["memory"] = False
        return build_agent(**child_config)

    # web_search is resolved per model, not selectable; subagent stays in, bounded by the depth guard.
    builtin_names = [name for name, setting in parent_builtin.items() if setting is not False and name != "web_search"]
    inherited = [*builtin_names, *consumer_by_name]
    return make_subagent(
        builder=builder,
        presets={"generalist": GENERALIST},
        # The tool is built even when `subagent` is off, so the selectable set can be empty.
        tools=Choice(inherited, multiple=True) if inherited else Fixed([]),
        # Offer context sharing; the generalist preset defaults to "none" (isolated).
        context=Choice(_CONTEXT_MODES),
        max_depth=max_depth,
        description=_DESCRIPTION,
    )
