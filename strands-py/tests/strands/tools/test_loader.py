import os
import re
import sys
import tempfile
import textwrap

import pytest

from strands.tools.decorator import DecoratedFunctionTool
from strands.tools.loader import _TOOL_MODULE_PREFIX, ToolLoader, load_tools_from_file_path
from strands.tools.tools import PythonAgentTool

# Suppress deprecation warnings for deprecated ToolLoader methods being tested
pytestmark = pytest.mark.filterwarnings(
    "ignore:ToolLoader.load_python_tool is deprecated:DeprecationWarning",
    "ignore:ToolLoader.load_python_tools is deprecated:DeprecationWarning",
    "ignore:ToolLoader.load_tool is deprecated:DeprecationWarning",
    "ignore:ToolLoader.load_tools is deprecated:DeprecationWarning",
)


@pytest.fixture
def tool_path(request, tmp_path, monkeypatch):
    definition = request.param

    package_dir = tmp_path / f"package_{request.function.__name__}"
    package_dir.mkdir()

    init_path = package_dir / "__init__.py"
    init_path.touch()

    definition_path = package_dir / f"module_{request.function.__name__}.py"
    definition_path.write_text(definition)

    monkeypatch.syspath_prepend(str(tmp_path))

    return str(definition_path)


@pytest.fixture
def tool_module(tool_path):
    return ".".join(os.path.splitext(tool_path)[0].split(os.sep)[-2:])


@pytest.mark.parametrize(
    "tool_path",
    [
        textwrap.dedent("""
            import strands

            @strands.tools.tool
            def identity(a: int):
                return a
        """)
    ],
    indirect=True,
)
def test_load_python_tool_path_function_based(tool_path):
    tool = ToolLoader.load_python_tool(tool_path, "identity")

    assert isinstance(tool, DecoratedFunctionTool)


@pytest.mark.parametrize(
    "tool_path",
    [
        textwrap.dedent("""
            TOOL_SPEC = {
                "name": "identity",
                "description": "identity tool",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "a": {
                            "type": "integer",
                        },
                    },
                },
            }

            def identity(a: int):
                return a
        """)
    ],
    indirect=True,
)
def test_load_python_tool_path_module_based(tool_path):
    tool = ToolLoader.load_python_tool(tool_path, "identity")

    assert isinstance(tool, PythonAgentTool)


def test_load_python_tool_path_invalid():
    with pytest.raises(ImportError, match="Could not create spec for identity"):
        ToolLoader.load_python_tool("invalid", "identity")


@pytest.mark.parametrize(
    "tool_path",
    [
        textwrap.dedent("""
            def no_spec():
                return
        """)
    ],
    indirect=True,
)
def test_load_python_tool_path_no_spec(tool_path):
    with pytest.raises(AttributeError, match="Tool no_spec missing TOOL_SPEC"):
        ToolLoader.load_python_tool(tool_path, "no_spec")


@pytest.mark.parametrize(
    "tool_path",
    [
        textwrap.dedent("""
            TOOL_SPEC = {"name": "no_function"}
        """)
    ],
    indirect=True,
)
def test_load_python_tool_path_no_function(tool_path):
    with pytest.raises(AttributeError, match="Tool no_function missing function"):
        ToolLoader.load_python_tool(tool_path, "no_function")


@pytest.mark.parametrize(
    "tool_path",
    [
        textwrap.dedent("""
            TOOL_SPEC = {"name": "no_callable"}

            no_callable = "not callable"
        """)
    ],
    indirect=True,
)
def test_load_python_tool_path_no_callable(tool_path):
    with pytest.raises(TypeError, match="Tool no_callable function is not callable"):
        ToolLoader.load_python_tool(tool_path, "no_callable")


@pytest.mark.parametrize(
    "tool_path",
    [
        textwrap.dedent("""
            import strands

            @strands.tools.tool
            def identity(a: int):
                return a
        """)
    ],
    indirect=True,
)
def test_load_python_tool_dot_function_based(tool_path, tool_module):
    _ = tool_path
    tool_module = f"{tool_module}:identity"

    tool = ToolLoader.load_python_tool(tool_module, "identity")

    assert isinstance(tool, DecoratedFunctionTool)


@pytest.mark.parametrize(
    "tool_path",
    [
        textwrap.dedent("""
            TOOL_SPEC = {"name": "no_function"}
        """)
    ],
    indirect=True,
)
def test_load_python_tool_dot_no_function(tool_path, tool_module):
    _ = tool_path

    with pytest.raises(AttributeError, match=re.escape(f"Module {tool_module} has no function named no_function")):
        ToolLoader.load_python_tool(f"{tool_module}:no_function", "no_function")


@pytest.mark.parametrize(
    "tool_path",
    [
        textwrap.dedent("""
            def no_decorator():
                return
        """)
    ],
    indirect=True,
)
def test_load_python_tool_dot_no_decorator(tool_path, tool_module):
    _ = tool_path

    with pytest.raises(ValueError, match=re.escape(f"Function no_decorator in {tool_module} is not a valid tool")):
        ToolLoader.load_python_tool(f"{tool_module}:no_decorator", "no_decorator")


def test_load_python_tool_dot_missing():
    with pytest.raises(ImportError, match="Failed to import module missing"):
        ToolLoader.load_python_tool("missing:function", "function")


@pytest.mark.parametrize(
    "tool_path",
    [
        textwrap.dedent("""
            import strands

            @strands.tools.tool
            def identity(a: int):
                return a
        """)
    ],
    indirect=True,
)
def test_load_tool(tool_path):
    tool = ToolLoader.load_tool(tool_path, "identity")

    assert isinstance(tool, DecoratedFunctionTool)


def test_load_tool_missing():
    with pytest.raises(FileNotFoundError, match="Tool file not found"):
        ToolLoader.load_tool("missing", "function")


def test_load_tool_invalid_ext(tmp_path):
    tool_path = tmp_path / "tool.txt"
    tool_path.touch()

    with pytest.raises(ValueError, match="Unsupported tool file type: .txt"):
        ToolLoader.load_tool(str(tool_path), "function")


@pytest.mark.parametrize(
    "tool_path",
    [
        textwrap.dedent("""
            def no_spec():
                return
        """)
    ],
    indirect=True,
)
def test_load_tool_no_spec(tool_path):
    with pytest.raises(AttributeError, match="Tool no_spec missing TOOL_SPEC"):
        ToolLoader.load_tool(tool_path, "no_spec")

    with pytest.raises(AttributeError, match="Tool no_spec missing TOOL_SPEC"):
        ToolLoader.load_tools(tool_path, "no_spec")

    with pytest.raises(AttributeError, match="Tool no_spec missing TOOL_SPEC"):
        ToolLoader.load_python_tool(tool_path, "no_spec")

    with pytest.raises(AttributeError, match="Tool no_spec missing TOOL_SPEC"):
        ToolLoader.load_python_tools(tool_path, "no_spec")


@pytest.mark.parametrize(
    "tool_path",
    [
        textwrap.dedent(
            """
            import strands

            @strands.tools.tool
            def alpha():
                return "alpha"

            @strands.tools.tool
            def bravo():
                return "bravo"
            """
        )
    ],
    indirect=True,
)
def test_load_python_tool_path_multiple_function_based(tool_path):
    # load_python_tools, load_tools returns a list when multiple decorated tools are present
    loaded_python_tools = ToolLoader.load_python_tools(tool_path, "alpha")

    assert isinstance(loaded_python_tools, list)
    assert len(loaded_python_tools) == 2
    assert all(isinstance(t, DecoratedFunctionTool) for t in loaded_python_tools)
    names = {t.tool_name for t in loaded_python_tools}
    assert names == {"alpha", "bravo"}

    loaded_tools = ToolLoader.load_tools(tool_path, "alpha")

    assert isinstance(loaded_tools, list)
    assert len(loaded_tools) == 2
    assert all(isinstance(t, DecoratedFunctionTool) for t in loaded_tools)
    names = {t.tool_name for t in loaded_tools}
    assert names == {"alpha", "bravo"}


@pytest.mark.parametrize(
    "tool_path",
    [
        textwrap.dedent(
            """
            import strands

            @strands.tools.tool
            def alpha():
                return "alpha"

            @strands.tools.tool
            def bravo():
                return "bravo"
            """
        )
    ],
    indirect=True,
)
def test_load_tool_path_returns_single_tool(tool_path):
    # loaded_python_tool and loaded_tool returns single item
    loaded_python_tool = ToolLoader.load_python_tool(tool_path, "alpha")
    loaded_tool = ToolLoader.load_tool(tool_path, "alpha")

    assert loaded_python_tool.tool_name == "alpha"
    assert loaded_tool.tool_name == "alpha"


def test_load_tools_from_file_path_module_spec_missing():
    with tempfile.NamedTemporaryFile() as f:
        with pytest.raises(ImportError, match=f"Could not create spec for {os.path.basename(f.name)}"):
            load_tools_from_file_path(f.name)


def test_tool_module_prefix_prevents_collision():
    """Test that tool modules are loaded with prefix to prevent sys.modules collisions."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(
            textwrap.dedent("""
            import strands

            @strands.tools.tool
            def test_tool():
                return "test"
        """)
        )
        f.flush()

        # Load the tool
        tools = load_tools_from_file_path(f.name)

        # Check that module is in sys.modules with prefix
        module_name = os.path.basename(f.name).split(".")[0]
        prefixed_name = f"{_TOOL_MODULE_PREFIX}{module_name}"

        assert prefixed_name in sys.modules
        assert len(tools) == 1
        assert tools[0].tool_name == "test_tool"
