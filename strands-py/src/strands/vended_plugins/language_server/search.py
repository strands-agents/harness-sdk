"""Workspace search behind ``retrieve_context``: a definition by name from the language server, or plain grep lines."""

from __future__ import annotations

import inspect
import re
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..._context_manager.retrieval_tool import RETRIEVAL_TOOL_NAME, _create_retrieval_tool
from ...tools.tools import PythonAgentTool
from ...types.tools import ToolResult, ToolSpec
from .client import LspClient, uri_to_path

if TYPE_CHECKING:
    from ..._context_manager.context_manager import ContextManager

_SKIP_DIRS = {".venv", "venv", "__pycache__", "node_modules", "site-packages", "build", "dist"}
_MAX_AMBIGUOUS = 8


class WorkspaceSearch:
    """Find a definition by name through the language server, or grep the workspace for a pattern.

    Results read from disk, so they show files as they are now, with line numbers an edit can cite.
    """

    def __init__(
        self,
        client: LspClient,
        root: Path | str,
        *,
        extensions: Sequence[str] = (".py",),
        max_chars: int = 6_000,
    ) -> None:
        """Configure the search.

        Args:
            client: The language server that finds definitions.
            root: Workspace root; searches stay under it.
            extensions: File extensions that grep searches.
            max_chars: Longest result returned; longer results are cut with a note to narrow the search.
        """
        self._client = client
        self._root = Path(root).resolve()
        self._extensions = tuple(extensions)
        self._max_chars = max_chars

    async def find_symbol(self, name: str, path: str | None = None) -> str:
        """The definition named ``name`` with numbered lines, or grep lines for ``name`` when none has that name.

        Args:
            name: A class, function, method, or variable name.
            path: A file or directory under the root to look in; the whole workspace when omitted.

        Returns:
            The definition, a list of definitions to choose from when several share the name, or grep lines.
        """
        scope = self._scope(path)
        if scope is None:
            return f"No file or directory {path} in the workspace."
        definitions = await self._definitions(name, scope)
        if len(definitions) == 1:
            return self._render_definition(*definitions[0], name)
        if definitions:
            places = ", ".join(
                f"{self._relative(file)} L{symbol['range']['start']['line'] + 1}"
                for file, symbol in definitions[:_MAX_AMBIGUOUS]
            )
            return f"{len(definitions)} definitions named {name!r}: {places}. Pass path= to choose one."
        where = f" in {path}" if path else ""
        return f"No definition named {name!r}{where}; text matches instead.\n" + self._grep(re.escape(name), scope)

    async def grep(self, pattern: str, path: str | None = None) -> str:
        """Lines matching ``pattern`` as ``path:line: text``, in file order.

        Args:
            pattern: A regular expression; searched as plain text when it does not compile.
            path: A file or directory under the root to search; the whole workspace when omitted.

        Returns:
            The matching lines.
        """
        scope = self._scope(path)
        if scope is None:
            return f"No file or directory {path} in the workspace."
        return self._grep(pattern, scope)

    async def _definitions(self, name: str, scope: Path) -> list[tuple[Path, dict[str, Any]]]:
        """The ``(file, DocumentSymbol)`` of each definition named ``name`` under ``scope``."""
        if scope.is_file():
            files = [scope]
        else:
            matches = await self._client.workspace_symbol(name)
            files = sorted(
                {
                    uri_to_path(match["location"]["uri"]).resolve()
                    for match in matches
                    if match.get("name") == name and "location" in match
                }
            )
        found: list[tuple[Path, dict[str, Any]]] = []
        for file in files:
            if file.is_relative_to(scope) and file.is_file():
                symbols = await self._client.document_symbols(file.as_uri())
                found += [(file, symbol) for symbol in _walk(symbols) if symbol.get("name") == name]
        return found

    def _render_definition(self, file: Path, symbol: dict[str, Any], name: str) -> str:
        lines = file.read_text(encoding="utf-8", errors="replace").splitlines()
        start, end = symbol["range"]["start"]["line"], symbol["range"]["end"]["line"]
        body = [f"{index + 1:4} | {lines[index]}" for index in range(start, min(end + 1, len(lines)))]
        return self._cap("\n".join([f"{self._relative(file)} L{start + 1}-{end + 1} ({name}):", *body]))

    def _grep(self, pattern: str, scope: Path) -> str:
        try:
            compiled = re.compile(pattern)
        except re.error:
            compiled = re.compile(re.escape(pattern))
        hits = [
            f"{self._relative(file)}:{number}: {line.strip()}"
            for file in self._files(scope)
            for number, line in _numbered_lines(file)
            if compiled.search(line)
        ]
        if not hits:
            return f"No matches for {pattern!r}."
        return self._cap("\n".join([f"{len(hits)} matching lines for {pattern!r}:", *hits]))

    def _files(self, scope: Path) -> list[Path]:
        if scope.is_file():
            return [scope]
        return sorted(
            file
            for file in scope.rglob("*")
            if file.suffix in self._extensions and file.is_file() and not _skipped(file.relative_to(self._root))
        )

    def _scope(self, path: str | None) -> Path | None:
        if not path:
            return self._root
        try:
            scope = (self._root / path).resolve()
            return scope if scope.is_relative_to(self._root) and scope.exists() else None
        except (OSError, ValueError, RuntimeError):
            return None

    def _cap(self, text: str) -> str:
        if len(text) <= self._max_chars:
            return text
        return text[: self._max_chars] + "\n... (truncated; pass path= to narrow the search)"

    def _relative(self, file: Path) -> str:
        return str(file.relative_to(self._root))


def workspace_retrieval_tool(context_manager: ContextManager, search: WorkspaceSearch) -> PythonAgentTool:
    """A ``retrieve_context`` that also searches the workspace, in place of the context manager's own.

    ``reference`` returns stashed content as the built-in tool does; ``symbol`` returns a definition, and ``pattern``
    without ``reference`` greps the workspace. Turn the built-in tool off so the agent has one ``retrieve_context``.

    Example:
        ```python
        manager = ContextManager(strategies=[...], stash={"retrieval_tool": False})
        agent = Agent(context_manager=manager, tools=[workspace_retrieval_tool(manager, WorkspaceSearch(client, root))])
        ```

    Args:
        context_manager: The context manager whose stash ``reference`` reads from.
        search: The workspace search ``symbol`` and ``pattern`` run.

    Returns:
        The tool.
    """

    async def _invoke(tool_use: dict[str, Any], **kwargs: Any) -> ToolResult:
        tool_use_id = tool_use["toolUseId"]
        inputs = tool_use.get("input") or {}
        if inputs.get("reference"):
            stash = context_manager.stash
            if stash is None:
                return _result(tool_use_id, "No stash is configured, so there is nothing to retrieve by reference.")
            answer = _create_retrieval_tool(stash)._tool_func(tool_use)
            return await answer if inspect.isawaitable(answer) else answer
        if inputs.get("symbol"):
            return _result(tool_use_id, await search.find_symbol(str(inputs["symbol"]), inputs.get("path")))
        if inputs.get("pattern"):
            return _result(tool_use_id, await search.grep(str(inputs["pattern"]), inputs.get("path")))
        return _result(tool_use_id, "Pass reference= for offloaded content, symbol= for a definition, or pattern=.")

    _invoke.__name__ = RETRIEVAL_TOOL_NAME
    return PythonAgentTool(tool_name=RETRIEVAL_TOOL_NAME, tool_spec=_TOOL_SPEC, tool_func=_invoke)


_TOOL_SPEC = ToolSpec(
    name=RETRIEVAL_TOOL_NAME,
    description=(
        "Retrieve code or content that was shortened to save context.\n\n"
        '  - reference: the <id> from an offload placeholder\'s "[ref: <id>]", for the original content; add pattern\n'
        "    or line_range to read part of it\n"
        "  - symbol: a class, function, method, or variable name, for its definition with line numbers; add path\n"
        "    (a file or directory) to narrow it. When no definition has the name, the workspace is searched for it\n"
        "  - pattern without reference: a regex to search the workspace (or path) for, as path:line: text lines\n\n"
        "Examples:\n"
        '  { reference: "toolu_abc", pattern: "error" }\n'
        '  { symbol: "Store", path: "pkg/store.py" }\n'
        '  { pattern: "retry_limit", path: "pkg" }'
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "reference": {"type": "string", "description": 'The <id> from an offload placeholder\'s "[ref: <id>]".'},
            "symbol": {"type": "string", "description": "Name of a definition to show."},
            "path": {"type": "string", "description": "File or directory to look in, relative to the root."},
            "pattern": {"type": "string", "description": "Regex to search for."},
            "line_range": {
                "type": "object",
                "description": "With reference: return only this span of lines.",
                "properties": {"start": {"type": "integer", "minimum": 1}, "end": {"type": "integer", "minimum": 1}},
                "required": ["start", "end"],
            },
            "context_lines": {
                "type": "integer",
                "minimum": 0,
                "description": "With reference and pattern: lines of context around each match (default: 5).",
            },
        },
    },
)


def _result(tool_use_id: str, text: str) -> ToolResult:
    return ToolResult(toolUseId=tool_use_id, status="success", content=[{"text": text}])


def _walk(symbols: list[dict[str, Any]]) -> Iterable[dict[str, Any]]:
    for symbol in symbols:
        if "range" in symbol:
            yield symbol
        yield from _walk(symbol.get("children", []))


def _numbered_lines(file: Path) -> Iterable[tuple[int, str]]:
    try:
        text = file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    yield from enumerate(text.splitlines(), start=1)


def _skipped(relative: Path) -> bool:
    return any(part in _SKIP_DIRS or part.startswith(".") for part in relative.parts[:-1])
