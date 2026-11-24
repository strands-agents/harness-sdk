"""CodeSkeletonStrategy: code a tool returns is offloaded as it arrives, and only its skeleton stays in context.

Whatever an agent reads code with, ``read`` with any range or read-only shell commands (``cat``, ``sed -n``,
``grep -n -A``, ``head``, chained with ``cd``, ``;`` or ``&&``), the code in the result is replaced by the skeleton of
what it covered: per file, the lines it held and the classes and functions they belong to, with line ranges and
declarations. Output that is not code stays as it was. The original result goes to the stash, and exact code comes
back through ``retrieve_context`` (``path`` with ``line_range``, or ``symbol``), whose results are never offloaded.
"""

from __future__ import annotations

import json
import logging
import re
import shlex
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..._context_manager.strategies.offload.base import BaseOffloadStrategy
from ..._context_manager.strategies.offload.conditions import OffloadConditions
from ...types.content import ContentBlock, Message
from .client import LspClient
from .skeleton import _tool_input

if TYPE_CHECKING:
    from ..._context_manager.types import ContextState
    from ...agent.agent import Agent
    from ...agent.invocation_context import InvocationContext
    from ...types.tools import ToolResultContent

logger = logging.getLogger(__name__)

# LSP SymbolKind: class, method, constructor, enum, interface, function, variable, constant.
_SHOWN_KINDS = {5, 6, 9, 10, 11, 12, 13, 14}
_DESCEND_KINDS = {2, 3, 5, 10, 11}
_READ_ONLY = {"cd", "cat", "sed", "grep", "egrep", "head", "tail", "nl", "ls", "wc", "echo", "true"}
_SEPARATORS = {"&&", ";", "|"}
_REDIRECTS = {">", ">>", "<", "&", "||", "|&", ">&"}
_READ_PREFIX = re.compile(r"^\s*(\d+)\t(.*)$")
_HIT_PREFIX = re.compile(r"^(?:(?P<path>[^\s:]+?)[:-])?(?P<line>\d+)[:-](?P<text>.*)$")
_NUMBERED_PREFIX = re.compile(r"^\s*(\d+)\s*\|\s?(.*)$")
_MIN_MATCH_CHARS = 4
_MAX_KEPT_LINES = 80
_MAX_SYMBOLS = 60


@dataclass
class _Coverage:
    """The file lines one result held, and its lines that were not code from those files."""

    lines: dict[Path, set[int]] = field(default_factory=dict)
    other: list[str] = field(default_factory=list)

    def add(self, path: Path, number: int) -> None:
        self.lines.setdefault(path, set()).add(number)


class CodeSkeletonStrategy(BaseOffloadStrategy):
    """Offload the code in every code-reading tool result as it arrives; keep the skeleton of what it covered.

    A result is replaced when it holds at least one line of code from a file under ``root`` and its skeleton is
    shorter than it. With ``targeted_lines`` set, only broad reads are: code from more than one file, all of one file,
    or more than ``targeted_lines`` lines of one. A targeted read of part of one file, which an agent usually makes
    to edit it, arrives in full. Results the strategy cannot map to file lines (a shell command that writes, runs
    code, or uses a redirect), files without a listed extension, and language server failures arrive in full. It acts
    only on arrival, so history the model has already read is never rewritten and the prompt cache is kept.

    Example:
        ```python
        manager = ContextManager(
            strategies=[CodeSkeletonStrategy(client, root="/work/repo")], stash={"retrieval_tool": False}
        )
        search = WorkspaceSearch(client, "/work/repo")
        agent = Agent(context_manager=manager, tools=[workspace_retrieval_tool(manager, search)])
        ```
    """

    def __init__(
        self,
        client: LspClient,
        root: Path | str,
        *,
        read_tools: Sequence[str] = ("read",),
        shell_tools: Sequence[str] = ("shell",),
        extensions: Sequence[str] = (".py",),
        targeted_lines: int | None = None,
        conditions: OffloadConditions | None = None,
    ) -> None:
        """Configure the strategy.

        Args:
            client: The language server that outlines files.
            root: Workspace root; code from files outside it arrives in full.
            read_tools: Tools that read files through ``path``, ``offset`` and ``limit`` and return ``cat -n`` lines.
            shell_tools: Shell tools that take a ``command`` and return ``{"output", "error", "exit_code"}`` JSON text.
            extensions: File extensions the language server understands.
            targeted_lines: Most lines of one file a read may hold and still arrive in full, unless it holds all of
                the file; None to offload every code result.
            conditions: When the strategy fires; defaults to every matching result on arrival (``block_threshold=1``).

        Raises:
            ValueError: When both tool lists are empty or a condition value is invalid.
        """
        if not read_tools and not shell_tools:
            raise ValueError("read_tools and shell_tools are empty: name the tools that read code")
        if targeted_lines is not None and targeted_lines < 1:
            raise ValueError(f"targeted_lines={targeted_lines} is invalid: expected a whole number of at least 1")
        # Every result, stated as a 1-token threshold: the strategy means to act before the model reads the code.
        resolved = conditions if conditions is not None else OffloadConditions(block_threshold=1)
        super().__init__("skeleton", [*read_tools, *shell_tools], resolved)
        self._client = client
        self._root = Path(root).resolve()
        self._read_tools = tuple(read_tools)
        self._shell_tools = tuple(shell_tools)
        self._extensions = tuple(extensions)
        self._targeted_lines = targeted_lines

    def _with_conditions(self, conditions: OffloadConditions) -> CodeSkeletonStrategy:
        return CodeSkeletonStrategy(
            self._client,
            self._root,
            read_tools=self._read_tools,
            shell_tools=self._shell_tools,
            extensions=self._extensions,
            targeted_lines=self._targeted_lines,
            conditions=conditions,
        )

    async def _apply_per_message(self, context: ContextState) -> bool:
        return False

    async def _replace_block(
        self,
        block: ContentBlock,
        tokens: int,
        message: Message,
        agent: Agent,
        tool_name: str | None,
        invocation_context: InvocationContext | None = None,
    ) -> tuple[str, list[ToolResultContent]] | None:
        if "toolResult" not in block:
            return None
        tool_input = _tool_input(agent.messages, block["toolResult"]["toolUseId"]) or {}
        text = _result_text(block["toolResult"]["content"])
        if text is None:
            return None
        coverage = self._coverage(tool_name, tool_input, text)
        if coverage is None or not coverage.lines or self._is_targeted(coverage):
            return None
        try:
            skeleton = await self._render(coverage)
        except Exception:
            logger.warning("tool=<%s> | language server could not outline the result, keeping it", tool_name)
            return None
        return (skeleton, []) if len(skeleton) < len(text) else None

    def _is_targeted(self, coverage: _Coverage) -> bool:
        """Whether a result is a targeted read: part of one file, no more than ``targeted_lines`` lines of it."""
        if self._targeted_lines is None or len(coverage.lines) != 1:
            return False
        [(path, numbers)] = coverage.lines.items()
        code_lines = sum(1 for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip())
        return len(numbers) <= self._targeted_lines and len(numbers) < code_lines

    def _coverage(self, tool_name: str | None, tool_input: dict[str, Any], text: str) -> _Coverage | None:
        if tool_name in self._read_tools:
            path = self._code_file(self._root, tool_input.get("path"))
            return _read_coverage(path, text) if path is not None else None
        if tool_name in self._shell_tools:
            return self._shell_coverage(tool_input.get("command"), text)
        return None

    def _shell_coverage(self, command: Any, text: str) -> _Coverage | None:
        output = _shell_output(text)
        files = self._read_only_files(command) if isinstance(command, str) else None
        if output is None or files is None:
            return None
        index = {path: path.read_text(encoding="utf-8", errors="replace").splitlines() for path in files}
        coverage = _Coverage()
        previous: tuple[Path, int] | None = None
        for line in output.splitlines():
            previous = self._place(line, index, previous, coverage)
        return coverage

    def _place(
        self, line: str, index: dict[Path, list[str]], previous: tuple[Path, int] | None, coverage: _Coverage
    ) -> tuple[Path, int] | None:
        """Record which file line ``line`` is, or keep it as other output; return where the next line would be."""
        hit = _HIT_PREFIX.match(line)
        if hit is not None:
            path = self._hit_file(hit.group("path"), index)
            if path is not None and _line_is(index[path], int(hit.group("line")), hit.group("text")):
                coverage.add(path, int(hit.group("line")))
                return path, int(hit.group("line")) + 1
        if not line.strip() or line == "--":
            # A blank line the file has here keeps the run of lines going; grep's "--" separator ends it.
            blank_here = previous is not None and line != "--" and _line_is(index[previous[0]], previous[1], "")
            return (previous[0], previous[1] + 1) if blank_here and previous is not None else previous
        if previous is not None and _line_is(index[previous[0]], previous[1], line):
            coverage.add(*previous)
            return previous[0], previous[1] + 1
        found = _find_line(index, line)
        if found is not None:
            coverage.add(*found)
            return found[0], found[1] + 1
        coverage.other.append(line)
        return None

    def _hit_file(self, raw: str | None, index: dict[Path, list[str]]) -> Path | None:
        if raw is None:
            return next(iter(index)) if len(index) == 1 else None
        for directory in {path.parent for path in index} | {self._root}:
            path = self._code_file(directory, raw)
            if path is not None and path in index:
                return path
        return next((path for path in index if str(path).endswith("/" + raw.lstrip("./"))), None)

    def _read_only_files(self, command: str) -> list[Path] | None:
        """The code files a read-only command names (or finds under a directory it greps), or None if it isn't one."""
        lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        try:
            words = list(lexer)
        except ValueError:
            return None
        if any(word in _REDIRECTS for word in words):
            return None
        directory, files = self._root, set()
        for segment in _segments(words):
            if not segment or segment[0] not in _READ_ONLY or (segment[0] == "sed" and _sed_writes(segment)):
                return None
            if segment[0] == "cd":
                directory = (directory / (segment[1] if len(segment) > 1 else ".")).resolve()
                continue
            files |= set(self._named_files(directory, segment[1:], search=segment[0] in ("grep", "egrep")))
        return sorted(files)

    def _named_files(self, directory: Path, words: list[str], search: bool) -> Iterable[Path]:
        for word in words:
            path = self._code_file(directory, word)
            if path is not None:
                yield path
                continue
            folder = _directory(directory, word, self._root) if search else None
            if folder is not None:
                yield from (p for p in folder.rglob("*") if p.suffix in self._extensions and p.is_file())

    async def _render(self, coverage: _Coverage) -> str:
        parts = [
            "Code offloaded to save context; below is the skeleton of what this result held. Exact current lines:"
            ' retrieve_context(path="<file>", line_range={"start": a, "end": b}); one definition:'
            ' retrieve_context(symbol="<name>", path="<file>"); the original output: retrieve_context with the'
            " reference below."
        ]
        for path in sorted(coverage.lines):
            numbers = sorted(coverage.lines[path])
            symbols = list(_flatten(await self._client.document_symbols(path.as_uri())))
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            parts.append(f"{path.relative_to(self._root)}: lines {_spans(numbers)} of {len(lines)}")
            touched = [(symbol, depth) for symbol, depth in symbols if _overlaps(symbol, numbers)]
            for symbol, depth in touched[:_MAX_SYMBOLS]:
                start, end = symbol["range"]["start"]["line"] + 1, symbol["range"]["end"]["line"] + 1
                declaration = lines[start - 1].strip()[:160] if start <= len(lines) else str(symbol["name"])
                parts.append(f"{'  ' * (depth + 1)}L{start}-{end} {declaration}")
            if len(touched) > _MAX_SYMBOLS:
                parts.append(f"  ... {len(touched) - _MAX_SYMBOLS} more symbols")
        if coverage.other:
            parts.append("Other output:")
            parts += coverage.other[:_MAX_KEPT_LINES]
            if len(coverage.other) > _MAX_KEPT_LINES:
                parts.append(f"... {len(coverage.other) - _MAX_KEPT_LINES} more lines, in the original output")
        return "\n".join(parts)

    def _code_file(self, directory: Path, raw: Any) -> Path | None:
        if not isinstance(raw, str) or not raw or raw.startswith("-"):
            return None
        try:
            path = (directory / raw).resolve()
            readable = path.is_relative_to(self._root) and path.is_file()
        except (OSError, ValueError, RuntimeError):
            return None
        return path if readable and path.suffix in self._extensions else None


def _read_coverage(path: Path, text: str) -> _Coverage:
    coverage = _Coverage()
    for line in text.splitlines():
        match = _READ_PREFIX.match(line)
        if match is not None:
            coverage.add(path, int(match.group(1)))
        elif line.strip():
            coverage.other.append(line)
    return coverage


def _segments(words: list[str]) -> Iterable[list[str]]:
    segment: list[str] = []
    for word in words:
        if word in _SEPARATORS:
            yield segment
            segment = []
        else:
            segment.append(word)
    yield segment


def _sed_writes(segment: list[str]) -> bool:
    return any(word.startswith("-i") or word == "--in-place" or word.startswith("--in-place=") for word in segment)


def _directory(directory: Path, raw: str, root: Path) -> Path | None:
    if raw.startswith("-"):
        return None
    try:
        folder = (directory / raw).resolve()
        return folder if folder.is_relative_to(root) and folder.is_dir() else None
    except (OSError, ValueError, RuntimeError):
        return None


def _line_is(lines: list[str], number: int, text: str) -> bool:
    return 1 <= number <= len(lines) and lines[number - 1].rstrip() == _strip_numbering(text).rstrip()


def _strip_numbering(text: str) -> str:
    numbered = _NUMBERED_PREFIX.match(text)
    return numbered.group(2) if numbered else text


def _find_line(index: dict[Path, list[str]], line: str) -> tuple[Path, int] | None:
    """Where an unnumbered output line is in the files, when it is distinctive enough to say."""
    text = _strip_numbering(line).rstrip()
    if len(text.strip()) < _MIN_MATCH_CHARS:
        return None
    places = [
        (path, number + 1)
        for path, lines in index.items()
        for number, found in enumerate(lines)
        if found.rstrip() == text
    ]
    return places[0] if len(places) == 1 else None


def _flatten(symbols: list[dict[str, Any]], depth: int = 0) -> Iterable[tuple[dict[str, Any], int]]:
    for symbol in sorted(symbols, key=lambda entry: entry.get("range", {}).get("start", {}).get("line", 0)):
        if "range" not in symbol:
            continue
        if symbol.get("kind") in _SHOWN_KINDS and not (symbol.get("kind") == 13 and depth > 0):
            yield symbol, depth
        if symbol.get("kind") in _DESCEND_KINDS:
            yield from _flatten(symbol.get("children", []), depth + 1)


def _overlaps(symbol: dict[str, Any], numbers: list[int]) -> bool:
    start, end = symbol["range"]["start"]["line"] + 1, symbol["range"]["end"]["line"] + 1
    return any(start <= number <= end for number in numbers)


def _spans(numbers: list[int]) -> str:
    spans: list[tuple[int, int]] = []
    for number in numbers:
        if spans and number == spans[-1][1] + 1:
            spans[-1] = (spans[-1][0], number)
        else:
            spans.append((number, number))
    return ", ".join(f"{a}-{b}" if a != b else str(a) for a, b in spans)


def _result_text(content: list[Any]) -> str | None:
    if len(content) != 1 or "text" not in content[0]:
        return None
    text = content[0]["text"]
    return text if isinstance(text, str) else None


def _shell_output(text: str) -> str | None:
    try:
        result = json.loads(text)
    except ValueError:
        return None
    if not isinstance(result, dict) or result.get("exit_code") not in (0, 1) or result.get("error"):
        return None
    output = result.get("output")
    return output if isinstance(output, str) else None
