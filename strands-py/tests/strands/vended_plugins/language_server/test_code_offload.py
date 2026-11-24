"""CodeSkeletonStrategy: code a tool returns arrives as the skeleton of what it covered, the code in the stash."""

import asyncio
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from strands import Agent, tool
from strands.experimental.context_manager import ContextManager
from strands.storage import InMemoryStorage
from strands.types.content import Message
from strands.vended_plugins.language_server import (
    CodeSkeletonStrategy,
    StdioLspClient,
    WorkspaceSearch,
    workspace_retrieval_tool,
)
from tests.fixtures.mocked_model_provider import MockedModelProvider

pytestmark = pytest.mark.filterwarnings("ignore:context_window_limit is not set")

CLASS, METHOD, FUNCTION = 5, 6, 12

_PAD = "  # " + "padding so a range of this file is longer than its skeleton " * 2

SOURCE = f"""\
import os


class Store:
    def __init__(self, path):
        self.path = path{_PAD}

    def get(self, key):
        value = os.environ.get(key){_PAD}
        if value is None:{_PAD}
            return None{_PAD}
        return value.strip(){_PAD}


def run(store):
    return store.get("HOME"){_PAD}
"""


def _symbol(name: str, kind: int, start: int, end: int, children: list[Any] | None = None) -> dict[str, Any]:
    span = {"start": {"line": start - 1, "character": 0}, "end": {"line": end - 1, "character": 0}}
    return {"name": name, "kind": kind, "range": span, "selectionRange": span, "children": children or []}


SYMBOLS = [
    _symbol("Store", CLASS, 4, 12, [_symbol("__init__", METHOD, 5, 6), _symbol("get", METHOD, 8, 12)]),
    _symbol("run", FUNCTION, 15, 16),
]


class FakeOutlineClient:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail

    async def document_symbols(self, uri: str, **kwargs: Any) -> list[dict[str, Any]]:
        if self.fail:
            raise ConnectionError("language server went away")
        return SYMBOLS

    async def references(self, uri: str, position: Any, **kwargs: Any) -> list[dict[str, Any]]:
        return []

    async def definition(self, uri: str, position: Any, **kwargs: Any) -> dict[str, Any] | None:
        return None

    async def workspace_symbol(self, query: str, **kwargs: Any) -> list[dict[str, Any]]:
        return []


@pytest.fixture
def code_root(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "pkg").mkdir(parents=True)
    (root / "pkg" / "store.py").write_text(SOURCE)
    (root / "pkg" / "notes.md").write_text(SOURCE)
    return root


def _tools(root: Path):
    @tool(name="shell")
    def run_shell(command: str) -> dict[str, Any]:
        """Run a command.

        Args:
            command: The command.
        """
        done = subprocess.run(command, shell=True, capture_output=True, text=True, cwd=root, check=False)  # noqa: S602
        return {"output": done.stdout, "error": done.stderr, "exit_code": done.returncode}

    @tool(name="read")
    def read_file(path: str, offset: int = 1, limit: int = 2000) -> str:
        """Read a file.

        Args:
            path: The file.
            offset: First line.
            limit: Lines to read.
        """
        lines = (root / path).read_text().splitlines()[offset - 1 : offset - 1 + limit]
        return "\n".join(f"{number:>6}\t{line}" for number, line in enumerate(lines, start=offset))

    return [run_shell, read_file]


def _call(
    root: Path, name: str, tool_input: dict[str, Any], client: Any = None, targeted_lines: int | None = None
) -> tuple[Agent, dict[str, Any]]:
    """Run an agent that makes one tool call and answers; return it and the tool result the model saw."""
    model = MockedModelProvider(
        [
            Message(role="assistant", content=[{"toolUse": {"toolUseId": "c1", "name": name, "input": tool_input}}]),
            Message(role="assistant", content=[{"text": "Done."}]),
        ]
    )
    strategy = CodeSkeletonStrategy(client or FakeOutlineClient(), root, targeted_lines=targeted_lines)
    agent = Agent(
        model=model,
        tools=_tools(root),
        context_manager=ContextManager(strategies=[strategy], stash={"storage": InMemoryStorage()}),
        callback_handler=None,
    )
    agent("Look.")
    result = next(
        block["toolResult"] for message in agent.messages for block in message["content"] if "toolResult" in block
    )
    return agent, result


@pytest.mark.parametrize(
    "command",
    [
        "cat pkg/store.py",
        "cd pkg; sed -n 8,12p store.py; sed -n 15,16p store.py",
        'cd pkg && grep -n "def get" -A4 store.py',
        "grep -rn -A4 'def get' pkg --include=*.py",
        "head -n 16 pkg/store.py",
    ],
)
def test_code_a_read_only_command_prints_arrives_as_its_skeleton(code_root, command):
    agent, result = _call(code_root, "shell", {"command": command})

    [placeholder] = result["content"]
    text = placeholder["text"]
    assert text.startswith("Code offloaded to save context")
    assert "pkg/store.py: lines " in text
    assert "L8-12 def get(self, key):" in text
    assert placeholder["offloaded"]["method"] == "skeleton"
    stashed = asyncio.run(agent._context_manager.stash.retrieve("c1_0"))
    assert json.loads(stashed["text"])["output"].count("value.strip()") == 1


def test_the_skeleton_lists_only_what_the_result_covered(code_root):
    _, result = _call(code_root, "shell", {"command": "sed -n 8,12p pkg/store.py"})

    text = result["content"][0]["text"]
    assert "pkg/store.py: lines 8-12 of 16" in text
    assert "  L4-12 class Store:" in text
    assert "    L8-12 def get(self, key):" in text
    assert "__init__" not in text and "def run" not in text


def test_a_ranged_read_arrives_as_its_skeleton(code_root):
    _, result = _call(code_root, "read", {"path": "pkg/store.py", "offset": 5, "limit": 8})

    text = result["content"][0]["text"]
    assert "pkg/store.py: lines 5-12 of 16" in text
    assert "    L5-6 def __init__(self, path):" in text


def test_output_that_is_not_code_stays_in_the_skeleton(code_root):
    _, result = _call(code_root, "shell", {"command": "cd pkg; ls; sed -n 8,12p store.py"})

    text = result["content"][0]["text"]
    assert "Other output:\nnotes.md\nstore.py" in text


@pytest.mark.parametrize(
    "command",
    [
        "sed -n 8,12p pkg/notes.md",  # not a code file
        "python -c 'print(open(\"pkg/store.py\").read())'",  # runs code
        "cat pkg/store.py > /tmp/copy.py",  # redirects
        "sed -i 's/HOME/PATH/' pkg/store.py; sed -n 16p pkg/store.py",  # writes
        "grep -n import pkg/store.py",  # one short hit: the skeleton would be longer
        "sed -n 9,10p pkg/missing.py",  # failed
    ],
)
def test_other_results_arrive_in_full(code_root, command):
    _, result = _call(code_root, "shell", {"command": command})

    assert not result["content"][0]["text"].startswith("Code offloaded")


def test_a_language_server_failure_keeps_the_result(code_root):
    _, result = _call(code_root, "shell", {"command": "cat pkg/store.py"}, FakeOutlineClient(fail=True))

    assert json.loads(result["content"][0]["text"])["output"] == SOURCE


def test_retrieve_context_returns_exact_lines_by_path(code_root):
    manager = ContextManager(strategies=[], stash={"retrieval_tool": False})
    retrieve = workspace_retrieval_tool(manager, WorkspaceSearch(FakeOutlineClient(), code_root))
    tool_use = {
        "toolUseId": "r1",
        "name": "retrieve_context",
        "input": {"path": "pkg/store.py", "line_range": {"start": 8, "end": 9}},
    }

    result = asyncio.run(retrieve._tool_func(tool_use))

    assert result["content"][0]["text"].splitlines() == [
        "pkg/store.py L8-9 of 16:",
        "     8\t    def get(self, key):",
        "     9\t        value = os.environ.get(key)" + _PAD,
    ]


def test_rejects_no_tools(code_root):
    with pytest.raises(ValueError, match="read_tools and shell_tools are empty"):
        CodeSkeletonStrategy(FakeOutlineClient(), code_root, read_tools=[], shell_tools=[])


@pytest.mark.skipif(shutil.which("pyright-langserver") is None, reason="pyright-langserver is not on PATH")
def test_pyright_outlines_a_real_sed_range(code_root):
    with StdioLspClient(["pyright-langserver", "--stdio"], code_root) as client:
        _, result = _call(code_root, "shell", {"command": "sed -n 8,16p pkg/store.py"}, client)

    text = result["content"][0]["text"]
    assert "L8-12 def get(self, key):" in text
    assert "L15-16 def run(store):" in text


@pytest.mark.parametrize(
    ("command", "offloaded"),
    [
        ("sed -n 8,9p pkg/store.py", False),  # part of one file, within targeted_lines
        ("sed -n 8,12p pkg/store.py", True),  # more lines than targeted_lines
        ("cat pkg/store.py", True),  # all of one file
        ("cat pkg/store.py pkg/other.py", True),  # more than one file
    ],
)
def test_with_targeted_lines_only_broad_reads_are_offloaded(code_root, command, offloaded):
    (code_root / "pkg" / "other.py").write_text(SOURCE.replace("Store", "Other"))

    _, result = _call(code_root, "shell", {"command": command}, targeted_lines=3)

    assert result["content"][0]["text"].startswith("Code offloaded") is offloaded


def test_rejects_targeted_lines_below_one(code_root):
    with pytest.raises(ValueError, match="targeted_lines=0 is invalid"):
        CodeSkeletonStrategy(FakeOutlineClient(), code_root, targeted_lines=0)
