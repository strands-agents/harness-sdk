"""Notebook tool for managing persistent text notebooks in agent state.

Notebooks are stored on the agent's :attr:`~strands.Agent.state` under the
``notebooks`` key and persist within the agent session.

The tool is a thin wrapper over ``agent.state`` — persistence, isolation, and
serialization all follow whatever the caller configured for agent state.

Supported operations: ``create``, ``list``, ``read``, ``write`` (append,
string replacement, or line insertion), and ``clear``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from ...tools.decorator import tool
from ...types.tools import ToolContext
from .types import DEFAULT_NOTEBOOK_DESCRIPTION, _NotebookState

if TYPE_CHECKING:
    from ...tools.decorator import DecoratedFunctionTool

_DEFAULT_MAX_NOTEBOOK_SIZE_BYTES = 1_048_576  # 1 MiB

_DEFAULT_NOTEBOOK_NAME = "default"

_STATE_KEY = "notebooks"

# Modes that alter ``notebooks`` state. Only these persist a write.
_MUTATING_MODES = frozenset({"create", "write", "clear"})

# Modes that can grow state. Only these need size-cap enforcement.
_GROWING_MODES = frozenset({"create", "write"})


def make_notebook(
    *,
    name: str = "notebook",
    description: str = DEFAULT_NOTEBOOK_DESCRIPTION,
    max_notebook_size_bytes: int = _DEFAULT_MAX_NOTEBOOK_SIZE_BYTES,
) -> DecoratedFunctionTool:
    """Create a notebook tool.

    Args:
        name: Tool name exposed to the model. Defaults to ``"notebook"``.
        description: Tool description shown to the model.
        max_notebook_size_bytes: Maximum size of a single notebook's content
            in bytes (UTF-8 encoded). Defaults to 1 MiB.

    Returns:
        A decorated tool that manages text notebooks in agent state.

    Raises:
        ValueError: If ``name`` is empty, or ``max_notebook_size_bytes`` is not
            a positive integer.
    """
    if not name:
        raise ValueError("name must be a non-empty string")
    if (
        not isinstance(max_notebook_size_bytes, int)
        or isinstance(max_notebook_size_bytes, bool)
        or max_notebook_size_bytes < 1
    ):
        raise ValueError("max_notebook_size_bytes must be a positive integer")

    @tool(name=name, description=description, context="tool_context")
    async def notebook_tool(
        mode: Literal["create", "list", "read", "write", "clear"],
        tool_context: ToolContext,
        name: str | None = None,
        new_str: str | None = None,
        old_str: str | None = None,
        insert_line: int | str | None = None,
        read_range: list[int] | None = None,
    ) -> str:
        """Manages text notebooks for note-taking and documentation.

        Supports `create`, `list`, `read`, `write` (append, replace, or insert), and `clear`
        operations. Notebooks persist across invocations within a session.

        Args:
            mode: The operation to perform: `create`, `list`, `read`, `write`, `clear`.
            tool_context: Injected by the framework. Not user-facing.
            name: Name of the notebook to operate on. Defaults to "default".
            new_str: Content for create (initial text), write/append (text to append),
                or write/replace and write/insert.
            old_str: String to replace in write mode when doing text replacement.
            insert_line: Line number (int) or search text (str) for insertion point in write mode.
                Supports negative indices.
            read_range: Optional parameter of `read` command. Line range to show [start, end].
                Supports negative indices.
        """
        state = tool_context.agent.state

        notebooks_obj: _NotebookState | None = state.get(_STATE_KEY)
        # AgentState.get deep-copies; guard shape strictly to catch corruption from sibling tools.
        if notebooks_obj is None:
            notebooks: _NotebookState = {}
        elif isinstance(notebooks_obj, dict):
            for k, v in notebooks_obj.items():
                if not isinstance(k, str) or not isinstance(v, str):
                    raise ValueError("Malformed notebooks state: keys and values must be strings")
            notebooks = notebooks_obj
        else:
            raise ValueError("Malformed notebooks state: expected a dict")

        # Ensure default notebook exists in-memory; only persisted if this mode mutates state.
        if not notebooks:
            notebooks[_DEFAULT_NOTEBOOK_NAME] = ""

        target = name if name is not None else _DEFAULT_NOTEBOOK_NAME
        if not isinstance(target, str):
            raise ValueError("Notebook name must be a string")

        if mode == "create":
            result = _handle_create(notebooks, target, new_str)
        elif mode == "list":
            result = _handle_list(notebooks)
        elif mode == "read":
            result = _handle_read(notebooks, target, read_range)
        elif mode == "write":
            _validate_write_params(old_str, new_str, insert_line)
            result = _handle_write(notebooks, target, old_str, new_str, insert_line)
        elif mode == "clear":
            result = _handle_clear(notebooks, target)
        else:  # pragma: no cover - Literal narrows this at type-check time.
            raise ValueError(f"Unknown mode: {mode}")

        if mode in _GROWING_MODES:
            size = len(notebooks[target].encode("utf-8"))
            if size > max_notebook_size_bytes:
                raise ValueError(
                    f"Notebook '{target}' content ({size} bytes) would exceed"
                    f" maximum of {max_notebook_size_bytes} bytes"
                )
        if mode in _MUTATING_MODES:
            state.set(_STATE_KEY, notebooks)

        return result

    return notebook_tool


notebook = make_notebook()
"""Default notebook tool."""


# ---- Internals ----


def _validate_write_params(old_str: str | None, new_str: str | None, insert_line: int | str | None) -> None:
    """Validate the parameter combination for a write operation.

    Args:
        old_str: The string to replace, if this is a replacement.
        new_str: The replacement or inserted text.
        insert_line: The insertion anchor (line number or search text), if this is an insertion.

    Raises:
        ValueError: If neither valid combination is present.
    """
    has_replacement = old_str is not None and new_str is not None
    has_insertion = insert_line is not None and new_str is not None
    has_append = old_str is None and insert_line is None and new_str is not None
    if not (has_replacement or has_insertion or has_append):
        raise ValueError(
            "Write operation requires either new_str alone (append), "
            "(old_str + new_str) for replacement, "
            "or (insert_line + new_str) for insertion"
        )
    if old_str is not None and insert_line is not None:
        raise ValueError(
            "Write operation is ambiguous: pass either `old_str` (replace) or `insert_line` (insert), not both"
        )


def _handle_create(notebooks: _NotebookState, name: str, new_str: str | None) -> str:
    notebooks[name] = new_str if new_str is not None else ""
    suffix = " with specified content" if new_str else " (empty)"
    return f"Created notebook '{name}'{suffix}"


def _handle_list(notebooks: _NotebookState) -> str:
    lines = []
    for nb_name, content in notebooks.items():
        line_count = len(content.split("\n")) if content else 0
        status = "Empty" if line_count == 0 else f"{line_count} lines"
        lines.append(f"- {nb_name}: {status}")
    return "Available notebooks:\n" + "\n".join(lines)


def _handle_read(notebooks: _NotebookState, name: str, read_range: list[int] | None) -> str:
    if name not in notebooks:
        raise ValueError(f"Notebook '{name}' not found")

    content = notebooks[name]

    if read_range is None:
        return content if content else f"Notebook '{name}' is empty"

    if len(read_range) != 2:
        raise ValueError("`read_range` must be a list of two integers: `[start, end]`")

    lines = content.split("\n")
    start, end = read_range[0], read_range[1]

    if start < 0:
        start = len(lines) + start + 1
    if end < 0:
        end = len(lines) + end + 1

    selected: list[str] = []
    for line_num in range(max(start, 1), min(end, len(lines)) + 1):
        selected.append(f"{line_num}: {lines[line_num - 1]}")

    if not selected:
        return (
            f"No lines found in range [{read_range[0]}, {read_range[1]}]. Notebook '{name}' has {len(lines)} line(s)."
        )
    return "\n".join(selected)


def _handle_write(
    notebooks: _NotebookState,
    name: str,
    old_str: str | None,
    new_str: str | None,
    insert_line: int | str | None,
) -> str:
    if name not in notebooks:
        raise ValueError(f"Notebook '{name}' not found")

    # Append mode: new_str alone, no replacement or insertion anchor.
    if old_str is None and insert_line is None and new_str is not None:
        if len(new_str) == 0:
            return f"No changes made to notebook '{name}'"
        content = notebooks[name]
        separator = "\n" if content and not content.endswith("\n") else ""
        notebooks[name] = f"{content}{separator}{new_str}"
        return f"Appended text to notebook '{name}'"

    # String replacement mode.
    if old_str is not None and new_str is not None:
        if old_str not in notebooks[name]:
            raise ValueError(f"String '{old_str}' not found in notebook '{name}'")
        notebooks[name] = notebooks[name].replace(old_str, new_str, 1)
        return f"Replaced text in notebook '{name}'"

    # Line insertion mode.
    if insert_line is not None and new_str is not None:
        lines = notebooks[name].split("\n")

        if isinstance(insert_line, str):
            line_num = -1
            for i, line in enumerate(lines):
                if insert_line in line:
                    line_num = i
                    break
            if line_num == -1:
                raise ValueError(f"Text '{insert_line}' not found in notebook '{name}'")
        elif isinstance(insert_line, int):
            if insert_line < 0:
                line_num = len(lines) + insert_line
            else:
                line_num = insert_line - 1
        else:
            raise ValueError("`insert_line` must be an integer or string")

        if line_num < -1 or line_num > len(lines):
            raise ValueError("Line number out of range")

        lines.insert(line_num + 1, new_str)
        notebooks[name] = "\n".join(lines)
        return f"Inserted text at line {line_num + 2} in notebook '{name}'"

    raise ValueError("Invalid write operation")


def _handle_clear(notebooks: _NotebookState, name: str) -> str:
    if name not in notebooks:
        raise ValueError(f"Notebook '{name}' not found")
    notebooks[name] = ""
    return f"Cleared notebook '{name}'"
