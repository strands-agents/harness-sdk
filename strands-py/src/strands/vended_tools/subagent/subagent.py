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
from collections.abc import Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any

from ...multiagent.spec import (
    AgentBuilder,
    AgentSpec,
    Choice,
    Fixed,
    Inherit,
    Open,
    Preset,
    _default_builder,
    _resolve_spec,
)
from ...tools.tools import AgentTool
from ...types._events import ToolInterruptEvent, ToolResultEvent, ToolStreamEvent
from ...types.content import ContentBlock, Message
from ...types.tools import ToolGenerator, ToolUse
from .types import (
    DEFAULT_SUBAGENT_DESCRIPTION,
    DEFAULT_SUBAGENT_MAX_DEPTH,
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


def _description(base: str, presets: Mapping[str, Preset]) -> str:
    if not presets:
        return base
    roles = "\n".join(f"- {name}: {p.description or name}" for name, p in presets.items())
    return f"{base}\n\nAvailable subagents (agent_type):\n{roles}"


def _build_schema(
    *,
    presets: Mapping[str, Preset],
    default_preset: str | None,
    instructions: Any,
    tools: Any,
    mcp_servers: Any,
    model: Any,
    context: Any,
) -> dict[str, Any]:
    """Derive the tool's input schema from the axis modes."""
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
            "description": f"Which subagent role to use. Omit to use the default ({default_preset!r}).",
        }

    if isinstance(instructions, Open):
        props["instructions"] = {
            "type": "string",
            "description": "A system prompt defining the subagent's role.",
        }
    elif isinstance(instructions, Choice):
        props["instructions"] = instructions.to_schema_property("A system prompt defining the subagent's role.")

    if isinstance(tools, Choice):
        props["tools"] = tools.to_schema_property(
            "Subset of tools to grant the subagent. Fewer is safer; it cannot exceed your own. "
            "Omit to grant all inherited tools."
        )

    if isinstance(mcp_servers, Choice):
        props["mcp_servers"] = mcp_servers.to_schema_property(
            "Subset of MCP servers whose tools to grant the subagent. Fewer is safer; it cannot "
            "exceed your own. Omit to grant all of them.",
        )

    if isinstance(model, Choice):
        props["model"] = model.to_schema_property(
            "Which model the subagent runs on. Omit to inherit the parent's model."
        )

    if isinstance(context, Choice):
        props["context"] = context.to_schema_property(
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


class _SubagentTool(AgentTool):
    """Streams a fresh per-call child and propagates its interrupts to the parent for resume."""

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
        self._spec = tool_spec
        self._resolve = resolve
        self._context = context
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

    def _is_valid_trim_point(self, messages: list[Message], index: int) -> bool:
        """Check if ``index`` is a safe point to trim the message history."""
        message = messages[index]
        if message["role"] != "user" or any("toolResult" in b for b in message["content"]):
            return False
        if any("toolUse" in b for b in message["content"]):
            return index + 1 < len(messages) and any("toolResult" in b for b in messages[index + 1]["content"])
        return True

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
            start = max(len(forked) - last_n, 0)
            while start > 0 and not self._is_valid_trim_point(forked, start):
                start -= 1
            forked = forked[start:]
        return forked

    def _render_context(self, parent: Agent | None, last_n: int | None) -> str:
        """Render the parent's text turns as a plain-text block for ``"no_tools"`` context mode."""
        if parent is None:
            return ""
        lines = []
        for message in parent.messages:
            text = " ".join(b["text"] for b in message["content"] if "text" in b).strip()
            if text.startswith("<parent_context>\n"):
                _, found, stripped = text.partition(_FRAMING_END)
                if found:
                    text = stripped
            if text:
                lines.append(f"{message['role']}: {text}".replace("\n", "\n  "))
        if last_n is not None and last_n > 0:
            lines = lines[-last_n:]
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

    def _build_prompt(
        self, task: str, ctx_mode: str, last_messages: int | None, parent: Agent | None
    ) -> str | list[Message]:
        """Build the child's prompt, incorporating parent context based on the context mode."""
        if ctx_mode == "all":
            messages = self._fork_messages(parent, last_messages)
            if not messages:
                return task
            framed: ContentBlock = {"text": f"{_FORK_PREAMBLE}\n\n{task}"}
            if messages[-1]["role"] == "user":
                return [
                    *messages[:-1],
                    {"role": "user", "content": [*messages[-1]["content"], framed]},
                ]
            return [*messages, {"role": "user", "content": [framed]}]

        if ctx_mode == "no_tools":
            block = self._render_context(parent, last_messages)
            if block:
                return f"<parent_context>\n{block}\n</parent_context>\n\n{_CONTEXT_PREAMBLE}\n\n{task}"

        return task

    def _error_result(self, tool_use_id: str, text: str) -> ToolResultEvent:
        return ToolResultEvent({"toolUseId": tool_use_id, "status": "error", "content": [{"text": text}]})

    async def stream(self, tool_use: ToolUse, invocation_state: dict[str, Any], **kwargs: Any) -> ToolGenerator:
        tool_use_id = tool_use["toolUseId"]
        raw = tool_use.get("input", {}) or {}
        parent = invocation_state.get("agent")

        # resolve/build/render can raise; surface it as an error tool result, not an uncaught
        # exception.
        try:
            child = self._pending.get(tool_use_id)
            if child is not None and child._interrupt_state.activated:
                # Resume: the parent set responses on the shared interrupt objects the child
                # still holds.
                prompt: Any = [
                    {
                        "interruptResponse": {
                            "interruptId": interrupt.id,
                            "response": interrupt.response,
                        }
                    }
                    for interrupt in child._interrupt_state.interrupts.values()
                    if interrupt.response is not None
                ]
            else:
                stored_depth = None if parent is None else parent.state.get(_DEPTH_STATE_KEY)
                depth = self._max_depth if stored_depth is None else stored_depth
                if depth <= 0:
                    yield self._error_result(
                        tool_use_id,
                        f"Delegation depth limit reached ({self._max_depth} levels); you cannot delegate "
                        "further. Complete this task yourself instead of calling subagent again.",
                    )
                    return
                spec = self._resolve(raw)
                build = self._builder or _default_builder(parent)  # type: ignore[arg-type]
                child = build(spec)
                child.state.set(_DEPTH_STATE_KEY, depth - 1)
                task = str(raw["task"])
                ctx_mode, last_messages = self._resolve_context(raw)
                prompt = self._build_prompt(task, ctx_mode, last_messages, parent)

            # Cancelling the parent's tool call cancels the delegation too (mirrors _AgentAsTool).
            # A framework-supplied _tool_context (background execution) carries a per-call signal.
            tool_context = kwargs.get("_tool_context")
            cancel_signal = (
                tool_context.cancel_signal if tool_context is not None else getattr(parent, "cancel_signal", None)
            )
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
                yield self._error_result(tool_use_id, "Subagent produced no result.")
                return
            if result.stop_reason == "interrupt" and result.interrupts:
                self._pending[tool_use_id] = child
                yield ToolInterruptEvent(tool_use, list(result.interrupts))
                return
            if result.stop_reason == "cancelled":
                self._pending.pop(tool_use_id, None)
                yield self._error_result(tool_use_id, "Subagent was cancelled.")
                return
            self._pending.pop(tool_use_id, None)
            yield ToolResultEvent(
                {
                    "toolUseId": tool_use_id,
                    "status": "success",
                    "content": [{"text": str(result)}],
                }
            )
        except Exception as exc:
            self._pending.pop(tool_use_id, None)
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
    mcp_servers: Choice | Fixed | Inherit | None = None,
    model: Inherit | Choice | Fixed | None = None,
    context: Fixed | Choice | None = None,
    inherited_tools: Sequence[str] = (),
    inherited_mcp_servers: Sequence[str] = (),
    max_depth: int = DEFAULT_SUBAGENT_MAX_DEPTH,
    name: str = "subagent",
) -> AgentTool:
    """Build a ``subagent`` tool whose schema is derived from the axis modes and presets.

    Each axis accepts a policy from :mod:`~strands.multiagent.spec` that controls what
    the model sees and can supply. Omitted axes use sensible defaults.

    Raises:
        ValueError: If *max_depth* < 1, *name* is empty, or a ``Choice`` axis violates
            its constraints (empty options, ``multiple=False`` for tools).
    """
    if not name:
        raise ValueError("name must be a non-empty string.")
    if not isinstance(max_depth, int) or isinstance(max_depth, bool) or max_depth < 1:
        raise ValueError("max_depth must be a positive integer (>= 1).")

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

    schema = _build_schema(
        presets=presets,
        default_preset=default_preset,
        instructions=instructions,
        tools=tools,
        mcp_servers=mcp_servers,
        model=model,
        context=context,
    )
    tool_spec = {
        "name": name,
        "description": _description(DEFAULT_SUBAGENT_DESCRIPTION, presets),
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
        )

    return _SubagentTool(name, tool_spec, resolve, context, builder, max_depth)
