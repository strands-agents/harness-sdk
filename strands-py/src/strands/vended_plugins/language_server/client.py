"""Language server clients: the query surface ``LspStrategy`` needs, and a stdio JSON-RPC implementation of it."""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import subprocess
import threading
from pathlib import Path
from typing import IO, Any, Protocol, runtime_checkable
from urllib.parse import unquote, urlparse

from typing_extensions import Self, TypedDict

logger = logging.getLogger(__name__)


class Position(TypedDict):
    """A zero-based position in a document, as LSP sends it."""

    line: int
    character: int


@runtime_checkable
class LspClient(Protocol):
    """The language server queries ``LspStrategy`` makes.

    Arguments and results are LSP JSON: ``file://`` URIs, zero-based positions, and ``Location``, ``DocumentSymbol``
    or ``SymbolInformation`` objects as the server returns them.
    """

    async def references(self, uri: str, position: Position, **kwargs: Any) -> list[dict[str, Any]]:
        """Locations that reference the symbol at ``position``, without its declaration."""
        ...

    async def definition(self, uri: str, position: Position, **kwargs: Any) -> dict[str, Any] | None:
        """The first location defining the symbol at ``position``, or None."""
        ...

    async def workspace_symbol(self, query: str, **kwargs: Any) -> list[dict[str, Any]]:
        """Symbols across the workspace matching ``query``."""
        ...

    async def document_symbols(self, uri: str, **kwargs: Any) -> list[dict[str, Any]]:
        """The symbols a document defines, nested when the server supports it."""
        ...


class LanguageServerNotFoundError(FileNotFoundError):
    """The language server binary is not on PATH."""


class LanguageServerError(RuntimeError):
    """The language server answered with an error, or exited."""


def uri_to_path(uri: str) -> Path:
    """The local path a ``file://`` URI names."""
    return Path(unquote(urlparse(uri).path))


class StdioLspClient:
    """An :class:`LspClient` that runs a language server as a subprocess and speaks JSON-RPC over its stdio.

    Documents are synced in full from disk before each query, so the server sees the file as it is now. Requests run
    on a worker thread, so one client serves any event loop, including the fresh one each synchronous agent call runs.

    Example:
        ```python
        with StdioLspClient(["pyright-langserver", "--stdio"], root="/work/repo") as client:
            ...
        ```
    """

    def __init__(
        self,
        command: list[str],
        root: Path | str,
        *,
        language_id: str = "python",
        ready_log_pattern: str | None = "source file",
        ready_timeout: float = 10.0,
        request_timeout: float = 30.0,
    ) -> None:
        """Start the server, initialize it, and wait until it has indexed the workspace.

        Cross-file queries come back empty while the server is still enumerating the workspace. Pyright logs
        "Found N source files" at that point, which the default ``ready_log_pattern`` matches.

        Args:
            command: The server command line, such as ``["pyright-langserver", "--stdio"]``.
            root: Workspace root the server indexes.
            language_id: LSP language id sent when opening documents.
            ready_log_pattern: Text in a ``window/logMessage`` that marks the server ready; None to not wait.
            ready_timeout: Seconds to wait for the ready message before going ahead without it.
            request_timeout: Seconds to wait for each response.

        Raises:
            ValueError: When ``command`` is empty.
            LanguageServerNotFoundError: When the server binary is not on PATH.
        """
        if not command:
            raise ValueError(
                "command is empty: pass the server command line, such as ['pyright-langserver', '--stdio']"
            )
        if shutil.which(command[0]) is None:
            raise LanguageServerNotFoundError(
                f"{command[0]!r} not found on PATH; install it (e.g. pip install pyright) or pass the full path"
            )
        self.root = Path(root).resolve()
        self._language_id = language_id
        self._ready_log_pattern = ready_log_pattern
        self._request_timeout = request_timeout
        self._next_id = 0
        self._write_lock = threading.Lock()
        self._sync_lock = threading.Lock()
        self._responses: dict[int, dict[str, Any]] = {}
        self._response_ready = threading.Condition()
        self._exited = False
        self._ready = threading.Event()
        self._versions: dict[str, int] = {}
        self._texts: dict[str, str] = {}
        self._process = subprocess.Popen(  # noqa: S603  # the caller chooses the server to run
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=self.root
        )
        self._reader = threading.Thread(target=self._read_loop, name="lsp-reader", daemon=True)
        self._reader.start()
        try:
            self._initialize()
        except BaseException:
            self._process.kill()
            raise
        if ready_log_pattern is None:
            self._ready.set()
        if not self._ready.wait(ready_timeout):
            logger.warning(
                "command=<%s>, ready_timeout=<%s> | language server not ready in time, continuing without it",
                command[0],
                ready_timeout,
            )

    async def references(self, uri: str, position: Position, **kwargs: Any) -> list[dict[str, Any]]:
        """Locations that reference the symbol at ``position``, without its declaration."""
        params = {"position": position, "context": {"includeDeclaration": False}}
        return await asyncio.to_thread(self._document_request, "textDocument/references", uri, params) or []

    async def definition(self, uri: str, position: Position, **kwargs: Any) -> dict[str, Any] | None:
        """The first location defining the symbol at ``position``, or None."""
        result = await asyncio.to_thread(self._document_request, "textDocument/definition", uri, {"position": position})
        location: dict[str, Any] | None = (result[0] if result else None) if isinstance(result, list) else result
        return location

    async def workspace_symbol(self, query: str, **kwargs: Any) -> list[dict[str, Any]]:
        """Symbols across the workspace matching ``query``."""
        return await asyncio.to_thread(self._request, "workspace/symbol", {"query": query}) or []

    async def document_symbols(self, uri: str, **kwargs: Any) -> list[dict[str, Any]]:
        """The symbols a document defines, nested when the server supports it."""
        return await asyncio.to_thread(self._document_request, "textDocument/documentSymbol", uri, {}) or []

    def close(self) -> None:
        """Shut the server down, killing it if it does not answer."""
        try:
            self._request("shutdown", None, timeout=5)
            self._notify("exit", None)
        except Exception:
            logger.debug("language server did not shut down cleanly", exc_info=True)
        self._process.kill()
        self._process.wait()

    def __enter__(self) -> Self:
        """Return the client."""
        return self

    def __exit__(self, *exc_info: object) -> None:
        """Shut the server down."""
        self.close()

    def _document_request(self, method: str, uri: str, params: dict[str, Any]) -> Any:
        self._sync(uri_to_path(uri).resolve())
        return self._request(method, {"textDocument": {"uri": uri}, **params})

    def _sync(self, path: Path) -> None:
        """Open the document, or send its contents again when they changed on disk."""
        uri = path.as_uri()
        text = path.read_text(encoding="utf-8", errors="replace")
        # Queries run on worker threads; one document's open and version updates must not interleave.
        with self._sync_lock:
            self._sync_text(uri, text)

    def _sync_text(self, uri: str, text: str) -> None:
        if uri not in self._versions:
            self._versions[uri] = 1
            document = {"uri": uri, "languageId": self._language_id, "version": 1, "text": text}
            self._notify("textDocument/didOpen", {"textDocument": document})
        elif self._texts[uri] != text:
            self._versions[uri] += 1
            document = {"uri": uri, "version": self._versions[uri]}
            self._notify("textDocument/didChange", {"textDocument": document, "contentChanges": [{"text": text}]})
        self._texts[uri] = text

    def _initialize(self) -> None:
        root_uri = self.root.as_uri()
        capabilities = {
            "textDocument": {
                "synchronization": {},
                "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                "references": {},
                "definition": {},
            },
            "workspace": {"configuration": True, "symbol": {}},
        }
        self._request(
            "initialize",
            {
                "processId": None,
                "rootUri": root_uri,
                "workspaceFolders": [{"uri": root_uri, "name": self.root.name}],
                "capabilities": capabilities,
            },
        )
        self._notify("initialized", {})

    def _request(self, method: str, params: Any, timeout: float | None = None) -> Any:
        with self._write_lock:
            self._next_id += 1
            request_id = self._next_id
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        with self._response_ready:
            answered = self._response_ready.wait_for(
                lambda: request_id in self._responses or self._exited, timeout or self._request_timeout
            )
            if request_id not in self._responses:
                reason = "exited" if answered else "timed out"
                raise LanguageServerError(f"method=<{method}> | language server {reason} before answering")
            response = self._responses.pop(request_id)
        if "error" in response:
            raise LanguageServerError(f"method=<{method}> | language server error: {response['error']}")
        return response.get("result")

    def _notify(self, method: str, params: Any) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _send(self, message: dict[str, Any]) -> None:
        body = json.dumps(message).encode()
        stdin = self._stdin()
        with self._write_lock:
            stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
            stdin.flush()

    def _stdin(self) -> IO[bytes]:
        if self._process.stdin is None or self._exited:
            raise LanguageServerError("language server has exited")
        return self._process.stdin

    def _read_loop(self) -> None:
        stdout = self._process.stdout
        try:
            while stdout is not None and (message := _read_message(stdout)) is not None:
                self._dispatch(message)
        except Exception:
            logger.warning("language server output could not be read, stopping the client", exc_info=True)
        finally:
            with self._response_ready:
                self._exited = True
                self._response_ready.notify_all()

    def _dispatch(self, message: dict[str, Any]) -> None:
        if "method" in message and "id" in message:
            self._answer_server_request(message)
        elif "id" in message:
            with self._response_ready:
                self._responses[message["id"]] = message
                self._response_ready.notify_all()
        elif message.get("method") == "window/logMessage":
            text = message.get("params", {}).get("message", "")
            if self._ready_log_pattern and self._ready_log_pattern in text:
                self._ready.set()

    def _answer_server_request(self, message: dict[str, Any]) -> None:
        """Answer a request the server sends: no settings for ``workspace/configuration``, null for the rest."""
        result: Any = None
        if message["method"] == "workspace/configuration":
            result = [None for _ in message.get("params", {}).get("items", [])]
        self._send({"jsonrpc": "2.0", "id": message["id"], "result": result})


def _read_message(stream: IO[bytes]) -> dict[str, Any] | None:
    """Read one ``Content-Length`` framed message, or None at end of stream."""
    length = 0
    while (line := stream.readline()) not in (b"\r\n", b""):
        name, _, value = line.partition(b":")
        if name.strip().lower() == b"content-length":
            length = int(value)
    if line == b"":
        return None
    message: dict[str, Any] = json.loads(stream.read(length))
    return message
