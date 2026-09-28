"""Delegation tool with a config-derived model-facing schema (design 0017-subagents).

Each axis — instructions, tools, mcp_servers, model, context — takes an authority mode that decides
whether it becomes a model-facing parameter:

- ``Fixed(value)``  — pinned by the developer; no parameter.
- ``Inherit()``     — take the parent's value; no parameter.
- ``Open(...)``     — model writes freely; string parameter.
- ``Choice(...)``   — model picks from a developer-supplied set of ``Option``s by ``name``; a
  single-value enum, or an array-of-enum when ``multiple=True``. The picked name maps back to the
  option's ``value``. For ``tools`` the chosen set is re-validated at call time, so a child can
  never gain a capability the parent lacked.

Named ``presets`` add an ``agent_type`` enum. Children are built through an injected ``builder``.
"""

from __future__ import annotations

import copy
import logging
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from strands.experimental.context_manager import ContextManager
from strands.models import Model, ModelRouter
from strands.tools.mcp import MCPClient
from strands.tools.tools import AgentTool
from strands.types._events import ToolInterruptEvent, ToolResultEvent, ToolStreamEvent
from strands.types.content import ContentBlock, Message
from strands.types.tools import ToolGenerator, ToolUse

from strands_harness import defaults
from strands_harness.memory import resolve_memory

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from strands import Agent


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


_UNSET: Any = object()


@dataclass(frozen=True)
class Option:
    """One selectable option. ``name`` is what the model picks (the enum entry and the key we map
    back on); ``value`` is what that choice resolves to, defaulting to ``name`` so a string-valued
    axis needs only a name. ``description`` guides the model."""

    name: str
    value: Any = _UNSET
    description: str = ""

    def resolved(self) -> Option:
        """This option with ``value`` filled in from ``name`` when it was left unset."""
        return self if self.value is not _UNSET else Option(self.name, self.name, self.description)


@dataclass(frozen=True)
class Choice:
    """The model picks from a developer-supplied set by ``name``; the axis contributes an enum
    parameter, or an array-of-enum when ``multiple`` is set (letting the model pick several).

    Each entry in ``options`` is a bare name or an ``Option(name, value=name, description="")``. The
    picked name maps back to the option's ``value``; descriptions render into the parameter's
    ``description`` (JSON Schema has no per-enum-value doc), the same way ``Preset`` descriptions
    surface under ``agent_type``. For ``tools`` the chosen set is re-validated at call time, so a
    delegate can never exceed the parent's tools.
    """

    options: Sequence[Any]
    multiple: bool = False

    def normalized(self) -> list[Option]:
        """The options as ``Option``s with ``value`` resolved, wrapping any bare name."""
        return [(o if isinstance(o, Option) else Option(str(o))).resolved() for o in self.options]

    def value_for(self, name: str) -> Any:
        """The value the picked ``name`` resolves to; the name itself if it isn't a known option."""
        for option in self.normalized():
            if option.name == name:
                return option.value
        return name

    def has(self, name: str) -> bool:
        """Whether ``name`` is one of the offered options (used to reject off-enum model input)."""
        return any(option.name == name for option in self.normalized())


@dataclass(frozen=True)
class Preset:
    """A named role: a partially applied child configuration selected via ``agent_type``."""

    instructions: str | None = None
    tools: Sequence[str] | None = None  # None inherits the parent's tools
    model: Model | ModelRouter | str | None = None  # None inherits the parent's model
    context: str = "none"  # "none" | "all" | "no_tools"
    last_messages: int | None = None  # cap shared context to the last N messages; None = all
    description: str = ""


GENERALIST = Preset(
    instructions=(
        "You are a general-purpose subagent handling a focused subtask on behalf of a parent "
        "agent. You run in your own fresh conversation and cannot ask follow-up questions, so "
        "work from the task as given, make reasonable assumptions where it is underspecified, "
        "and see it through to a verified result. Return a self-contained answer: state what you "
        "did, what you found, and anything the parent needs to act on. Your final message is the "
        "only thing that returns to the parent, so put the substance there rather than in "
        "intermediate steps."
    ),
    description="a general-purpose agent for a focused subtask that runs in its own context",
)


@dataclass
class AgentSpec:
    """The resolved child configuration handed to the builder: config + the model's arguments."""

    task: str
    agent_type: str | None = None
    instructions: str | None = None
    tools: list[str] | None = None  # None inherits the parent's tools
    mcp_servers: list[str] | None = None  # None inherits all the parent's MCP servers
    model: Model | ModelRouter | str | None = None  # None inherits the parent's model
    context: str = "none"  # "none" | "all" | "no_tools"
    last_messages: int | None = None  # cap shared context to the last N messages; None = all


# The builder turns a resolved spec into a child agent, built the way the parent was.
AgentBuilder = Callable[["AgentSpec"], "Agent"]


def _allowed_names(axis: Any) -> list[str] | None:
    """The option names the model may request on a ``Choice`` axis (tools, mcp_servers), or ``None``
    when the axis exposes no such parameter."""
    if isinstance(axis, Choice):
        return [o.name for o in axis.normalized()]
    return None


def _description(base: str, presets: Mapping[str, Preset]) -> str:
    if not presets:
        return base
    roles = "\n".join(f"- {name}: {p.description or name}" for name, p in presets.items())
    return f"{base}\n\nAvailable subagents (agent_type):\n{roles}"


def _choice_prop(choice: Choice, base: str = "") -> dict[str, Any]:
    """A ``string`` enum prop (an array-of-enum when ``choice.multiple``); per-option descriptions
    render into the prop's ``description`` so each value guides the model (JSON Schema has no
    per-enum-value doc)."""
    options = choice.normalized()
    values = [o.name for o in options]
    lines = [f"- {o.name}: {o.description}" for o in options if o.description]
    desc = base
    if lines:
        block = "Options:\n" + "\n".join(lines)
        desc = f"{base}\n{block}" if base else block
    prop: dict[str, Any] = (
        {"type": "array", "items": {"type": "string", "enum": values}}
        if choice.multiple
        else {"type": "string", "enum": values}
    )
    if desc:
        prop["description"] = desc
    return prop


def _build_schema(
    *,
    presets: Mapping[str, Preset],
    instructions: Any,
    tools: Any,
    mcp_servers: Any,
    model: Any,
    context: Any,
) -> dict[str, Any]:
    """Derive the input schema from the axis modes: each axis adds zero or one parameter."""
    props: dict[str, Any] = {
        "task": {
            "type": "string",
            "description": "The self-contained task, including all context the subagent needs. It "
            "starts from a blank conversation and cannot ask follow-up questions.",
        }
    }
    required = ["task"]

    if presets:
        props["agent_type"] = {
            "type": "string",
            "enum": list(presets),
            "description": "Which subagent role to use. Omit to use the default.",
        }

    if isinstance(instructions, Open):
        props["instructions"] = {"type": "string", "description": "A system prompt defining the subagent's role."}
    elif isinstance(instructions, Choice):
        props["instructions"] = _choice_prop(instructions, "A system prompt defining the subagent's role.")

    if isinstance(tools, Choice):
        props["tools"] = _choice_prop(
            tools, "Subset of tools to grant the subagent. Fewer is safer; it cannot exceed your own."
        )

    if isinstance(mcp_servers, Choice):
        props["mcp_servers"] = _choice_prop(
            mcp_servers,
            "Subset of MCP servers whose tools to grant the subagent. Fewer is safer; it cannot "
            "exceed your own. Omit to grant all of them.",
        )

    if isinstance(model, Choice):
        props["model"] = _choice_prop(model, "Which model the subagent runs on.")

    if isinstance(context, Choice):
        props["context"] = _choice_prop(
            context,
            "How much of this conversation the subagent sees: 'none' (fresh start), 'all' (full "
            "history including tool calls and their results — can be large), 'no_tools' (text turns "
            "only — tool calls and their results removed). More context costs more tokens.",
        )
        if any(str(o.value) != "none" for o in context.normalized()):
            props["last_messages"] = {
                "type": "integer",
                "description": "Optional: limit the shared context to the last N messages. Omit to "
                "share all of the selected context.",
            }

    return {"type": "object", "properties": props, "required": required}


def _resolve_spec(
    raw: Mapping[str, Any],
    *,
    presets: Mapping[str, Preset],
    default_preset: str | None,
    instructions: Any,
    tools: Any,
    mcp_servers: Any,
    model: Any,
    context: Any,
    allowed_tools: Sequence[str] | None,
    allowed_mcp: Sequence[str] | None,
) -> AgentSpec:
    """Combine the model's arguments, the selected preset, and the fixed axes into a spec.

    Precedence per axis: a model-supplied argument wins, then the preset's value, then the axis
    default (``Fixed``/``Inherit``). An omitted ``agent_type`` falls back to the default preset, so
    a bare ``subagent(task=...)`` behaves like the default role.
    """
    task = str(raw["task"])
    # agent_type is a closed enum: a provided value must be an exact preset name (absent = no role).
    raw_agent_type = raw.get("agent_type")
    if raw_agent_type is not None and raw_agent_type not in presets:
        raise ValueError(f"Unknown agent_type {raw_agent_type!r}; valid values: {sorted(presets)}.")
    # Ad-hoc instructions (only possible when the axis exposes one) override the default preset.
    overriding_instructions = isinstance(instructions, (Open, Choice)) and "instructions" in raw
    agent_type = raw_agent_type or (None if overriding_instructions else default_preset)
    preset = presets.get(agent_type) if agent_type else None

    spec = AgentSpec(task=task, agent_type=agent_type)

    # instructions — honored only when the axis exposes one (Open, or a Choice offering the name).
    if "instructions" in raw and isinstance(instructions, Open):
        spec.instructions = str(raw["instructions"])
    elif "instructions" in raw and isinstance(instructions, Choice) and instructions.has(str(raw["instructions"])):
        spec.instructions = str(instructions.value_for(str(raw["instructions"])))
    elif preset is not None:
        spec.instructions = preset.instructions
    elif isinstance(instructions, Fixed):
        spec.instructions = instructions.value

    # tools — model picks option names; each maps to its value (the real tool name granted), clamped.
    if "tools" in raw and allowed_tools is not None:
        raw_tools = raw["tools"]
        requested = [raw_tools] if isinstance(raw_tools, str) else raw_tools if isinstance(raw_tools, list) else []
        spec.tools = [tools.value_for(t) for t in requested if t in allowed_tools]
    elif preset is not None and preset.tools is not None:
        if allowed_tools is not None:
            allowed_values = {tools.value_for(n) for n in allowed_tools}
            spec.tools = [t for t in preset.tools if t in allowed_values]
        else:
            spec.tools = list(preset.tools)
    elif isinstance(tools, Choice) and tools.multiple and allowed_tools is not None:
        spec.tools = [tools.value_for(n) for n in allowed_tools]
    elif isinstance(tools, Fixed):
        spec.tools = list(tools.value) if tools.value is not None else None

    # mcp_servers — model picks server names, clamped to the parent's set; omitted inherits all.
    if "mcp_servers" in raw and allowed_mcp is not None:
        raw_mcp = raw["mcp_servers"]
        requested = [raw_mcp] if isinstance(raw_mcp, str) else raw_mcp if isinstance(raw_mcp, list) else []
        spec.mcp_servers = [mcp_servers.value_for(n) for n in requested if n in allowed_mcp]
    elif isinstance(mcp_servers, Choice) and mcp_servers.multiple and allowed_mcp is not None:
        spec.mcp_servers = [mcp_servers.value_for(n) for n in allowed_mcp]
    elif isinstance(mcp_servers, Fixed):
        spec.mcp_servers = list(mcp_servers.value) if mcp_servers.value is not None else None

    # model — the picked name maps back to its value; an off-enum name is ignored.
    if "model" in raw and isinstance(model, Choice) and model.has(str(raw["model"])):
        spec.model = model.value_for(str(raw["model"]))
    elif preset is not None and preset.model is not None:
        spec.model = preset.model
    elif isinstance(model, Fixed):
        spec.model = model.value

    # context — honored only when the Choice offers the name; off-enum can't flip a Fixed("none") delegate.
    if "context" in raw and isinstance(context, Choice) and context.has(str(raw["context"])):
        spec.context = str(context.value_for(str(raw["context"])))
    elif preset is not None:
        spec.context = preset.context
        spec.last_messages = preset.last_messages
    elif isinstance(context, Fixed) and context.value is not None:
        spec.context = str(context.value)

    # last_messages — model-supplied cap wins when the axis exposes it.
    if "last_messages" in raw and raw["last_messages"] is not None:
        try:
            spec.last_messages = int(raw["last_messages"])
        except (TypeError, ValueError):
            spec.last_messages = None

    return spec


_CONTEXT_MODES = ("none", "all", "no_tools")


def _is_valid_trim_point(messages: list[Message], index: int) -> bool:
    """Whether the SDK's conversation managers would cut the history at ``index`` — a user message that
    is not a tool result and not a tool use without its result right after. Mirrors the SDK's
    ``find_valid_trim_point(messages, index) == index``, duplicated here until the SDK exports it."""
    message = messages[index]
    if message["role"] != "user" or any("toolResult" in b for b in message["content"]):
        return False
    if any("toolUse" in b for b in message["content"]):
        return index + 1 < len(messages) and any("toolResult" in b for b in messages[index + 1]["content"])
    return True


def _fork_messages(parent: Agent | None, last_n: int | None) -> list[Message]:
    """The parent's messages for ``"all"`` mode — real content blocks (tool calls, results, images),
    not a text rendering. Tool calls still in flight — the delegating call itself and any parallel
    siblings, which nothing has answered yet — are dropped so the history stays valid, and so are
    ``reasoningContent`` blocks: they are the parent model's own signed state, and other models
    reject them (Bedrock: "User messages cannot contain reasoning content"). ``last_n``
    is widened back to the nearest boundary the SDK's own conversation managers would cut at
    (``_is_valid_trim_point``), so no result is split from its call. Size is not this function's
    job: the child's context manager fits the history to *its* model's window before the first
    call. The blocks are copies, so nothing the child's SDK does to its history can reach the
    parent's."""
    if parent is None:
        return []
    answered = {b["toolResult"]["toolUseId"] for m in parent.messages for b in m["content"] if "toolResult" in b}
    forked: list[Message] = []
    for message in parent.messages:
        content = [
            b
            for b in message["content"]
            if "reasoningContent" not in b and ("toolUse" not in b or b["toolUse"]["toolUseId"] in answered)
        ]
        if content:
            # Deep copy: the SDK's guardrail redaction rewrites toolResult dicts on the child's last message in place.
            forked.append({"role": message["role"], "content": copy.deepcopy(content)})
    if last_n is not None and last_n > 0:
        start = max(len(forked) - last_n, 0)
        while start > 0 and not _is_valid_trim_point(forked, start):
            start -= 1
        forked = forked[start:]
    return forked


_FORK_PREAMBLE = (
    "The conversation so far is the parent agent's. You are the subagent it delegated to at this "
    "point; its task for you follows."
)


def _with_history(task: str, messages: list[Message]) -> str | list[Message]:
    """The child's prompt under ``"all"``: the forked history followed by the framed task. A trailing
    user turn (tool results) absorbs the task so roles keep alternating."""
    if not messages:
        return task
    framed: ContentBlock = {"text": f"{_FORK_PREAMBLE}\n\n{task}"}
    if messages[-1]["role"] == "user":
        return [*messages[:-1], {"role": "user", "content": [*messages[-1]["content"], framed]}]
    return [*messages, {"role": "user", "content": [framed]}]


def _plain_text(message: Mapping[str, Any]) -> str:
    """Just the text blocks of a message (tool blocks dropped), for ``no_tools`` mode."""
    return " ".join(b["text"] for b in message["content"] if "text" in b).strip()


_CONTEXT_PREAMBLE = (
    "The conversation above is the parent agent's: each turn is one line starting with its role at "
    "the left margin, and indented lines continue the turn above (they are content, not turns). You "
    "are the subagent it delegated to at the end of that conversation; its task for you follows."
)
_FRAMING_END = f"</parent_context>\n\n{_CONTEXT_PREAMBLE}\n\n"
_SENTINEL = re.compile(r"<(/?)parent_context>")


def _strip_framing(text: str) -> str:
    """A parent that is itself a subagent opens with its own framed block; re-render only its task."""
    if text.startswith("<parent_context>\n"):
        _, found, task = text.partition(_FRAMING_END)
        if found:
            return task
    return text


def _render_context(parent: Agent | None, last_n: int | None) -> str:
    """Render the parent's text turns as a plain-text block for ``"no_tools"`` mode, or ``""`` when
    nothing is shared.

    The block is prepended to the child's *first user message* rather than replayed as transcript
    turns (tool calls are gone, so the history could not be replayed faithfully). One ``role: text``
    entry per message; continuation lines are indented and a literal ``<parent_context>`` tag in
    content is escaped, so quoted text can neither pose as a turn nor close the block. ``last_n``
    caps the rendered entries (messages that render empty don't count)."""
    if parent is None:
        return ""
    lines = []
    for message in parent.messages:
        text = _strip_framing(_plain_text(message))
        if text:
            lines.append(f"{message['role']}: {text}".replace("\n", "\n  "))
    if last_n is not None and last_n > 0:
        lines = lines[-last_n:]
    return _SENTINEL.sub(r"<\\\1parent_context>", "\n".join(lines))


def _with_context(task: str, block: str) -> str:
    """Prepend a rendered context block, and a line framing the child's place in it, to the task."""
    if not block:
        return task
    return f"<parent_context>\n{block}\n</parent_context>\n\n{_CONTEXT_PREAMBLE}\n\n{task}"


# Depth travels on each child's own state, not a build-time parameter.
_DEPTH_STATE_KEY = "subagent_depth"


class _SubagentTool(AgentTool):
    """Streams a fresh per-call child and propagates its interrupts to the parent for resume."""

    def __init__(
        self,
        name: str,
        tool_spec: dict[str, Any],
        resolve: Callable[[Mapping[str, Any]], AgentSpec],
        builder: AgentBuilder,
        max_depth: int,
    ) -> None:
        super().__init__()
        self._name = name
        self._spec = tool_spec
        self._resolve = resolve
        self._builder = builder
        self._max_depth = max_depth
        # Children awaiting a resume, keyed by the tool-use id that interrupted.
        self._pending: dict[str, Agent] = {}

    @property
    def tool_name(self) -> str:
        return self._name

    @property
    def tool_spec(self) -> Any:
        return self._spec

    @property
    def tool_type(self) -> str:
        return "agent"

    async def stream(self, tool_use: ToolUse, invocation_state: dict[str, Any], **kwargs: Any) -> ToolGenerator:
        tool_use_id = tool_use["toolUseId"]
        raw = tool_use.get("input", {}) or {}
        parent = invocation_state.get("agent")

        # resolve/build/render can raise; surface it as an error tool result, not an uncaught exception.
        try:
            child = self._pending.get(tool_use_id)
            if child is not None and child._interrupt_state.activated:
                # Resume: the parent set responses on the shared interrupt objects the child still holds.
                prompt: Any = [
                    {"interruptResponse": {"interruptId": interrupt.id, "response": interrupt.response}}
                    for interrupt in child._interrupt_state.interrupts.values()
                    if interrupt.response is not None
                ]
            else:
                stored_depth = None if parent is None else parent.state.get(_DEPTH_STATE_KEY)
                depth = self._max_depth if stored_depth is None else stored_depth
                if depth <= 0:
                    yield ToolResultEvent(
                        {
                            "toolUseId": tool_use_id,
                            "status": "error",
                            "content": [
                                {
                                    "text": f"Delegation depth limit reached ({self._max_depth} levels); you "
                                    "cannot delegate further. Complete this task yourself instead of calling "
                                    "subagent again."
                                }
                            ],
                        }
                    )
                    return
                spec = self._resolve(raw)
                child = self._builder(spec)
                child.state.set(_DEPTH_STATE_KEY, depth - 1)
                if spec.context == "all":
                    prompt = _with_history(spec.task, _fork_messages(parent, spec.last_messages))
                elif spec.context == "no_tools":
                    prompt = _with_context(spec.task, _render_context(parent, spec.last_messages))
                else:
                    prompt = spec.task

            # Cancelling the parent's tool call cancels the delegation too (mirrors the SDK's _AgentAsTool).
            cancel_signal = getattr(parent, "cancel_signal", None)
            # Shallow copy: the SDK rewrites invocation_state["agent"] per cycle; a shared dict would bleed agent=child.
            child_state = {**invocation_state} if isinstance(invocation_state, dict) else invocation_state
            result = None
            async for event in child.stream_async(prompt, invocation_state=child_state, cancel_signal=cancel_signal):
                if "result" in event:
                    result = event["result"]
                else:
                    yield ToolStreamEvent(tool_use, event)
            if result is None:
                self._pending.pop(tool_use_id, None)
                yield ToolResultEvent(
                    {"toolUseId": tool_use_id, "status": "error", "content": [{"text": "Subagent produced no result."}]}
                )
                return
            if result.stop_reason == "interrupt" and result.interrupts:
                self._pending[tool_use_id] = child
                yield ToolInterruptEvent(tool_use, list(result.interrupts))
                return
            if result.stop_reason == "cancelled":
                # Cancellation is data, not an exception: surface it as an error result, not a success.
                self._pending.pop(tool_use_id, None)
                yield ToolResultEvent(
                    {"toolUseId": tool_use_id, "status": "error", "content": [{"text": "Subagent was cancelled."}]}
                )
                return
            self._pending.pop(tool_use_id, None)
            yield ToolResultEvent({"toolUseId": tool_use_id, "status": "success", "content": [{"text": str(result)}]})
        except Exception as exc:
            self._pending.pop(tool_use_id, None)
            yield ToolResultEvent(
                {"toolUseId": tool_use_id, "status": "error", "content": [{"text": f"Subagent error: {exc}"}]}
            )


def make_subagent(
    *,
    builder: AgentBuilder,
    presets: Mapping[str, Preset] | None = None,
    default_preset: str | None = None,
    instructions: Open | Choice | Fixed = None,  # type: ignore[assignment]
    tools: Choice | Fixed | Inherit = None,  # type: ignore[assignment]
    mcp_servers: Choice | Fixed | Inherit = None,  # type: ignore[assignment]
    model: Inherit | Choice | Fixed = None,  # type: ignore[assignment]
    context: Fixed | Choice = None,  # type: ignore[assignment]
    inherited_tools: Sequence[str] = (),
    inherited_mcp_servers: Sequence[str] = (),
    max_depth: int = defaults.DEFAULT_SUBAGENT_MAX_DEPTH,
    name: str = "subagent",
) -> AgentTool:
    """Build a ``subagent`` tool whose schema follows the axis modes and preset map.

    ``max_depth`` bounds delegation depth: each child's remaining budget is stored on its own
    ``agent.state`` right after it's built (not passed to ``builder``), read back the next time this
    tool is called on that child, and decremented again. At 0 the tool refuses with an error result
    rather than building another child, so recursion is bounded without threading depth through the
    builder's construction path.
    """
    presets = dict(presets or {})
    instructions = instructions if instructions is not None else Open()
    model = model if model is not None else Inherit()
    context = context if context is not None else Fixed("none")
    if default_preset is None and presets:
        default_preset = next(iter(presets))

    # Default the tools axis to a multiple Choice over the inherited tools; a tools Choice must be multiple.
    if tools is None:
        tools = Choice(list(inherited_tools), multiple=True)
    elif isinstance(tools, Choice):
        if not tools.options:
            raise ValueError("tools=Choice([]) offers no options; use Fixed([]) for a toolless child, or Inherit().")
        if not tools.multiple:
            raise ValueError("tools=Choice(...) must be multiple=True; a subagent selects a subset of tools.")

    # mcp_servers mirrors tools: a multiple Choice over the parent's servers, or no parameter (Inherit)
    # when the parent has none.
    if mcp_servers is None:
        mcp_servers = Choice(list(inherited_mcp_servers), multiple=True) if inherited_mcp_servers else Inherit()
    elif isinstance(mcp_servers, Choice):
        if not mcp_servers.options:
            raise ValueError("mcp_servers=Choice([]) offers no options; use Fixed([]) for no servers, or Inherit().")
        if not mcp_servers.multiple:
            raise ValueError("mcp_servers=Choice(...) must be multiple=True; a subagent selects a subset of servers.")

    allowed_tools = _allowed_names(tools)
    allowed_mcp = _allowed_names(mcp_servers)
    schema = _build_schema(
        presets=presets,
        instructions=instructions,
        tools=tools,
        mcp_servers=mcp_servers,
        model=model,
        context=context,
    )
    base_description = (
        "Delegate a self-contained task to a subagent that runs in its own context and returns a "
        "final report. Reach for this when a subtask would otherwise flood your context with "
        "intermediate work and you only need its conclusion. Do not poll for progress or redo its work."
    )
    tool_spec = {
        "name": name,
        "description": _description(base_description, presets),
        "inputSchema": {"json": schema},
    }

    def resolve(raw: Mapping[str, Any]) -> AgentSpec:
        return _resolve_spec(
            raw,
            presets=presets,
            default_preset=default_preset,
            instructions=instructions,
            tools=tools,
            mcp_servers=mcp_servers,
            model=model,
            context=context,
            allowed_tools=allowed_tools,
            allowed_mcp=allowed_mcp,
        )

    return _SubagentTool(name, tool_spec, resolve, builder, max_depth)


def _mcp_clients_by_name(tools: Sequence[Any]) -> dict[str, MCPClient]:
    """Key the parent's ``MCPClient`` entries by ``client_name`` for the ``mcp_servers`` axis. The model
    picks servers by name, so a client without one can't be offered and is left out of delegation; when
    two share a name the first keeps it and the rest are dropped. Both are warned about."""
    clients: dict[str, MCPClient] = {}
    for client in tools:
        if not isinstance(client, MCPClient):
            continue
        name = client.client_name
        if name is None:
            logger.warning(
                "An MCPClient in `tools` has no application_name; it can't be offered to subagents on "
                "`mcp_servers`, so delegates won't get its tools. Set application_name to name it."
            )
        elif name in clients:
            logger.warning(
                "Two MCPClients in `tools` share the name %r; only the first is offered to subagents on `mcp_servers`.",
                name,
            )
        else:
            clients[name] = client
    return clients


def build_default_subagent(
    build_agent: Callable[..., Agent],
    parent_config: dict[str, Any],
    *,
    memory: bool = True,
    max_depth: int = defaults.DEFAULT_SUBAGENT_MAX_DEPTH,
) -> AgentTool:
    """The ``subagent`` tool the harness wires by default: the ``generalist`` preset and a builder that
    rebuilds the child through ``build_agent`` (the ``create_harness`` factory, injected to avoid
    importing ``agent.py``) with the resolved spec applied.

    Consumer ``tools`` join the selectable set (same objects, same inherited ``interventions``); the
    builder splits a selection back into ``builtin_tools`` (names) and ``tools`` (objects). The parent's
    live MCP clients are the ``MCPClient`` entries in its ``tools`` (named by ``client_name``); the selected
    ones stay in the child's ``tools`` (shared, not reconnected: a started client hands out its cached
    tools) so the delegate keeps the parent's MCP tools, narrowable per server through the ``mcp_servers``
    axis (omitted grants all). The clients are tool providers with no fixed tool name at schema-build
    time, so the axis selects whole servers, not individual MCP tools.

    ``parent_config`` holds the parent's ``create_harness`` keyword arguments, with ``builtin_tools``
    already normalized to ``{name: True | False | cfg}`` (never a list or ``"*"``) and ``memory`` as
    ``False`` or a ``MemoryConfig`` (a parent ``MemoryManager`` instance is not forwarded).

    ``memory`` (default ``True``) shares the parent's store(s) with the delegate read-only; ``False``
    builds delegates with no memory. ``max_depth`` is ``make_subagent``'s delegation-depth bound.
    """
    # Only named tools can join the selectable set; the SDK also accepts unnamed forms (lists, dicts).
    consumer_by_name = {t.tool_name: t for t in (parent_config.get("tools") or []) if hasattr(t, "tool_name")}
    mcp_clients_by_name = _mcp_clients_by_name(parent_config.get("tools") or [])
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
            # spec.tools is already clamped to the allowed set; split it back into the two channels. A
            # selected built-in keeps its parent config; web_search isn't selectable (the child resolves it for
            # its own model) and carries over as-is.
            child_config["builtin_tools"] = {
                name: setting if name == "web_search" or name in spec.tools else False
                for name, setting in parent_builtin.items()
            }
            child_config["tools"] = [consumer_by_name[t] for t in spec.tools if t in consumer_by_name]
        if spec.model is not None:
            child_config["model"] = spec.model
        # The clamped selection (or all servers, unnarrowed) replaces any parent clients in `tools`, so
        # the child re-offers exactly these on its own mcp_servers axis and can pass them to a grandchild.
        selected_names = mcp_clients_by_name if spec.mcp_servers is None else spec.mcp_servers
        selected = [mcp_clients_by_name[n] for n in dict.fromkeys(selected_names) if n in mcp_clients_by_name]
        child_tools = [t for t in child_config.get("tools") or [] if not isinstance(t, MCPClient)]
        child_config["tools"] = [*child_tools, *selected]
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
    inherited_tools = [*builtin_names, *consumer_by_name]
    return make_subagent(
        builder=builder,
        presets={"generalist": GENERALIST},
        inherited_tools=inherited_tools,
        inherited_mcp_servers=list(mcp_clients_by_name),
        max_depth=max_depth,
        # Offer context sharing; the generalist preset defaults to "none" (isolated).
        context=Choice(list(_CONTEXT_MODES)),
    )
