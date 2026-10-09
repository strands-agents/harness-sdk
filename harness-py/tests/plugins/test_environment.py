"""Tests for the EnvironmentContext plugin: what it injects and how it reads the sandbox."""

from strands.sandbox.types import ExecutionResult, FileInfo

from strands_harness import create_harness
from strands_harness.plugins import EnvironmentContext
from strands_harness.plugins import environment as env


class _FakeSandbox:
    """A minimal sandbox: a flat file map and a per-directory listing map."""

    def __init__(self, files: dict[str, str], tree: dict[str, list[FileInfo]], cwd: str | None = "/work"):
        self._files = files
        self._tree = tree
        self._cwd = cwd
        self.list_calls = 0

    async def read_text(self, path: str) -> str:
        if path not in self._files:
            raise FileNotFoundError(path)
        return self._files[path]

    async def list_files(self, path: str) -> list[FileInfo]:
        self.list_calls += 1
        if path not in self._tree:
            raise FileNotFoundError(path)
        return self._tree[path]

    async def execute(self, command: str) -> ExecutionResult:
        if self._cwd is None:
            raise RuntimeError("no shell")
        out = "Linux" if command.startswith("uname") else self._cwd
        return ExecutionResult(exit_code=0, stdout=f"{out}\n", stderr="")


class _FakeAgent:
    def __init__(self, sandbox: _FakeSandbox):
        self.sandbox = sandbox


def _repo_tree() -> dict[str, list[FileInfo]]:
    return {
        ".": [
            FileInfo("AGENTS.md", False),
            FileInfo("README.md", False),
            FileInfo("harness-py", True),
            FileInfo("node_modules", True),
            FileInfo(".git", True),
        ],
        "harness-py": [FileInfo("AGENTS.md", False), FileInfo("README.md", False), FileInfo("src", True)],
        "harness-py/src": [FileInfo("AGENTS.md", False)],
    }


async def test_render_includes_env_agents_md_and_nearby_links():
    sandbox = _FakeSandbox({"AGENTS.md": "root agents doc"}, _repo_tree())
    out = await env._render(_FakeAgent(sandbox), {})
    assert out is not None
    # Platform and cwd come from the sandbox probe (uname/pwd), not the host process.
    assert "<environment>" in out and "Platform: Linux" in out and "Date:" in out
    assert "Working directory: /work" in out
    # The working-directory AGENTS.md is shown in full...
    assert "<AGENTS.md>\nroot agents doc\n</AGENTS.md>" in out
    # ...nested ones are links, not contents.
    assert "harness-py/AGENTS.md" in out
    assert "harness-py/README.md" in out
    # Dependency and VCS trees are skipped.
    assert "node_modules" not in out and ".git" not in out


async def test_depth_limit_stops_the_walk():
    # Depth 2 reaches harness-py/src (level 2) but the plugin still only lists to that depth.
    sandbox = _FakeSandbox({"AGENTS.md": "x"}, _repo_tree())
    out = await env._render(_FakeAgent(sandbox), {})
    assert "harness-py/src/AGENTS.md" in out


async def test_missing_agents_md_omits_the_section():
    sandbox = _FakeSandbox({}, {".": [FileInfo("main.py", False)]})
    out = await env._render(_FakeAgent(sandbox), {})
    assert "<AGENTS.md>" not in out
    assert "<environment>" in out


async def test_oversize_agents_md_is_truncated():
    big = "a" * (env._AGENTS_MD_CAP + 500)
    sandbox = _FakeSandbox({"AGENTS.md": big}, {".": [FileInfo("AGENTS.md", False)]})
    out = await env._render(_FakeAgent(sandbox), {})
    assert "truncated" in out
    assert len(out) < len(big)


async def test_probe_failure_omits_platform_and_working_directory():
    # cwd=None makes the fake shell raise, so both sandbox probes (uname/pwd) fail; only the date
    # survives, and the block still renders.
    sandbox = _FakeSandbox({"AGENTS.md": "x"}, {".": [FileInfo("AGENTS.md", False)]}, cwd=None)
    out = await env._render(_FakeAgent(sandbox), {})
    assert "Working directory" not in out
    assert "Platform" not in out
    assert "Date:" in out


async def test_discovery_is_memoized_across_turns():
    sandbox = _FakeSandbox({"AGENTS.md": "x"}, _repo_tree())
    memo: dict = {}
    await env._render(_FakeAgent(sandbox), memo)
    calls_after_first = sandbox.list_calls
    await env._render(_FakeAgent(sandbox), memo)
    assert sandbox.list_calls == calls_after_first  # second turn re-uses the walk


def test_enabled_by_default_and_opt_out():
    agent = create_harness()
    assert any(isinstance(p, EnvironmentContext) for p in agent._plugin_registry._plugins.values())
    bare = create_harness(builtin_plugins=[])
    assert not any(isinstance(p, EnvironmentContext) for p in bare._plugin_registry._plugins.values())
