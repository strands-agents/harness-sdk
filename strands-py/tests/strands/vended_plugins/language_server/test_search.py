"""WorkspaceSearch and the retrieve_context that adds it to the stash lookup."""

import shutil
from pathlib import Path
from typing import Any

import pytest

from strands import Agent
from strands.experimental.context_manager import ContextManager
from strands.storage import InMemoryStorage
from strands.types.content import Message
from strands.vended_plugins.language_server import StdioLspClient, WorkspaceSearch, workspace_retrieval_tool
from tests.fixtures.mocked_model_provider import MockedModelProvider

FUNCTION, CLASS, METHOD = 12, 5, 6

STORE = (
    "class Store:\n    def get(self, key):\n        return RETRY_LIMIT\n\n\ndef helper():\n    return 'retry_limit'\n"
)
OTHER = "def helper():\n    return 2\n"
CONFIG = "RETRY_LIMIT = 3\n"


def _symbol(name: str, kind: int, start: int, end: int, children: list[Any] | None = None) -> dict[str, Any]:
    span = {"start": {"line": start, "character": 0}, "end": {"line": end, "character": 0}}
    return {"name": name, "kind": kind, "range": span, "selectionRange": span, "children": children or []}


SYMBOLS = {
    "store.py": [_symbol("Store", CLASS, 0, 2, [_symbol("get", METHOD, 1, 2)]), _symbol("helper", FUNCTION, 5, 6)],
    "other.py": [_symbol("helper", FUNCTION, 0, 1)],
    "config.py": [],
}


class FakeSymbolClient:
    def __init__(self, root: Path) -> None:
        self.root = root

    async def workspace_symbol(self, query: str, **kwargs: Any) -> list[dict[str, Any]]:
        return [
            {"name": query, "location": {"uri": (self.root / "pkg" / file).as_uri()}}
            for file, symbols in SYMBOLS.items()
            if any(symbol["name"] == query for symbol in _walk(symbols))
        ]

    async def document_symbols(self, uri: str, **kwargs: Any) -> list[dict[str, Any]]:
        return SYMBOLS[uri.rsplit("/", 1)[-1]]

    async def references(self, uri: str, position: Any, **kwargs: Any) -> list[dict[str, Any]]:
        return []

    async def definition(self, uri: str, position: Any, **kwargs: Any) -> dict[str, Any] | None:
        return None


def _walk(symbols: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [nested for symbol in symbols for nested in [symbol, *_walk(symbol["children"])]]


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "pkg").mkdir(parents=True)
    (root / ".venv").mkdir()
    (root / "pkg" / "store.py").write_text(STORE)
    (root / "pkg" / "other.py").write_text(OTHER)
    (root / "pkg" / "config.py").write_text(CONFIG)
    (root / ".venv" / "vendored.py").write_text("RETRY_LIMIT = 9\n")
    return root


@pytest.fixture
def search(repo: Path) -> WorkspaceSearch:
    return WorkspaceSearch(FakeSymbolClient(repo), repo)


@pytest.mark.asyncio
async def test_find_symbol_returns_the_definition_with_line_numbers(search):
    assert await search.find_symbol("Store") == (
        "pkg/store.py L1-3 (Store):\n"
        "   1 | class Store:\n"
        "   2 |     def get(self, key):\n"
        "   3 |         return RETRY_LIMIT"
    )


@pytest.mark.asyncio
async def test_find_symbol_finds_a_method_inside_a_file(search):
    assert (await search.find_symbol("get", "pkg/store.py")).startswith("pkg/store.py L2-3 (get):")


@pytest.mark.asyncio
async def test_find_symbol_lists_definitions_that_share_a_name(search):
    assert await search.find_symbol("helper") == (
        "2 definitions named 'helper': pkg/other.py L1, pkg/store.py L6. Pass path= to choose one."
    )
    assert (await search.find_symbol("helper", "pkg/other.py")).startswith("pkg/other.py L1-2 (helper):")


@pytest.mark.asyncio
async def test_find_symbol_falls_back_to_grep_when_no_definition_has_the_name(search):
    assert await search.find_symbol("RETRY_LIMIT") == (
        "No definition named 'RETRY_LIMIT'; text matches instead.\n"
        "2 matching lines for 'RETRY_LIMIT':\n"
        "pkg/config.py:1: RETRY_LIMIT = 3\n"
        "pkg/store.py:3: return RETRY_LIMIT"
    )


@pytest.mark.asyncio
async def test_grep_returns_plain_lines_in_file_order_and_skips_hidden_and_vendored_dirs(search):
    assert await search.grep("(?i)retry_limit") == (
        "3 matching lines for '(?i)retry_limit':\n"
        "pkg/config.py:1: RETRY_LIMIT = 3\n"
        "pkg/store.py:3: return RETRY_LIMIT\n"
        "pkg/store.py:7: return 'retry_limit'"
    )


@pytest.mark.asyncio
async def test_grep_searches_an_invalid_regex_as_text_and_narrows_to_a_path(search, repo):
    (repo / "pkg" / "other.py").write_text("x = f(\n")

    assert await search.grep("f(", "pkg/other.py") == "1 matching lines for 'f(':\npkg/other.py:1: x = f("
    assert await search.grep("nothing here") == "No matches for 'nothing here'."


@pytest.mark.asyncio
async def test_a_path_outside_the_workspace_is_refused(search):
    assert await search.grep("x", "../elsewhere") == "No file or directory ../elsewhere in the workspace."
    assert await search.find_symbol("Store", "missing.py") == "No file or directory missing.py in the workspace."


@pytest.mark.asyncio
async def test_long_results_are_cut_with_a_note_to_narrow(repo):
    (repo / "pkg" / "many.py").write_text("".join(f"hit_{index} = 1\n" for index in range(500)))
    search = WorkspaceSearch(FakeSymbolClient(repo), repo, max_chars=200)

    text = await search.grep("hit_")

    assert len(text) < 260
    assert text.endswith("... (truncated; pass path= to narrow the search)")


@pytest.mark.filterwarnings("ignore:context_window_limit is not set")
def test_the_tool_replaces_the_built_in_one_and_serves_references_symbols_and_patterns(search):
    manager = ContextManager(strategies=[], stash={"storage": InMemoryStorage(), "retrieval_tool": False})
    calls = [
        {"reference": "old"},
        {"symbol": "Store"},
        {"pattern": "RETRY_LIMIT", "path": "pkg/config.py"},
        {},
    ]
    responses = [
        Message(
            role="assistant",
            content=[{"toolUse": {"toolUseId": f"c{index}", "name": "retrieve_context", "input": call}}],
        )
        for index, call in enumerate(calls)
    ]
    history = [
        Message(role="user", content=[{"text": "start"}]),
        Message(role="assistant", content=[{"toolUse": {"toolUseId": "old", "name": "read", "input": {}}}]),
        Message(
            role="user",
            content=[{"toolResult": {"toolUseId": "old", "status": "success", "content": [{"text": "stashed text"}]}}],
        ),
        Message(role="assistant", content=[{"text": "ok"}]),
    ]
    agent = Agent(
        model=MockedModelProvider([*responses, Message(role="assistant", content=[{"text": "Done."}])]),
        messages=history,
        context_manager=manager,
        tools=[workspace_retrieval_tool(manager, search)],
        callback_handler=None,
    )

    agent("Look things up.")

    assert agent.tool_names == ["retrieve_context"]
    answers = {
        block["toolResult"]["toolUseId"]: block["toolResult"]["content"][0]["text"]
        for message in agent.messages
        for block in message["content"]
        if "toolResult" in block
    }
    assert "stashed text" in answers["c0"]
    assert answers["c1"].startswith("pkg/store.py L1-3 (Store):")
    assert answers["c2"] == "1 matching lines for 'RETRY_LIMIT':\npkg/config.py:1: RETRY_LIMIT = 3"
    assert (
        answers["c3"]
        == "Pass reference= for offloaded content, path= with line_range= for exact lines, symbol= for a definition,"
        " or pattern=."
    )


@pytest.mark.skipif(shutil.which("pyright-langserver") is None, reason="pyright-langserver is not on PATH")
@pytest.mark.asyncio
async def test_pyright_finds_a_definition_across_the_workspace(repo):
    with StdioLspClient(["pyright-langserver", "--stdio"], repo) as client:
        text = await WorkspaceSearch(client, repo).find_symbol("Store")

    assert text.startswith("pkg/store.py L1-3 (Store):")
