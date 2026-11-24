import gc
import logging
import shutil
from pathlib import Path
from typing import Any

import pytest
from strands.experimental.context_manager import ContextManager
from strands.vended_plugins import language_server
from strands.vended_plugins.language_server import CodeSkeletonStrategy, LspStrategy

from strands_harness import create_harness
from strands_harness import lsp as lsp_module
from strands_harness.tools import AgentSpec
from strands_harness.tools.subagent import GENERALIST


class FakeStdioLspClient:
    """Stands in for the stdio client so the pipeline builds without a language server."""

    started: list[tuple[list[str], str]] = []

    def __init__(self, command: list[str], root: Any, **kwargs: Any) -> None:
        FakeStdioLspClient.started.append((command, str(root)))

    async def document_symbols(self, uri: str, **kwargs: Any) -> list[dict[str, Any]]:
        return []

    async def workspace_symbol(self, query: str, **kwargs: Any) -> list[dict[str, Any]]:
        return []

    async def references(self, uri: str, position: Any, **kwargs: Any) -> list[dict[str, Any]]:
        return []

    async def definition(self, uri: str, position: Any, **kwargs: Any) -> dict[str, Any] | None:
        return None

    def close(self) -> None:
        pass


@pytest.fixture
def workdir(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.fixture
def fake_server(monkeypatch):
    FakeStdioLspClient.started = []
    monkeypatch.setattr(language_server, "StdioLspClient", FakeStdioLspClient)
    return FakeStdioLspClient


def _strategies(agent) -> list[Any]:
    return agent._context_manager._strategies


def test_lsp_builds_skeletons_relevance_and_auto_with_a_workspace_retrieve_context(workdir, fake_server):
    agent = create_harness(context_manager="lsp")

    [(command, root)] = fake_server.started
    assert (Path(command[0]).name, command[1:], root) == ("pyright-langserver", ["--stdio"], str(workdir))
    names = [strategy.name for strategy in _strategies(agent)]
    assert names == [
        "offload:skeleton",
        "offload:lsp",
        "offload:truncate",
        "offload:summarize",
        "offload:emergency-truncate",
    ]
    assert isinstance(_strategies(agent)[0], CodeSkeletonStrategy)
    assert isinstance(_strategies(agent)[1], LspStrategy)
    assert agent.tool_names.count("retrieve_context") == 1
    schema = agent.tool_registry.registry["retrieve_context"].tool_spec["inputSchema"]
    assert "symbol" in schema.get("json", schema)["properties"]
    assert agent.state.get("context_manager") == {"requested": "lsp", "active": "lsp"}


def test_lsp_skeletons_the_harness_read_tool(workdir, fake_server):
    skeleton = _strategies(create_harness(context_manager="lsp"))[0]

    assert skeleton._read_tools == ("read",)
    assert skeleton._shell_tools == ("shell",)


def test_lsp_falls_back_to_auto_when_the_server_is_missing(workdir, monkeypatch, caplog):
    monkeypatch.setattr(lsp_module, "LSP_COMMAND", ["no-such-langserver", "--stdio"])

    with caplog.at_level(logging.WARNING, logger="strands_harness.lsp"):
        agent = create_harness(context_manager="lsp")

    assert isinstance(agent._context_manager, ContextManager)
    assert [strategy.name for strategy in _strategies(agent)] == [
        "offload:truncate",
        "offload:summarize",
        "offload:emergency-truncate",
    ]
    assert agent.tool_names.count("retrieve_context") == 1
    status = agent.state.get("context_manager")
    assert status["requested"] == "lsp" and status["active"] == "auto"
    assert "LanguageServerNotFoundError" in status["reason"]
    assert "falling back to auto" in caplog.text


def test_lsp_falls_back_to_auto_when_the_server_fails_to_start(workdir, monkeypatch):
    def failing(*args: Any, **kwargs: Any) -> None:
        raise TimeoutError("method=<initialize> | language server timed out before answering")

    monkeypatch.setattr(language_server, "StdioLspClient", failing)

    status = create_harness(context_manager="lsp").state.get("context_manager")

    assert status == {
        "requested": "lsp",
        "active": "auto",
        "reason": "TimeoutError: method=<initialize> | language server timed out before answering",
    }


def test_other_context_managers_record_nothing(workdir):
    assert create_harness().state.get("context_manager") is None


def test_a_subagent_of_an_lsp_harness_runs_auto(workdir, fake_server):
    parent = create_harness(context_manager="lsp")
    spec = AgentSpec(name="subagent", agent_type="generalist", instructions=GENERALIST.instructions)

    child = parent.tool_registry.registry["subagent"]._builder(spec)

    assert len(fake_server.started) == 1
    assert [strategy.name for strategy in _strategies(child)] == [
        "offload:truncate",
        "offload:summarize",
        "offload:emergency-truncate",
    ]


@pytest.mark.skipif(
    shutil.which(lsp_module._server_command(lsp_module.LSP_COMMAND)[0]) is None,
    reason="pyright-langserver is not installed",
)
def test_lsp_starts_pyright(workdir):
    (workdir / "app.py").write_text("def main() -> int:\n    return 1\n")

    agent = create_harness(context_manager="lsp")

    assert agent.state.get("context_manager") == {"requested": "lsp", "active": "lsp"}


def test_lsp_finds_the_server_next_to_the_interpreter_when_it_is_not_on_path(workdir, fake_server, monkeypatch):
    bin_dir = workdir / "venv-bin"
    bin_dir.mkdir()
    server = bin_dir / "pyright-langserver"
    server.write_text("#!/bin/sh\n")
    server.chmod(0o755)
    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(lsp_module.sys, "executable", str(bin_dir / "python"))

    create_harness(context_manager="lsp")

    assert fake_server.started == [([str(server), "--stdio"], str(workdir))]


def test_lsp_falls_back_to_auto_in_a_non_local_sandbox(workdir, fake_server):
    from strands.sandbox import PosixShellSandbox

    class RemoteSandbox(PosixShellSandbox):
        async def execute_streaming(self, command, *, timeout=None, cwd=None, env=None, **kwargs):
            raise NotImplementedError
            yield

    status = create_harness(context_manager="lsp", sandbox=RemoteSandbox()).state.get("context_manager")

    assert fake_server.started == []
    assert status["active"] == "auto"
    assert "RemoteSandbox" in status["reason"]


def test_lsp_shuts_the_server_down_with_the_agent(workdir, fake_server, monkeypatch):
    closed: list[bool] = []
    monkeypatch.setattr(FakeStdioLspClient, "close", lambda self: closed.append(True))
    agent = create_harness(context_manager="lsp")

    del agent
    gc.collect()

    assert closed == [True]


def test_lsp_adds_no_plugins(workdir, fake_server):
    from strands.vended_plugins.language_server import CodeFetchEnricher

    agent = create_harness(context_manager="lsp")

    assert not [p for p in agent._plugin_registry._plugins.values() if isinstance(p, CodeFetchEnricher)]
