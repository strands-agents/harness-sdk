"""SkeletonStrategy: a large code read arrives as its language server outline, with the original in the stash."""

from __future__ import annotations

import json
import logging
import shlex
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..._context_manager.strategies.offload.base import BaseOffloadStrategy
from ..._context_manager.strategies.offload.conditions import OffloadConditions
from ...types.content import ContentBlock, Message
from .client import LspClient

if TYPE_CHECKING:
    from ..._context_manager.types import ContextState
    from ...agent.agent import Agent
    from ...agent.invocation_context import InvocationContext
    from ...types.tools import ToolResultContent

logger = logging.getLogger(__name__)

DEFAULT_SKELETON_THRESHOLD = 1_500
"""Tokens above which a whole-file read becomes a skeleton: roughly a 150-line file."""

# LSP SymbolKind: class, method, constructor, enum, interface, function, variable, constant.
_SHOWN_KINDS = {5, 6, 9, 10, 11, 12, 13, 14}
_DESCEND_KINDS = {2, 3, 5, 10, 11}  # module, namespace, class, enum, interface
_HEADER_KINDS = {5, 6, 9, 12}  # declarations that can span lines before their ":"
_VARIABLE = 13
_MAX_DECLARATION_CHARS = 160
_MAX_DECLARATION_LINES = 6
_MAX_IMPORT_LINES = 40
_MAX_SYMBOLS = 120
_RANGE_KEYS = ("offset", "limit", "start_line", "end_line", "line_range")
_COMMAND_SEPARATORS = {"&&", "||", ";", "|", "&"}


class SkeletonStrategy(BaseOffloadStrategy):
    """Replace a large whole-file code read, as it arrives, with the file's skeleton from the language server.

    The skeleton keeps the imports verbatim and lists every class, function, method and module-level variable with its
    line range. The stash keeps the original read, which ``retrieve_context`` returns by its reference. Reads of part of
    a file, test files, files outside ``root``, and files without a listed extension arrive in full, as does any read
    the language server cannot outline. A shell command counts as a whole-file read when it succeeds and its output is
    exactly the full text of a code file it names, such as ``cat pkg/store.py`` or ``cd pkg && cat store.py``. It only
    acts on arrival, so history the model has already read is never rewritten and the prompt cache is kept.

    Example:
        ```python
        ContextManager(strategies=[SkeletonStrategy(client, root="/work/repo"), "large_tool_offloading"])
        # Outline whole-file reads over 3,000 tokens instead of the default 1,500
        SkeletonStrategy(client, root="/work/repo").when(block_threshold=3_000)
        ```
    """

    def __init__(
        self,
        client: LspClient,
        root: Path | str,
        *,
        read_tools: Sequence[str] = ("read",),
        shell_tools: Sequence[str] = (),
        extensions: Sequence[str] = (".py",),
        symbol_lookup: bool = False,
        conditions: OffloadConditions | None = None,
    ) -> None:
        """Configure the strategy.

        Args:
            client: The language server that outlines files.
            root: Workspace root; reads of files outside it arrive in full.
            read_tools: Names of the tools that read files; each takes the file as its ``path`` input.
            shell_tools: Names of shell tools whose whole-file dumps are outlined too; each takes a ``command`` input
                and returns ``{"output", "error", "exit_code"}`` as JSON text.
            extensions: File extensions the language server understands.
            symbol_lookup: Whether the skeleton points the model at ``retrieve_context(symbol=..., path=...)``; set it
                when the agent has ``workspace_retrieval_tool`` in place of the built-in one.
            conditions: When and how the strategy fires; defaults to a ``block_threshold`` of
                ``DEFAULT_SKELETON_THRESHOLD`` tokens, acting on arrival.

        Raises:
            ValueError: When ``read_tools`` is empty or a condition value is invalid.
        """
        if not read_tools:
            raise ValueError("read_tools is empty: name the tools that read files, such as ['read']")
        resolved = (
            conditions if conditions is not None else OffloadConditions(block_threshold=DEFAULT_SKELETON_THRESHOLD)
        )
        super().__init__("skeleton", [*read_tools, *shell_tools], resolved)
        self._client = client
        self._root = Path(root).resolve()
        self._read_tools = tuple(read_tools)
        self._shell_tools = tuple(shell_tools)
        self._extensions = tuple(extensions)
        self._symbol_lookup = symbol_lookup

    def _with_conditions(self, conditions: OffloadConditions) -> SkeletonStrategy:
        return SkeletonStrategy(
            self._client,
            self._root,
            read_tools=self._read_tools,
            shell_tools=self._shell_tools,
            extensions=self._extensions,
            symbol_lookup=self._symbol_lookup,
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
        path = (
            self._whole_file_dump(block, agent)
            if tool_name in self._shell_tools
            else self._whole_file_read(block, agent)
        )
        if path is None:
            return None
        try:
            symbols = await self._client.document_symbols(path.as_uri())
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            logger.warning("path=<%s> | language server could not outline the file, keeping the full read", path)
            return None
        relative_path = str(path.relative_to(self._root))
        return render_skeleton(lines, symbols, relative_path, self._symbol_lookup, self._read_tools[0]), []

    def _whole_file_read(self, block: ContentBlock, agent: Agent) -> Path | None:
        """The code file a whole-file read in ``block`` returned, or None when it is not one to outline."""
        tool_input = _tool_input(agent.messages, block["toolResult"]["toolUseId"]) if "toolResult" in block else None
        if tool_input is None or any(tool_input.get(key) is not None for key in _RANGE_KEYS):
            return None
        raw = tool_input.get("path")
        if not isinstance(raw, str) or not raw:
            return None
        return self._code_file(self._root, raw)

    def _whole_file_dump(self, block: ContentBlock, agent: Agent) -> Path | None:
        """The code file a shell command in ``block`` printed whole, or None when its output is anything else."""
        if "toolResult" not in block:
            return None
        tool_input = _tool_input(agent.messages, block["toolResult"]["toolUseId"])
        command = tool_input.get("command") if tool_input else None
        output = _shell_output(block["toolResult"]["content"])
        if not isinstance(command, str) or output is None:
            return None
        candidates = {path for path in self._command_files(command) if path is not None}
        return next((path for path in sorted(candidates) if _same_text(path, output)), None)

    def _command_files(self, command: str) -> Iterable[Path | None]:
        """The code files under the root that ``command``'s words name, each resolved after the ``cd`` before it."""
        lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        try:
            words = list(lexer)
        except ValueError:
            return
        directory = self._root
        for index, word in enumerate(words):
            if words[index - 1 : index] == ["cd"] and (
                index + 1 == len(words) or words[index + 1] in _COMMAND_SEPARATORS
            ):
                directory = (directory / word).resolve()
            elif word not in _COMMAND_SEPARATORS:
                yield self._code_file(directory, word)

    def _code_file(self, directory: Path, raw: str) -> Path | None:
        """``raw`` as a code file under the root, resolved from ``directory``, or None when it is not one to outline."""
        try:
            path = (directory / raw).resolve()
            readable = path.is_relative_to(self._root) and path.is_file()
        except (OSError, ValueError, RuntimeError):
            return None
        if not readable or path.suffix not in self._extensions or _is_test_file(path.relative_to(self._root)):
            return None
        return path


def render_skeleton(
    lines: list[str],
    symbols: list[dict[str, Any]],
    relative_path: str,
    symbol_lookup: bool = False,
    read_tool: str = "read",
) -> str:
    """The skeleton of a file: a header, its imports verbatim, and each symbol's line range and declaration.

    Args:
        lines: The file's lines.
        symbols: The file's ``DocumentSymbol`` tree from the language server.
        relative_path: The file's path as the model should name it.
        symbol_lookup: Whether to point at ``retrieve_context(symbol=..., path=...)`` for one definition.
        read_tool: The tool the model reads a line range with, through its ``offset`` and ``limit`` inputs.

    Returns:
        The skeleton text.
    """
    flat = list(_flatten(symbols))
    first_symbol_line = min((symbol["range"]["start"]["line"] for symbol, _ in flat), default=len(lines))
    lookup = (
        f'retrieve_context(symbol="<name>", path="{relative_path}") shows one definition; ' if symbol_lookup else ""
    )
    out = [
        f"Skeleton of {relative_path} ({len(lines)} lines): imports and signatures, bodies omitted to save context."
        f" {lookup}retrieve_context with the reference below returns the full file,"
        f' or {read_tool}(path="{relative_path}", offset=..., limit=...) reads a line range.'
    ]
    imports = _import_lines(lines, first_symbol_line)
    if imports:
        out += ["imports:", *imports]
    for count, (symbol, depth) in enumerate(flat):
        if count >= _MAX_SYMBOLS:
            out.append(f"... {len(flat) - _MAX_SYMBOLS} more symbols")
            break
        start, end = symbol["range"]["start"]["line"], symbol["range"]["end"]["line"]
        out.append(f"{'  ' * depth}L{start + 1}-{end + 1} {_declaration(lines, symbol)}")
    return "\n".join(out)


def _flatten(symbols: list[dict[str, Any]], depth: int = 0) -> Iterable[tuple[dict[str, Any], int]]:
    """Shown symbols in line order with their depth; members of classes, but no nested variables."""
    for symbol in sorted(symbols, key=lambda entry: entry.get("range", {}).get("start", {}).get("line", 0)):
        if "range" not in symbol:
            continue
        kind = symbol.get("kind")
        if kind in _SHOWN_KINDS and not (kind == _VARIABLE and depth > 0):
            yield symbol, depth
        if kind in _DESCEND_KINDS:
            yield from _flatten(symbol.get("children", []), depth + 1)


def _declaration(lines: list[str], symbol: dict[str, Any]) -> str:
    """The symbol's declaration line, joined with its continuation lines up to the ``:``, and shortened if long."""
    start = symbol["range"]["start"]["line"]
    if start >= len(lines):
        return str(symbol["name"])
    parts = [lines[start].strip()]
    line = start
    while (
        symbol.get("kind") in _HEADER_KINDS
        and not parts[-1].endswith(":")
        and line + 1 < len(lines)
        and line - start < _MAX_DECLARATION_LINES
    ):
        line += 1
        parts.append(lines[line].strip())
    declaration = " ".join(parts)
    return (
        declaration if len(declaration) <= _MAX_DECLARATION_CHARS else declaration[: _MAX_DECLARATION_CHARS - 3] + "..."
    )


def _import_lines(lines: list[str], first_symbol_line: int) -> list[str]:
    """The import statements above the first symbol, numbered, including parenthesized multi-line imports."""
    out: list[str] = []
    in_parentheses = False
    for index, line in enumerate(lines[:first_symbol_line]):
        stripped = line.strip()
        if not (in_parentheses or stripped.startswith(("import ", "from "))):
            continue
        out.append(f"{index + 1:4} | {line}")
        in_parentheses = (in_parentheses or "(" in stripped) and ")" not in stripped
        if len(out) >= _MAX_IMPORT_LINES:
            out.append("     | ... more imports")
            break
    return out


def _tool_input(messages: list[Message], tool_use_id: str) -> dict[str, Any] | None:
    tool_use = next(
        (
            block["toolUse"]
            for message in reversed(messages)
            for block in message["content"]
            if "toolUse" in block and block["toolUse"]["toolUseId"] == tool_use_id
        ),
        None,
    )
    if tool_use is None:
        return None
    tool_input = tool_use.get("input")
    return tool_input if isinstance(tool_input, dict) else {}


def _shell_output(content: list[Any]) -> str | None:
    """The output of a shell result that succeeded with nothing on stderr, or None."""
    if len(content) != 1 or "text" not in content[0]:
        return None
    try:
        result = json.loads(content[0]["text"])
    except ValueError:
        return None
    if not isinstance(result, dict) or result.get("exit_code") != 0 or result.get("error"):
        return None
    output = result.get("output")
    return output if isinstance(output, str) else None


def _same_text(path: Path, output: str) -> bool:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return bool(text.strip()) and text.rstrip("\n") == output.rstrip("\n")


def _is_test_file(relative_path: Path) -> bool:
    name, stem = relative_path.name, relative_path.stem
    return name.startswith("test_") or stem.endswith("_test") or "tests" in relative_path.parts
