"""LspStrategy: offload old tool results about code the agent is no longer working on, judged by a language server."""

from __future__ import annotations

import logging
import re
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

from ..._context_manager.placeholder import carried_tokens, is_offloaded, offload_placeholder, placeholder_result
from ..._context_manager.retrieval_tool import RETRIEVAL_TOOL_NAME
from ..._context_manager.strategies.offload.conditions import ParsedCondition, ResolvedConditions, build_conditions
from ...agent.conversation_manager.compression.pin_message import is_pinned
from ...models._model_proxy import ModelProxy
from ...types.content import ContentBlock, Message, Messages
from .client import LspClient, Position, uri_to_path

if TYPE_CHECKING:
    from ..._context_manager.stash import Stash
    from ..._context_manager.types import ContextState
    from ...agent.agent import Agent
    from ...types.tools import ToolResult

logger = logging.getLogger(__name__)

T = TypeVar("T")

# LSP SymbolKind values that name code another file can use.
_CLASS, _INTERFACE, _VARIABLE = 5, 11, 13
_TRACKED_KINDS = {_CLASS, 6, 10, _INTERFACE, 12, _VARIABLE, 14}  # + Method, Enum, Function, Constant
_IDENTIFIER = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{2,}\b")
_PATHLIKE = re.compile(r"[\w./\\-]+\.[A-Za-z]{1,5}\b")
_MAX_PATH_CHARS = 500
_MIN_SYMBOL_CHARS = 4


@dataclass
class LspPassReport:
    """What the last pass decided, for logging and tuning.

    Attributes:
        working_set: Files touched in the newest ``preserve_recent`` messages.
        related: Files found one reference away from the working set.
        active_symbols: Distinctive top-level symbols the working set defines.
        offloaded: ``(toolUseId, files it mentioned)`` for each result replaced, relative to the root.
        kept: Results with file or symbol evidence that stayed.
        queries: LSP requests made.
        skipped_reason: Why the pass stopped early, if it did.
    """

    working_set: set[Path] = field(default_factory=set)
    related: set[Path] = field(default_factory=set)
    active_symbols: set[str] = field(default_factory=set)
    offloaded: list[tuple[str, list[str]]] = field(default_factory=list)
    kept: int = 0
    queries: int = 0
    skipped_reason: str | None = None


class _QueryBudgetExceededError(Exception):
    """The pass reached ``max_queries``."""


class _LspQueryError(Exception):
    """A language server query failed."""


class _Queries:
    """The LSP requests of one pass: counted against the cap, and cached by key."""

    def __init__(self, client: LspClient, limit: int) -> None:
        self.client = client
        self.limit = limit
        self.used = 0
        self.cache: dict[tuple[Any, ...], Any] = {}

    async def get(self, key: tuple[Any, ...], request: Callable[[], Awaitable[T]]) -> T:
        """The cached answer for ``key``, or the answer ``request`` gets, counted against the cap."""
        if key in self.cache:
            return self.cache[key]  # type: ignore[no-any-return]
        if self.used >= self.limit:
            raise _QueryBudgetExceededError
        self.used += 1
        try:
            answer = await request()
        except Exception as error:
            raise _LspQueryError from error
        self.cache[key] = answer
        return answer


class LspStrategy:
    """A context strategy that offloads old tool results about code unrelated to the files being worked on.

    A language server decides relevance. The working set is the files touched in the newest ``preserve_recent``
    messages; files one ``references`` hop away (dependencies and dependents) are related. An older tool result that
    mentions only unrelated files is replaced with a placeholder carrying a stash reference, keeping its
    ``toolUseId`` and status. Results with no file or symbol evidence are left alone. The strategy adds no tools.

    It does nothing without a stash, below ``context_utilization`` (unless the context overflowed), or when a language
    server query fails, so the strategies after it still run.

    Example:
        ```python
        from strands import Agent
        from strands.experimental.context_manager import ContextManager
        from strands.vended_plugins.language_server import LspStrategy, StdioLspClient

        client = StdioLspClient(["pyright-langserver", "--stdio"], root="/work/repo")
        agent = Agent(
            context_manager=ContextManager(strategies=[LspStrategy(client, root="/work/repo"), "large_tool_offloading"])
        )
        ```
    """

    def __init__(
        self,
        client: LspClient,
        root: Path | str,
        *,
        preserve_recent: int | str = 5,
        context_utilization: int | str | None = "60%",
        block_threshold: int | str | None = 500,
        max_queries: int = 200,
        max_defining_files: int = 2,
        active_symbol_threshold: int = 1,
    ) -> None:
        """Configure the strategy.

        Args:
            client: The language server to query.
            root: Workspace root; only files under it count as evidence.
            preserve_recent: Newest messages never offloaded, which define the working set: a count, or ``"N%"`` of
                the messages.
            context_utilization: Context usage at or above which the strategy runs: ``"60%"`` of the context window, or
                a whole number of input tokens; None to run on every pass. Each offload rewrites history and breaks the
                prompt cache from that point on, so the default waits until the window is filling up.
            block_threshold: Tool results this size or smaller are left alone: a token count, or ``"N%"`` of the
                context window; None for no size check.
            max_queries: Cap on language server requests per pass; results not yet decided are kept.
            max_defining_files: A top-level name counts as evidence only if at most this many files define it.
            active_symbol_threshold: Results naming at least this many of the working set's distinctive symbols are
                kept.

        Raises:
            ValueError: When a condition value is invalid, ``preserve_recent`` is 0, or a count is below 1.
        """
        self._conditions = ResolvedConditions(
            build_conditions(
                context_utilization=context_utilization,
                block_threshold=block_threshold,
                preserve_recent=preserve_recent,
            )
        )
        if self._conditions.preserve_recent is None:
            raise ValueError(
                "preserve_recent=0 is invalid: the newest messages define the working set, keep at least 1"
            )
        self._preserve_recent: ParsedCondition = self._conditions.preserve_recent
        for name, value in (
            ("max_queries", max_queries),
            ("max_defining_files", max_defining_files),
            ("active_symbol_threshold", active_symbol_threshold),
        ):
            if value < 1:
                raise ValueError(f"{name}={value} is invalid: expected a whole number of at least 1")
        self._client = client
        self._root = Path(root).resolve()
        self._max_queries = max_queries
        self._max_defining_files = max_defining_files
        self._active_symbol_threshold = active_symbol_threshold
        self.last_report = LspPassReport()

    @property
    def name(self) -> str:
        """Stable identifier for logging and observability."""
        return "offload:lsp"

    def init(self, agent: Agent, stash: Stash | None = None) -> None:
        """Check a token-count ``context_utilization`` fits the agent's model.

        Raises:
            ValueError: When it is larger than the model's context window.
        """
        self._conditions.check_fits(agent)

    async def apply(self, context: ContextState) -> bool:
        """Offload older tool results that mention only files unrelated to the working set.

        Args:
            context: The context the strategy runs on.

        Returns:
            Whether any result was offloaded.
        """
        report = self.last_report = LspPassReport()
        report.skipped_reason = self._skip_reason(context)
        if report.skipped_reason:
            return False
        messages = context.messages
        tool_uses = _tool_use_inputs(messages)
        cutoff = len(messages) - self._preserve_recent.of(len(messages))
        report.working_set = {
            path for message in messages[cutoff:] for path in self._files_in_message(message, tool_uses)
        }
        if not report.working_set:
            report.skipped_reason = "no files in recent messages"
            return False

        queries = _Queries(self._client, self._max_queries)
        try:
            await self._find_related(report, queries)
            unrelated = await self._unrelated_results(messages, cutoff, tool_uses, report, queries)
        except _LspQueryError:
            logger.warning("strategy=<%s> | language server query failed, skipping this pass", self.name, exc_info=True)
            report.skipped_reason = "lsp error"
            return False
        finally:
            report.queries = queries.used
        return await self._offload(context, unrelated, report)

    def _skip_reason(self, context: ContextState) -> str | None:
        if context.stash is None:
            return "no stash"
        if not self._conditions.reached(context):
            return "below context_utilization"
        if len(context.messages) <= self._preserve_recent.of(len(context.messages)) + 1:
            return "no messages outside preserve_recent"
        return None

    async def _find_related(self, report: LspPassReport, queries: _Queries) -> None:
        """Collect the working set's distinctive symbols, and the files that reference any of its symbols."""
        try:
            for path in sorted(report.working_set):
                for symbol in await self._symbols(path, queries):
                    if symbol["_depth"] == 0 and await self._is_distinctive(symbol["name"], queries):
                        report.active_symbols.add(symbol["name"])
                    report.related |= await self._referencing_files(path, symbol, queries)
        except _QueryBudgetExceededError:
            report.skipped_reason = "max_queries reached while building the working set"

    async def _unrelated_results(
        self,
        messages: Messages,
        cutoff: int,
        tool_uses: dict[str, tuple[str, dict[str, Any]]],
        report: LspPassReport,
        queries: _Queries,
    ) -> list[tuple[Message, int, set[Path]]]:
        """The ``(message, block index, files)`` of each older tool result that mentions only unrelated files."""
        unrelated: list[tuple[Message, int, set[Path]]] = []
        if report.skipped_reason:
            return unrelated
        for message, block_index in _older_results(messages, cutoff, tool_uses):
            block = message["content"][block_index]
            files = self._files_in_block(block, tool_uses)
            if not files and not self._mentions_active(block, report.active_symbols):
                continue
            try:
                live = await self._is_live(block, files, report, queries)
            except _QueryBudgetExceededError:
                report.skipped_reason = "max_queries reached, remaining results kept"
                return unrelated
            if live:
                report.kept += 1
            else:
                unrelated.append((message, block_index, files))
        return unrelated

    async def _offload(
        self, context: ContextState, unrelated: list[tuple[Message, int, set[Path]]], report: LspPassReport
    ) -> bool:
        """Replace each unrelated result above ``block_threshold`` with a placeholder that references the stash."""
        stash = context.stash
        assert stash is not None
        proxy = ModelProxy(context.agent.model)
        threshold = self._conditions.threshold_tokens(context.agent)
        acted = False
        for message, block_index, files in unrelated:
            block = message["content"][block_index]
            measured = await proxy.count_tokens([Message(role=message["role"], content=[block])])
            if threshold is not None and measured <= threshold:
                report.kept += 1
                continue
            tool_result: ToolResult = block["toolResult"]
            tokens = measured + carried_tokens([block])
            names = sorted(self._relative(path) for path in files)
            stash_ref = await stash.ensure_stashed(block, message, block_index)
            preview = f"[Offloaded: about {', '.join(names)}, ~{tokens:,} tokens, not related to the current work]"
            placeholder = offload_placeholder("lsp", preview, stash_ref, tokens)
            message["content"][block_index] = placeholder_result(tool_result, [placeholder])
            report.offloaded.append((tool_result["toolUseId"], names))
            acted = True
        return acted

    async def _is_live(self, block: ContentBlock, files: set[Path], report: LspPassReport, queries: _Queries) -> bool:
        """Whether a result is about the working set, a file related to it, or a dependency of it."""
        if files & (report.working_set | report.related) or self._mentions_active(block, report.active_symbols):
            return True
        # Top-level symbols only: imports go through them, and method-level queries on large files make a pass slow.
        for path in sorted(files):
            for symbol in await self._symbols(path, queries):
                if symbol["_depth"] == 0 and await self._referencing_files(path, symbol, queries) & report.working_set:
                    report.related.add(path)
                    return True
        return False

    def _mentions_active(self, block: ContentBlock, active_symbols: set[str]) -> bool:
        if not active_symbols:
            return False
        hits = {name for name in _IDENTIFIER.findall(_block_text(block)) if name in active_symbols}
        return len(hits) >= self._active_symbol_threshold

    async def _is_distinctive(self, name: str, queries: _Queries) -> bool:
        """Whether few enough files define ``name`` for it to be evidence; ``logger`` or ``name`` match nearly all."""
        if name.startswith("__") or len(name) < _MIN_SYMBOL_CHARS:
            return False
        matches = await queries.get(("workspace_symbol", name), lambda: self._client.workspace_symbol(name))
        defining = {match["location"]["uri"] for match in matches if match.get("name") == name and "location" in match}
        return len(defining) <= self._max_defining_files

    async def _symbols(self, path: Path, queries: _Queries) -> list[dict[str, Any]]:
        if not path.is_file():
            return []
        symbols = await queries.get(("document_symbols", path), lambda: self._client.document_symbols(path.as_uri()))
        return list(_flatten_tracked(symbols))

    async def _referencing_files(self, path: Path, symbol: dict[str, Any], queries: _Queries) -> set[Path]:
        start = symbol["selectionRange"]["start"]
        position = Position(line=start["line"], character=start["character"])
        key = ("references", path, position["line"], position["character"])
        locations = await queries.get(key, lambda: self._client.references(path.as_uri(), position))
        return {uri_to_path(location["uri"]).resolve() for location in locations} - {path}

    def _files_in_message(self, message: Message, tool_uses: dict[str, tuple[str, dict[str, Any]]]) -> set[Path]:
        files: set[Path] = set()
        for block in message["content"]:
            if "toolUse" in block:
                files |= self._paths_in(block["toolUse"].get("input", {}).values())
            files |= self._files_in_block(block, tool_uses)
        return files

    def _files_in_block(self, block: ContentBlock, tool_uses: dict[str, tuple[str, dict[str, Any]]]) -> set[Path]:
        files: set[Path] = set()
        if "toolResult" in block:
            _, tool_input = tool_uses.get(block["toolResult"]["toolUseId"], ("", {}))
            files |= self._paths_in(tool_input.values())
        return files | self._paths_in(_PATHLIKE.findall(_block_text(block)))

    def _paths_in(self, values: Iterable[Any]) -> set[Path]:
        """The files under the root that string ``values`` name, relative to the root or absolute."""
        found: set[Path] = set()
        for value in values:
            if not isinstance(value, str) or len(value) > _MAX_PATH_CHARS or "\n" in value:
                continue
            path = self._existing_file(value)
            if path is not None:
                found.add(path)
        return found

    def _existing_file(self, value: str) -> Path | None:
        try:
            path = (self._root / value).resolve()
            return path if path.is_relative_to(self._root) and path.is_file() else None
        except (OSError, ValueError, RuntimeError):
            return None

    def _relative(self, path: Path) -> str:
        return str(path.relative_to(self._root)) if path.is_relative_to(self._root) else str(path)


def _flatten_tracked(symbols: list[dict[str, Any]], depth: int = 0) -> Iterable[dict[str, Any]]:
    """Tracked ``DocumentSymbol`` entries with their nesting depth; methods inside classes, no nested variables."""
    for symbol in symbols:
        # Flat SymbolInformation has no selectionRange to query references at.
        if "selectionRange" not in symbol:
            continue
        kind = symbol.get("kind")
        if kind in _TRACKED_KINDS and not (kind == _VARIABLE and depth > 0):
            yield {**symbol, "_depth": depth}
        if kind in (_CLASS, _INTERFACE):
            yield from _flatten_tracked(symbol.get("children", []), depth + 1)


def _tool_use_inputs(messages: Messages) -> dict[str, tuple[str, dict[str, Any]]]:
    """``toolUseId`` -> ``(tool name, input)`` for every tool use in the conversation."""
    inputs: dict[str, tuple[str, dict[str, Any]]] = {}
    for message in messages:
        for block in message["content"]:
            if "toolUse" in block:
                tool_use = block["toolUse"]
                tool_input = tool_use.get("input")
                inputs[tool_use["toolUseId"]] = (tool_use["name"], tool_input if isinstance(tool_input, dict) else {})
    return inputs


def _older_results(
    messages: Messages, cutoff: int, tool_uses: dict[str, tuple[str, dict[str, Any]]]
) -> Iterable[tuple[Message, int]]:
    """``(message, block index)`` of each offloadable tool result after the task and before ``cutoff``, unpinned."""
    for index in range(1, cutoff):
        if is_pinned(messages, index):
            continue
        for block_index, block in enumerate(messages[index]["content"]):
            if _is_offloadable(block, tool_uses):
                yield messages[index], block_index


def _is_offloadable(block: ContentBlock, tool_uses: dict[str, tuple[str, dict[str, Any]]]) -> bool:
    """A non-empty tool result that is not retrieved content and holds no placeholder yet."""
    if "toolResult" not in block:
        return False
    tool_result = block["toolResult"]
    if not tool_result.get("content"):
        return False
    if tool_uses.get(tool_result["toolUseId"], ("", {}))[0] == RETRIEVAL_TOOL_NAME:
        return False
    return not any(is_offloaded(item) for item in tool_result["content"])


def _block_text(block: ContentBlock) -> str:
    if "text" in block:
        return block["text"]
    if "toolResult" in block:
        return "\n".join(item["text"] for item in block["toolResult"]["content"] if "text" in item)
    return ""
