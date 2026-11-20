"""LspStrategy against a fake language server that answers from a symbol table."""

import asyncio
import shutil
from pathlib import Path
from typing import Any

import pytest

from strands import Agent
from strands._context_manager.retrieval_tool import RETRIEVAL_TOOL_NAME
from strands._context_manager.stash import Stash
from strands.experimental.context_manager import ContextManager
from strands.storage import InMemoryStorage, LocalFileStorage
from strands.types.content import Message, Messages
from strands.vended_plugins.language_server import LspClient, LspStrategy, StdioLspClient
from tests.fixtures.context_manager_helpers import make_context
from tests.fixtures.mocked_model_provider import MockedModelProvider

from ._session import FILES, conversation, read_pair, results

FUNCTION, CLASS, METHOD, VARIABLE = 12, 5, 6, 13

# file -> (name, kind, line, children) for each top-level symbol it defines.
SYMBOLS: dict[str, list[tuple[str, int, int, list[Any]]]] = {
    "a.py": [("main", FUNCTION, 3, [])],
    "b.py": [("helper", FUNCTION, 0, [])],
    "c.py": [("unrelated", FUNCTION, 0, []), ("Logger", CLASS, 4, [("log", METHOD, 5, [])])],
    "d.py": [],
}
# symbol name -> files that reference it.
REFERENCES = {"main": ["d.py"], "helper": ["a.py"]}


class FakeLspClient:
    """Answers document symbols, references and workspace symbols from the tables above."""

    def __init__(
        self,
        root: Path,
        symbols: dict[str, list[tuple[str, int, int, list[Any]]]] | None = None,
        references: dict[str, list[str]] | None = None,
        fail_on: str | None = None,
    ) -> None:
        self.root = root
        self.symbols = SYMBOLS if symbols is None else symbols
        self.reference_table = REFERENCES if references is None else references
        self.fail_on = fail_on
        self.calls: list[tuple[str, str]] = []

    async def document_symbols(self, uri: str, **kwargs: Any) -> list[dict[str, Any]]:
        name = self._file(uri)
        self._record("document_symbols", name)
        return [_document_symbol(*entry) for entry in self.symbols.get(name, [])]

    async def references(self, uri: str, position: Any, **kwargs: Any) -> list[dict[str, Any]]:
        name = self._file(uri)
        self._record("references", name)
        symbol = next(entry[0] for entry in _all_symbols(self.symbols[name]) if entry[2] == position["line"])
        return [{"uri": (self.root / file).as_uri()} for file in self.reference_table.get(symbol, [])]

    async def workspace_symbol(self, query: str, **kwargs: Any) -> list[dict[str, Any]]:
        self._record("workspace_symbol", query)
        defining = [file for file, entries in self.symbols.items() if any(e[0] == query for e in _all_symbols(entries))]
        return [{"name": query, "location": {"uri": (self.root / file).as_uri()}} for file in defining]

    async def definition(self, uri: str, position: Any, **kwargs: Any) -> dict[str, Any] | None:
        return None

    def _file(self, uri: str) -> str:
        return uri.rsplit("/", 1)[-1]

    def _record(self, method: str, argument: str) -> None:
        self.calls.append((method, argument))
        if self.fail_on == argument:
            raise ConnectionError("language server went away")


def _document_symbol(name: str, kind: int, line: int, children: list[Any]) -> dict[str, Any]:
    start = {"line": line, "character": 4}
    return {
        "name": name,
        "kind": kind,
        "selectionRange": {"start": start, "end": start},
        "children": [_document_symbol(*child) for child in children],
    }


def _all_symbols(entries: list[tuple[str, int, int, list[Any]]]) -> list[tuple[str, int, int, list[Any]]]:
    return [nested for entry in entries for nested in [entry, *_all_symbols(entry[3])]]


@pytest.fixture
def stash() -> Stash:
    return Stash(InMemoryStorage(), "session", "agent")


async def _stashed_context(messages: Messages, stash: Stash | None, **context: Any) -> Any:
    if stash is not None:
        for message in messages:
            await stash.store_message(message)
    return make_context(messages, stash=stash, utilization=context.pop("utilization", 0.9), **context)


def _strategy(workspace: Path, client: Any = None, **options: Any) -> LspStrategy:
    options = {"preserve_recent": 2, "block_threshold": None, "context_utilization": None, **options}
    return LspStrategy(client or FakeLspClient(workspace), workspace, **options)


def test_fake_client_satisfies_the_protocol(workspace):
    assert isinstance(FakeLspClient(workspace), LspClient)


@pytest.mark.asyncio
async def test_offloads_only_the_unrelated_read(workspace, stash):
    strategy = _strategy(workspace)
    messages = conversation()

    assert await strategy.apply(await _stashed_context(messages, stash)) is True

    offloaded = messages[2]["content"][0]["toolResult"]
    assert offloaded["toolUseId"] == "t1"
    assert offloaded["status"] == "success"
    [placeholder] = offloaded["content"]
    assert placeholder["text"].startswith("[Offloaded: about c.py, ~")
    assert placeholder["text"].endswith("not related to the current work] [ref: t1]")
    assert placeholder["offloaded"]["method"] == "lsp"
    assert placeholder["offloaded"]["ref"] == "t1"
    assert placeholder["offloaded"]["tokens"] > 0
    assert results(messages)["t2"] == FILES["b.py"]  # a.py imports helper from it
    assert results(messages)["t3"] == FILES["d.py"]  # it imports main from a.py
    assert len(messages) == 9

    report = strategy.last_report
    assert report.working_set == {workspace / "a.py"}
    assert report.related == {workspace / "b.py", workspace / "d.py"}
    assert report.active_symbols == {"main"}
    assert report.offloaded == [("t1", ["c.py"])]
    assert report.kept == 2
    assert report.skipped_reason is None


@pytest.mark.asyncio
async def test_the_offloaded_original_stays_retrievable_and_a_second_pass_changes_nothing(workspace, stash):
    strategy = _strategy(workspace)
    messages = conversation()
    context = await _stashed_context(messages, stash)

    await strategy.apply(context)

    assert await stash.retrieve("t1_0") == {"text": FILES["c.py"]}
    assert await strategy.apply(context) is False
    assert strategy.last_report.offloaded == []


@pytest.mark.asyncio
async def test_a_generic_name_is_not_evidence(tmp_path, stash):
    """A name like ``logger`` that many files define must not make an unrelated file look relevant."""
    (tmp_path / "work.py").write_text("logger = 1\nclass DropStrategy: ...\n")
    (tmp_path / "other.py").write_text("logger = 2\ndef unrelated(): ...\n")
    (tmp_path / "third.py").write_text("logger = 3\n")
    symbols = {
        "work.py": [("logger", VARIABLE, 0, []), ("DropStrategy", CLASS, 1, [])],
        "other.py": [("logger", VARIABLE, 0, []), ("unrelated", FUNCTION, 1, [])],
        "third.py": [("logger", VARIABLE, 0, [])],
    }
    messages: Messages = [Message(role="user", content=[{"text": "task"}])]
    messages += read_pair("old", "b.py", text="logger = 2\ndef unrelated(): ...")
    messages[1]["content"][0]["toolUse"]["input"] = {"path": "other.py"}
    messages += [
        Message(
            role="assistant", content=[{"toolUse": {"toolUseId": "w", "name": "edit", "input": {"path": "work.py"}}}]
        ),
        Message(
            role="user", content=[{"toolResult": {"toolUseId": "w", "status": "success", "content": [{"text": "ok"}]}}]
        ),
    ]
    strategy = _strategy(tmp_path, FakeLspClient(tmp_path, symbols=symbols, references={}))

    assert await strategy.apply(await _stashed_context(messages, stash)) is True
    assert strategy.last_report.active_symbols == {"DropStrategy"}
    assert results(messages)["old"].startswith("[Offloaded: about other.py")


@pytest.mark.asyncio
async def test_a_result_naming_a_working_set_symbol_is_kept(workspace, stash):
    messages = conversation()
    messages[2]["content"][0]["toolResult"]["content"] = [{"text": "c.py: see main() for the entry point"}]

    assert await _strategy(workspace).apply(await _stashed_context(messages, stash)) is False
    assert results(messages)["t1"] == "c.py: see main() for the entry point"


@pytest.mark.asyncio
async def test_an_lsp_failure_while_building_the_working_set_is_a_no_op(workspace, stash):
    strategy = _strategy(workspace, FakeLspClient(workspace, fail_on="a.py"))
    messages = conversation()

    assert await strategy.apply(await _stashed_context(messages, stash)) is False
    assert strategy.last_report.skipped_reason == "lsp error"
    assert results(messages)["t1"] == FILES["c.py"]


@pytest.mark.asyncio
async def test_an_lsp_failure_while_scoring_changes_nothing(workspace, stash):
    # The read of c.py is decided before the query about b.py fails.
    messages = conversation()
    client = FakeLspClient(workspace, fail_on="b.py")
    strategy = _strategy(workspace, client)

    assert await strategy.apply(await _stashed_context(messages, stash)) is False
    assert strategy.last_report.skipped_reason == "lsp error"
    assert ("document_symbols", "c.py") in client.calls
    assert results(messages)["t1"] == FILES["c.py"]


@pytest.mark.asyncio
async def test_does_nothing_without_a_stash(workspace):
    client = FakeLspClient(workspace)
    strategy = _strategy(workspace, client)
    messages = conversation()

    assert await strategy.apply(make_context(messages, utilization=0.9)) is False
    assert strategy.last_report.skipped_reason == "no stash"
    assert client.calls == []
    assert results(messages)["t1"] == FILES["c.py"]


@pytest.mark.asyncio
async def test_waits_for_context_utilization_unless_the_context_overflowed(workspace, stash):
    strategy = _strategy(workspace, context_utilization="80%")

    below = await _stashed_context(conversation(), stash, utilization=0.5)
    assert await strategy.apply(below) is False
    assert strategy.last_report.skipped_reason == "below context_utilization"

    overflowed = await _stashed_context(conversation(), stash, utilization=0.5, overflow=True)
    assert await strategy.apply(overflowed) is True

    reached = await _stashed_context(conversation(), stash, utilization=0.8)
    assert await strategy.apply(reached) is True


def test_defaults_gate_on_utilization_and_size(workspace):
    strategy = LspStrategy(FakeLspClient(workspace), workspace)

    assert strategy._conditions.context_utilization.value == 60
    assert strategy._conditions.block_threshold.value == 500
    assert strategy._preserve_recent.value == 5
    assert strategy.name == "offload:lsp"


@pytest.mark.asyncio
async def test_block_threshold_leaves_small_results(workspace, stash):
    strategy = _strategy(workspace, block_threshold=10_000)
    messages = conversation()

    assert await strategy.apply(await _stashed_context(messages, stash)) is False
    assert results(messages)["t1"] == FILES["c.py"]
    assert strategy.last_report.kept == 3


@pytest.mark.asyncio
async def test_a_pinned_message_is_kept(workspace, stash):
    messages = conversation()
    messages[2].setdefault("metadata", {}).setdefault("custom", {})["pinned"] = True

    assert await _strategy(workspace).apply(await _stashed_context(messages, stash)) is False
    assert results(messages)["t1"] == FILES["c.py"]


@pytest.mark.asyncio
async def test_retrieved_content_is_left_alone(workspace, stash):
    messages = conversation()
    messages[1]["content"][0]["toolUse"]["name"] = RETRIEVAL_TOOL_NAME

    assert await _strategy(workspace).apply(await _stashed_context(messages, stash)) is False
    assert results(messages)["t1"] == FILES["c.py"]


@pytest.mark.asyncio
async def test_a_result_with_no_evidence_is_left_alone(workspace, stash):
    messages = conversation()
    messages[1]["content"][0]["toolUse"].update(name="bash", input={"command": "pytest -q"})
    messages[2]["content"][0]["toolResult"]["content"] = [{"text": "3 passed in 0.01s"}]

    strategy = _strategy(workspace)
    assert await strategy.apply(await _stashed_context(messages, stash)) is False
    assert results(messages)["t1"] == "3 passed in 0.01s"
    assert strategy.last_report.kept == 2


@pytest.mark.asyncio
async def test_does_nothing_without_files_in_recent_messages(workspace, stash):
    messages = conversation()
    messages += [Message(role="assistant", content=[{"text": "Done."}]), Message(role="user", content=[{"text": "ok"}])]

    strategy = _strategy(workspace)
    assert await strategy.apply(await _stashed_context(messages, stash)) is False
    assert strategy.last_report.skipped_reason == "no files in recent messages"


@pytest.mark.asyncio
async def test_max_queries_keeps_results_it_cannot_decide(workspace, stash):
    # 3 queries build the working set (a.py's symbols, main's definers, main's references); c.py needs 3 more.
    strategy = _strategy(workspace, max_queries=4)
    messages = conversation()

    assert await strategy.apply(await _stashed_context(messages, stash)) is False
    assert strategy.last_report.skipped_reason == "max_queries reached, remaining results kept"
    assert strategy.last_report.queries == 4
    assert results(messages)["t1"] == FILES["c.py"]


@pytest.mark.asyncio
async def test_max_queries_reached_while_building_the_working_set(workspace, stash):
    strategy = _strategy(workspace, max_queries=2)

    assert await strategy.apply(await _stashed_context(conversation(), stash)) is False
    assert strategy.last_report.skipped_reason == "max_queries reached while building the working set"


@pytest.mark.parametrize(
    ("options", "message"),
    [
        ({"preserve_recent": 0}, "preserve_recent=0 is invalid"),
        ({"context_utilization": 80}, "context_utilization=80 is invalid"),
        ({"block_threshold": "100%"}, 'block_threshold="100%" is invalid'),
        ({"max_queries": 0}, "max_queries=0 is invalid"),
        ({"max_defining_files": 0}, "max_defining_files=0 is invalid"),
    ],
)
def test_rejects_invalid_options(workspace, options, message):
    with pytest.raises(ValueError, match=message):
        LspStrategy(FakeLspClient(workspace), workspace, **options)


@pytest.mark.filterwarnings("ignore:context_window_limit is not set")
def test_runs_through_a_context_manager_with_a_file_stash(workspace, tmp_path):
    """Before the model call, the pipeline offloads the unrelated read; the original is on disk in the stash."""
    stash_dir = tmp_path / "stash"
    messages = conversation() + [Message(role="assistant", content=[{"text": "Edited."}])]
    agent = Agent(
        model=MockedModelProvider([Message(role="assistant", content=[{"text": "Done."}])]),
        messages=messages,
        context_manager=ContextManager(
            strategies=[_strategy(workspace, preserve_recent=4)],
            stash={"storage": LocalFileStorage(str(stash_dir))},
        ),
        callback_handler=None,
    )

    agent("Is it done?")

    assert results(agent.messages)["t1"].startswith("[Offloaded: about c.py")
    assert results(agent.messages)["t2"] == FILES["b.py"]
    assert any(path.name.startswith("t1_0") for path in stash_dir.rglob("*") if path.is_file())
    # A fresh stash over the same directory, as after a restart, reads the original back.
    reopened = Stash(LocalFileStorage(str(stash_dir)), agent.session_id, agent.agent_id)
    assert asyncio.run(reopened.retrieve("t1_0")) == {"text": FILES["c.py"]}


@pytest.mark.skipif(shutil.which("pyright-langserver") is None, reason="pyright-langserver is not on PATH")
@pytest.mark.filterwarnings("ignore:context_window_limit is not set")
def test_pyright_drives_the_strategy_through_a_context_manager(workspace, tmp_path):
    """The prototype's measured behavior against a real server: dependency and dependent kept, unrelated offloaded."""
    stash_dir = tmp_path / "stash"
    pyright = StdioLspClient(["pyright-langserver", "--stdio"], workspace)
    strategy = LspStrategy(pyright, workspace, preserve_recent=4, context_utilization=None, block_threshold=None)
    agent = Agent(
        model=MockedModelProvider([Message(role="assistant", content=[{"text": "Done."}])]),
        messages=conversation() + [Message(role="assistant", content=[{"text": "Edited."}])],
        context_manager=ContextManager(strategies=[strategy], stash={"storage": LocalFileStorage(str(stash_dir))}),
        callback_handler=None,
    )

    with pyright:
        agent("Is it done?")

    assert results(agent.messages)["t1"].startswith("[Offloaded: about c.py")
    assert results(agent.messages)["t2"] == FILES["b.py"]
    assert results(agent.messages)["t3"] == FILES["d.py"]
    assert strategy.last_report.working_set == {workspace / "a.py"}
    assert "main" in strategy.last_report.active_symbols
    stash = Stash(LocalFileStorage(str(stash_dir)), agent.session_id, agent.agent_id)
    assert asyncio.run(stash.retrieve("t1_0")) == {"text": FILES["c.py"]}
