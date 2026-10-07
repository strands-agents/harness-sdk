"""Multi-Agent Specification and Resolution.

Provides the authority-mode system for model-driven multi-agent patterns, where the
model configures child agents at runtime. The developer sets axis policies that shape
the parameters the model sees and govern what values it can supply:

- ``Fixed``  — developer-pinned value; hidden from the model.
- ``Inherit`` — value taken from the parent agent; hidden from the model.
- ``Open``   — model supplies a free-form value.
- ``Choice`` — model picks from a developer-supplied set.

``_resolve_spec`` merges model-supplied arguments, preset defaults, and axis policies
into a fully resolved ``AgentSpec`` used to build child agents.  ``Inherit`` axes resolve
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

    def to_schema_property(self, description: str = "") -> dict[str, Any]:
        """Render this axis as a JSON Schema property for a tool's ``inputSchema``.

        Produces a ``string`` enum (or ``array`` of enum when ``multiple``), with per-option
        descriptions folded into the property's ``description``.
        """
        options = self.normalized()
        values = [option.name for option in options]
        lines = [f"- {option.name}: {option.description}" for option in options if option.description]
        desc = description
        if lines:
            block = "Options:\n" + "\n".join(lines)
            desc = f"{description}\n{block}" if description else block
        prop: dict[str, Any] = (
            {"type": "array", "items": {"type": "string", "enum": values}}
            if self.multiple
            else {"type": "string", "enum": values}
        )
        if desc:
            prop["description"] = desc
        return prop

    def value_for(self, name: str) -> Any:
        """The resolved value behind ``name``, or ``name`` itself if unknown."""
        for option in self.normalized():
            if option.name == name:
                return option.value
        return name


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


def _resolve_spec(
    model_input: Mapping[str, Any],
    *,
    presets: Mapping[str, Preset],
    default_preset: str | None,
    instructions: Open | Choice | Fixed,
    tools: Choice | Fixed | Inherit | None = None,
    mcp_servers: Choice | Fixed | Inherit | None = None,
    model: Inherit | Choice | Fixed | None = None,
) -> AgentSpec:
    """Combine the model's arguments, the selected preset, and the fixed axes into a spec.

    Precedence per axis: a model-supplied argument wins, then the preset's value, then the axis
    default (``Fixed``/``Inherit``). An omitted ``agent_type`` falls back to the default preset, so
    a bare model input behaves like the default role.

    Args:
        model_input: The model-supplied arguments.
        presets: Named presets mapping ``agent_type`` strings to ``Preset`` instances.
        default_preset: The preset to apply when the model omits ``agent_type``.
        instructions: Axis policy for the ``instructions`` field.
        tools: Axis policy for tool selection. Defaults to ``Inherit()`` when not supplied.
        mcp_servers: Axis policy for MCP server selection. Defaults to ``Inherit()`` when not supplied.
        model: Axis policy for model selection. Defaults to ``Inherit()`` when not supplied.

    Returns:
        The resolved ``AgentSpec`` (the child's configuration).

    Raises:
        ValueError: If ``agent_type`` is provided but not found in ``presets``.
    """
    if tools is None:
        tools = Inherit()
    if mcp_servers is None:
        mcp_servers = Inherit()
    if model is None:
        model = Inherit()
    name = model_input.get("name")

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

    # Combine the model inputs, axis policies, and presets into an agent spec
    spec = AgentSpec(name=str(name) if name is not None else None, agent_type=agent_type)
    spec.instructions = _resolve_scalar(
        model_input.get("instructions", _UNSET), instructions, preset.instructions if preset else None
    )
    spec.tools = _resolve_list(model_input.get("tools", _UNSET), tools, preset.tools if preset else None)
    spec.mcp_servers = _resolve_list(model_input.get("mcp_servers", _UNSET), mcp_servers)
    spec.model = _resolve_scalar(model_input.get("model", _UNSET), model, preset.model if preset else None)

    return spec


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
        for tool in parent.tool_registry.registry.values() if parent else []:
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
