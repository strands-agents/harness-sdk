"""SkeletonStrategy: large whole-file code reads arrive as an outline, with the original in the stash."""

import asyncio
import shutil
from pathlib import Path
from typing import Any

import pytest

from strands import Agent, tool
from strands.experimental.context_manager import ContextManager
from strands.storage import InMemoryStorage
from strands.types.content import Message
from strands.vended_plugins.language_server import SkeletonStrategy, StdioLspClient
from strands.vended_plugins.language_server.skeleton import render_skeleton
from tests.fixtures.mocked_model_provider import MockedModelProvider

CLASS, METHOD, FUNCTION, VARIABLE = 5, 6, 12, 13

SOURCE = """\
import os
from typing import (
    Any,
    Callable,
)

LIMIT = 3


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        local = 1

    def get(
        self, key: str, default: Any = None
    ) -> Any:
        return os.environ.get(key, default)


def run(callback: Callable[[], None]) -> None:
    callback()
""" + "".join(f"# filler line {index} padded so the file is well over the threshold\n" for index in range(400))


def _symbol(name: str, kind: int, start: int, end: int, children: list[Any] | None = None) -> dict[str, Any]:
    span = {"start": {"line": start, "character": 0}, "end": {"line": end, "character": 0}}
    return {"name": name, "kind": kind, "range": span, "selectionRange": span, "children": children or []}


SYMBOLS = [
    _symbol("LIMIT", VARIABLE, 6, 6),
    _symbol(
        "Store",
        CLASS,
        9,
        17,
        [
            _symbol("__init__", METHOD, 10, 12, [_symbol("local", VARIABLE, 12, 12)]),
            _symbol("get", METHOD, 14, 17),
        ],
    ),
    _symbol("run", FUNCTION, 20, 21),
]


class FakeOutlineClient:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.uris: list[str] = []

    async def document_symbols(self, uri: str, **kwargs: Any) -> list[dict[str, Any]]:
        self.uris.append(uri)
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
    (root / "tests").mkdir()
    (root / "pkg" / "store.py").write_text(SOURCE)
    (root / "pkg" / "small.py").write_text("X = 1\n")
    (root / "tests" / "test_store.py").write_text(SOURCE)
    (root / "pkg" / "notes.md").write_text(SOURCE)
    return root


@tool(name="read")
def read_file(path: str, offset: int | None = None) -> str:
    """Read a file.

    Args:
        path: The file.
        offset: First line to read.
    """
    return Path(path).read_text()


def _read_once(strategy: SkeletonStrategy, tool_input: dict[str, Any]) -> tuple[Agent, dict[str, Any]]:
    """Run an agent that reads once and answers, returning it and the tool result the model saw."""
    model = MockedModelProvider(
        [
            Message(role="assistant", content=[{"toolUse": {"toolUseId": "r1", "name": "read", "input": tool_input}}]),
            Message(role="assistant", content=[{"text": "Done."}]),
        ]
    )
    agent = Agent(
        model=model,
        tools=[read_file],
        context_manager=ContextManager(strategies=[strategy], stash={"storage": InMemoryStorage()}),
        callback_handler=None,
    )
    agent("Read it.")
    result = next(
        block["toolResult"] for message in agent.messages for block in message["content"] if "toolResult" in block
    )
    return agent, result


def test_render_skeleton_keeps_imports_and_lists_signatures():
    text = render_skeleton(SOURCE.splitlines(), SYMBOLS, "pkg/store.py")

    assert text.splitlines() == [
        "Skeleton of pkg/store.py (422 lines): imports and signatures, bodies omitted to save context. Retrieve the"
        ' full file with retrieve_context and the reference below, or read a line range of "pkg/store.py".',
        "imports:",
        "   1 | import os",
        "   2 | from typing import (",
        "   3 |     Any,",
        "   4 |     Callable,",
        "   5 | )",
        "L7-7 LIMIT = 3",
        "L10-18 class Store:",
        "  L11-13 def __init__(self, path: str) -> None:",
        "  L15-18 def get( self, key: str, default: Any = None ) -> Any:",
        "L21-22 def run(callback: Callable[[], None]) -> None:",
    ]


def test_render_skeleton_caps_the_symbols_it_lists():
    many = [_symbol(f"name_{index}", FUNCTION, index, index) for index in range(130)]
    lines = [f"def name_{index}(): ..." for index in range(130)]

    text = render_skeleton(lines, many, "big.py")

    assert text.splitlines()[-1] == "... 10 more symbols"


@pytest.mark.filterwarnings("ignore:context_window_limit is not set")
def test_a_large_whole_file_read_arrives_as_its_skeleton(code_root):
    client = FakeOutlineClient()
    path = code_root / "pkg" / "store.py"

    agent, result = _read_once(SkeletonStrategy(client, code_root), {"path": str(path)})

    [placeholder] = result["content"]
    assert placeholder["text"].startswith("Skeleton of pkg/store.py (422 lines)")
    assert placeholder["text"].endswith(" [ref: r1]")
    assert "L15-18 def get(" in placeholder["text"]
    assert placeholder["offloaded"]["method"] == "skeleton"
    assert placeholder["offloaded"]["ref"] == "r1"
    assert result["toolUseId"] == "r1" and result["status"] == "success"
    assert client.uris == [path.as_uri()]
    stash = agent._context_manager.stash  # the stash the ContextManager wrote on arrival
    assert asyncio.run(stash.retrieve("r1_0")) == {"text": SOURCE}


@pytest.mark.filterwarnings("ignore:context_window_limit is not set")
@pytest.mark.parametrize(
    ("relative", "extra"),
    [
        ("pkg/small.py", {}),  # under the threshold
        ("pkg/store.py", {"offset": 10}),  # a line range
        ("tests/test_store.py", {}),  # a test file
        ("pkg/notes.md", {}),  # not a listed extension
    ],
)
def test_other_reads_arrive_in_full(code_root, relative, extra):
    client = FakeOutlineClient()
    path = code_root / relative

    _, result = _read_once(SkeletonStrategy(client, code_root), {"path": str(path), **extra})

    assert result["content"] == [{"text": path.read_text()}]
    assert client.uris == []


@pytest.mark.filterwarnings("ignore:context_window_limit is not set")
def test_a_file_outside_the_root_arrives_in_full(code_root, tmp_path):
    outside = tmp_path / "elsewhere.py"
    outside.write_text(SOURCE)

    _, result = _read_once(SkeletonStrategy(FakeOutlineClient(), code_root), {"path": str(outside)})

    assert result["content"] == [{"text": SOURCE}]


@pytest.mark.filterwarnings("ignore:context_window_limit is not set")
def test_a_language_server_failure_keeps_the_full_read(code_root):
    path = code_root / "pkg" / "store.py"

    _, result = _read_once(SkeletonStrategy(FakeOutlineClient(fail=True), code_root), {"path": str(path)})

    assert result["content"] == [{"text": SOURCE}]


@pytest.mark.filterwarnings("ignore:context_window_limit is not set")
def test_when_sets_the_threshold(code_root):
    path = code_root / "pkg" / "store.py"
    strategy = SkeletonStrategy(FakeOutlineClient(), code_root).when(block_threshold=100_000)

    _, result = _read_once(strategy, {"path": str(path)})

    assert result["content"] == [{"text": SOURCE}]


def test_defaults(code_root):
    strategy = SkeletonStrategy(FakeOutlineClient(), code_root)

    assert strategy.name == "offload:skeleton"
    assert strategy._conditions.block_threshold.value == 1_500
    assert strategy._runs_eagerly


def test_rejects_an_empty_read_tool_list(code_root):
    with pytest.raises(ValueError, match="read_tools is empty"):
        SkeletonStrategy(FakeOutlineClient(), code_root, read_tools=[])


@pytest.mark.skipif(shutil.which("pyright-langserver") is None, reason="pyright-langserver is not on PATH")
@pytest.mark.filterwarnings("ignore:context_window_limit is not set")
def test_pyright_outlines_a_real_file(code_root):
    path = code_root / "pkg" / "store.py"
    with StdioLspClient(["pyright-langserver", "--stdio"], code_root) as client:
        _, result = _read_once(SkeletonStrategy(client, code_root), {"path": str(path)})

    text = result["content"][0]["text"]
    assert "L10-18 class Store:" in text
    assert "  L15-18 def get( self, key: str, default: Any = None ) -> Any:" in text
    assert "L21-22 def run(callback: Callable[[], None]) -> None:" in text
    assert "local" not in text
