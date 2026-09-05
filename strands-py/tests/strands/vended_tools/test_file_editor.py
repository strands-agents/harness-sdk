"""Tests for the sandbox-routed file editor tool.

Tests for the sandbox-routed file editor tool.
The tool is exercised against a real ``NotASandboxLocalEnvironment`` (host
filesystem), and called directly
(like a normal async function). Errors
surface as raised ``ValueError`` (the raw function raises; the error->status
wrapping only happens through the tool's ``stream`` path). Path semantics assume
POSIX, so these are skipped on Windows.
"""

import sys
from types import SimpleNamespace

import pytest

from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.types.tools import ToolContext
from strands.vended_tools.file_editor import file_editor, make_file_editor
from strands.vended_tools.file_editor.file_editor import DEFAULT_FILE_EDITOR_DESCRIPTION

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX path semantics assumed")


def _tool_context(sandbox: NotASandboxLocalEnvironment | None = None) -> ToolContext:
    """Build a ToolContext whose agent exposes the given sandbox (or a fresh one)."""
    agent = SimpleNamespace(sandbox=sandbox or NotASandboxLocalEnvironment())
    return ToolContext(
        tool_use={"name": "file_editor", "toolUseId": "test-id", "input": {}},
        agent=agent,
        invocation_state={},
    )


def _write(path, content: str) -> str:
    """Write content to a path and return it as a string (test helper)."""
    path.write_text(content)
    return str(path)


@pytest.fixture
def editor():
    """A file editor bound to a host sandbox, bound to a host sandbox."""
    return make_file_editor(sandbox=NotASandboxLocalEnvironment())


@pytest.fixture
def ctx():
    return _tool_context()


class TestViewFile:
    """Viewing an entire file or a line range."""

    @pytest.mark.asyncio
    async def test_returns_content_with_line_numbers(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2\nLine 3")
        result = await editor(command="view", path=file_path, tool_context=ctx)
        assert "Here's the result of running `cat -n`" in result
        assert "     1  Line 1" in result
        assert "     2  Line 2" in result
        assert "     3  Line 3" in result

    @pytest.mark.asyncio
    async def test_handles_empty_file(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "empty.txt", "")
        result = await editor(command="view", path=file_path, tool_context=ctx)
        assert "Here's the result of running `cat -n`" in result

    @pytest.mark.asyncio
    async def test_handles_single_line(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "single.txt", "Only one line")
        result = await editor(command="view", path=file_path, tool_context=ctx)
        assert "     1  Only one line" in result

    @pytest.mark.asyncio
    async def test_range_returns_specified_lines(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2\nLine 3\nLine 4\nLine 5")
        result = await editor(command="view", path=file_path, tool_context=ctx, view_range=[2, 4])
        assert "     2  Line 2" in result
        assert "     3  Line 3" in result
        assert "     4  Line 4" in result
        assert "     1  " not in result
        assert "     5  " not in result

    @pytest.mark.asyncio
    async def test_range_negative_end_means_to_end(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2\nLine 3\nLine 4\nLine 5")
        result = await editor(command="view", path=file_path, tool_context=ctx, view_range=[3, -1])
        assert "     3  Line 3" in result
        assert "     5  Line 5" in result
        assert "     1  " not in result
        assert "     2  " not in result

    @pytest.mark.asyncio
    async def test_range_single_line(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2\nLine 3")
        result = await editor(command="view", path=file_path, tool_context=ctx, view_range=[2, 2])
        assert "     2  Line 2" in result
        assert "     1  " not in result
        assert "     3  " not in result


class TestViewDirectory:
    """Viewing a directory lists its contents."""

    @pytest.mark.asyncio
    async def test_lists_two_levels_deep(self, editor, ctx, tmp_path):
        d = tmp_path / "testdir"
        (d / "subdir" / "nested").mkdir(parents=True)
        _write(d / "file1.txt", "content")
        _write(d / "file2.txt", "content")
        _write(d / "subdir" / "file3.txt", "content")
        _write(d / "subdir" / "nested" / "file4.txt", "content")
        result = await editor(command="view", path=str(d), tool_context=ctx)
        assert "file1.txt" in result
        assert "file2.txt" in result
        assert "subdir" in result
        assert "file3.txt" in result
        assert "file4.txt" in result

    @pytest.mark.asyncio
    async def test_excludes_hidden(self, editor, ctx, tmp_path):
        d = tmp_path / "testdir"
        d.mkdir()
        _write(d / "visible.txt", "content")
        _write(d / ".hidden.txt", "content")
        result = await editor(command="view", path=str(d), tool_context=ctx)
        assert "visible.txt" in result
        assert ".hidden" not in result


class TestViewErrors:
    """Error cases for the view command."""

    @pytest.mark.asyncio
    async def test_nonexistent_raises(self, editor, ctx, tmp_path):
        with pytest.raises(ValueError, match="does not exist"):
            await editor(command="view", path=str(tmp_path / "nope.txt"), tool_context=ctx)

    @pytest.mark.asyncio
    async def test_relative_path_raises(self, editor, ctx):
        with pytest.raises(ValueError, match="not an absolute path"):
            await editor(command="view", path="relative/path.txt", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_path_traversal_raises(self, editor, ctx):
        with pytest.raises(ValueError, match="path traversal"):
            await editor(command="view", path="/tmp/../etc/passwd", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_range_invalid_start_raises(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2\nLine 3")
        with pytest.raises(ValueError, match="view_range"):
            await editor(command="view", path=file_path, tool_context=ctx, view_range=[0, 2])

    @pytest.mark.asyncio
    async def test_range_end_beyond_length_raises(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2\nLine 3")
        with pytest.raises(ValueError, match="view_range"):
            await editor(command="view", path=file_path, tool_context=ctx, view_range=[1, 10])

    @pytest.mark.asyncio
    async def test_range_end_before_start_raises(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2\nLine 3")
        with pytest.raises(ValueError, match="view_range"):
            await editor(command="view", path=file_path, tool_context=ctx, view_range=[3, 1])

    @pytest.mark.asyncio
    async def test_range_on_directory_raises(self, editor, ctx, tmp_path):
        d = tmp_path / "testdir"
        d.mkdir()
        _write(d / "file.txt", "content")
        with pytest.raises(ValueError, match="not allowed when"):
            await editor(command="view", path=str(d), tool_context=ctx, view_range=[1, 2])


class TestCreate:
    """The create command."""

    @pytest.mark.asyncio
    async def test_new_file(self, editor, ctx, tmp_path):
        file_path = str(tmp_path / "new-file.txt")
        content = "Hello World\nLine 2"
        result = await editor(command="create", path=file_path, tool_context=ctx, file_text=content)
        assert "File created successfully" in result
        assert file_path in result
        assert (tmp_path / "new-file.txt").read_text() == content

    @pytest.mark.asyncio
    async def test_in_nonexistent_directory(self, editor, ctx, tmp_path):
        file_path = str(tmp_path / "newdir" / "subdir" / "new-file.txt")
        result = await editor(command="create", path=file_path, tool_context=ctx, file_text="Content")
        assert "File created successfully" in result
        assert (tmp_path / "newdir" / "subdir" / "new-file.txt").read_text() == "Content"

    @pytest.mark.asyncio
    async def test_empty_file(self, editor, ctx, tmp_path):
        file_path = str(tmp_path / "empty.txt")
        result = await editor(command="create", path=file_path, tool_context=ctx, file_text="")
        assert "File created successfully" in result
        assert (tmp_path / "empty.txt").read_text() == ""

    @pytest.mark.asyncio
    async def test_existing_file_raises(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "existing.txt", "content")
        with pytest.raises(ValueError, match="already exists"):
            await editor(command="create", path=file_path, tool_context=ctx, file_text="new content")

    @pytest.mark.asyncio
    async def test_relative_path_raises(self, editor, ctx):
        with pytest.raises(ValueError, match="not an absolute path"):
            await editor(command="create", path="relative/path.txt", tool_context=ctx, file_text="content")

    @pytest.mark.asyncio
    async def test_on_directory_raises(self, editor, ctx, tmp_path):
        d = tmp_path / "testdir"
        d.mkdir()
        with pytest.raises(ValueError, match="already exists"):
            await editor(command="create", path=str(d), tool_context=ctx, file_text="content")


class TestStrReplace:
    """The str_replace command."""

    @pytest.mark.asyncio
    async def test_unique_occurrence(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2 OLD\nLine 3\nLine 4")
        result = await editor(command="str_replace", path=file_path, tool_context=ctx, old_str="OLD", new_str="NEW")
        assert "has been edited" in result
        assert "NEW" in result
        assert (tmp_path / "test.txt").read_text() == "Line 1\nLine 2 NEW\nLine 3\nLine 4"

    @pytest.mark.asyncio
    async def test_snippet_window(self, editor, ctx, tmp_path):
        content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5 OLD\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10"
        file_path = _write(tmp_path / "test.txt", content)
        result = await editor(command="str_replace", path=file_path, tool_context=ctx, old_str="OLD", new_str="NEW")
        assert "Line 1" in result
        assert "Line 9" in result
        assert "Line 10" not in result

    @pytest.mark.asyncio
    async def test_deletion(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2 DELETE_ME\nLine 3")
        result = await editor(command="str_replace", path=file_path, tool_context=ctx, old_str=" DELETE_ME", new_str="")
        assert "has been edited" in result
        assert (tmp_path / "test.txt").read_text() == "Line 1\nLine 2\nLine 3"

    @pytest.mark.asyncio
    async def test_multiline(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nOLD LINE 1\nOLD LINE 2\nLine 4")
        await editor(
            command="str_replace",
            path=file_path,
            tool_context=ctx,
            old_str="OLD LINE 1\nOLD LINE 2",
            new_str="NEW LINE",
        )
        assert (tmp_path / "test.txt").read_text() == "Line 1\nNEW LINE\nLine 4"

    @pytest.mark.asyncio
    async def test_preserves_dollar_patterns_literally(self, editor, ctx, tmp_path):
        # Python's str.replace is literal, so $&/$1/$$ must survive verbatim
        file_path = _write(tmp_path / "test.txt", "const value = getPrice()")
        await editor(
            command="str_replace", path=file_path, tool_context=ctx, old_str="getPrice()", new_str="$& is not $1 or $$"
        )
        assert (tmp_path / "test.txt").read_text() == "const value = $& is not $1 or $$"

    @pytest.mark.asyncio
    async def test_not_found_raises(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2\nLine 3")
        with pytest.raises(ValueError, match="did not appear"):
            await editor(command="str_replace", path=file_path, tool_context=ctx, old_str="NOTFOUND", new_str="NEW")

    @pytest.mark.asyncio
    async def test_multiple_occurrences_raises(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "DUP Line 1\nLine 2\nDUP Line 3")
        with pytest.raises(ValueError, match="Multiple occurrences"):
            await editor(command="str_replace", path=file_path, tool_context=ctx, old_str="DUP", new_str="NEW")

    @pytest.mark.asyncio
    async def test_multiple_occurrences_reports_the_lines(self, editor, ctx, tmp_path):
        """The error names the lines the duplicates start on, so the caller can disambiguate."""
        file_path = _write(tmp_path / "test.txt", "DUP Line 1\nLine 2\nDUP Line 3")
        with pytest.raises(ValueError, match=r"in lines \[1, 3\]"):
            await editor(command="str_replace", path=file_path, tool_context=ctx, old_str="DUP", new_str="NEW")

    @pytest.mark.asyncio
    async def test_multiple_occurrences_of_multiline_old_str_reports_the_lines(self, editor, ctx, tmp_path):
        """A multi-line ``old_str`` reports its start lines rather than an empty list.

        The occurrences used to be counted by testing ``old_str in line`` for each
        line, which no single line of a multi-line ``old_str`` can satisfy, so the
        message said ``in lines []`` and told the caller nothing.
        """
        file_path = _write(tmp_path / "test.txt", "A\nB\nX\nA\nB")
        with pytest.raises(ValueError, match=r"in lines \[1, 4\]"):
            await editor(command="str_replace", path=file_path, tool_context=ctx, old_str="A\nB", new_str="Z")

    @pytest.mark.asyncio
    async def test_nonexistent_raises(self, editor, ctx, tmp_path):
        with pytest.raises(ValueError, match="does not exist"):
            await editor(
                command="str_replace", path=str(tmp_path / "nope.txt"), tool_context=ctx, old_str="OLD", new_str="NEW"
            )

    @pytest.mark.asyncio
    async def test_on_directory_raises(self, editor, ctx, tmp_path):
        d = tmp_path / "testdir"
        d.mkdir()
        with pytest.raises(ValueError, match="directory"):
            await editor(command="str_replace", path=str(d), tool_context=ctx, old_str="OLD", new_str="NEW")


class TestInsert:
    """The insert command."""

    @pytest.mark.asyncio
    async def test_at_beginning(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2\nLine 3")
        await editor(command="insert", path=file_path, tool_context=ctx, insert_line=0, new_str="NEW LINE")
        assert (tmp_path / "test.txt").read_text() == "NEW LINE\nLine 1\nLine 2\nLine 3"

    @pytest.mark.asyncio
    async def test_in_middle(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2\nLine 3")
        await editor(command="insert", path=file_path, tool_context=ctx, insert_line=2, new_str="NEW LINE")
        assert (tmp_path / "test.txt").read_text() == "Line 1\nLine 2\nNEW LINE\nLine 3"

    @pytest.mark.asyncio
    async def test_at_end(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2\nLine 3")
        await editor(command="insert", path=file_path, tool_context=ctx, insert_line=3, new_str="NEW LINE")
        assert (tmp_path / "test.txt").read_text() == "Line 1\nLine 2\nLine 3\nNEW LINE"

    @pytest.mark.asyncio
    async def test_snippet_window(self, editor, ctx, tmp_path):
        content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9"
        file_path = _write(tmp_path / "test.txt", content)
        result = await editor(command="insert", path=file_path, tool_context=ctx, insert_line=5, new_str="INSERTED")
        assert "Line 2" in result
        assert "Line 9" in result
        assert "INSERTED" in result

    @pytest.mark.asyncio
    async def test_multiline(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2")
        await editor(command="insert", path=file_path, tool_context=ctx, insert_line=1, new_str="NEW 1\nNEW 2\nNEW 3")
        assert (tmp_path / "test.txt").read_text() == "Line 1\nNEW 1\nNEW 2\nNEW 3\nLine 2"

    @pytest.mark.asyncio
    async def test_in_empty_file(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "empty.txt", "")
        await editor(command="insert", path=file_path, tool_context=ctx, insert_line=0, new_str="First line")
        assert (tmp_path / "empty.txt").read_text() == "First line"

    @pytest.mark.asyncio
    async def test_negative_line_raises(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2")
        with pytest.raises(ValueError, match="insert_line"):
            await editor(command="insert", path=file_path, tool_context=ctx, insert_line=-1, new_str="NEW")

    @pytest.mark.asyncio
    async def test_beyond_length_raises(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "Line 1\nLine 2")
        with pytest.raises(ValueError, match="insert_line"):
            await editor(command="insert", path=file_path, tool_context=ctx, insert_line=10, new_str="NEW")

    @pytest.mark.asyncio
    async def test_nonexistent_raises(self, editor, ctx, tmp_path):
        with pytest.raises(ValueError, match="does not exist"):
            await editor(
                command="insert", path=str(tmp_path / "nope.txt"), tool_context=ctx, insert_line=0, new_str="NEW"
            )

    @pytest.mark.asyncio
    async def test_on_directory_raises(self, editor, ctx, tmp_path):
        d = tmp_path / "testdir"
        d.mkdir()
        with pytest.raises(ValueError, match="directory"):
            await editor(command="insert", path=str(d), tool_context=ctx, insert_line=0, new_str="NEW")


class TestPreservesUntouchedBytes:
    """Guards #4049: an edit rewrites only the requested region.

    Tabs are expanded for `cat -n` display, never in the content written back to the file. A
    Makefile is the sharp case, since make requires recipe lines to begin with a tab.
    """

    MAKEFILE = "build:\n\tgcc -o app main.c\n\ntest:\n\tpytest tests/\n"

    @pytest.mark.asyncio
    async def test_str_replace_leaves_tabs_outside_the_match(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "Makefile", self.MAKEFILE)

        await editor(command="str_replace", path=file_path, old_str="test:", new_str="check:", tool_context=ctx)

        assert (tmp_path / "Makefile").read_text() == self.MAKEFILE.replace("test:", "check:")

    @pytest.mark.asyncio
    async def test_insert_leaves_tabs_intact(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "Makefile", self.MAKEFILE)

        await editor(command="insert", path=file_path, insert_line=0, new_str=".PHONY: build test", tool_context=ctx)

        assert (tmp_path / "Makefile").read_text() == ".PHONY: build test\n" + self.MAKEFILE

    @pytest.mark.asyncio
    async def test_str_replace_matches_tabs_verbatim(self, editor, ctx, tmp_path):
        """A tab in old_str matches a tab in the file, not the spaces it displays as."""
        file_path = _write(tmp_path / "Makefile", self.MAKEFILE)

        await editor(
            command="str_replace",
            path=file_path,
            old_str="\tpytest tests/",
            new_str="\tpytest -q tests/",
            tool_context=ctx,
        )

        assert (tmp_path / "Makefile").read_text() == self.MAKEFILE.replace("pytest tests/", "pytest -q tests/")

    @pytest.mark.asyncio
    async def test_empty_old_str_reports_the_empty_argument(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "notes.txt", "alpha\nbeta\n")

        with pytest.raises(ValueError, match="old_str must not be empty"):
            await editor(command="str_replace", path=file_path, old_str="", new_str="x", tool_context=ctx)

        assert (tmp_path / "notes.txt").read_text() == "alpha\nbeta\n"


class TestFileSizeLimit:
    """The 1MB content size guard."""

    @pytest.mark.asyncio
    async def test_view_exceeds_size_limit_raises(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "large.txt", "x" * 1048577)  # 1MB + 1 byte
        with pytest.raises(ValueError, match="exceeds"):
            await editor(command="view", path=file_path, tool_context=ctx)


class TestEdgeCases:
    """Content edge cases: special characters, unicode, tabs, trailing slashes."""

    @pytest.mark.asyncio
    async def test_special_characters(self, editor, ctx, tmp_path):
        content = 'Special chars: @#$%^&*()_+-={}[]|:;"<>,.?/~`'
        file_path = _write(tmp_path / "special.txt", content)
        result = await editor(command="view", path=file_path, tool_context=ctx)
        assert "Special chars:" in result

    @pytest.mark.asyncio
    async def test_unicode(self, editor, ctx, tmp_path):
        content = "你好世界\n🚀 Emoji test\nΣ Greek letters"
        file_path = _write(tmp_path / "unicode.txt", content)
        result = await editor(command="view", path=file_path, tool_context=ctx)
        assert "你好世界" in result
        assert "🚀" in result

    @pytest.mark.asyncio
    async def test_expands_tabs(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "tabs.txt", "Line 1\tTab\tSeparated")
        result = await editor(command="view", path=file_path, tool_context=ctx)
        assert "\t" not in result

    @pytest.mark.asyncio
    async def test_handles_trailing_slash_on_file_path(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "trailing.txt", "content here")
        result = await editor(command="view", path=f"{file_path}/", tool_context=ctx)
        assert "content here" in result


class TestSandboxErrorPropagation:
    """A non-'not found' listing error must propagate, not be disguised as non-existence."""

    @pytest.mark.asyncio
    async def test_propagates_non_not_found_list_errors(self):
        sandbox = NotASandboxLocalEnvironment()

        async def boom(path, **kwargs):
            raise OSError("EACCES: permission denied")

        sandbox.list_files = boom  # type: ignore[method-assign]
        editor = make_file_editor(sandbox=sandbox)
        with pytest.raises(OSError, match="permission denied"):
            await editor(command="view", path="/tmp/x.txt", tool_context=_tool_context(sandbox))


class TestToolMetadata:
    """Tests for the file editor tool's name, description, and input schema."""

    def test_default_name(self):
        assert file_editor.tool_name == "file_editor"

    def test_custom_name(self):
        assert make_file_editor(name="sandbox_file_editor").tool_name == "sandbox_file_editor"

    def test_default_description(self):
        assert make_file_editor().tool_spec["description"] == DEFAULT_FILE_EDITOR_DESCRIPTION

    def test_input_schema_excludes_context(self):
        props = file_editor.tool_spec["inputSchema"]["json"]["properties"]
        assert "command" in props
        assert "path" in props
        assert "tool_context" not in props
