"""Tests for the sandbox-routed file editor tool.

Exercises the tool against a real ``NotASandboxLocalEnvironment`` (host
filesystem), calling it directly as an async function. Errors surface as
raised ``ValueError`` — the raw function raises; the error→status wrapping
only happens through the tool's ``stream`` path. Path semantics assume
POSIX, so these tests are skipped on Windows.
"""

import asyncio
import sys

import pytest

from strands.agent.state import AgentState
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.types.tools import ToolContext
from strands.vended_tools.file_editor import file_editor, make_file_editor
from strands.vended_tools.file_editor.file_editor import DEFAULT_FILE_EDITOR_DESCRIPTION

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX path semantics assumed")


class _FakeAgent:
    """A minimal agent stand-in with a ``sandbox`` and ``state``."""

    def __init__(self, sandbox: NotASandboxLocalEnvironment | None = None) -> None:
        self.sandbox = sandbox or NotASandboxLocalEnvironment()
        self.state = AgentState()


def _tool_context(sandbox: NotASandboxLocalEnvironment | None = None) -> ToolContext:
    """Build a ToolContext whose agent exposes the given sandbox (or a fresh one)."""
    agent = _FakeAgent(sandbox=sandbox)
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
    async def test_traversal_normalizes_and_uses_target(self, editor, ctx):
        # No root configured: `..` normalizes lexically and the sandbox governs
        # what exists. The resolver does not manufacture a traversal error.
        with pytest.raises(ValueError, match="does not exist"):
            await editor(command="view", path="/tmp/../nonexistent-xyzzy", tool_context=ctx)

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
    """Guards #4049: an edit rewrites only the requested region."""

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
    async def test_empty_old_str_reports_the_empty_argument(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "notes.txt", "alpha\nbeta\n")

        with pytest.raises(ValueError, match="`old_str` must not be empty"):
            await editor(command="str_replace", path=file_path, old_str="", new_str="x", tool_context=ctx)

        assert (tmp_path / "notes.txt").read_text() == "alpha\nbeta\n"


class TestFileSizeLimit:
    """The configurable content size guard."""

    @pytest.mark.asyncio
    async def test_view_exceeds_size_limit_raises(self, ctx, tmp_path):
        # Use a low custom cap so the test doesn't need to allocate the default cap.
        small_editor = make_file_editor(sandbox=NotASandboxLocalEnvironment(), max_file_size=1024)
        file_path = _write(tmp_path / "large.txt", "x" * 2048)
        with pytest.raises(ValueError, match="exceeds"):
            await small_editor(command="view", path=file_path, tool_context=ctx)

    @pytest.mark.asyncio
    async def test_default_cap_is_one_megabyte(self, editor, ctx, tmp_path):
        # Default cap is 1 MB. A file just under it is accepted; a 2 MB file is rejected.
        under = _write(tmp_path / "under.txt", "x" * (1 * 1024 * 1024 - 1))
        result = await editor(command="view", path=under, tool_context=ctx)
        assert "cat -n" in result
        over = _write(tmp_path / "over.txt", "x" * (2 * 1024 * 1024))
        with pytest.raises(ValueError, match="exceeds"):
            await editor(command="view", path=over, tool_context=ctx)


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

    def test_input_schema_advertises_commands(self):
        command_enum = file_editor.tool_spec["inputSchema"]["json"]["properties"]["command"]["enum"]
        assert set(command_enum) == {
            "view",
            "create",
            "str_replace",
            "insert",
            "find_line",
            "undo_edit",
        }


class TestConfinementRoot:
    """When a ``root`` is configured, all paths must resolve inside it."""

    @pytest.mark.asyncio
    async def test_rejects_absolute_path_outside_root(self, ctx, tmp_path):
        root = tmp_path / "workspace"
        root.mkdir()
        outside = tmp_path / "outside.txt"
        _write(outside, "secret")
        confined = make_file_editor(sandbox=NotASandboxLocalEnvironment(), root=str(root))
        with pytest.raises(ValueError, match="outside the configured root"):
            await confined(command="view", path=str(outside), tool_context=ctx)

    @pytest.mark.asyncio
    async def test_rejects_traversal_even_with_root(self, ctx, tmp_path):
        root = tmp_path / "workspace"
        root.mkdir()
        confined = make_file_editor(sandbox=NotASandboxLocalEnvironment(), root=str(root))
        with pytest.raises(ValueError, match="outside the configured root"):
            await confined(command="view", path=f"{root}/../outside.txt", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_rejects_sibling_that_shares_prefix(self, ctx, tmp_path):
        root = tmp_path / "ws"
        root.mkdir()
        sibling = tmp_path / "ws-neighbor"
        sibling.mkdir()
        _write(sibling / "file.txt", "content")
        confined = make_file_editor(sandbox=NotASandboxLocalEnvironment(), root=str(root))
        with pytest.raises(ValueError, match="outside the configured root"):
            await confined(command="view", path=str(sibling / "file.txt"), tool_context=ctx)

    @pytest.mark.asyncio
    async def test_allows_path_inside_root(self, ctx, tmp_path):
        root = tmp_path / "workspace"
        root.mkdir()
        target = _write(root / "ok.txt", "hello")
        confined = make_file_editor(sandbox=NotASandboxLocalEnvironment(), root=str(root))
        result = await confined(command="view", path=target, tool_context=ctx)
        assert "hello" in result

    def test_rejects_relative_root_at_construction(self):
        with pytest.raises(ValueError, match="absolute path"):
            make_file_editor(root="relative/root")

    def test_default_description_mentions_configured_root(self, tmp_path):
        root = tmp_path / "workspace"
        root.mkdir()
        confined = make_file_editor(sandbox=NotASandboxLocalEnvironment(), root=str(root))
        assert str(root) in confined.tool_spec["description"]

    def test_custom_description_is_not_rewritten(self, tmp_path):
        root = tmp_path / "workspace"
        root.mkdir()
        confined = make_file_editor(
            sandbox=NotASandboxLocalEnvironment(), root=str(root), description="custom description"
        )
        assert confined.tool_spec["description"] == "custom description"

    @pytest.mark.asyncio
    async def test_symlink_semantics_are_sandbox_governed(self, ctx, tmp_path):
        # The editor enforces lexical confinement only: whether a symlink inside
        # root resolves outside root is a sandbox concern. Documented so a
        # future contract change is a conscious one.
        root = tmp_path / "workspace"
        root.mkdir()
        secret = tmp_path / "secret.txt"
        _write(secret, "top secret")
        link = root / "escape.txt"
        link.symlink_to(secret)
        confined = make_file_editor(sandbox=NotASandboxLocalEnvironment(), root=str(root))
        # NotASandboxLocalEnvironment follows symlinks; a real isolating sandbox
        # would confine the resolution to its own filesystem.
        result = await confined(command="view", path=str(link), tool_context=ctx)
        assert "top secret" in result

    @pytest.mark.asyncio
    async def test_symlink_pointing_inside_root_is_allowed(self, ctx, tmp_path):
        root = tmp_path / "workspace"
        root.mkdir()
        target = _write(root / "real.txt", "inside content")
        link = root / "alias.txt"
        link.symlink_to(target)
        confined = make_file_editor(sandbox=NotASandboxLocalEnvironment(), root=str(root))
        result = await confined(command="view", path=str(link), tool_context=ctx)
        assert "inside content" in result


class TestWriteSizeCaps:
    """The write side must also reject payloads above the configured cap."""

    @pytest.mark.asyncio
    async def test_create_rejects_oversize_file_text(self, ctx, tmp_path):
        e = make_file_editor(sandbox=NotASandboxLocalEnvironment(), max_file_size=1024)
        with pytest.raises(ValueError, match="exceeds maximum allowed size"):
            await e(
                command="create",
                path=str(tmp_path / "big.txt"),
                tool_context=ctx,
                file_text="x" * 2048,
            )

    @pytest.mark.asyncio
    async def test_str_replace_rejects_oversize_new_str(self, ctx, tmp_path):
        e = make_file_editor(sandbox=NotASandboxLocalEnvironment(), max_file_size=1024)
        file_path = _write(tmp_path / "s.txt", "small")
        with pytest.raises(ValueError, match="exceeds maximum allowed size"):
            await e(
                command="str_replace",
                path=file_path,
                tool_context=ctx,
                old_str="small",
                new_str="y" * 2048,
            )


class TestMissingRoot:
    """A ``root`` that does not exist in the sandbox is rejected on first use."""

    @pytest.mark.asyncio
    async def test_missing_root_fails_on_first_use(self, ctx):
        missing_root = "/workspace-does-not-exist-anywhere"
        e = make_file_editor(sandbox=NotASandboxLocalEnvironment(), root=missing_root)
        with pytest.raises(ValueError, match="does not exist in the sandbox"):
            await e(command="view", path=f"{missing_root}/foo.txt", tool_context=ctx)


class TestUndoLRUEviction:
    """The undo history is a bounded LRU: it must evict on overflow."""

    @pytest.mark.asyncio
    async def test_evicts_oldest_entry_past_entry_cap(self, ctx, tmp_path):
        # Two-entry cap; three edits must evict the oldest.
        e = make_file_editor(sandbox=NotASandboxLocalEnvironment(), max_undo_entries=2)
        paths = [_write(tmp_path / f"f{i}.txt", f"orig{i}") for i in range(3)]
        for i, p in enumerate(paths):
            await e(command="str_replace", path=p, tool_context=ctx, old_str=f"orig{i}", new_str=f"new{i}")
        # Oldest snapshot (f0) has been evicted.
        with pytest.raises(ValueError, match="No undo history"):
            await e(command="undo_edit", path=paths[0], tool_context=ctx)
        # Two most recent still restore.
        await e(command="undo_edit", path=paths[1], tool_context=ctx)
        assert (tmp_path / "f1.txt").read_text() == "orig1"

    @pytest.mark.asyncio
    async def test_evicts_past_byte_cap(self, ctx, tmp_path):
        # Byte cap sized to fit one snapshot but not two, so a second edit
        # forces the oldest out.
        snapshot = "x" * 100
        e = make_file_editor(sandbox=NotASandboxLocalEnvironment(), max_undo_bytes=len(snapshot) + 20)
        p1 = _write(tmp_path / "big1.txt", snapshot)
        p2 = _write(tmp_path / "big2.txt", "y" * 100)
        await e(command="str_replace", path=p1, tool_context=ctx, old_str="x", new_str="X", replace_all=True)
        await e(command="str_replace", path=p2, tool_context=ctx, old_str="y", new_str="Y", replace_all=True)
        with pytest.raises(ValueError, match="No undo history"):
            await e(command="undo_edit", path=p1, tool_context=ctx)
        await e(command="undo_edit", path=p2, tool_context=ctx)
        assert (tmp_path / "big2.txt").read_text() == "y" * 100


class TestBinaryRejection:
    """Binary files must be rejected on view/edit rather than silently mangled."""

    @pytest.mark.asyncio
    async def test_view_rejects_binary_file(self, editor, ctx, tmp_path):
        file_path = tmp_path / "binary.bin"
        file_path.write_bytes(b"\x00\x01\x02BINARY\x00DATA")
        with pytest.raises(ValueError, match="binary"):
            await editor(command="view", path=str(file_path), tool_context=ctx)

    @pytest.mark.asyncio
    async def test_str_replace_rejects_binary_file(self, editor, ctx, tmp_path):
        file_path = tmp_path / "binary.bin"
        file_path.write_bytes(b"HEAD\x00TAIL")
        with pytest.raises(ValueError, match="binary"):
            await editor(command="str_replace", path=str(file_path), tool_context=ctx, old_str="HEAD", new_str="X")

    @pytest.mark.asyncio
    async def test_utf16_le_bom_rejected_as_unsupported_encoding(self, editor, ctx, tmp_path):
        # UTF-16 text is a valid, decodable format but not UTF-8. Report it as
        # an unsupported encoding rather than misclassifying as binary.
        file_path = tmp_path / "utf16.txt"
        file_path.write_bytes(b"\xff\xfe" + "hello world".encode("utf-16-le"))
        with pytest.raises(ValueError, match="UTF-16"):
            await editor(command="view", path=str(file_path), tool_context=ctx)


class TestViewMedia:
    """``view`` returns a media-shaped ToolResult for images and binary documents."""

    @pytest.mark.parametrize(
        ("filename", "expected_format"),
        [
            ("photo.png", "png"),
            ("photo.jpg", "jpeg"),
            ("photo.jpeg", "jpeg"),
            ("photo.gif", "gif"),
            ("photo.webp", "webp"),
            ("photo.PNG", "png"),
        ],
    )
    @pytest.mark.asyncio
    async def test_image_returns_image_content_block(self, editor, ctx, tmp_path, filename, expected_format):
        file_path = tmp_path / filename
        payload = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
        file_path.write_bytes(payload)
        result = await editor(command="view", path=str(file_path), tool_context=ctx)
        assert result["status"] == "success"
        assert result["toolUseId"] == "test-id"
        (block,) = result["content"]
        assert block["image"]["format"] == expected_format
        assert block["image"]["source"]["bytes"] == payload

    @pytest.mark.parametrize(
        ("filename", "expected_format"),
        [
            ("report.pdf", "pdf"),
            ("report.doc", "doc"),
            ("report.docx", "docx"),
            ("report.xls", "xls"),
            ("report.xlsx", "xlsx"),
        ],
    )
    @pytest.mark.asyncio
    async def test_binary_document_returns_document_content_block(
        self, editor, ctx, tmp_path, filename, expected_format
    ):
        file_path = tmp_path / filename
        payload = b"%PDF-1.4\n%\xd0\xd4\xc5\xd8\n" + b"\x00" * 32
        file_path.write_bytes(payload)
        result = await editor(command="view", path=str(file_path), tool_context=ctx)
        assert result["status"] == "success"
        (block,) = result["content"]
        assert block["document"]["format"] == expected_format
        assert block["document"]["name"] == filename
        assert block["document"]["source"]["bytes"] == payload

    @pytest.mark.parametrize("filename", ["notes.csv", "notes.html", "notes.txt", "notes.md"])
    @pytest.mark.asyncio
    async def test_text_representable_documents_stay_on_text_path(self, editor, ctx, tmp_path, filename):
        # csv/html/txt/md are documents by Bedrock's taxonomy but are text-
        # representable, so view keeps them on the numbered-lines path where
        # find_line and str_replace still work.
        file_path = _write(tmp_path / filename, "alpha\nbeta\n")
        result = await editor(command="view", path=file_path, tool_context=ctx)
        assert isinstance(result, str)
        assert "alpha" in result and "beta" in result

    @pytest.mark.asyncio
    async def test_view_range_rejected_on_image(self, editor, ctx, tmp_path):
        file_path = tmp_path / "photo.png"
        file_path.write_bytes(b"\x89PNG\r\n\x1a\n")
        with pytest.raises(ValueError, match="view_range"):
            await editor(command="view", path=str(file_path), tool_context=ctx, view_range=[1, 2])

    @pytest.mark.asyncio
    async def test_view_range_rejected_on_document(self, editor, ctx, tmp_path):
        file_path = tmp_path / "report.pdf"
        file_path.write_bytes(b"%PDF-1.4\n")
        with pytest.raises(ValueError, match="view_range"):
            await editor(command="view", path=str(file_path), tool_context=ctx, view_range=[1, 2])

    @pytest.mark.asyncio
    async def test_media_still_bound_by_max_file_size(self, ctx, tmp_path):
        file_path = tmp_path / "big.png"
        file_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 4096)
        editor = make_file_editor(sandbox=NotASandboxLocalEnvironment(), max_file_size=256)
        with pytest.raises(ValueError, match="exceeds maximum allowed size"):
            await editor(command="view", path=str(file_path), tool_context=ctx)


class TestStrReplaceReplaceAll:
    """``str_replace`` must refuse ambiguous matches without ``replace_all``."""

    @pytest.mark.asyncio
    async def test_ambiguous_without_opt_in_raises(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "DUP\nfoo\nDUP\nbar\nDUP\n")
        with pytest.raises(ValueError, match="replace_all"):
            await editor(command="str_replace", path=file_path, tool_context=ctx, old_str="DUP", new_str="X")

    @pytest.mark.asyncio
    async def test_replace_all_opt_in_replaces_every_occurrence(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "DUP\nfoo\nDUP\nbar\nDUP\n")
        result = await editor(
            command="str_replace",
            path=file_path,
            tool_context=ctx,
            old_str="DUP",
            new_str="X",
            replace_all=True,
        )
        assert "3 occurrences replaced" in result
        assert (tmp_path / "test.txt").read_text() == "X\nfoo\nX\nbar\nX\n"


class TestFindLine:
    """The ``find_line`` command returns every match and treats absence as an empty report."""

    @pytest.mark.asyncio
    async def test_returns_every_match(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "alpha\nbeta\ngamma\nbeta again\n")
        result = await editor(command="find_line", path=file_path, tool_context=ctx, search_text="beta")
        assert "[2, 4]" in result
        # The snippet is drawn around the first hit.
        assert "gamma" in result

    @pytest.mark.asyncio
    async def test_returns_empty_report_when_missing(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "alpha\n")
        result = await editor(command="find_line", path=file_path, tool_context=ctx, search_text="MISSING")
        assert "No matches" in result
        assert "MISSING" in result

    @pytest.mark.asyncio
    async def test_fuzzy_matches_across_whitespace(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "def   my_function ( ):\n    pass\n")
        result = await editor(
            command="find_line", path=file_path, tool_context=ctx, search_text="def my_function", fuzzy=True
        )
        assert "[1]" in result

    @pytest.mark.asyncio
    async def test_truncates_past_hit_cap(self, editor, ctx, tmp_path):
        # 300 matching lines with a 200-hit cap: the reply is truncated and says so.
        content = "\n".join("hit line" for _ in range(300)) + "\n"
        file_path = _write(tmp_path / "test.txt", content)
        result = await editor(command="find_line", path=file_path, tool_context=ctx, search_text="hit")
        assert "truncated" in result

    @pytest.mark.asyncio
    async def test_fuzzy_search_is_linear_on_pathological_input(self, editor, ctx, tmp_path):
        # Regression: an earlier implementation joined escaped tokens with a
        # regex ``.*`` chain, which backtracks catastrophically on a long
        # single line and cannot be interrupted (see #3394). Assert the linear
        # scan completes well inside a short wall-clock bound.
        content = "a" * 500 + "\n"
        file_path = _write(tmp_path / "long.txt", content)
        result = await asyncio.wait_for(
            editor(command="find_line", path=file_path, tool_context=ctx, search_text="a a a b", fuzzy=True),
            timeout=2.0,
        )
        assert "No matches" in result


class TestUndo:
    """In-memory, per-agent ``undo_edit``."""

    @pytest.mark.asyncio
    async def test_undo_str_replace(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "hello\n")
        await editor(command="str_replace", path=file_path, tool_context=ctx, old_str="hello", new_str="goodbye")
        assert (tmp_path / "test.txt").read_text() == "goodbye\n"
        await editor(command="undo_edit", path=file_path, tool_context=ctx)
        assert (tmp_path / "test.txt").read_text() == "hello\n"

    @pytest.mark.asyncio
    async def test_undo_insert(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "one\ntwo\n")
        await editor(command="insert", path=file_path, tool_context=ctx, insert_line=1, new_str="between")
        await editor(command="undo_edit", path=file_path, tool_context=ctx)
        assert (tmp_path / "test.txt").read_text() == "one\ntwo\n"

    @pytest.mark.asyncio
    async def test_undo_without_history_raises(self, editor, ctx, tmp_path):
        file_path = _write(tmp_path / "test.txt", "content\n")
        with pytest.raises(ValueError, match="No undo history"):
            await editor(command="undo_edit", path=file_path, tool_context=ctx)

    @pytest.mark.asyncio
    async def test_snapshot_survives_across_agent_state_roundtrip(self, tmp_path):
        # Guards #3235: undo history lives in ``agent.state`` so a session
        # manager can persist it. Simulate a rehydrated agent by copying the
        # first agent's serialized state into a fresh one and confirm undo
        # still restores the pre-edit content.
        file_path = _write(tmp_path / "test.txt", "original\n")
        editor = make_file_editor(sandbox=NotASandboxLocalEnvironment())

        first_agent = _FakeAgent()
        first_ctx = ToolContext(
            tool_use={"name": "file_editor", "toolUseId": "first", "input": {}},
            agent=first_agent,
            invocation_state={},
        )
        await editor(
            command="str_replace", path=file_path, tool_context=first_ctx, old_str="original", new_str="edited"
        )
        serialized = first_agent.state.get()
        assert serialized  # sanity: state was written

        rehydrated = _FakeAgent()
        rehydrated.state = AgentState(serialized)
        rehydrated_ctx = ToolContext(
            tool_use={"name": "file_editor", "toolUseId": "second", "input": {}},
            agent=rehydrated,
            invocation_state={},
        )
        await editor(command="undo_edit", path=file_path, tool_context=rehydrated_ctx)
        assert (tmp_path / "test.txt").read_text() == "original\n"

    @pytest.mark.asyncio
    async def test_undo_is_scoped_per_agent_within_one_editor(self, tmp_path):
        # Guards #3235: two agents sharing one editor instance must not see each
        # other's undo history, so agent B cannot restore agent A's snapshot
        # over B's file.
        file_a = _write(tmp_path / "a.txt", "A-original\n")
        file_b = _write(tmp_path / "b.txt", "B-original\n")
        shared = make_file_editor(sandbox=NotASandboxLocalEnvironment())

        agent_a = _FakeAgent()
        agent_b = _FakeAgent()
        ctx_a = ToolContext(
            tool_use={"name": "file_editor", "toolUseId": "a", "input": {}}, agent=agent_a, invocation_state={}
        )
        ctx_b = ToolContext(
            tool_use={"name": "file_editor", "toolUseId": "b", "input": {}}, agent=agent_b, invocation_state={}
        )

        await shared(command="str_replace", path=file_a, tool_context=ctx_a, old_str="A-original", new_str="A-changed")
        await shared(command="str_replace", path=file_b, tool_context=ctx_b, old_str="B-original", new_str="B-changed")

        # Agent B cannot undo agent A's edit.
        with pytest.raises(ValueError, match="No undo history"):
            await shared(command="undo_edit", path=file_a, tool_context=ctx_b)
        # Agent B's own edit is still undoable and lands on B's file (not A's).
        await shared(command="undo_edit", path=file_b, tool_context=ctx_b)
        assert (tmp_path / "a.txt").read_text() == "A-changed\n"
        assert (tmp_path / "b.txt").read_text() == "B-original\n"

    @pytest.mark.asyncio
    async def test_snapshot_only_stored_after_successful_write(self, ctx, tmp_path):
        # Guards #3235: a write failure must not shadow the still-valid earlier
        # snapshot. undo_edit after a failed edit restores what was on disk
        # before the last successful write, not the current-but-unwritten content.
        file_path = _write(tmp_path / "test.txt", "original\n")
        sandbox = NotASandboxLocalEnvironment()
        editor = make_file_editor(sandbox=sandbox)

        await editor(command="str_replace", path=file_path, tool_context=ctx, old_str="original", new_str="first")
        assert (tmp_path / "test.txt").read_text() == "first\n"

        original_write = sandbox.write_text

        async def failing_write(path, content, **kwargs):
            raise OSError("EIO: transient failure")

        sandbox.write_text = failing_write  # type: ignore[method-assign]
        with pytest.raises(OSError, match="transient failure"):
            await editor(command="str_replace", path=file_path, tool_context=ctx, old_str="first", new_str="second")

        # The failed write must not have shadowed the still-valid snapshot.
        sandbox.write_text = original_write  # type: ignore[method-assign]
        await editor(command="undo_edit", path=file_path, tool_context=ctx)
        assert (tmp_path / "test.txt").read_text() == "original\n"

    @pytest.mark.asyncio
    async def test_undo_stays_retryable_on_transient_write_failure(self, ctx, tmp_path):
        # Guards #3235: a failed undo write must keep the entry in history so
        # the caller can retry.
        file_path = _write(tmp_path / "test.txt", "original\n")
        sandbox = NotASandboxLocalEnvironment()
        editor = make_file_editor(sandbox=sandbox)

        await editor(command="str_replace", path=file_path, tool_context=ctx, old_str="original", new_str="edited")
        assert (tmp_path / "test.txt").read_text() == "edited\n"

        original_write = sandbox.write_text
        calls = {"count": 0}

        async def flaky_write(path, content, **kwargs):
            calls["count"] += 1
            if calls["count"] == 1:
                raise OSError("EIO: transient failure")
            return await original_write(path, content, **kwargs)

        sandbox.write_text = flaky_write  # type: ignore[method-assign]
        with pytest.raises(OSError, match="transient failure"):
            await editor(command="undo_edit", path=file_path, tool_context=ctx)

        # Undo entry is still there and the retry succeeds.
        await editor(command="undo_edit", path=file_path, tool_context=ctx)
        assert (tmp_path / "test.txt").read_text() == "original\n"


class TestEmptyInputRejection:
    """Empty ``old_str`` input produces confusing behavior and is rejected."""

    @pytest.mark.asyncio
    async def test_str_replace_empty_old_str_raises(self, editor, ctx, tmp_path):
        # `"".count("")` returns `len + 1`; without an explicit guard the caller
        # would see a confusing "multiple occurrences" error or, with
        # replace_all, `new_str` inserted between every character.
        file_path = _write(tmp_path / "test.txt", "hello\n")
        with pytest.raises(ValueError, match="empty"):
            await editor(command="str_replace", path=file_path, tool_context=ctx, old_str="", new_str="X")


class TestOversizePreflight:
    """An edit whose projected output would exceed ``max_file_size`` is rejected before allocation."""

    @pytest.mark.asyncio
    async def test_str_replace_expansion_past_cap_rejected(self, ctx, tmp_path):
        # Cap is 32 bytes. Original is 20 bytes. `replace_all` on "x" -> "XXX"
        # produces 60 bytes, past the cap.
        e = make_file_editor(sandbox=NotASandboxLocalEnvironment(), max_file_size=32)
        file_path = _write(tmp_path / "grow.txt", "x" * 20)
        with pytest.raises(ValueError, match="exceeding the maximum"):
            await e(
                command="str_replace",
                path=file_path,
                tool_context=ctx,
                old_str="x",
                new_str="XXX",
                replace_all=True,
            )

    @pytest.mark.asyncio
    async def test_str_replace_preflight_runs_before_allocation(self, ctx, tmp_path):
        # Guards #3235: replace_all must reject an oversized projected output
        # by byte-count arithmetic, before str.replace allocates the buffer.
        # Small file × small replacement × many matches models the pathological
        # case where the individual payloads fit but the aggregate is huge.
        e = make_file_editor(sandbox=NotASandboxLocalEnvironment(), max_file_size=4 * 1024)
        file_path = _write(tmp_path / "small.txt", "a" * 1000)
        with pytest.raises(ValueError, match="exceeding the maximum"):
            await e(
                command="str_replace",
                path=file_path,
                tool_context=ctx,
                old_str="a",
                new_str="x" * 100,
                replace_all=True,
            )

    @pytest.mark.asyncio
    async def test_insert_expansion_past_cap_rejected(self, ctx, tmp_path):
        e = make_file_editor(sandbox=NotASandboxLocalEnvironment(), max_file_size=32)
        file_path = _write(tmp_path / "grow.txt", "x" * 30)
        with pytest.raises(ValueError, match="exceeding the maximum"):
            await e(
                command="insert",
                path=file_path,
                tool_context=ctx,
                insert_line=0,
                new_str="y" * 10,
            )
