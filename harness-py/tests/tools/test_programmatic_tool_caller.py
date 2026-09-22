"""Unit tests for the programmatic tool caller.

The tool is exercised as a direct tool call on a real ``Agent`` whose model is never invoked, so
these are offline and fast. They cover execution shapes (single/loop/gather), the print-only output
contract, the sandbox boundary (no host access, limits), identifier aliasing, error handling, output
truncation, timeout/cancellation, and driving real MCP tools over stdio.
"""

import asyncio
import re
import sys
import threading
import time
from pathlib import Path

import pytest
from mcp import StdioServerParameters, stdio_client
from strands import Agent
from strands.hooks import BeforeToolCallEvent
from strands.tools.decorator import tool
from strands.tools.mcp.mcp_client import MCPClient
from strands.types.tools import ToolContext

from strands_harness.tools import make_programmatic_tool_caller, programmatic_tool_caller
from strands_harness.tools.programmatic_tool_caller import (
    _MAX_CONCURRENT_TOOL_CALLS,
    _MAX_OUTPUT_CHARS,
    _SKIP_CONTEXT_OFFLOAD_KEY,
    DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION,
    _Output,
    _unwrap_result,
)


@tool
def calculator(expression: str) -> str:
    """Evaluate a simple arithmetic expression."""
    return str(eval(expression, {"__builtins__": {}}, {}))  # noqa: S307 - test helper, fixed namespace


@tool
def boom() -> str:
    """Always fail."""
    raise ValueError("kaboom")


@tool
def info() -> dict:
    """Return structured data (the SDK serializes it to JSON text)."""
    return {"name": "demo", "tags": ["a", "b"]}


@tool(name="fetch-url")
def fetch_url(value: str) -> str:
    """A tool whose name is not a valid identifier."""
    return f"dash:{value}"


@tool(name="ns.fetch")
def ns_fetch(value: str) -> str:
    """A tool whose name has a dot."""
    return f"dot:{value}"


def _agent(*tools):
    return Agent(model=None, tools=[programmatic_tool_caller, *tools])


def _run(agent, code, tool_name="programmatic_tool_caller"):
    return getattr(agent.tool, tool_name)(code=code, record_direct_tool_call=False)


def _text(result):
    return result["content"][0]["text"]


def test_single_call():
    result = _run(_agent(calculator), 'print(await calculator(expression="10 * 2"))')
    assert result["status"] == "success"
    assert _text(result) == "20"


def test_loop_over_calls():
    result = _run(_agent(calculator), "for i in range(3):\n    print(await calculator(expression=f'{i} + 10'))")
    assert _text(result) == "10\n11\n12"


def test_gather_runs_calls_concurrently():
    @tool
    def slow(value: int) -> int:
        """Sleep, then return the value."""
        time.sleep(0.3)
        return value

    code = "import asyncio\nprint(await asyncio.gather(*[slow(value=i) for i in range(4)]))"
    start = time.monotonic()
    result = _run(_agent(slow), code)
    elapsed = time.monotonic() - start
    assert _text(result) == "['0', '1', '2', '3']"
    assert elapsed < 1.1, f"gather did not run concurrently ({elapsed:.2f}s)"  # serial would take >= 1.2 s


def test_inner_call_concurrency_is_bounded():
    in_flight = {"now": 0, "peak": 0}

    # Async on purpose: a sync tool runs on the SDK's thread pool, whose own size would mask the semaphore.
    @tool
    async def slow(value: int) -> int:
        """Track how many calls overlap."""
        in_flight["now"] += 1
        in_flight["peak"] = max(in_flight["peak"], in_flight["now"])
        await asyncio.sleep(0.05)
        in_flight["now"] -= 1
        return value

    count = _MAX_CONCURRENT_TOOL_CALLS * 3
    code = f"import asyncio\nprint(len(await asyncio.gather(*[slow(value=i) for i in range({count})])))"
    assert _text(_run(_agent(slow), code)) == str(count)
    assert 1 < in_flight["peak"] <= _MAX_CONCURRENT_TOOL_CALLS


def test_only_printed_output_is_returned():
    result = _run(_agent(calculator), 'x = await calculator(expression="6 * 7")\nprint("done")')
    assert _text(result) == "done"


def test_comment_only_code_is_no_output():
    result = _run(_agent(calculator), "# nothing here")
    assert result["status"] == "success"
    assert _text(result) == "(no output)"


def test_stdlib_subset_is_importable():
    code = (
        "import json, re, math, datetime, collections, itertools, functools, dataclasses, typing, base64\n"
        "print(json.dumps({'ok': math.floor(2.5)}))"
    )
    result = _run(_agent(calculator), code)
    assert _text(result) == '{"ok": 2}'


def test_positional_arguments_are_rejected_with_a_hint():
    result = _run(_agent(calculator), 'print(await calculator("1 + 1"))')
    assert result["status"] == "error"
    assert "keyword arguments only" in _text(result)
    assert "calculator(key=value)" in _text(result)


def test_json_text_result_is_parsed():
    result = _run(_agent(info), "r = await info()\nprint(type(r).__name__, r['tags'][1])")
    assert _text(result) == "dict b"


def test_non_json_text_result_is_a_string():
    result = _run(_agent(calculator), "r = await calculator(expression='1 + 1')\nprint(type(r).__name__, r)")
    assert _text(result) == "str 2"


def test_inner_calls_carry_the_parent_invocation_state_not_guest_kwargs():
    seen = []

    @tool(context="tool_context")
    def whoami(label: str, tool_context: ToolContext) -> str:
        """Record the invocation state the inner call ran with."""
        seen.append(dict(tool_context.invocation_state))
        return label

    agent = _agent(whoami)
    context = ToolContext(
        tool_use={"toolUseId": "x", "name": "programmatic_tool_caller", "input": {}},
        agent=agent,
        invocation_state={"principal": "alice"},
    )
    # A guest kwarg named like an invocation_state key must not override the parent's value (a Cedar
    # principal resolver reads from invocation_state), and the parent's state must reach the inner call.
    code = "print(await whoami(label='ok', principal='admin'))"
    result = asyncio.run(programmatic_tool_caller._tool_func(code=code, tool_context=context))
    assert _text(result) == "ok"
    assert seen[0]["principal"] == "alice"


def test_inner_calls_opt_out_of_context_offloading_without_touching_the_parent_state():
    seen = []

    @tool(context="tool_context")
    def whoami(tool_context: ToolContext) -> str:
        """Record the invocation state the inner call ran with."""
        seen.append(dict(tool_context.invocation_state))
        return "ok"

    parent_state = {"principal": "alice"}
    context = ToolContext(
        tool_use={"toolUseId": "x", "name": "programmatic_tool_caller", "input": {}},
        agent=_agent(whoami),
        invocation_state=parent_state,
    )
    result = asyncio.run(programmatic_tool_caller._tool_func(code="print(await whoami())", tool_context=context))
    assert _text(result) == "ok"
    # The inner call opts out; the parent's own result must still be eligible for offloading.
    assert seen[0][_SKIP_CONTEXT_OFFLOAD_KEY] is True
    assert parent_state == {"principal": "alice"}


def test_unwrap_prefers_structured_content():
    result = {"status": "success", "content": [{"text": '{"a": 1}'}], "structuredContent": {"a": 1, "b": 2}}
    assert _unwrap_result("t", result) == {"a": 1, "b": 2}


def test_unwrap_returns_a_lone_json_block_as_data():
    assert _unwrap_result("t", {"status": "success", "content": [{"json": {"a": [1]}}]}) == {"a": [1]}


def test_unwrap_parses_a_lone_json_text_block():
    assert _unwrap_result("t", {"status": "success", "content": [{"text": '{"a": [1]}'}]}) == {"a": [1]}
    assert _unwrap_result("t", {"status": "success", "content": [{"text": "[1, 2]"}]}) == [1, 2]
    assert _unwrap_result("t", {"status": "success", "content": [{"text": "{not json"}]}) == "{not json"
    assert _unwrap_result("t", {"status": "success", "content": [{"text": "42"}]}) == "42"


def test_unwrap_joins_mixed_blocks_as_text():
    result = {"status": "success", "content": [{"text": "x"}, {"json": {"a": 1}}]}
    assert _unwrap_result("t", result) == 'x\n{"a": 1}'


def test_unwrap_raises_runtime_error_for_error_results():
    with pytest.raises(RuntimeError, match="Tool 't' error: nope"):
        _unwrap_result("t", {"status": "error", "content": [{"text": "nope"}]})
    with pytest.raises(RuntimeError, match=r"Tool 't' error: \{\"code\": 1\}"):
        _unwrap_result("t", {"status": "error", "content": [{"json": {"code": 1}}]})
    with pytest.raises(RuntimeError, match="Unknown error"):
        _unwrap_result("t", {"status": "error", "content": None})


# --- sandbox boundary ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("import os\nprint(os.listdir('/'))", "PermissionError"),
        ("import os\nprint(os.environ['HOME'])", "not supported"),
        ("print(open('/etc/passwd').read())", "PermissionError"),
        ("import subprocess", "ModuleNotFoundError"),
        ("import socket", "ModuleNotFoundError"),
        ("import sys\nprint(sys.modules)", "AttributeError"),
        ("print(().__class__.__bases__)", "AttributeError"),
        ("print(__builtins__)", "NameError"),
        ("print(eval('1 + 1'))", "NameError"),
        ("exec('x = 1')", "NameError"),
        ("def f(): pass\nprint(f.__globals__)", "AttributeError"),
        ("from pathlib import Path\nprint(Path('/etc/passwd').read_text())", "PermissionError"),
    ],
)
def test_host_is_unreachable(code, expected):
    result = _run(_agent(calculator), code)
    assert result["status"] == "error"
    assert expected in _text(result)


def test_memory_limit_is_enforced():
    result = _run(_agent(calculator), "x = 'a' * 10**9\nprint(len(x))")
    assert result["status"] == "error"
    assert "MemoryError" in _text(result)


def test_recursion_limit_is_catchable():
    code = "def f(n):\n    return f(n + 1)\ntry:\n    f(0)\nexcept RecursionError:\n    print('bounded')"
    assert _text(_run(_agent(calculator), code)) == "bounded"


# ``strands_harness.tools.programmatic_tool_caller`` the attribute is the tool; the module is in sys.modules.
_module = sys.modules["strands_harness.tools.programmatic_tool_caller"]


def test_synchronous_busy_loop_is_bounded(monkeypatch):
    monkeypatch.setattr(_module, "_LIMITS", {**_module._LIMITS, "max_duration_secs": 0.2})
    start = time.monotonic()
    result = _run(_agent(calculator), "while True:\n    pass")
    assert result["status"] == "error"
    assert "TimeoutError" in _text(result)
    assert time.monotonic() - start < 5


def test_suspension_limit_bounds_tool_calls(monkeypatch):
    monkeypatch.setattr(_module, "_LIMITS", {**_module._LIMITS, "max_suspensions": 3})
    result = _run(_agent(calculator), "for i in range(10):\n    await calculator(expression='1')")
    assert result["status"] == "error"
    assert "suspension limit" in _text(result)


def test_unsupported_python_is_reported_as_an_error():
    result = _run(_agent(calculator), "def g():\n    yield 1\nprint(list(g()))")
    assert result["status"] == "error"
    assert "yield" in _text(result)


# --- errors ----------------------------------------------------------------------------------------


def test_tool_error_is_catchable():
    code = "try:\n    await boom()\nexcept RuntimeError as e:\n    print('caught:', e)"
    result = _run(_agent(boom), code)
    assert result["status"] == "success"
    assert _text(result).startswith("caught: Tool 'boom' error:")
    assert "kaboom" in _text(result)


def test_tool_error_inside_gather_propagates():
    code = (
        "import asyncio\n"
        "try:\n"
        "    await asyncio.gather(calculator(expression='1 + 1'), boom())\n"
        "except RuntimeError as e:\n"
        "    print('caught:', e)"
    )
    assert _text(_run(_agent(calculator, boom), code)).startswith("caught: Tool 'boom' error:")


def test_output_printed_before_an_error_is_kept():
    result = _run(_agent(calculator), "print('step 1')\nprint('step 2')\nraise ValueError('late')")
    assert result["status"] == "error"
    text = _text(result)
    assert text.startswith("step 1\nstep 2\n\nExecution error:")
    assert "ValueError: late" in text


def test_error_without_prior_output_has_no_output_prefix():
    result = _run(_agent(calculator), "raise ValueError('early')")
    assert _text(result).startswith("Execution error:\nTraceback")


def test_syntax_error_is_reported():
    result = _run(_agent(calculator), "def broken(:\n    pass")
    assert result["status"] == "error"
    assert _text(result).startswith("Syntax error:")
    assert "SyntaxError" in _text(result)


def test_runtime_error_traceback_uses_user_line_numbers():
    result = _run(_agent(calculator), "x = 1\ny = 2\nz = {}['missing']")
    assert result["status"] == "error"
    assert "line 3" in _text(result)
    assert "KeyError" in _text(result)


def test_multiline_string_is_preserved():
    code = 'text = """line one\n  indented two\nthree"""\nprint(text)'
    assert _text(_run(_agent(calculator), code)) == "line one\n  indented two\nthree"


def test_no_agent_context_is_an_error():
    context = ToolContext(
        tool_use={"toolUseId": "x", "name": "programmatic_tool_caller", "input": {}}, agent=None, invocation_state={}
    )
    result = asyncio.run(programmatic_tool_caller._tool_func(code="print(1)", tool_context=context))
    assert result["status"] == "error"
    assert "No agent available" in _text(result)


# --- exposure --------------------------------------------------------------------------------------


def test_self_is_not_exposed():
    result = _run(_agent(calculator), "programmatic_tool_caller")
    assert result["status"] == "error"
    assert "NameError" in _text(result)


def test_another_caller_is_not_exposed():
    other = make_programmatic_tool_caller(name="run_code", allowed_tools=["programmatic_tool_caller", "calculator"])
    agent = Agent(model=None, tools=[programmatic_tool_caller, other, calculator])
    for caller, target in (("run_code", "programmatic_tool_caller"), ("programmatic_tool_caller", "run_code")):
        result = _run(agent, f"await {target}(code='print(1)')", caller)
        assert result["status"] == "error"
        assert "NameError" in _text(result)
    assert _text(_run(agent, 'print(await calculator(expression="1 + 1"))', "run_code")) == "2"


def test_allowed_tools_filters_exposed_tools():
    restricted = make_programmatic_tool_caller(allowed_tools=["calculator"], name="run_code")
    agent = Agent(model=None, tools=[restricted, calculator, boom])
    assert _text(_run(agent, 'print(await calculator(expression="1 + 1"))', "run_code")) == "2"
    result = _run(agent, "await boom()", "run_code")
    assert result["status"] == "error"
    assert "NameError" in _text(result)


def test_allowed_tools_ignores_unregistered_names():
    caller = make_programmatic_tool_caller(allowed_tools=["calculator", "not_registered"], name="run_code")
    agent = Agent(model=None, tools=[caller, calculator])
    assert _text(_run(agent, 'print(await calculator(expression="2 + 2"))', "run_code")) == "4"


def test_description_states_the_contract():
    for phrase in ("await", "print()", "RuntimeError", "keyword arguments", "fetch_url"):
        assert phrase in DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION


def test_hyphenated_tool_is_callable_via_alias():
    assert _text(_run(_agent(fetch_url), 'print(await fetch_url(value="x"))')) == "dash:x"


def test_dotted_tool_is_callable_via_alias():
    assert _text(_run(_agent(ns_fetch), 'print(await ns_fetch(value="y"))')) == "dot:y"


def test_ambiguous_alias_is_dropped():
    @tool(name="a-b")
    def dash(value: str) -> str:
        """Dash."""
        return "dash"

    @tool(name="a.b")
    def dot(value: str) -> str:
        """Dot."""
        return "dot"

    result = _run(_agent(dash, dot), 'print(await a_b(value="x"))')
    assert result["status"] == "error"
    assert "NameError" in _text(result)


# --- interventions ---------------------------------------------------------------------------------


def test_hook_that_cancels_the_inner_call_blocks_the_tool():
    calls = []

    @tool
    def shell_like(command: str) -> str:
        """Record that it ran."""
        calls.append(command)
        return f"ran:{command}"

    agent = _agent(shell_like)

    def deny(event: BeforeToolCallEvent) -> None:
        if event.tool_use["name"] == "shell_like":
            event.cancel_tool = "shell is off"

    agent.hooks.add_callback(BeforeToolCallEvent, deny)
    code = "try:\n    print(await shell_like(command='rm -rf /'))\nexcept RuntimeError as e:\n    print('ERR', e)"
    result = _run(agent, code)
    assert result["status"] == "success"
    assert "shell is off" in _text(result)
    assert calls == []


def test_hook_that_needs_approval_refuses_the_inner_call():
    calls = []

    @tool
    def shell_like(command: str) -> str:
        """Record that it ran."""
        calls.append(command)
        return f"ran:{command}"

    agent = _agent(shell_like)

    def ask(event: BeforeToolCallEvent) -> None:
        if event.tool_use["name"] == "shell_like":
            event.interrupt("approve-shell", reason="Run shell?")

    agent.hooks.add_callback(BeforeToolCallEvent, ask)
    code = "try:\n    print(await shell_like(command='ls'))\nexcept RuntimeError as e:\n    print('ERR', e)"
    result = _run(agent, code)
    assert result["status"] == "success"
    assert "approval" in _text(result)
    assert calls == []


# --- output, timeout, cancellation -----------------------------------------------------------------


def test_output_is_truncated_when_too_long():
    result = _run(_agent(calculator), f"print('x' * {_MAX_OUTPUT_CHARS + 500})")
    text = _text(result)
    assert text.endswith(f"[output truncated at {_MAX_OUTPUT_CHARS} characters]")
    assert len(text) < _MAX_OUTPUT_CHARS + 100


def test_oversized_print_is_not_buffered_in_full():
    output = _Output()
    output("stdout", "a" * (_MAX_OUTPUT_CHARS * 20))
    output("stdout", "b" * 100)
    assert sum(len(chunk) for chunk in output.chunks) <= _MAX_OUTPUT_CHARS + 1
    assert output.text().endswith(f"[output truncated at {_MAX_OUTPUT_CHARS} characters]")


def test_error_output_is_truncated_when_too_long():
    result = _run(_agent(calculator), f"print('before')\nraise ValueError('x' * {_MAX_OUTPUT_CHARS * 3})")
    text = _text(result)
    assert result["status"] == "error"
    assert text.startswith("before\n\nExecution error:")
    assert re.search(r"\[output truncated at \d+ characters\]$", text)
    assert len(text) < _MAX_OUTPUT_CHARS + 100


def test_printed_output_and_error_share_the_cap():
    code = f"print('p' * {_MAX_OUTPUT_CHARS + 10_000})\nraise ValueError('e' * {_MAX_OUTPUT_CHARS + 10_000})"
    text = _text(_run(_agent(calculator), code))
    assert text.startswith("ppp")
    assert "ValueError: eee" in text
    assert len(text) < _MAX_OUTPUT_CHARS + 100


def test_syntax_error_output_is_truncated_when_too_long():
    long_line = "A" * (_MAX_OUTPUT_CHARS * 2)
    text = _text(_run(_agent(calculator), f"x = '{long_line}' +"))
    assert text.startswith("Syntax error:")
    assert len(text) < _MAX_OUTPUT_CHARS + 100


def test_timeout_is_enforced():
    @tool
    def slow() -> str:
        """Block longer than the timeout."""
        time.sleep(5)
        return "late"

    quick = make_programmatic_tool_caller(name="quick", timeout=0.3)
    result = _run(Agent(model=None, tools=[quick, slow]), "print('start')\nawait slow()", "quick")
    assert result["status"] == "error"
    assert _text(result).startswith("start\n\nExecution error: timed out after 0.3 seconds.")


def test_cancellation_is_honored():
    agent = _agent(calculator)
    agent.cancel()
    result = _run(agent, "import asyncio\nawait asyncio.sleep(5)\nprint('late')")
    assert result["status"] == "error"
    assert _text(result) == "Execution cancelled."


def test_in_flight_cancellation_stops_promptly():
    @tool
    def hang() -> str:
        """Block for a while."""
        time.sleep(3)
        return "late"

    # Driven on a loop of our own: the SDK's sync direct-call bridge tears its loop down with
    # ``asyncio.run``, which waits for the worker thread the blocked inner call is parked on.
    agent = _agent(hang)
    context = ToolContext(
        tool_use={"toolUseId": "x", "name": "programmatic_tool_caller", "input": {}},
        agent=agent,
        invocation_state={},
        cancel_signal=agent.cancel_signal,
    )
    threading.Timer(0.1, agent.cancel).start()
    start = time.monotonic()
    loop = asyncio.new_event_loop()
    result = loop.run_until_complete(programmatic_tool_caller._tool_func(code="await hang()", tool_context=context))
    elapsed = time.monotonic() - start
    for task in asyncio.all_tasks(loop):  # the parked inner call, orphaned by the cancel
        task.cancel()
    loop.run_until_complete(asyncio.gather(*asyncio.all_tasks(loop), return_exceptions=True))
    loop.close()
    assert elapsed < 2  # cancel unwound the run; the 900 s tool timeout never fired
    assert result["status"] == "error"
    assert _text(result) == "Execution cancelled."


def test_no_inner_tool_calls_after_cancel():
    calls = []

    @tool
    def bump() -> str:
        """Record a call."""
        calls.append(time.monotonic())
        time.sleep(0.05)
        return "ok"

    agent = _agent(bump)
    threading.Timer(0.3, agent.cancel).start()
    result = _run(agent, "while True:\n    await bump()")
    cancelled_at = time.monotonic()
    time.sleep(0.5)
    assert result["status"] == "error"
    assert not [t for t in calls if t > cancelled_at + 0.1], "inner tool calls continued after cancel"


# --- real MCP tools over stdio ---------------------------------------------------------------------

_MCP_SERVER = str(Path(__file__).parent / "programmatic_tool_caller_mcp_server.py")


@pytest.fixture(scope="module")
def mcp_agent():
    client = MCPClient(lambda: stdio_client(StdioServerParameters(command="python", args=[_MCP_SERVER])))
    with client:
        yield Agent(model=None, tools=[programmatic_tool_caller, *client.list_tools_sync()])


def test_calls_mcp_tool(mcp_agent):
    assert _text(_run(mcp_agent, 'print(await ptc_echo(text="hi"))')) == "echo:hi"


def test_loops_over_mcp_tool_calls(mcp_agent):
    result = _run(mcp_agent, "for i in range(3):\n    print(await ptc_add(a=i, b=10))")
    assert _text(result) == "10\n11\n12"


def test_runs_mcp_tools_concurrently(mcp_agent):
    code = "import asyncio\nprint(await asyncio.gather(*[ptc_echo(text=str(i)) for i in range(3)]))"
    assert _text(_run(mcp_agent, code)) == "['echo:0', 'echo:1', 'echo:2']"


def test_mcp_tool_error_is_catchable(mcp_agent):
    code = "try:\n    await ptc_boom()\nexcept RuntimeError as e:\n    print('caught:', e)"
    result = _run(mcp_agent, code)
    assert result["status"] == "success"
    assert "mcp tool exploded" in _text(result)


def test_hyphenated_mcp_tool_is_callable(mcp_agent):
    assert _text(_run(mcp_agent, 'print(await ptc_dash(value="x"))')) == "dash:x"


def test_dotted_mcp_tool_is_callable(mcp_agent):
    assert _text(_run(mcp_agent, 'print(await ptc_dot(value="y"))')) == "dot:y"


def test_mcp_structured_content_arrives_as_data(mcp_agent):
    result = _run(mcp_agent, 'r = await ptc_info(name="demo")\nprint(type(r).__name__, r["size"])')
    assert _text(result) == "dict 6"


def test_unprinted_mcp_result_does_not_leak(mcp_agent):
    result = _run(mcp_agent, 'x = await ptc_echo(text="secret")\nprint("done")')
    assert _text(result) == "done"
