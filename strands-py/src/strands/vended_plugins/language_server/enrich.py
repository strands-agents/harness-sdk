"""CodeFetchEnricher: answer the code fetches an agent already makes with what the language server knows.

Agents read code through the shell, with ``grep -n`` to find lines and ``sed -n 'a,bp'`` to print a range. Each such
result arrives with language server structure added: grep hits name the symbol they sit in, a grep that finds a
definition carries that definition, and a range that cuts a function off carries the rest of it. The command still runs
and its output stays as it was; additions are marked ``[language server]``.
"""

from __future__ import annotations

import json
import logging
import re
import shlex
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ...hooks import AfterToolCallEvent
from ...plugins import Plugin
from .client import LspClient

if TYPE_CHECKING:
    from ...agent.agent import Agent
    from ...types.tools import ToolResult

logger = logging.getLogger(__name__)

MARKER = "[language server]"
"""Prefix of every addition, so the model and a reader of the trajectory can tell it from the command's output."""

# LSP SymbolKind: class, method, constructor, enum, interface, function.
_CONTAINER_KINDS = {5, 6, 9, 10, 11, 12}
_FUNCTION_KINDS = {6, 9, 12}
_SEPARATORS = {"&&", ";"}
_GREP_VALUE_OPTIONS = {"-e", "-f", "-A", "-B", "-C", "-m", "--max-count", "--regexp", "--file", "--context"}
_HIT = re.compile(r"^(?:(?P<path>[^:\n]+):)?(?P<line>\d+)[:-]")
_RANGE = re.compile(r"^(\d+),(\d+)p$")
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")
_NOT_NAMES = {"def", "class", "async", "self", "return", "import", "from", "lambda"}


@dataclass(frozen=True)
class _Symbol:
    name: str
    qualified: str
    kind: int
    start: int  # 1-based, inclusive
    end: int
    selection: int


class CodeFetchEnricher(Plugin):
    """Add language server structure to the shell commands an agent reads code with, as each result arrives.

    - ``grep -n`` (or ``-rn``): each hit in a code file is tagged with the symbol it is in. When a hit is the definition
      of a name the pattern searches for, that definition follows, with numbered lines.
    - ``sed -n 'a,bp' file``: when line ``b`` falls inside a function, the rest of the function follows; when line ``a``
      does, its declaration is named.

    Only the last command of a ``cd ... && <command>`` chain is read, and a trailing ``| head`` is allowed after grep.
    Anything else, a failed command, or a language server error leaves the result as it was.

    Example:
        ```python
        client = StdioLspClient(["pyright-langserver", "--stdio"], root="/work/repo")
        agent = Agent(tools=[shell], plugins=[CodeFetchEnricher(client, root="/work/repo")])
        ```
    """

    name = "language_server_fetch"

    def __init__(
        self,
        client: LspClient,
        root: Path | str,
        *,
        shell_tools: Sequence[str] = ("shell",),
        extensions: Sequence[str] = (".py",),
        max_definition_lines: int = 150,
        max_annotated_hits: int = 60,
    ) -> None:
        """Configure the enricher.

        Args:
            client: The language server that outlines files.
            root: Workspace root; files outside it are left alone.
            shell_tools: Names of shell tools; each takes a ``command`` input and returns ``{"output", "error",
                "exit_code"}`` as JSON text.
            extensions: File extensions the language server understands.
            max_definition_lines: Longest definition or continuation added to a result.
            max_annotated_hits: Grep hits tagged per result; later hits are left as they are.

        Raises:
            ValueError: When a limit is below 1.
        """
        for label, value in (
            ("max_definition_lines", max_definition_lines),
            ("max_annotated_hits", max_annotated_hits),
        ):
            if value < 1:
                raise ValueError(f"{label}={value} is invalid: expected a whole number of at least 1")
        super().__init__()
        self._client = client
        self._root = Path(root).resolve()
        self._shell_tools = tuple(shell_tools)
        self._extensions = tuple(extensions)
        self._max_definition_lines = max_definition_lines
        self._max_annotated_hits = max_annotated_hits

    def init_agent(self, agent: Agent) -> None:
        """Enrich each shell result before the agent adds it to the conversation."""
        agent.add_hook(self._enrich_shell_result, AfterToolCallEvent)

    async def _enrich_shell_result(self, event: AfterToolCallEvent) -> None:
        if event.exception is not None or event.tool_use.get("name") not in self._shell_tools:
            return
        command = (event.tool_use.get("input") or {}).get("command")
        shell = _shell_json(event.result)
        if not isinstance(command, str) or shell is None:
            return
        try:
            enriched = await self._enrich(command, shell["output"])
        except Exception:
            logger.debug(
                "command=<%s> | language server could not enrich the result, keeping it", command, exc_info=True
            )
            return
        if enriched is not None and enriched != shell["output"]:
            event.result = _with_output(event.result, shell, enriched)

    async def _enrich(self, command: str, output: str) -> str | None:
        parsed = _final_command(command, self._root)
        if parsed is None:
            return None
        directory, words = parsed
        if words[0] == "grep":
            return await self._enrich_grep(words, directory, output)
        if words[0] == "sed":
            return await self._enrich_sed(words, directory, output)
        return None

    async def _enrich_grep(self, words: list[str], directory: Path, output: str) -> str | None:
        grep = _parse_grep(words)
        if grep is None:
            return None
        pattern, files, numbered = grep
        if not numbered:
            return None
        single = self._code_file(directory, files[0]) if len(files) == 1 else None
        names = {name for name in _IDENTIFIER.findall(pattern) if name not in _NOT_NAMES}
        lines = output.splitlines()
        definitions: list[tuple[Path, _Symbol]] = []
        for index, line in enumerate(lines[: self._max_annotated_hits]):
            hit = await self._locate(line, directory, single)
            if hit is None:
                continue
            path, number, symbols = hit
            enclosing = _innermost([s for s in symbols if s.selection != number], number)
            if enclosing is not None:
                lines[index] = f"{line}  {MARKER} in {enclosing.qualified}"
            defined = next((s for s in symbols if s.selection == number and s.name in names), None)
            if defined is not None and (path, defined) not in definitions:
                definitions.append((path, defined))
        sections = [self._render_definition(path, symbol) for path, symbol in definitions[:2]]
        return "\n".join([*lines, *sections]) + ("\n" if output.endswith("\n") else "")

    async def _enrich_sed(self, words: list[str], directory: Path, output: str) -> str | None:
        if len(words) != 4 or words[1] != "-n" or not (match := _RANGE.match(words[2])):
            return None
        path = self._code_file(directory, words[3])
        if path is None:
            return None
        first, last = int(match.group(1)), int(match.group(2))
        text = path.read_text(encoding="utf-8", errors="replace").splitlines()
        if output.rstrip("\n") != "\n".join(text[first - 1 : last]).rstrip("\n"):
            return None
        symbols = await self._symbols(path)
        notes = []
        head = _innermost(symbols, first, kinds=_FUNCTION_KINDS)
        if head is not None and head.start < first:
            declaration = text[head.start - 1].strip()
            notes.append(f"{MARKER} L{first} is inside {head.qualified} (L{head.start}-{head.end}): {declaration}")
        tail = _innermost(symbols, last, kinds=_FUNCTION_KINDS)
        if tail is not None and tail.end > last:
            rest = min(tail.end, last + self._max_definition_lines)
            more = "" if rest == tail.end else f", first {rest - last} lines"
            notes.append(
                f"{MARKER} L{last} is inside {tail.qualified} (L{tail.start}-{tail.end}); the rest of it{more}:"
            )
            notes += [f"{number:5} | {text[number - 1]}" for number in range(last + 1, min(rest, len(text)) + 1)]
        if not notes:
            return None
        return output.rstrip("\n") + "\n" + "\n".join(notes) + "\n"

    async def _locate(self, line: str, directory: Path, single: Path | None) -> tuple[Path, int, list[_Symbol]] | None:
        match = _HIT.match(line)
        if match is None:
            return None
        path = self._code_file(directory, match.group("path")) if match.group("path") else single
        if path is None:
            return None
        return path, int(match.group("line")), await self._symbols(path)

    async def _symbols(self, path: Path) -> list[_Symbol]:
        return list(_flatten(await self._client.document_symbols(path.as_uri())))

    def _render_definition(self, path: Path, symbol: _Symbol) -> str:
        text = path.read_text(encoding="utf-8", errors="replace").splitlines()
        end = min(symbol.end, symbol.start + self._max_definition_lines - 1, len(text))
        cut = "" if end == symbol.end else f", first {end - symbol.start + 1} lines"
        where = f"{path.relative_to(self._root)} L{symbol.start}-{symbol.end}{cut}"
        header = f"{MARKER} definition of {symbol.qualified}, {where}:"
        return "\n".join([header, *(f"{number:5} | {text[number - 1]}" for number in range(symbol.start, end + 1))])

    def _code_file(self, directory: Path, raw: str) -> Path | None:
        try:
            path = (directory / raw).resolve()
            readable = path.is_relative_to(self._root) and path.is_file()
        except (OSError, ValueError, RuntimeError):
            return None
        return path if readable and path.suffix in self._extensions else None


def _final_command(command: str, root: Path) -> tuple[Path, list[str]] | None:
    """The directory the last command runs in and its words, for ``cd ... && <command> [| head ...]``, else None."""
    words = _words(command)
    if words is None:
        return None
    segments: list[list[str]] = [[]]
    for word in words:
        if word in _SEPARATORS:
            segments.append([])
        else:
            segments[-1].append(word)
    directory = root
    for segment in segments[:-1]:
        if len(segment) != 2 or segment[0] != "cd":
            return None
        directory = (directory / segment[1]).resolve()
    final = segments[-1]
    if "|" in final:
        pipe = final.index("|")
        if final[0] != "grep" or final[pipe + 1 : pipe + 2] != ["head"] or "|" in final[pipe + 1 :]:
            return None
        final = final[:pipe]
    if not final or any(word in {"||", "&", ">", ">>", "<", "|&"} for word in final):
        return None
    return directory, final


def _words(command: str) -> list[str] | None:
    """``command`` split as a shell would, with ``&&``, ``;`` and ``|`` as their own words; None if it can't be."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        return list(lexer)
    except ValueError:
        return None


def _parse_grep(words: list[str]) -> tuple[str, list[str], bool] | None:
    """``(pattern, files, numbered)`` of a grep command line, or None when it reads stdin or has no pattern."""
    pattern: str | None = None
    positional: list[str] = []
    numbered = False
    index = 1
    while index < len(words):
        word = words[index]
        if word in ("-e", "--regexp") and index + 1 < len(words):
            pattern = words[index + 1]
            index += 2
            continue
        if word in _GREP_VALUE_OPTIONS:
            index += 2
            continue
        if word.startswith("--"):
            numbered = numbered or word == "--line-number"
        elif word.startswith("-") and len(word) > 1:
            numbered = numbered or "n" in word[1:]
        else:
            positional.append(word)
        index += 1
    if pattern is None and positional:
        pattern, positional = positional[0], positional[1:]
    if pattern is None or not positional:
        return None
    return pattern, positional, numbered


def _flatten(symbols: list[dict[str, Any]], parent: str = "") -> Iterable[_Symbol]:
    for symbol in symbols:
        if "range" not in symbol or "selectionRange" not in symbol:
            continue
        qualified = f"{parent}.{symbol['name']}" if parent else str(symbol["name"])
        kind = symbol.get("kind", 0)
        if kind in _CONTAINER_KINDS:
            yield _Symbol(
                name=str(symbol["name"]),
                qualified=qualified,
                kind=kind,
                start=symbol["range"]["start"]["line"] + 1,
                end=symbol["range"]["end"]["line"] + 1,
                selection=symbol["selectionRange"]["start"]["line"] + 1,
            )
        yield from _flatten(symbol.get("children", []), qualified)


def _innermost(symbols: list[_Symbol], line: int, kinds: set[int] = _CONTAINER_KINDS) -> _Symbol | None:
    containing = [s for s in symbols if s.kind in kinds and s.start <= line <= s.end]
    return min(containing, key=lambda s: s.end - s.start, default=None)


def _shell_json(result: ToolResult) -> dict[str, Any] | None:
    content = result.get("content") or []
    if result.get("status") != "success" or len(content) != 1 or "text" not in content[0]:
        return None
    try:
        shell = json.loads(content[0]["text"])
    except ValueError:
        return None
    if not isinstance(shell, dict) or shell.get("exit_code") != 0 or not isinstance(shell.get("output"), str):
        return None
    return shell


def _with_output(result: ToolResult, shell: dict[str, Any], output: str) -> ToolResult:
    text = json.dumps({**shell, "output": output}, ensure_ascii=False)
    return {**result, "content": [{"text": text}]}
