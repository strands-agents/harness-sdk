"""CodeFetchEnricher: grep and sed results arrive with the symbols and definitions they touch."""

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from strands import Agent, tool
from strands.types.content import Message
from strands.vended_plugins.language_server import CodeFetchEnricher, StdioLspClient
from strands.vended_plugins.language_server.enrich import MARKER
from tests.fixtures.mocked_model_provider import MockedModelProvider

CLASS, METHOD, FUNCTION = 5, 6, 12

SOURCE = """\
import os


class Store:
    def __init__(self, path):
        self.path = path

    def get(self, key):
        value = os.environ.get(key)
        if value is None:
            return None
        return value.strip()


def run(store):
    return store.get("HOME")
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
    (root / "pkg" / "store.py").write_text(SOURCE)
    (root / "pkg" / "notes.md").write_text(SOURCE)
    return root


def _shell(root: Path):
    @tool(name="shell")
    def run_shell(command: str) -> dict[str, Any]:
        """Run a command.

        Args:
            command: The command.
        """
        completed = subprocess.run(command, shell=True, capture_output=True, text=True, cwd=root, check=False)  # noqa: S602
        return {"output": completed.stdout, "error": completed.stderr, "exit_code": completed.returncode}

    return run_shell


def _run(root: Path, command: str, client: FakeOutlineClient | StdioLspClient) -> str:
    """The output the model saw for one shell command."""
    model = MockedModelProvider(
        [
            Message(
                role="assistant",
                content=[{"toolUse": {"toolUseId": "s1", "name": "shell", "input": {"command": command}}}],
            ),
            Message(role="assistant", content=[{"text": "Done."}]),
        ]
    )
    agent = Agent(model=model, tools=[_shell(root)], plugins=[CodeFetchEnricher(client, root)], callback_handler=None)
    agent("Look.")
    result = next(
        block["toolResult"] for message in agent.messages for block in message["content"] if "toolResult" in block
    )
    return json.loads(result["content"][0]["text"])["output"]


def test_grep_hits_name_their_symbol_and_a_definition_hit_carries_the_definition(code_root):
    output = _run(code_root, 'grep -rn --include=*.py "def get\\|get(" pkg', FakeOutlineClient())

    lines = output.splitlines()
    assert lines[0] == "pkg/store.py:8:    def get(self, key):  " + MARKER + " in Store"
    assert lines[1] == "pkg/store.py:9:        value = os.environ.get(key)  " + MARKER + " in Store.get"
    assert lines[2] == 'pkg/store.py:16:    return store.get("HOME")  ' + MARKER + " in run"
    assert lines[3] == MARKER + " definition of Store.get, pkg/store.py L8-12:"
    assert lines[4:9] == [
        "    8 |     def get(self, key):",
        "    9 |         value = os.environ.get(key)",
        "   10 |         if value is None:",
        "   11 |             return None",
        "   12 |         return value.strip()",
    ]


def test_grep_in_one_file_after_cd_maps_hits_to_that_file(code_root):
    output = _run(code_root, 'cd pkg && grep -n "strip" store.py', FakeOutlineClient())

    assert output.splitlines() == ["12:        return value.strip()  " + MARKER + " in Store.get"]


def test_a_long_definition_is_capped(code_root):
    model_client = FakeOutlineClient()
    root = code_root
    agent_output = None
    plugin = CodeFetchEnricher(model_client, root, max_definition_lines=2)
    model = MockedModelProvider(
        [
            Message(
                role="assistant",
                content=[
                    {
                        "toolUse": {
                            "toolUseId": "s1",
                            "name": "shell",
                            "input": {"command": 'grep -n "def get" pkg/store.py'},
                        }
                    }
                ],
            ),
            Message(role="assistant", content=[{"text": "Done."}]),
        ]
    )
    agent = Agent(model=model, tools=[_shell(root)], plugins=[plugin], callback_handler=None)
    agent("Look.")
    for message in agent.messages:
        for block in message["content"]:
            if "toolResult" in block:
                agent_output = json.loads(block["toolResult"]["content"][0]["text"])["output"]

    assert MARKER + " definition of Store.get, pkg/store.py L8-12, first 2 lines:" in agent_output
    assert "   10 |" not in agent_output


def test_a_sed_range_that_cuts_a_method_carries_its_declaration_and_the_rest_of_it(code_root):
    output = _run(code_root, "sed -n 9,10p pkg/store.py", FakeOutlineClient())

    assert output.splitlines() == [
        "        value = os.environ.get(key)",
        "        if value is None:",
        MARKER + " L9 is inside Store.get (L8-12): def get(self, key):",
        MARKER + " L10 is inside Store.get (L8-12); the rest of it:",
        "   11 |             return None",
        "   12 |         return value.strip()",
    ]


@pytest.mark.parametrize(
    "command",
    [
        "sed -n 4,13p pkg/store.py",  # whole definitions: nothing to add
        "grep -rn get pkg | wc -l",  # not grep's own output
        "grep get pkg/store.py",  # no line numbers to place hits by
        "grep -n get pkg/notes.md",  # not a code file
        "sed -n 9,10p pkg/missing.py",  # failed
        "cat pkg/store.py",  # not grep or sed
        "ls pkg; grep -n get pkg/store.py",  # a chain that isn't cd
    ],
)
def test_other_commands_arrive_as_they_were(code_root, command):
    completed = subprocess.run(command, shell=True, capture_output=True, text=True, cwd=code_root, check=False)  # noqa: S602

    output = _run(code_root, command, FakeOutlineClient())

    assert output == completed.stdout
    assert MARKER not in output


def test_a_language_server_failure_leaves_the_result_as_it_was(code_root):
    output = _run(code_root, "grep -n get pkg/store.py", FakeOutlineClient(fail=True))

    assert MARKER not in output
    assert output.startswith("8:    def get(self, key):")


def test_rejects_a_limit_below_one(code_root):
    with pytest.raises(ValueError, match="max_definition_lines=0 is invalid"):
        CodeFetchEnricher(FakeOutlineClient(), code_root, max_definition_lines=0)


@pytest.mark.skipif(shutil.which("pyright-langserver") is None, reason="pyright-langserver is not on PATH")
def test_pyright_enriches_a_real_grep(code_root):
    with StdioLspClient(["pyright-langserver", "--stdio"], code_root) as client:
        output = _run(code_root, 'grep -rn --include=*.py "def run" pkg', client)

    assert output.splitlines()[0] == "pkg/store.py:15:def run(store):"
    assert MARKER + " definition of run, pkg/store.py L15-16:" in output
