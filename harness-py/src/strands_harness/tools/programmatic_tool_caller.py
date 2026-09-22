"""``programmatic_tool_caller``: let the agent orchestrate its other tools with Python code.

The model calls this tool with a ``code`` string; the code runs in a `Monty <https://github.com/pydantic/monty>`_
sandbox with every other registered tool exposed as an ``async`` function, so the model can chain, loop
over, filter, and parallelize tool calls in a single turn instead of one tool call per model round-trip.
Only text the code sends to ``print()`` is returned to the model; a tool's return value stays in the
code's local scope unless printed, which keeps large intermediate payloads out of the context window.

Security posture: Monty is a Python interpreter written in Rust whose VM implements no host operations
-- no filesystem, environment, network, FFI, or process access exists in the bytecode, and the
interpreter runs in a separate worker process with memory/time/recursion limits enforced by the VM.
The only way out of the sandbox is the tool functions handed in here, so the sandbox reaches exactly
what the agent's own tools reach. This is a language-level sandbox, not an OS-level one; for an OS
boundary around the *tools*, run the agent under a Docker/SSH sandbox.

Interventions apply to the tool calls the code makes: inner calls run through the agent's normal
executor with the parent call's ``invocation_state``, so an autonomous policy (Cedar, a natural-language
risk policy) that denies a call blocks it and the code sees a catchable ``RuntimeError``. Interrupt-based
human approval cannot prompt from inside a direct call, so a call gated that way raises a catchable error
instead of pausing.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import re
import weakref
from collections.abc import Awaitable, Callable
from typing import Any

from pydantic_monty import AsyncMonty, MontyError, MontyRuntimeError, MontySyntaxError
from strands.tools.decorator import tool
from strands.tools.executors._executor import ToolExecutor
from strands.types._events import ToolInterruptEvent
from strands.types.tools import ToolContext, ToolResult, ToolUse

logger = logging.getLogger(__name__)

# Enforced by the Monty VM. Duration counts interpreter time only (the clock pauses while a tool call
# is in flight), so it bounds runaway guest code without penalizing slow tools; the wall clock is
# bounded separately by ``timeout``. Suspensions are host round trips: a sequentially awaited tool
# call costs two, a gathered one about one, so this is roughly 500 sequential calls per run.
_LIMITS = {"max_duration_secs": 60.0, "max_memory": 256 * 1024 * 1024, "max_suspensions": 1_000}

# Inner tool calls in flight at once per run: ``asyncio.gather`` over a big list must not fan out
# unbounded against the same agent (a model turn is naturally bounded by its handful of tool_use blocks).
_MAX_CONCURRENT_TOOL_CALLS = 10

# Every caller made by this module; none is ever exposed to another's code (no nested runs).
_INSTANCES: weakref.WeakSet[Any] = weakref.WeakSet()

_USER_CODE_FILENAME = "<programmatic_tool_caller>"

# Cap on the text returned to the model; a runaway ``print`` should not blow up the context window.
_MAX_OUTPUT_CHARS = 200_000

# ``invocation_state`` key the SDK's ``ContextOffloader`` honours (``SKIP_CONTEXT_OFFLOAD_KEY``). Inner results
# are consumed by the guest code, not the model, so a preview in place of the data would break it.
_SKIP_CONTEXT_OFFLOAD_KEY = "strands:skip_context_offload"

# Wall-clock ceiling for a run, tool calls included.
_DEFAULT_TIMEOUT = 900.0
_CANCEL_POLL_INTERVAL = 0.05


class _Cancelled(Exception):
    """Raised when the parent's cancel signal fires mid-execution (distinct from an external cancel)."""


async def _poll_cancel(cancel_signal: Any) -> None:
    while not cancel_signal.is_set():
        await asyncio.sleep(_CANCEL_POLL_INTERVAL)


async def _await_bounded(coro: Awaitable[Any], timeout: float | None, cancel_signal: Any) -> None:
    """Await ``coro`` until it finishes, ``timeout`` elapses, or ``cancel_signal`` fires; on the latter
    two the coroutine is cancelled (unwinding any in-flight tool ``await``) before raising."""
    task = asyncio.ensure_future(coro)
    watch = asyncio.ensure_future(_poll_cancel(cancel_signal)) if cancel_signal is not None else None
    waiters = {task} | ({watch} if watch is not None else set())
    try:
        done, _ = await asyncio.wait(waiters, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if task in done:
            task.result()
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        if watch is not None and watch in done:
            raise _Cancelled
        raise asyncio.TimeoutError
    finally:
        # asyncio.wait leaves its children running if the wait itself is cancelled; cancel both so an
        # external cancel can't orphan the user coroutine (which could keep issuing tool calls detached).
        for pending in (task, watch):
            if pending is not None and not pending.done():
                pending.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await pending


DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION = (
    "Execute Python code that orchestrates the agent's other tools, each exposed as an async function "
    'taking keyword arguments -- always `await` them, e.g. `result = await read(path="/etc/hosts")`. '
    "The code runs in an async context, so `await` and `asyncio.gather(...)` work without boilerplate. "
    "A tool result that is structured content or JSON text (an object or array) arrives parsed, as a "
    "dict/list; anything else arrives as a string. A tool that fails raises RuntimeError, which you can "
    "catch. "
    "Only text sent to `print()` is returned to you: a tool's return value stays in the code's local "
    "scope unless you print it. A tool whose name is not a valid Python identifier (for example "
    "`fetch-url` or `ns.fetch`) is also available with those characters replaced by underscores "
    "(`fetch_url`, `ns_fetch`). The code runs in a sandboxed Python subset: `asyncio`, `json`, `re`, "
    "`math`, `datetime`, `collections`, `itertools`, `functools`, `dataclasses`, `typing`, `base64` "
    "are importable; filesystem, network, and subprocess access do not exist -- use the agent's tools "
    "for those. Generators (`yield`), class inheritance, `match`, and `del` are not supported. Use this "
    "to chain, loop over, filter, or parallelize tool calls in a single turn instead of one tool call "
    "per model round-trip, keeping large intermediate results out of the conversation."
)


def _error_result(message: str) -> dict[str, Any]:
    return {"status": "error", "content": [{"text": message}]}


def _unwrap_result(tool_name: str, result: Any) -> Any:
    """Turn a tool result into the value the code receives.

    An error result is raised as a ``RuntimeError`` so it propagates like a normal exception in the
    code. Structured data (an MCP ``structuredContent``, a ``json`` block, or a lone text block that is
    a JSON object/array) is returned as data so the code can index into it; otherwise the ``text``
    blocks are joined into one string.
    """
    if not isinstance(result, dict):
        return result

    blocks = [block for block in (result.get("content") or []) if isinstance(block, dict)]
    if result.get("status") == "error":
        raise RuntimeError(f"Tool '{tool_name}' error: {_join_text(blocks) or 'Unknown error'}")

    if result.get("structuredContent") is not None:
        return result["structuredContent"]
    if len(blocks) == 1 and "json" in blocks[0]:
        return blocks[0]["json"]
    text = _join_text(blocks)
    if len(blocks) == 1 and text[:1] in "[{":
        with contextlib.suppress(ValueError):
            return json.loads(text)
    return text


def _join_text(blocks: list[dict[str, Any]]) -> str:
    parts = []
    for block in blocks:
        if "text" in block:
            parts.append(block["text"])
        elif "json" in block:
            parts.append(json.dumps(block["json"]))
    return "\n".join(parts)


async def _execute_tool(tool_context: ToolContext, tool_name: str, tool_input: dict[str, Any]) -> Any:
    """Run an inner tool call through the agent's executor, the way ``agent.tool.<name>`` does, but
    async and with the parent call's ``invocation_state`` rather than the guest's kwargs (which is where
    a Cedar principal resolver reads from). Nothing is recorded in the message history."""
    agent = tool_context.agent
    tool_use: ToolUse = {
        "toolUseId": f"tooluse_{tool_name}_{random.randint(100000000, 999999999)}",
        "name": tool_name,
        "input": tool_input,
    }
    tool_results: list[ToolResult] = []
    invocation_state = {**tool_context.invocation_state, _SKIP_CONTEXT_OFFLOAD_KEY: True}
    try:
        async for event in ToolExecutor._stream(agent, tool_use, tool_results, invocation_state):
            if isinstance(event, ToolInterruptEvent):
                agent._interrupt_state.deactivate()
                raise RuntimeError(
                    f"Tool '{tool_name}' needs approval, which programmatic_tool_caller cannot prompt for; "
                    "call it as a normal tool call instead."
                )
    except RuntimeError:
        raise
    except Exception as error:
        raise RuntimeError(f"Failed to execute tool '{tool_name}': {error}") from error
    if not tool_results:
        raise RuntimeError(f"Tool '{tool_name}' produced no result.")
    return _unwrap_result(tool_name, tool_results[0])


def _make_async_tool_function(
    tool_context: ToolContext, tool_name: str, semaphore: asyncio.Semaphore
) -> Callable[..., Awaitable[Any]]:
    """Wrap a tool as an ``async`` host function taking keyword arguments only."""

    async def tool_function(*args: Any, **kwargs: Any) -> Any:
        if args:
            raise TypeError(f"{tool_name}() takes keyword arguments only, e.g. {tool_name}(key=value)")
        async with semaphore:
            return await _execute_tool(tool_context, tool_name, kwargs)

    return tool_function


def _resolve_available_tools(agent: Any, allowed_tools: list[str] | None) -> set[str]:
    """Determine which tools to expose to the code. No programmatic tool caller is ever exposed -- not
    this one, not another instance (two callers exposing each other would recurse). With
    ``allowed_tools`` set, the exposed set is the intersection with the registered tools (names not
    registered are ignored and logged, since a tool may be registered after the caller is created).
    """
    registered = {name for name, tool in agent.tool_registry.registry.items() if tool not in _INSTANCES}
    if allowed_tools is None:
        return registered

    available = registered & set(allowed_tools)
    dropped = set(allowed_tools) - set(agent.tool_registry.registry)
    if dropped:
        logger.debug("dropped=<%s> | allowed_tools entries are not registered and were ignored", sorted(dropped))
    return available


def _build_external_lookup(available_tools: set[str], tool_context: ToolContext) -> dict[str, Any]:
    """The host functions handed to the sandbox: one per tool, plus an alias for each tool whose name
    is not a valid identifier (MCP servers commonly use ``-`` or ``.``): every non-word character
    becomes ``_``, matching how ``agent.tool.<name>`` resolves underscores to hyphens. An alias is
    skipped when it would shadow a real tool name or another tool's alias. The functions share one
    pool of concurrency slots per run."""
    semaphore = asyncio.Semaphore(_MAX_CONCURRENT_TOOL_CALLS)
    lookup: dict[str, Any] = {
        name: _make_async_tool_function(tool_context, name, semaphore) for name in available_tools
    }

    aliases: dict[str, str] = {}
    ambiguous: set[str] = set()
    for tool_name in sorted(available_tools):
        if tool_name.isidentifier():
            continue
        alias = re.sub(r"\W", "_", tool_name)
        if not alias.isidentifier():
            continue
        if alias in available_tools:
            logger.debug(
                "alias=<%s>, tool_name=<%s> | alias is taken by another tool, no alias injected", alias, tool_name
            )
            continue
        if alias in aliases:
            ambiguous.add(alias)
            continue
        aliases[alias] = tool_name

    for alias in ambiguous:
        del aliases[alias]
        logger.warning("alias=<%s> | multiple tools normalize to this name, no alias injected", alias)

    for alias, tool_name in aliases.items():
        lookup[alias] = lookup[tool_name]
    return lookup


class _Output:
    """Collects the code's ``print()`` output, capped at ``_MAX_OUTPUT_CHARS``."""

    def __init__(self) -> None:
        self.chunks: list[str] = []
        self.size = 0

    def __call__(self, stream: str, text: str) -> None:
        # Buffer one char past the cap so ``_cap`` still sees that the output overflowed.
        room = _MAX_OUTPUT_CHARS + 1 - self.size
        if room > 0:
            self.chunks.append(text[:room])
            self.size += len(text[:room])

    def text(self) -> str:
        return _cap("".join(self.chunks))

    def with_error(self, message: str) -> str:
        """The error message, preceded by whatever the code printed before failing. Both share the cap (a
        traceback can carry a huge exception message): the error keeps at least half, the output the rest."""
        raw = "".join(self.chunks)
        message_limit = max(_MAX_OUTPUT_CHARS - len(raw), _MAX_OUTPUT_CHARS // 2)
        message = _cap(message, message_limit)
        printed = _cap(raw, _MAX_OUTPUT_CHARS - min(len(message), message_limit))
        return f"{printed}\n\n{message}" if printed else message


def _cap(raw: str, limit: int = _MAX_OUTPUT_CHARS) -> str:
    if len(raw) <= limit:
        return raw.strip()
    return f"{raw[:limit].strip()}\n[output truncated at {limit} characters]"


async def _run_sandboxed(code: str, external_lookup: dict[str, Any], output: _Output) -> None:
    async with AsyncMonty() as pool:
        async with pool.checkout(script_name=_USER_CODE_FILENAME, limits=_LIMITS) as session:
            await session.feed_run(code, external_lookup=external_lookup, print_callback=output)


def make_programmatic_tool_caller(
    *,
    allowed_tools: list[str] | None = None,
    name: str = "programmatic_tool_caller",
    description: str = DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION,
    timeout: float | None = _DEFAULT_TIMEOUT,
) -> Any:
    """Create a programmatic-tool-caller tool.

    The returned tool executes agent-authored Python code in a Monty sandbox in which the agent's
    other tools are exposed as ``async`` functions (``await tool_name(...)``). Only ``print()``
    output is returned.

    Args:
        allowed_tools: Registry names of the tools to expose to the code. ``None`` (the default)
            exposes every other registered tool. No programmatic tool caller is ever exposed,
            this one or another instance, even if named here.
        name: Tool name. Defaults to ``"programmatic_tool_caller"``.
        description: Tool description shown to the model.
        timeout: Wall-clock ceiling in seconds for a run, tool calls included, or ``None`` to
            disable it. Guest compute time is bounded separately by the sandbox (``_LIMITS``).

    Returns:
        A decorated tool that runs code with access to the agent's other tools.
    """
    resolved_allowed_tools = list(allowed_tools) if allowed_tools is not None else None

    @tool(name=name, description=description, context="tool_context")
    async def programmatic_tool_caller_tool(code: str, tool_context: ToolContext) -> dict[str, Any]:
        """Execute Python code with the agent's other tools as async functions.

        Args:
            code: Python code to execute. Use ``await tool_name(...)`` to call tools.
            tool_context: Injected by the framework. Not user-facing.

        Returns:
            A tool result whose text is the code's captured ``print()`` output on success, or the
            error/traceback on failure.
        """
        agent = tool_context.agent
        if agent is None:
            return _error_result("No agent available. The programmatic tool caller requires an agent context.")

        available_tools = _resolve_available_tools(agent, resolved_allowed_tools)
        external_lookup = _build_external_lookup(available_tools, tool_context)
        output = _Output()

        try:
            await _await_bounded(_run_sandboxed(code, external_lookup, output), timeout, tool_context.cancel_signal)
        except _Cancelled:
            return _error_result("Execution cancelled.")
        except asyncio.TimeoutError:
            return _error_result(output.with_error(f"Execution error: timed out after {timeout:g} seconds."))
        except MontySyntaxError as error:
            return _error_result(_cap(f"Syntax error:\n{error.display()}"))
        except MontyRuntimeError as error:
            return _error_result(output.with_error(f"Execution error:\n{error.display()}"))
        except MontyError as error:
            return _error_result(output.with_error(f"Execution error: {error}"))

        return {"status": "success", "content": [{"text": output.text() or "(no output)"}]}

    _INSTANCES.add(programmatic_tool_caller_tool)
    return programmatic_tool_caller_tool


programmatic_tool_caller = make_programmatic_tool_caller()
"""Default programmatic tool caller. Exposes every other registered tool."""
