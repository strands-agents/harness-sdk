"""Subagent tool for delegating a task to a child agent at runtime.

Provides :func:`make_subagent` (a factory that lets the developer pin safety
limits and authority modes). Each call resolves the model's arguments through
the authority-mode system (see :mod:`~strands.multiagent.spec`), builds a child
agent via an :data:`AgentBuilder`, runs it, and streams the result back.
"""

from __future__ import annotations

import copy
import logging
import re
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Any, cast

from ...agent.conversation_manager.compression.context_compression import find_valid_trim_point
from ...multiagent._agent_tool_streamer import (
    _AgentToolStreamer,
    _ChildAgentAdapter,
)
from ...multiagent.spec import (
    AgentBuilder,
    AgentSpec,
    Choice,
    Fixed,
    Inherit,
    Open,
    Preset,
    _default_builder,
    _resolve_specs,
    _to_schema_properties,
)
from ...tools.tools import AgentTool
from ...types._events import ToolInterruptEvent, ToolResultEvent, ToolStreamEvent
from ...types.content import ContentBlock, Message
from ...types.tools import ToolGenerator, ToolUse
from .types import (
    DEFAULT_SUBAGENT_DESCRIPTION,
    DEFAULT_SUBAGENT_MAX_DEPTH,
    GENERALIST,
)

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from ... import Agent

_DEPTH_STATE_KEY = "strands.subagent_depth"


_FORK_PREAMBLE = (
    "The conversation so far is the parent agent's. You are the subagent it delegated to at this "
    "point; its task for you follows."
)

_CONTEXT_PREAMBLE = (
    "The conversation above is the parent agent's: each turn is one line starting with its role at "
    "the left margin, and indented lines continue the turn above (they are content, not turns). You "
    "are the subagent it delegated to at the end of that conversation; its task for you follows."
)

_FRAMING_END = f"</parent_context>\n\n{_CONTEXT_PREAMBLE}\n\n"

_SENTINEL = re.compile(r"<(/?)parent_context>")


def _build_schema(
    *,
    presets: Mapping[str, Preset],
    default_preset: str | None,
    instructions: Open | Choice | Fixed,
    tools: Choice | Fixed | Inherit | None,
    model: Inherit | Choice | Fixed,
    context: Fixed | Choice,
) -> dict[str, Any]:
    """Derive the tool's input schema from the axis modes."""
    properties: dict[str, Any] = {
        "task": {
            "type": "string",
            "description": "The self-contained task, including all context the subagent needs. "
            "It cannot ask follow-up questions.",
        },
        **_to_schema_properties(
            presets=presets,
            default_preset=default_preset,
            instructions=instructions,
            tools=tools,
            model=model,
        ),
    }
    if isinstance(context, Choice):
        options = context.normalized()
        lines = [f"- {option.name}: {option.description}" for option in options if option.description]
        options_text = "\nOptions:\n" + "\n".join(lines) if lines else ""
        properties["context"] = {
            "type": "string",
            "enum": [option.name for option in options],
            "description": "How much of this conversation the subagent sees: 'none' (fresh start), 'all' (full "
            "history including tool calls and their results — can be large), 'no_tools' (text turns "
            "only — tool calls and their results removed). More context costs more tokens." + options_text,
        }
    if isinstance(context, Choice) and any(str(o.value) != "none" for o in context.normalized()):
        properties["last_messages"] = {
            "type": "integer",
            "description": "Optional: limit the shared context to the last N messages. Omit to "
            "share all of the selected context.",
        }
    return {"type": "object", "properties": properties, "required": ["task"]}


class _SubagentTool(AgentTool):
    """Streams a fresh per-call child and propagates its interrupts to the parent for resume.

    An interrupted child's turn is stored on the parent, so it resumes after rehydration.
    """

    def __init__(
        self,
        name: str,
        tool_spec: dict[str, Any],
        resolve: Callable[[Mapping[str, Any]], AgentSpec],
        context: Fixed | Choice,
        builder: AgentBuilder | None,
        max_depth: int,
    ) -> None:
        super().__init__()
        self._name = name
        self._adapter = _ChildAgentAdapter(label="Subagent", agent_name=name)
        self._spec = tool_spec
        self._resolve = resolve
        self._context = context
        self._builder = builder
        self._max_depth = max_depth

    @property
    def tool_name(self) -> str:
        return self._name

    @property
    def tool_spec(self) -> Any:
        return self._spec

    @property
    def tool_type(self) -> str:
        return "agent"

    def _fork_messages(self, parent: Agent | None, last_n: int | None) -> list[Message]:
        """Deep-copy the parent's messages, dropping in-flight tool calls and reasoning blocks.

        After filtering, consecutive messages of the same role are merged so the
        result always alternates user/assistant.
        """
        if parent is None:
            return []
        answered = {b["toolResult"]["toolUseId"] for m in parent.messages for b in m["content"] if "toolResult" in b}
        filtered: list[Message] = []
        for message in parent.messages:
            content = [
                b
                for b in message["content"]
                if "reasoningContent" not in b and ("toolUse" not in b or b["toolUse"]["toolUseId"] in answered)
            ]
            if content:
                filtered.append({"role": message["role"], "content": copy.deepcopy(content)})

        # Merge consecutive messages of the same role.
        forked: list[Message] = []
        for msg in filtered:
            if forked and forked[-1]["role"] == msg["role"]:
                forked[-1]["content"].extend(msg["content"])
            else:
                forked.append(msg)

        if last_n is not None and last_n > 0:
            # Search backwards for a valid trim point using a 2-element window.
            start = max(len(forked) - last_n, 0)
            while start > 0 and find_valid_trim_point(forked[start : start + 2], 0) != 0:
                start -= 1
            forked = forked[start:]
        return forked

    def _render_context(self, parent: Agent | None, last_n: int | None) -> str:
        """Render the parent's text turns as a plain-text block for ``"no_tools"`` context mode."""
        if parent is None:
            return ""
        messages = parent.messages
        if last_n is not None and last_n > 0:
            messages = messages[-last_n:]
        lines = []
        for message in messages:
            text = " ".join(b["text"] for b in message["content"] if "text" in b).strip()
            if text.startswith("<parent_context>\n"):
                _, found, stripped = text.partition(_FRAMING_END)
                if found:
                    text = stripped
            if text:
                lines.append(f"{message['role']}: {text}".replace("\n", "\n  "))
        return _SENTINEL.sub(r"<\\\1parent_context>", "\n".join(lines))

    def _resolve_context(self, raw: Mapping[str, Any]) -> tuple[str, int | None]:
        """Resolve context mode and last_messages from the model's raw input and the context axis."""
        ctx_mode = "none"
        if isinstance(self._context, Choice):
            raw_ctx = raw.get("context")
            if raw_ctx is not None and any(o.name == str(raw_ctx) for o in self._context.normalized()):
                ctx_mode = str(self._context.value_for(str(raw_ctx)))
        elif isinstance(self._context, Fixed) and self._context.value is not None:
            ctx_mode = str(self._context.value)

        last_n = None
        raw_last = raw.get("last_messages")
        if raw_last is not None:
            try:
                last_n = int(raw_last)
                if last_n < 1:
                    last_n = None
            except (TypeError, ValueError):
                pass

        return ctx_mode, last_n

    def _error_result(self, tool_use_id: str, text: str) -> ToolResultEvent:
        return ToolResultEvent({"toolUseId": tool_use_id, "status": "error", "content": [{"text": text}]})

    def _prepare_child(
        self, tool_use: ToolUse, raw: Mapping[str, Any], parent: Agent | None, tool_streamer: _AgentToolStreamer
    ) -> tuple[Agent, Any] | str | ToolInterruptEvent | ToolResultEvent:
        """Resolve or resume the child agent and its prompt.

        Returns ``(child, prompt)`` on success, a ``str`` error message on validation failure, or the
        event to yield if the child's stored turn could not be resumed.
        """
        if tool_streamer.is_resuming():
            return self._prepare_resume(tool_use, raw, parent, tool_streamer)

        stored_depth = None if parent is None else parent.state.get(_DEPTH_STATE_KEY)
        depth = self._max_depth if stored_depth is None else stored_depth
        if depth <= 0:
            return (
                f"Delegation depth limit reached ({self._max_depth} levels); you cannot delegate "
                "further. Complete this task yourself instead of calling subagent again."
            )
        task = raw.get("task")
        if not isinstance(task, str) or not task.strip():
            return "Missing required parameter 'task': describe the task to delegate."

        spec = self._resolve(raw)
        build = self._builder or _default_builder(parent)  # type: ignore[arg-type]
        child = build(spec)
        child.state.set(_DEPTH_STATE_KEY, depth - 1)
        ctx_mode, last_messages = self._resolve_context(raw)

        prompt: Any = task
        if ctx_mode == "all":
            messages = self._fork_messages(parent, last_messages)
            if messages:
                framed: ContentBlock = {"text": f"{_FORK_PREAMBLE}\n\n{task}"}
                if messages[-1]["role"] == "user":
                    prompt = [
                        *messages[:-1],
                        {"role": "user", "content": [*messages[-1]["content"], framed]},
                    ]
                else:
                    prompt = [*messages, {"role": "user", "content": [framed]}]
        elif ctx_mode == "no_tools":
            block = self._render_context(parent, last_messages)
            if block:
                prompt = f"<parent_context>\n{block}\n</parent_context>\n\n{_CONTEXT_PREAMBLE}\n\n{task}"

        return child, prompt

    def _prepare_resume(
        self, tool_use: ToolUse, raw: Mapping[str, Any], parent: Agent | None, tool_streamer: _AgentToolStreamer
    ) -> tuple[Agent, Any] | ToolInterruptEvent | ToolResultEvent:
        """Rebuild the interrupted child from the same tool input and restore its stored turn."""
        spec = self._resolve(raw)
        build = self._builder or _default_builder(parent)  # type: ignore[arg-type]
        child: Agent | None = None
        try:
            child = build(spec)
        except Exception as error:
            logger.warning(
                "tool_name=<%s>, tool_use_id=<%s> | failed to rebuild interrupted subagent: %s",
                self._name,
                tool_use["toolUseId"],
                error,
            )
        resumed = tool_streamer.resume(
            self._adapter,
            child,
            "Subagent did NOT run and the response was NOT applied: its interrupted turn is not available. "
            "Do not report the delegated task as completed; if it is still needed, delegate it again.",
        )
        if resumed is None:
            return tool_streamer.terminal_event(tool_use)
        # resume() returns an event when there is no child to resume.
        return cast("Agent", child), resumed

    async def stream(self, tool_use: ToolUse, invocation_state: dict[str, Any], **kwargs: Any) -> ToolGenerator:
        tool_use_id = tool_use["toolUseId"]
        raw = tool_use.get("input", {}) or {}
        parent = invocation_state.get("agent")
        tool_streamer = _AgentToolStreamer(
            interrupt_state=getattr(parent, "_interrupt_state", None),
            tool_use_id=tool_use_id,
            namespace="v1:subagent",
        )

        try:
            prepared = self._prepare_child(tool_use, raw, parent, tool_streamer)
            if not isinstance(prepared, tuple):
                yield self._error_result(tool_use_id, prepared) if isinstance(prepared, str) else prepared
                return
            child, prompt = prepared

            tool_context = kwargs.get("_tool_context")
            cancel_signal = (
                tool_context.cancel_signal if tool_context is not None else getattr(parent, "cancel_signal", None)
            )
            # Join the request of the tool call so the child shares its limits and usage.
            invocation_context = tool_context.invocation_context if tool_context is not None else None
            child_state = {**invocation_state} if isinstance(invocation_state, dict) else invocation_state
            source = child.stream_async(
                prompt, invocation_state=child_state, cancel_signal=cancel_signal, invocation_context=invocation_context
            )
            async for event in tool_streamer.stream(self._adapter, child, source):
                yield ToolStreamEvent(tool_use, event)
            yield tool_streamer.terminal_event(tool_use)
        except Exception as exc:
            logger.warning(
                "tool_name=<%s>, tool_use_id=<%s> | subagent failed: %s",
                self._name,
                tool_use_id,
                exc,
            )
            yield self._error_result(tool_use_id, f"Subagent error: {exc}")


def make_subagent(
    *,
    builder: AgentBuilder | None = None,
    presets: Mapping[str, Preset] | None = None,
    default_preset: str | None = None,
    instructions: Open | Choice | Fixed | None = None,
    tools: Choice | Fixed | Inherit | None = None,
    model: Inherit | Choice | Fixed | None = None,
    context: Fixed | Choice | None = None,
    max_depth: int = DEFAULT_SUBAGENT_MAX_DEPTH,
    name: str = "subagent",
    description: str = DEFAULT_SUBAGENT_DESCRIPTION,
) -> AgentTool:
    """Build a ``subagent`` tool whose schema is derived from the axis modes and presets.

    Each axis accepts a policy from :mod:`~strands.multiagent.spec` that controls what
    the model sees and can supply. Omitted axes use sensible defaults.

    Raises:
        ValueError: If *max_depth* < 1, *name* or *description* is empty, or a ``Choice`` axis violates
            its constraints (empty options, ``multiple=False`` for tools).
    """
    if not name:
        raise ValueError("name must be a non-empty string.")
    if not description:
        raise ValueError("description must be a non-empty string.")
    if not isinstance(max_depth, int) or isinstance(max_depth, bool) or max_depth < 1:
        raise ValueError("max_depth must be a positive integer (>= 1).")

    presets = dict(presets) if presets is not None else {"generalist": GENERALIST}
    instructions = instructions if instructions is not None else Open()
    model = model if model is not None else Inherit()
    context = context if context is not None else Fixed("none")
    if default_preset is None and presets:
        default_preset = next(iter(presets))

    schema = _build_schema(
        presets=presets,
        default_preset=default_preset,
        instructions=instructions,
        tools=tools,
        model=model,
        context=context,
    )
    tool_spec = {
        "name": name,
        "description": description,
        "inputSchema": {"json": schema},
    }

    def resolve(raw: Mapping[str, Any]) -> AgentSpec:
        # The schema has no name field; the child takes the tool's name.
        model_input: list[Mapping[str, Any]] = [{**raw, "name": name}]
        return _resolve_specs(
            model_input,
            presets=presets,
            default_preset=default_preset,
            instructions=instructions,
            tools=tools,
            model=model,
        )[0]

    return _SubagentTool(name, tool_spec, resolve, context, builder, max_depth)


subagent = make_subagent()
"""Pre-built subagent tool with default settings (generalist preset, all axes using defaults)."""
