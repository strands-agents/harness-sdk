"""Tests for the notebook tool."""

from types import SimpleNamespace

import pytest

from strands.agent.state import AgentState
from strands.types.tools import ToolContext
from strands.vended_tools import make_notebook, notebook
from strands.vended_tools.notebook.notebook import (
    _DEFAULT_MAX_NOTEBOOK_SIZE_BYTES,
)
from strands.vended_tools.notebook.types import DEFAULT_NOTEBOOK_DESCRIPTION


def _fresh_context(initial_notebooks: dict[str, str] | None = None) -> tuple[AgentState, ToolContext]:
    state = AgentState({"notebooks": initial_notebooks} if initial_notebooks is not None else {"notebooks": {}})
    agent = SimpleNamespace(state=state)
    ctx = ToolContext(
        tool_use={"name": "notebook", "toolUseId": "test-id", "input": {}},
        agent=agent,
        invocation_state={},
    )
    return state, ctx


async def _invoke(ctx: ToolContext, input_: dict, alist) -> dict:
    events = await alist(notebook.stream({"toolUseId": "t", "input": input_}, {"agent": ctx.agent}))
    return events[-1]["tool_result"]


class TestCreate:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "name,expected_name",
        [
            (None, "default"),
            ("notes", "notes"),
        ],
    )
    async def test_creates_empty_notebook_stream_envelope(self, name, expected_name, alist):
        state, ctx = _fresh_context()
        input_ = {"mode": "create"}
        if name is not None:
            input_["name"] = name
        tru_result = await _invoke(ctx, input_, alist)
        exp_result = {
            "toolUseId": "t",
            "status": "success",
            "content": [{"text": f"Created notebook '{expected_name}' (empty)"}],
        }
        assert tru_result == exp_result
        assert state.get("notebooks")[expected_name] == ""

    @pytest.mark.asyncio
    async def test_creates_notebook_with_initial_content(self):
        state, ctx = _fresh_context()
        content = "# My Notes\n\nFirst entry"
        result = await notebook(mode="create", name="notes", new_str=content, tool_context=ctx)
        assert result == "Created notebook 'notes' with specified content"
        assert state.get("notebooks")["notes"] == content

    @pytest.mark.asyncio
    async def test_overwrites_existing_notebook(self):
        state, ctx = _fresh_context({"notes": "Old content"})
        result = await notebook(mode="create", name="notes", new_str="New content", tool_context=ctx)
        assert result == "Created notebook 'notes' with specified content"
        assert state.get("notebooks")["notes"] == "New content"


class TestList:
    @pytest.mark.asyncio
    async def test_lists_default_when_initialized(self):
        _, ctx = _fresh_context({"default": ""})
        assert await notebook(mode="list", tool_context=ctx) == "Available notebooks:\n- default: Empty"

    @pytest.mark.asyncio
    async def test_lists_multiple_with_line_counts(self):
        _, ctx = _fresh_context({"default": "", "notes": "Line 1\nLine 2\nLine 3", "todo": "Single line"})
        result = await notebook(mode="list", tool_context=ctx)
        assert result == "Available notebooks:\n- default: Empty\n- notes: 3 lines\n- todo: 1 lines"


class TestRead:
    @pytest.mark.asyncio
    async def test_reads_entire_notebook(self):
        _, ctx = _fresh_context({"notes": "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"})
        assert await notebook(mode="read", name="notes", tool_context=ctx) == "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"

    @pytest.mark.asyncio
    async def test_reads_empty_notebook(self):
        _, ctx = _fresh_context({"empty": ""})
        assert await notebook(mode="read", name="empty", tool_context=ctx) == "Notebook 'empty' is empty"

    @pytest.mark.asyncio
    async def test_reads_specific_line_range(self):
        _, ctx = _fresh_context({"default": "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"})
        assert await notebook(mode="read", read_range=[2, 4], tool_context=ctx) == "2: Line 2\n3: Line 3\n4: Line 4"

    @pytest.mark.parametrize(
        "read_range,expected",
        [
            ([-3, 5], "3: Line 3\n4: Line 4\n5: Line 5"),
            ([1, -2], "1: Line 1\n2: Line 2\n3: Line 3\n4: Line 4"),
            ([-2, -1], "4: Line 4\n5: Line 5"),
        ],
    )
    @pytest.mark.asyncio
    async def test_reads_range_with_negative_indices(self, read_range, expected):
        _, ctx = _fresh_context({"default": "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"})
        assert await notebook(mode="read", read_range=read_range, tool_context=ctx) == expected

    @pytest.mark.asyncio
    async def test_reads_out_of_range(self):
        _, ctx = _fresh_context({"default": "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"})
        result = await notebook(mode="read", read_range=[10, 20], tool_context=ctx)
        assert "No lines found in range [10, 20]" in result
        assert "5 line(s)" in result


class TestWriteReplace:
    @pytest.mark.asyncio
    async def test_replaces_text(self):
        state, ctx = _fresh_context({"default": "# Todo List\n\n[ ] Task 1\n[ ] Task 2\n[x] Task 3"})
        result = await notebook(mode="write", old_str="[ ] Task 1", new_str="[x] Task 1", tool_context=ctx)
        assert result == "Replaced text in notebook 'default'"
        assert state.get("notebooks")["default"] == "# Todo List\n\n[x] Task 1\n[ ] Task 2\n[x] Task 3"

    @pytest.mark.asyncio
    async def test_replaces_multiline_text(self):
        state, ctx = _fresh_context({"default": "# Todo List\n\n[ ] Task 1\n[ ] Task 2\n[x] Task 3"})
        await notebook(
            mode="write", old_str="[ ] Task 1\n[ ] Task 2", new_str="[x] Task 1\n[x] Task 2", tool_context=ctx
        )
        assert state.get("notebooks")["default"] == "# Todo List\n\n[x] Task 1\n[x] Task 2\n[x] Task 3"

    @pytest.mark.asyncio
    async def test_preserves_dollar_sign_patterns_literally(self):
        state, ctx = _fresh_context({"default": "const value = getPrice()"})
        await notebook(mode="write", old_str="getPrice()", new_str="$& is not $1 or $$", tool_context=ctx)
        assert state.get("notebooks")["default"] == "const value = $& is not $1 or $$"

    @pytest.mark.asyncio
    async def test_replaces_only_first_occurrence(self):
        state, ctx = _fresh_context({"default": "a b a b"})
        await notebook(mode="write", old_str="a", new_str="X", tool_context=ctx)
        assert state.get("notebooks")["default"] == "X b a b"

    @pytest.mark.asyncio
    async def test_missing_old_string_raises(self):
        _, ctx = _fresh_context({"default": "# Todo List\n\n[ ] Task 1"})
        with pytest.raises(ValueError, match="String 'Nonexistent' not found in notebook 'default'"):
            await notebook(mode="write", old_str="Nonexistent", new_str="New", tool_context=ctx)


class TestWriteInsert:
    @pytest.mark.asyncio
    async def test_inserts_after_line_number(self):
        state, ctx = _fresh_context({"default": "Line 1\nLine 2\nLine 3"})
        result = await notebook(mode="write", insert_line=2, new_str="Inserted line", tool_context=ctx)
        assert result == "Inserted text at line 3 in notebook 'default'"
        assert state.get("notebooks")["default"] == "Line 1\nLine 2\nInserted line\nLine 3"

    @pytest.mark.asyncio
    async def test_inserts_at_beginning_line_zero(self):
        state, ctx = _fresh_context({"default": "Line 1\nLine 2\nLine 3"})
        result = await notebook(mode="write", insert_line=0, new_str="First line", tool_context=ctx)
        assert result == "Inserted text at line 1 in notebook 'default'"
        assert state.get("notebooks")["default"] == "First line\nLine 1\nLine 2\nLine 3"

    @pytest.mark.asyncio
    async def test_inserts_after_last_line_via_negative_index(self):
        state, ctx = _fresh_context({"default": "Line 1\nLine 2\nLine 3"})
        result = await notebook(mode="write", insert_line=-1, new_str="Last line", tool_context=ctx)
        assert result == "Inserted text at line 4 in notebook 'default'"
        assert state.get("notebooks")["default"] == "Line 1\nLine 2\nLine 3\nLast line"

    @pytest.mark.asyncio
    async def test_inserts_after_negative_index(self):
        state, ctx = _fresh_context({"default": "Line 1\nLine 2\nLine 3"})
        result = await notebook(mode="write", insert_line=-2, new_str="Before last", tool_context=ctx)
        assert result == "Inserted text at line 3 in notebook 'default'"
        assert state.get("notebooks")["default"] == "Line 1\nLine 2\nBefore last\nLine 3"

    @pytest.mark.asyncio
    async def test_inserts_after_partial_text_match(self):
        state, ctx = _fresh_context({"default": "Line 1\nLine 2\nLine 3"})
        result = await notebook(mode="write", insert_line="2", new_str="After match", tool_context=ctx)
        assert result == "Inserted text at line 3 in notebook 'default'"
        assert state.get("notebooks")["default"] == "Line 1\nLine 2\nAfter match\nLine 3"

    @pytest.mark.asyncio
    async def test_bool_insert_line_coerced_to_int_via_stream(self, alist):
        # Pydantic coerces True→1 on the model path; the in-body bool guard was dead and has been removed.
        state, ctx = _fresh_context({"default": "Line 1\nLine 2"})
        tru_result = await _invoke(ctx, {"mode": "write", "insert_line": True, "new_str": "x"}, alist)
        assert tru_result["status"] == "success"
        assert state.get("notebooks")["default"] == "Line 1\nx\nLine 2"

    @pytest.mark.asyncio
    async def test_search_not_found_raises(self):
        _, ctx = _fresh_context({"default": "Line 1\nLine 2\nLine 3"})
        with pytest.raises(ValueError, match="Text 'Nonexistent' not found in notebook 'default'"):
            await notebook(mode="write", insert_line="Nonexistent", new_str="New line", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_line_number_out_of_range_raises(self):
        _, ctx = _fresh_context({"default": "Line 1\nLine 2\nLine 3"})
        with pytest.raises(ValueError, match="Line number out of range"):
            await notebook(mode="write", insert_line=100, new_str="New line", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_insert_line_at_line_count_plus_one_appends(self):
        # Matches TS: insert_line=N+1 appends correctly; message reports lineNum+2 (same shared quirk).
        state, ctx = _fresh_context({"default": "Line 1\nLine 2\nLine 3"})
        result = await notebook(mode="write", insert_line=4, new_str="Appended", tool_context=ctx)
        assert result == "Inserted text at line 5 in notebook 'default'"
        assert state.get("notebooks")["default"] == "Line 1\nLine 2\nLine 3\nAppended"

    @pytest.mark.asyncio
    async def test_inserts_into_custom_notebook(self):
        state, ctx = _fresh_context({"notes": "First\nSecond"})
        result = await notebook(mode="write", name="notes", insert_line=1, new_str="Middle", tool_context=ctx)
        assert result == "Inserted text at line 2 in notebook 'notes'"
        assert state.get("notebooks")["notes"] == "First\nMiddle\nSecond"


class TestWriteAppend:
    @pytest.mark.asyncio
    async def test_appends_to_non_empty_notebook(self):
        state, ctx = _fresh_context({"default": "Line 1"})
        result = await notebook(mode="write", new_str="Line 2", tool_context=ctx)
        assert result == "Appended text to notebook 'default'"
        assert state.get("notebooks")["default"] == "Line 1\nLine 2"

    @pytest.mark.asyncio
    async def test_appends_to_empty_notebook(self):
        state, ctx = _fresh_context({"default": ""})
        result = await notebook(mode="write", new_str="First line", tool_context=ctx)
        assert result == "Appended text to notebook 'default'"
        assert state.get("notebooks")["default"] == "First line"

    @pytest.mark.asyncio
    async def test_no_double_newline_when_content_ends_with_newline(self):
        state, ctx = _fresh_context({"default": "Line 1\n"})
        await notebook(mode="write", new_str="Line 2", tool_context=ctx)
        assert state.get("notebooks")["default"] == "Line 1\nLine 2"

    @pytest.mark.asyncio
    async def test_empty_new_str_is_noop(self):
        state, ctx = _fresh_context({"default": "unchanged"})
        result = await notebook(mode="write", new_str="", tool_context=ctx)
        assert result == "No changes made to notebook 'default'"
        assert state.get("notebooks")["default"] == "unchanged"


class TestClear:
    @pytest.mark.asyncio
    async def test_clears_notebook(self):
        state, ctx = _fresh_context({"default": "Some content"})
        result = await notebook(mode="clear", tool_context=ctx)
        assert result == "Cleared notebook 'default'"
        assert state.get("notebooks")["default"] == ""

    @pytest.mark.asyncio
    async def test_clearing_does_not_affect_other_notebooks(self):
        state, ctx = _fresh_context({"default": "Some content", "notes": "More content"})
        await notebook(mode="clear", name="notes", tool_context=ctx)
        assert state.get("notebooks")["default"] == "Some content"


class TestStatePersistence:
    @pytest.mark.asyncio
    async def test_persists_across_operations(self):
        state, ctx = _fresh_context()
        await notebook(mode="create", name="notes", new_str="Initial", tool_context=ctx)
        assert state.get("notebooks")["notes"] == "Initial"

        await notebook(mode="write", name="notes", old_str="Initial", new_str="Initial\nAdded", tool_context=ctx)
        assert state.get("notebooks")["notes"] == "Initial\nAdded"

        content = await notebook(mode="read", name="notes", tool_context=ctx)
        assert content == "Initial\nAdded"

    @pytest.mark.asyncio
    async def test_read_does_not_mutate_state(self):
        oversized = {f"nb-{i}": "a" * (_DEFAULT_MAX_NOTEBOOK_SIZE_BYTES // 2) for i in range(20)}
        state, ctx = _fresh_context(oversized)
        version_before = state._get_version()
        await notebook(mode="read", name="nb-0", tool_context=ctx)
        assert state._get_version() == version_before

    @pytest.mark.asyncio
    async def test_list_does_not_mutate_state_when_empty(self):
        state, ctx = _fresh_context()
        await notebook(mode="list", tool_context=ctx)
        assert state.get("notebooks") == {}

    @pytest.mark.asyncio
    async def test_rejects_malformed_state(self):
        state = AgentState({"notebooks": {"good": ["not", "a", "string"]}})
        agent = SimpleNamespace(state=state)
        ctx = ToolContext(
            tool_use={"name": "notebook", "toolUseId": "t", "input": {}},
            agent=agent,
            invocation_state={},
        )
        with pytest.raises(ValueError, match="Malformed notebooks state"):
            await notebook(mode="read", tool_context=ctx)


class TestValidationErrors:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "mode,kwargs",
        [
            ("read", {"name": "missing"}),
            ("write", {"name": "missing", "old_str": "Old", "new_str": "New"}),
            ("write", {"name": "missing", "new_str": "x"}),
            ("clear", {"name": "missing"}),
        ],
    )
    async def test_missing_notebook_raises(self, mode, kwargs):
        _, ctx = _fresh_context()
        with pytest.raises(ValueError, match="Notebook 'missing' not found"):
            await notebook(mode=mode, tool_context=ctx, **kwargs)

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "kwargs",
        [
            {"old_str": "Old"},
            {"insert_line": 1},
            {},
        ],
    )
    async def test_rejects_write_without_new_str(self, kwargs):
        _, ctx = _fresh_context()
        with pytest.raises(ValueError):
            await notebook(mode="write", tool_context=ctx, **kwargs)

    @pytest.mark.asyncio
    async def test_rejects_write_with_both_old_str_and_insert_line(self):
        _, ctx = _fresh_context({"default": "Line 1\nLine 2"})
        with pytest.raises(ValueError, match="ambiguous"):
            await notebook(mode="write", old_str="Line 1", new_str="Replaced", insert_line=0, tool_context=ctx)

    @pytest.mark.asyncio
    async def test_rejects_read_range_wrong_length(self):
        _, ctx = _fresh_context({"default": "Line 1\nLine 2"})
        with pytest.raises(ValueError, match="two integers"):
            await notebook(mode="read", read_range=[1], tool_context=ctx)


class TestSessionCaps:
    @pytest.mark.asyncio
    async def test_rejects_notebook_content_over_size_limit(self):
        _, ctx = _fresh_context()
        oversized = "a" * (_DEFAULT_MAX_NOTEBOOK_SIZE_BYTES + 1)
        with pytest.raises(ValueError, match="would exceed maximum"):
            await notebook(mode="create", name="big", new_str=oversized, tool_context=ctx)
        assert "big" not in (_.get("notebooks") or {})

    @pytest.mark.asyncio
    async def test_allows_write_to_other_notebook_when_one_is_oversized(self):
        custom = make_notebook(max_notebook_size_bytes=4)
        initial = {"big": "x" * 100, "small": "hi"}
        _, ctx = _fresh_context(initial)
        result = await custom(mode="write", name="small", new_str="!", tool_context=ctx)
        assert result == "Appended text to notebook 'small'"

    @pytest.mark.asyncio
    async def test_write_rolls_back_on_size_cap_exceeded(self):
        custom = make_notebook(max_notebook_size_bytes=5)
        initial = {"notes": "hello"}
        _, ctx = _fresh_context(initial)
        with pytest.raises(ValueError, match="would exceed maximum"):
            await custom(mode="write", name="notes", new_str=" world", tool_context=ctx)
        assert _.get("notebooks")["notes"] == "hello"

    @pytest.mark.asyncio
    async def test_custom_max_notebook_size_bytes(self):
        custom = make_notebook(max_notebook_size_bytes=10)
        _, ctx = _fresh_context()
        with pytest.raises(ValueError, match="would exceed maximum"):
            await custom(mode="create", name="small-cap", new_str="x" * 11, tool_context=ctx)


class TestMakeNotebook:
    def test_custom_name(self):
        custom = make_notebook(name="scratchpad")
        assert custom.tool_name == "scratchpad"

    def test_custom_description(self):
        custom = make_notebook(description="My custom description")
        assert custom.tool_spec["description"] == "My custom description"

    def test_default_name_and_description(self):
        custom = make_notebook()
        assert custom.tool_name == "notebook"
        assert custom.tool_spec["description"] == DEFAULT_NOTEBOOK_DESCRIPTION

    @pytest.mark.asyncio
    async def test_custom_tool_is_functional(self):
        custom = make_notebook(name="scratchpad")
        state, ctx = _fresh_context()
        result = await custom(mode="create", name="notes", new_str="hello", tool_context=ctx)
        assert result == "Created notebook 'notes' with specified content"
        assert state.get("notebooks")["notes"] == "hello"

    def test_rejects_empty_name(self):
        with pytest.raises(ValueError, match="non-empty"):
            make_notebook(name="")

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"max_notebook_size_bytes": 0},
            {"max_notebook_size_bytes": -1},
            {"max_notebook_size_bytes": 1.5},
            {"max_notebook_size_bytes": True},
        ],
    )
    def test_rejects_invalid_cap(self, kwargs):
        with pytest.raises(ValueError, match="max_notebook_size_bytes"):
            make_notebook(**kwargs)  # type: ignore[arg-type]
