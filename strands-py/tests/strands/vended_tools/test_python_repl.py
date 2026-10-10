"""Tests for the python_repl tool.

The python_repl tool is a shim over ``Sandbox.execute_code``: it routes code through
the agent's sandbox (or a bound one). Each call runs in a fresh interpreter, so
in-memory state does not persist across calls. The end-to-end tests spawn ``sh``
and ``python3`` and require POSIX, so they are skipped on Windows.
"""

import json
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import strands.vended_tools as vended_tools
from strands.sandbox.errors import SandboxTimeoutError
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.sandbox.types import ExecutionResult
from strands.types.tools import ToolContext
from strands.vended_tools.python_repl import make_python_repl, python_repl
from strands.vended_tools.python_repl.types import PYTHON_REPL_DESCRIPTION, PythonReplError


def _tool_context(sandbox=None) -> ToolContext:
    """Build a ToolContext whose agent exposes a sandbox (or a fresh local one)."""
    agent = SimpleNamespace(sandbox=sandbox or NotASandboxLocalEnvironment())
    return ToolContext(
        tool_use={"name": "python_repl", "toolUseId": "id", "input": {}}, agent=agent, invocation_state={}
    )


def _mock_sandbox(stdout: str = "", side_effect: BaseException | None = None) -> SimpleNamespace:
    result = ExecutionResult(exit_code=0, stdout=stdout, stderr="")
    return SimpleNamespace(execute_code=AsyncMock(return_value=result, side_effect=side_effect))


class TestShim:
    """The tool forwards to ``execute_code`` and maps the result."""

    @pytest.mark.asyncio
    async def test_default_tool_uses_agent_sandbox_and_defaults(self):
        sandbox = _mock_sandbox(stdout="hi\n")
        result = await python_repl(code="print('hi')", tool_context=_tool_context(sandbox))
        sandbox.execute_code.assert_awaited_once_with("print('hi')", "python3", timeout=120)
        assert result == {"output": "hi\n", "error": "", "exit_code": 0}

    @pytest.mark.asyncio
    async def test_bound_sandbox_language_and_timeout(self):
        bound, agent_sandbox = _mock_sandbox(), _mock_sandbox()
        tool = make_python_repl(sandbox=bound, language="python3.12")
        await tool(code="pass", tool_context=_tool_context(agent_sandbox), timeout=7)
        bound.execute_code.assert_awaited_once_with("pass", "python3.12", timeout=7)
        agent_sandbox.execute_code.assert_not_awaited()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("timeout", [0, -1])
    async def test_rejects_non_positive_timeout(self, timeout):
        sandbox = _mock_sandbox()
        with pytest.raises(ValueError, match="timeout must be a positive"):
            await python_repl(code="pass", tool_context=_tool_context(sandbox), timeout=timeout)
        sandbox.execute_code.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_wraps_sandbox_error_as_python_repl_error(self):
        boom = OSError("container gone")
        with pytest.raises(PythonReplError, match="container gone") as exc_info:
            await python_repl(code="pass", tool_context=_tool_context(_mock_sandbox(side_effect=boom)))
        assert exc_info.value.__cause__ is boom
        assert isinstance(exc_info.value, RuntimeError)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell required")
class TestLocalExecution:
    """End-to-end through ``NotASandboxLocalEnvironment``, the default agent sandbox."""

    @pytest.mark.asyncio
    async def test_runs_python(self):
        result = await python_repl(code="print(sum(range(10)))", tool_context=_tool_context())
        assert result == {"output": "45\n", "error": "", "exit_code": 0}

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("code", "expected_error"),
        [("raise ValueError('bad')", "ValueError: bad"), ("input()", "EOFError")],
        ids=["exception", "stdin_unavailable"],
    )
    async def test_failure_reports_error_and_nonzero_exit(self, code, expected_error):
        result = await python_repl(code=code, tool_context=_tool_context())
        assert result["exit_code"] != 0
        assert expected_error in result["error"]

    @pytest.mark.asyncio
    async def test_state_does_not_persist_but_files_do(self, tmp_path):
        path = str(tmp_path / "state.json")
        ctx = _tool_context()
        await python_repl(code=f"import json; x = 42; json.dump({{'x': x}}, open({path!r}, 'w'))", tool_context=ctx)

        missing = await python_repl(code="print(x)", tool_context=ctx)
        assert "NameError" in missing["error"]

        restored = await python_repl(code=f"import json; print(json.load(open({path!r}))['x'])", tool_context=ctx)
        assert restored["output"] == "42\n"

    @pytest.mark.asyncio
    async def test_timeout_carries_partial_output_with_success_field_names(self):
        with pytest.raises(SandboxTimeoutError) as exc_info:
            await python_repl(
                code="print('partial', flush=True)\nimport time; time.sleep(10)",
                tool_context=_tool_context(),
                timeout=1,
            )
        payload = json.loads(str(exc_info.value).split("\n", 1)[1])
        assert payload == {"output": "partial\n", "error": "", "exit_code": 124}


class TestMakePythonRepl:
    @pytest.mark.parametrize(
        ("kwargs", "match"),
        [
            ({"name": ""}, "name"),
            ({"language": ""}, "language"),
            ({"language": "python3; rm -rf /"}, "language"),
            ({"language": "py thon"}, "language"),
        ],
    )
    def test_rejects_invalid_arguments(self, kwargs, match):
        with pytest.raises(ValueError, match=match):
            make_python_repl(**kwargs)

    def test_default_tool_spec_and_exports(self):
        assert python_repl.tool_name == "python_repl"
        assert python_repl.tool_spec["description"] == PYTHON_REPL_DESCRIPTION
        schema = python_repl.tool_spec["inputSchema"]["json"]
        assert set(schema["properties"]) == {"code", "timeout"}
        assert schema["required"] == ["code"]
        assert vended_tools.python_repl is python_repl
        assert vended_tools.make_python_repl is make_python_repl

    def test_custom_name_and_description(self):
        tool = make_python_repl(name="run_python", description="custom")
        assert tool.tool_name == "run_python"
        assert tool.tool_spec["description"] == "custom"
