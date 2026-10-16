"""Multi-Agent Specification and Resolution.

Provides the authority-mode system for model-driven multi-agent patterns, where the
model configures child agents at runtime. The developer sets axis policies that shape
the parameters the model sees and govern what values it can supply:

- ``Fixed``  — developer-pinned value; hidden from the model.
- ``Inherit`` — value taken from the parent agent; hidden from the model.
- ``Open``   — model supplies a free-form value.
- ``Choice`` — model picks from a developer-supplied set.

``_resolve_specs`` merges model-supplied arguments, preset defaults, and axis policies
into fully resolved ``AgentSpec`` objects used to build child agents.  ``Inherit`` axes resolve
to ``None`` (meaning "inherit all"); the class is a self-documenting marker.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..agent import Agent
from ..models import Model, ModelRouter
from ..tools.mcp import MCPClient
from ..tools.mcp.mcp_agent_tool import MCPAgentTool

logger = logging.getLogger(__name__)

# The builder turns a resolved spec into a child agent, built the way the parent was.
AgentBuilder = Callable[["AgentSpec"], "Agent"]

_UNSET: Any = object()
"""Sentinel for :attr:`Option.value` so ``None`` can be a legitimate value."""

_AXIS_DESCRIPTIONS = {
    "agent_type": "Role to assign this agent.",
    "instructions": "A system prompt defining this agent's role.",
    "tools": (
        "Subset of tools to grant this agent. Fewer is safer; it cannot exceed your own. "
        "Omit to grant all inherited tools."
    ),
    "mcp_servers": (
        "Subset of MCP servers whose tools to grant this agent. Fewer is safer; it cannot "
        "exceed your own. Omit to grant all of them."
    ),
    "model": "Which model this agent runs on. Omit to inherit the parent's model.",
}
"""Model-facing description of each axis property."""


@dataclass(frozen=True)
class Fixed:
    """The developer pins the value; the axis contributes no model-facing parameter."""

    value: Any = None


@dataclass(frozen=True)
class Inherit:
    """The child takes the parent's value; the axis contributes no model-facing parameter."""


@dataclass(frozen=True)
class Open:
    """The model writes the value freely; the axis contributes a string parameter."""


@dataclass(frozen=True)
class Option:
    """A selectable entry in a ``Choice``."""

    name: str
    value: Any = _UNSET
    description: str = ""


@dataclass(frozen=True)
class Choice:
    """The model picks from a developer-supplied set.

    Each entry is a bare name or an ``Option``. Set ``multiple=True`` to let the model
    pick more than one.
    """

    options: Sequence[str | Option]
    multiple: bool = False

    def normalized(self) -> list[Option]:
        """The options as ``Option``s with ``value`` resolved, wrapping any bare name."""
        result = []
        for entry in self.options:
            if isinstance(entry, Option):
                # Fill in value from name when it was left unset.
                result.append(entry if entry.value is not _UNSET else Option(entry.name, entry.name, entry.description))
            else:
                name = str(entry)
                result.append(Option(name, name))
        return result

    def value_for(self, name: str) -> Any:
        """The resolved value behind ``name``, or ``name`` itself if unknown."""
        for option in self.normalized():
            if option.name == name:
                return option.value
        return name


Axis = Fixed | Inherit | Open | Choice
"""Any authority mode an axis can take."""


@dataclass(frozen=True)
class Preset:
    """A named role: a partially applied child configuration selected via ``agent_type``."""

    instructions: str | None = None
    tools: Sequence[str] | None = None
    model: Model | ModelRouter | str | None = None
    description: str = ""


@dataclass
class AgentSpec:
    """The resolved child configuration handed to the builder."""

    name: str | None = None
    agent_type: str | None = None
    instructions: str | None = None
    tools: list[str] | None = None
    mcp_servers: list[str] | None = None
    model: Model | ModelRouter | str | None = None


def _append_presets(base: str, presets: Mapping[str, Preset]) -> str:
    """Append the preset roster to a tool description so the model knows which ``agent_type`` values exist."""
    if not presets:
        return base
    roles = "\n".join(f"- {name}: {p.description or name}" for name, p in presets.items())
    return f"{base}\n\nAvailable presets (agent_type):\n{roles}"


def _to_schema_properties(
    *,
    presets: Mapping[str, Preset],
    default_preset: str | None,
    instructions: Axis | None,
    tools: Axis | None,
    mcp_servers: Axis | None,
    model: Axis | None,
) -> dict[str, Any]:
    """Render each model-visible axis, plus an ``agent_type`` choice over ``presets``, as JSON Schema properties.

    Raises:
        ValueError: If a ``Choice`` axis has no options, or a ``tools``/``mcp_servers`` ``Choice`` is not ``multiple``.
    """
    agent_type = Choice([Option(n, description=p.description) for n, p in presets.items()]) if presets else None
    axes: dict[str, Axis | None] = {
        "agent_type": agent_type,
        "instructions": instructions,
        "tools": tools,
        "mcp_servers": mcp_servers,
        "model": model,
    }
    props: dict[str, Any] = {}
    for key, axis in axes.items():
        description = _AXIS_DESCRIPTIONS[key]
        if key == "agent_type" and default_preset is not None:
            description = f"{description} Omit to use the default ({default_preset!r})."
        if isinstance(axis, Open):
            prop: dict[str, Any] = {"type": "string"}
        elif isinstance(axis, Choice):
            options = axis.normalized()
            if not options:
                raise ValueError(
                    f"{key}=Choice([]) offers no options; use Fixed(...), or omit {key} to use its default."
                )
            if key in ("tools", "mcp_servers") and not axis.multiple:
                raise ValueError(f"{key}=Choice(...) must be multiple=True; a child agent selects a subset of {key}.")
            values = [option.name for option in options]
            lines = [f"- {option.name}: {option.description}" for option in options if option.description]
            if lines:
                description = f"{description}\nOptions:\n" + "\n".join(lines)
            prop = (
                {"type": "array", "items": {"type": "string", "enum": values}}
                if axis.multiple
                else {"type": "string", "enum": values}
            )
        else:
            continue
        prop["description"] = description
        props[key] = prop
    return props


def _resolve_scalar(
    model_value: Any,
    axis: Open | Choice | Fixed | Inherit,
    preset_value: Any = None,
) -> Any:
    """Resolve a scalar axis: model-supplied value, then preset, then axis default."""
    if model_value is not _UNSET:
        if isinstance(axis, Open):
            return model_value
        if isinstance(axis, Choice) and any(option.name == model_value for option in axis.normalized()):
            return axis.value_for(model_value)
    if preset_value is not None:
        return preset_value
    if isinstance(axis, Fixed):
        return axis.value
    return None


def _resolve_list(
    model_value: Any,
    axis: Choice | Fixed | Inherit,
    preset_values: Sequence[str] | None = None,
) -> list[str] | None:
    """Resolve a list axis: model-supplied value, then preset, then axis default, then ``None``.

    When the axis is a Choice, ignores values that are not valid options.
    """
    allowed = [option.name for option in axis.normalized()] if isinstance(axis, Choice) else None

    # Model-supplied value
    if model_value is not _UNSET and allowed is not None:
        assert isinstance(axis, Choice)
        if isinstance(model_value, str):
            requested = [model_value]
        elif isinstance(model_value, list):
            requested = model_value
        else:
            requested = []
        return [axis.value_for(tool_name) for tool_name in requested if tool_name in allowed]
    # Preset value
    if preset_values is not None:
        if allowed is not None:
            assert isinstance(axis, Choice)
            allowed_values = {axis.value_for(name) for name in allowed}
            return [tool_name for tool_name in preset_values if tool_name in allowed_values]
        return list(preset_values)
    # All choices
    if isinstance(axis, Choice) and axis.multiple and allowed is not None:
        return [axis.value_for(name) for name in allowed]
    if isinstance(axis, Fixed):
        return list(axis.value) if axis.value is not None else None
    return None


def _resolve_specs(
    model_inputs: list[Mapping[str, Any]],
    *,
    presets: Mapping[str, Preset],
    default_preset: str | None,
    instructions: Open | Choice | Fixed,
    tools: Choice | Fixed | Inherit | None = None,
    mcp_servers: Choice | Fixed | Inherit | None = None,
    model: Inherit | Choice | Fixed | None = None,
    label: str = "agent",
) -> list[AgentSpec]:
    """Combine each model-supplied agent input with the axis policies into a spec.

    Precedence per axis: a model-supplied argument wins, then the preset's value, then the axis
    default (``Fixed``/``Inherit``). An omitted ``agent_type`` falls back to the default preset, so
    a bare model input behaves like the default role.

    Args:
        model_inputs: The model-supplied arguments, one mapping per agent.
        presets: Named presets mapping ``agent_type`` strings to ``Preset`` instances.
        default_preset: The preset to apply when the model omits both ``agent_type`` and ``instructions``.
        instructions: Axis policy for the ``instructions`` field.
        tools: Axis policy for tool selection. Defaults to ``Inherit()`` when not supplied.
        mcp_servers: Axis policy for MCP server selection. Defaults to ``Inherit()`` when not supplied.
        model: Axis policy for model selection. Defaults to ``Inherit()`` when not supplied.
        label: Model-facing noun for one input in error messages, matching the tool's parameter name.

    Returns:
        The resolved ``AgentSpec`` for each input, in order.

    Raises:
        ValueError: If ``model_inputs`` is not a list, an input is not a mapping, a name is missing,
            empty, or duplicated, or an ``agent_type`` is not found in ``presets``.
    """
    if tools is None:
        tools = Inherit()
    if mcp_servers is None:
        mcp_servers = Inherit()
    if model is None:
        model = Inherit()

    if not isinstance(model_inputs, list):
        raise ValueError(f"{label}s must be a list, got {type(model_inputs).__name__}")

    seen_names: set[str] = set()
    specs: list[AgentSpec] = []
    for index, model_input in enumerate(model_inputs):
        if not isinstance(model_input, Mapping):
            raise ValueError(f"{label.capitalize()} at index {index} must be a dict, got {type(model_input).__name__}")

        name = model_input.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"{label.capitalize()} at index {index} must have a non-empty 'name' string")
        name = name.strip()
        if name in seen_names:
            raise ValueError(f"Duplicate {label} name {name!r} at index {index}")
        seen_names.add(name)

        # agent_type is a closed enum: a provided value must be an exact preset name (absent = no role).
        model_agent_type = model_input.get("agent_type")
        is_known_preset = isinstance(model_agent_type, str) and model_agent_type in presets
        if model_agent_type is not None and not is_known_preset:
            raise ValueError(f"Unknown agent_type {model_agent_type!r}; valid values: {sorted(presets)}.")
        # Ad-hoc instructions (only possible when the axis exposes one) override the default preset.
        overriding_instructions = isinstance(instructions, (Open, Choice)) and "instructions" in model_input

        if is_known_preset:
            agent_type = model_agent_type
        elif not overriding_instructions:
            agent_type = default_preset
        else:
            agent_type = None
        preset = presets.get(agent_type) if agent_type else None

        spec = AgentSpec(name=name, agent_type=agent_type)
        spec.instructions = _resolve_scalar(
            model_input.get("instructions", _UNSET), instructions, preset.instructions if preset else None
        )
        spec.tools = _resolve_list(model_input.get("tools", _UNSET), tools, preset.tools if preset else None)
        spec.mcp_servers = _resolve_list(model_input.get("mcp_servers", _UNSET), mcp_servers)
        spec.model = _resolve_scalar(model_input.get("model", _UNSET), model, preset.model if preset else None)
        specs.append(spec)

    return specs


def _default_builder(parent: Agent) -> AgentBuilder:
    """A builder that creates an Agent inheriting the parent's model, tools, and MCP servers.

    Used by the vended multi-agent tools when no custom builder is supplied.
    Resolves ``spec.tools`` against the parent's tool registry and ``spec.mcp_servers``
    against the parent's MCP clients (by ``client_name``). Memory tools are also
    inherited through the tools axis.
    """

    def build(spec: AgentSpec) -> Agent:
        parent_tools: dict[str, Any] = {}
        mcp_clients: dict[str, MCPClient] = {}
        # The child's own context manager registers its tools; skip the parent's.
        managed_tools = {id(t) for t in parent.context_manager.tools} if parent and parent.context_manager else set()
        for tool in parent.tool_registry.registry.values() if parent else []:
            if id(tool) in managed_tools:
                continue
            if isinstance(tool, MCPAgentTool):
                # MCP tools flow through mcp_servers to avoid duplicates with their client.
                if tool.mcp_client.client_name is not None:
                    mcp_clients.setdefault(tool.mcp_client.client_name, tool.mcp_client)
            else:
                # Plain tools are selected by name via spec.tools.
                parent_tools[tool.tool_name] = tool

        # tools=None means inherit all; a list means only those.
        child_tools: list[Any] = list(parent_tools.values()) if spec.tools is None else []
        if spec.tools is not None:
            for tool_name in spec.tools:
                if tool_name in parent_tools:
                    child_tools.append(parent_tools[tool_name])
                else:
                    logger.warning("subagent requested tool %r but parent does not own it; skipping", tool_name)

        # MCP servers: spec.mcp_servers=None means inherit all, a list means only those.
        selected: Mapping[str, MCPClient]
        if spec.mcp_servers is None:
            selected = mcp_clients
        else:
            selected = {}
            for name in spec.mcp_servers:
                if name in mcp_clients:
                    selected[name] = mcp_clients[name]
                else:
                    logger.warning("subagent requested MCP server %r but parent does not own it; skipping", name)
        child_tools.extend(selected.values())

        child_model = spec.model or (parent.model if parent else None)
        return Agent(
            system_prompt=spec.instructions or "",
            tools=child_tools,
            model=child_model,
            name=spec.name,
            context_manager=None if getattr(child_model, "stateful", False) else "auto",
            sandbox=parent.sandbox if parent else None,
            callback_handler=parent.callback_handler if parent else None,
            trace_attributes=parent.trace_attributes if parent else None,
        )

    return build
