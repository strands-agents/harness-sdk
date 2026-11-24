"""StdioLspClient against a scripted stdio server, and against pyright when it is installed."""

import re
import shutil
import sys
import textwrap
from pathlib import Path

import pytest

from strands.vended_plugins.language_server import (
    LanguageServerError,
    LanguageServerNotFoundError,
    LspClient,
    StdioLspClient,
)

from ._session import FILES

# Answers initialize, asks the client for configuration, logs readiness, then fails workspace/symbol and exits on
# documentSymbol. It records what it received to the file given as its argument.
SCRIPTED_SERVER = textwrap.dedent(
    """
    import json, sys

    log = open(sys.argv[1], "w")

    def read():
        length = 0
        while (line := sys.stdin.buffer.readline()) not in (b"\\r\\n", b""):
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":")[1])
        return json.loads(sys.stdin.buffer.read(length)) if line else None

    def send(message):
        body = json.dumps(message).encode()
        sys.stdout.buffer.write(b"Content-Length: %d\\r\\n\\r\\n" % len(body) + body)
        sys.stdout.buffer.flush()

    while (message := read()) is not None:
        log.write(json.dumps(message) + "\\n")
        log.flush()
        method = message.get("method")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": 900, "method": "workspace/configuration", "params": {"items": [{}, {}]}})
            send({"jsonrpc": "2.0", "id": message["id"], "result": {"capabilities": {}}})
        elif method == "initialized":
            ready = {"type": 3, "message": "Found 4 source files"}
            send({"jsonrpc": "2.0", "method": "window/logMessage", "params": ready})
        elif method == "workspace/symbol":
            send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32603, "message": "boom"}})
        elif method == "textDocument/references":
            send({"jsonrpc": "2.0", "id": message["id"], "result": [{"uri": "file:///x.py"}]})
        elif method == "textDocument/documentSymbol":
            sys.exit(0)
        elif method == "shutdown":
            send({"jsonrpc": "2.0", "id": message["id"], "result": None})
    """
)

requires_pyright = pytest.mark.skipif(
    shutil.which("pyright-langserver") is None, reason="pyright-langserver is not on PATH"
)


@pytest.fixture
def scripted(tmp_path, workspace):
    script = tmp_path / "server.py"
    script.write_text(SCRIPTED_SERVER)
    received = tmp_path / "received.jsonl"
    client = StdioLspClient([sys.executable, str(script), str(received)], workspace, ready_timeout=5)
    yield client, received
    client.close()


def test_a_missing_binary_fails_at_construction(workspace):
    with pytest.raises(LanguageServerNotFoundError, match="'no-such-langserver' not found on PATH; install it"):
        StdioLspClient(["no-such-langserver", "--stdio"], workspace)


def test_an_empty_command_is_rejected(workspace):
    with pytest.raises(ValueError, match="command is empty"):
        StdioLspClient([], workspace)


@pytest.mark.asyncio
async def test_answers_server_requests_and_waits_for_readiness(scripted):
    client, received = scripted

    assert isinstance(client, LspClient)
    assert client._ready.is_set()
    lines = received.read_text().splitlines()
    assert '{"jsonrpc": "2.0", "id": 900, "result": [null, null]}' in lines


@pytest.mark.asyncio
async def test_syncs_the_document_before_a_query(scripted, workspace):
    client, received = scripted
    uri = (workspace / "a.py").as_uri()

    assert await client.references(uri, {"line": 3, "character": 4}) == [{"uri": "file:///x.py"}]
    (workspace / "a.py").write_text("def main() -> int:\n    return 4\n")
    await client.references(uri, {"line": 0, "character": 4})

    methods = [line for line in received.read_text().splitlines() if "textDocument/did" in line]
    assert '"textDocument/didOpen"' in methods[0] and FILES["a.py"].splitlines()[0] in methods[0]
    assert '"textDocument/didChange"' in methods[1] and '"version": 2' in methods[1]


@pytest.mark.asyncio
async def test_an_error_response_raises(scripted):
    client, _ = scripted

    with pytest.raises(LanguageServerError, match=re.escape("method=<workspace/symbol> | language server error")):
        await client.workspace_symbol("main")


@pytest.mark.asyncio
async def test_a_server_that_exits_mid_request_raises_without_waiting_for_the_timeout(scripted, workspace):
    client, _ = scripted

    with pytest.raises(LanguageServerError, match="exited"):
        await client.document_symbols((workspace / "a.py").as_uri())


@pytest.fixture
def pyright(workspace):
    with StdioLspClient(["pyright-langserver", "--stdio"], workspace) as client:
        yield client


@requires_pyright
@pytest.mark.asyncio
async def test_pyright_answers_each_query(pyright, workspace):
    a_uri = (workspace / "a.py").as_uri()

    symbols = await pyright.document_symbols(a_uri)
    main = next(symbol for symbol in symbols if symbol["name"] == "main")
    references = await pyright.references(a_uri, main["selectionRange"]["start"])
    definition = await pyright.definition(a_uri, {"line": 4, "character": 11})
    matches = await pyright.workspace_symbol("helper")

    assert {Path(reference["uri"]).name for reference in references} == {"d.py"}
    assert definition is not None and definition["uri"].endswith("/b.py")
    assert any(match["name"] == "helper" and match["location"]["uri"].endswith("/b.py") for match in matches)
