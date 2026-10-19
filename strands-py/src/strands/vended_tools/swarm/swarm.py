"""Swarm meta-agent tool for spinning up a handoff-based sub-agent team at runtime.

Provides :func:`make_swarm` (a factory that lets the developer pin safety
limits and authority modes) and :data:`swarm` (a default instance). The tool is
a thin shim over :class:`~strands.multiagent.Swarm`: it resolves each agent spec
through the authority-mode system, builds agents via an :data:`AgentBuilder`,
runs the swarm, and maps the result.
"""

from __future__ import annotations

import logging
import weakref
from collections.abc import AsyncGenerator, Mapping
from typing import TYPE_CHECKING, Any

from ...interrupt import Interrupt
from ...multiagent.base import Status
from ...multiagent.spec import (
    AgentBuilder,
    Choice,
    Fixed,
    Inherit,
    Open,
    Preset,
    _default_builder,
    _resolve_specs,
    _to_schema_properties,
)
from ...multiagent.swarm import Swarm, SwarmResult
from ...tools.decorator import tool
from ...types.interrupt import InterruptResponseContent
from ...types.multiagent import MultiAgentInput
from ...types.tools import ToolContext

if TYPE_CHECKING:
    from ...tools.decorator import DecoratedFunctionTool

logger = logging.getLogger(__name__)

DEFAULT_SWARM_DESCRIPTION = (
    "Spin up a team of AI agents that solve a task together by handing off to one another. "
    "Each agent has its own name, system prompt, and tools (drawn from your own). "
    "Agents get their own handoff tool and cannot start another swarm; your other tools are passed through. "
    "The `entry_point` agent (default: the first in `agents`) receives the "
    "task and starts the work. The run ends when an agent finishes without handing off. "
    "Returns each participating agent's final output, prefixed with its name. If the team "
    "does not complete (an agent fails, or a handoff, iteration, or time limit is hit), the "
    "call fails with the partial output."
)
"""Description for the default swarm tool."""

_DEFAULT_MAX_AGENTS = 20
"""Upper bound on the number of agents a single swarm invocation may create."""

# The SDK Swarm raises ValueError if a node already has handoff_to_agent.
_EXCLUDED_TOOLS = frozenset({"handoff_to_agent"})

# Every swarm tool created, so children lose all of them regardless of name or instance.
_SWARM_TOOLS: weakref.WeakSet[DecoratedFunctionTool] = weakref.WeakSet()


def make_swarm(
    *,
    name: str = "swarm",
    description: str = DEFAULT_SWARM_DESCRIPTION,
    builder: AgentBuilder | None = None,
    presets: Mapping[str, Preset] | None = None,
    default_preset: str | None = None,
    instructions: Open | Choice | Fixed | None = None,
    tools: Choice | Fixed | Inherit | None = None,
    model: Inherit | Choice | Fixed | None = None,
    max_agents: int = _DEFAULT_MAX_AGENTS,
    max_handoffs: int | None = None,
    max_iterations: int | None = None,
    execution_timeout: float | None = None,
    node_timeout: float | None = None,
    repetitive_handoff_detection_window: int | None = None,
    repetitive_handoff_min_unique_agents: int | None = None,
) -> DecoratedFunctionTool:
    """Create a swarm tool with developer-controlled safety limits and authority modes.

    The swarm tool is a meta-agent tool: the model defines the agents it needs at runtime.
    Each agent spec from the model is resolved through the authority-mode system
    (see :mod:`~strands.multiagent.spec`), then built via ``builder``. A running swarm
    cannot be cancelled from the parent agent. Children never receive a swarm tool, so swarms
    do not nest. If no swarm limits are configured, the Swarm primitive's defaults are used.

    A child's interrupt is surfaced as an interrupt of this tool. An interrupted swarm is
    held in memory until resumed, so it cannot be resumed after a process restart.

    Args:
        name: Tool name shown to the model.
        description: Tool description shown to the model.
        builder: Callable that turns an :class:`AgentSpec` into an ``Agent``.
            When ``None`` a default builder is used that creates an ``Agent``
            inheriting the caller's model with the spec's instructions and tools.
        presets: Named roles the model can select via ``agent_type``.
        default_preset: Preset used when the model omits ``agent_type``.
        instructions: Authority mode for the instructions axis.
        tools: Authority mode for the tools axis.
        model: Authority mode for the model axis.
        max_agents: Upper bound on agents per invocation.
        max_handoffs: Maximum handoffs between agents.
        max_iterations: Maximum total agent invocations.
        execution_timeout: Total timeout in seconds.
        node_timeout: Per-agent timeout in seconds.
        repetitive_handoff_detection_window: Window size for repetition detection.
        repetitive_handoff_min_unique_agents: Minimum unique agents in window.

    Returns:
        A decorated tool that spins up and runs a :class:`~strands.multiagent.Swarm`.
    """
    if not isinstance(max_agents, int) or isinstance(max_agents, bool) or max_agents < 1:
        raise ValueError("max_agents must be a positive integer")

    presets = dict(presets or {})
    instructions = instructions if instructions is not None else Open()
    model = model if model is not None else Inherit()

    if default_preset is None and presets:
        default_preset = next(iter(presets))

    input_schema = _build_schema(
        presets=presets,
        default_preset=default_preset,
        instructions=instructions,
        tools=tools,
        model=model,
        max_agents=max_agents,
    )

    # Unset limits are omitted so the Swarm primitive's defaults apply.
    limits: dict[str, Any] = {
        "max_handoffs": max_handoffs,
        "max_iterations": max_iterations,
        "execution_timeout": execution_timeout,
        "node_timeout": node_timeout,
        "repetitive_handoff_detection_window": repetitive_handoff_detection_window,
        "repetitive_handoff_min_unique_agents": repetitive_handoff_min_unique_agents,
    }
    swarm_limits = {key: value for key, value in limits.items() if value is not None}

    # Interrupted swarms awaiting a resume, keyed by the tool-use id that started them.
    pending: dict[str, tuple[Swarm, list[Interrupt]]] = {}

    @tool(name=name, description=description, inputSchema={"json": input_schema}, context="tool_context")
    async def swarm_tool(
        task: str,
        agents: list[Mapping[str, Any]],
        tool_context: ToolContext,
        entry_point: str | None = None,
    ) -> AsyncGenerator[dict[str, Any] | str, None]:
        """Spins up a team of agents that collaborate via handoffs to solve a task.

        Args:
            task: The objective for the agent team.
            agents: Agent specifications (see :func:`make_swarm`).
            tool_context: Injected by the framework. Not user-facing.
            entry_point: Name of the agent that starts the swarm. Defaults to the first agent.
        """
        tool_use_id = tool_context.tool_use["toolUseId"]
        swarm_input: MultiAgentInput
        if tool_use_id in pending:
            sdk_swarm, interrupts = pending[tool_use_id]
            swarm_input = _interrupt_responses(tool_context, interrupts)
        else:
            build = builder or _default_builder(tool_context.agent)
            specs = _resolve_specs(
                agents,
                presets=presets,
                default_preset=default_preset,
                instructions=instructions,
                tools=tools,
                model=model,
            )
            if not 1 <= len(specs) <= max_agents:
                raise ValueError(f"Between 1 and {max_agents} agents required, got {len(specs)}")
            if entry_point is not None and entry_point not in {spec.name for spec in specs}:
                raise ValueError(f"entry_point {entry_point!r} does not match any agent name")
            child_agents = {}
            for spec in specs:
                child = build(spec)
                for tool_name, child_tool in list(child.tool_registry.registry.items()):
                    if tool_name in _EXCLUDED_TOOLS or child_tool in _SWARM_TOOLS:
                        del child.tool_registry.registry[tool_name]
                child_agents[spec.name] = child

            sdk_swarm = Swarm(
                nodes=list(child_agents.values()),
                entry_point=child_agents[entry_point] if entry_point is not None else None,
                **swarm_limits,
            )
            swarm_input = task
            logger.info("task=<%s>, agents=<%d> | starting swarm", task[:120], len(child_agents))

        async for event in _stream_swarm(sdk_swarm, swarm_input, tool_context, pending):
            yield event

    _SWARM_TOOLS.add(swarm_tool)
    return swarm_tool


# ---- Internals ----


def _interrupt_responses(tool_context: ToolContext, interrupts: list[Interrupt]) -> list[InterruptResponseContent]:
    """Map the user's answers to the swarm's interrupts, raising for the first still unanswered.

    Raising surfaces the child interrupts to the user one per resume.
    """
    return [
        {
            "interruptResponse": {
                "interruptId": interrupt.id,
                "response": tool_context.interrupt(
                    interrupt.id, reason={"name": interrupt.name, "reason": interrupt.reason}
                ),
            }
        }
        for interrupt in interrupts
    ]


async def _stream_swarm(
    sdk_swarm: Swarm,
    swarm_input: MultiAgentInput,
    tool_context: ToolContext,
    pending: dict[str, tuple[Swarm, list[Interrupt]]],
) -> AsyncGenerator[dict[str, Any] | str, None]:
    """Stream the swarm's events, ending with its output as the tool result.

    An interrupted swarm is held in ``pending`` under the tool-use id and its first interrupt is raised.

    Raises:
        InterruptException: If the swarm is interrupted.
        RuntimeError: If the stream ends without a result or the swarm does not complete.
    """
    tool_use_id = tool_context.tool_use["toolUseId"]
    # Copy so child cycles can't mutate the parent's state; drop request_state so a child's stop can't halt it.
    child_state = {k: v for k, v in tool_context.invocation_state.items() if k != "request_state"}
    result: SwarmResult | None = None
    try:
        async for event in sdk_swarm.stream_async(swarm_input, invocation_state=child_state):
            # Hold back the result event: the decorator treats the tool's last yield as its result.
            if event.get("type") == "multiagent_result":
                result = event["result"]
            else:
                yield event
    finally:
        pending.pop(tool_use_id, None)

    if result is None:
        raise RuntimeError("Swarm stream ended without producing a result")
    if result.status == Status.INTERRUPTED:
        pending[tool_use_id] = (sdk_swarm, list(result.interrupts))
        first = result.interrupts[0]
        tool_context.interrupt(first.id, reason={"name": first.name, "reason": first.reason})
    if result.status != Status.COMPLETED:
        raise RuntimeError(
            f"Swarm stopped before completing (status={result.status.value}, "
            f"{result.execution_count} iterations). Partial output:\n{result}"
        )
    yield str(result)


def _build_schema(
    *,
    presets: Mapping[str, Preset],
    default_preset: str | None,
    instructions: Open | Choice | Fixed,
    tools: Choice | Fixed | Inherit | None,
    model: Inherit | Choice | Fixed | None,
    max_agents: int,
) -> dict[str, Any]:
    """Derive the tool's input schema from the axis modes; hidden axes produce no agent property."""
    # Without a preset to fall back on, an Open prompt must come from the model.
    required = ["name", "instructions"] if isinstance(instructions, Open) and not presets else ["name"]
    axis_properties = _to_schema_properties(
        presets=presets,
        default_preset=default_preset,
        instructions=instructions,
        tools=tools,
        model=model,
    )
    return {
        "type": "object",
        "required": ["task", "agents"],
        "properties": {
            "task": {"type": "string", "description": "The objective for the agent team."},
            "entry_point": {
                "type": "string",
                "description": "Name of the agent that receives the task and starts the swarm. "
                "Defaults to the first agent.",
            },
            "agents": {
                "type": "array",
                "description": "Agent specifications.",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "A unique name for this agent."},
                        **axis_properties,
                    },
                    "required": required,
                    "additionalProperties": False,
                },
                "minItems": 1,
                "maxItems": max_agents,
            },
        },
    }


swarm = make_swarm()
"""Default swarm tool. Children inherit the caller's model."""
