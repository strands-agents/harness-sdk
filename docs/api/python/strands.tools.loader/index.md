Tool loading utilities.

#### load\_tool\_from\_string

```python
def load_tool_from_string(tool_string: str) -> list[AgentTool]
```

Defined in: [src/strands/tools/loader.py:77](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/loader.py#L77)

Load tools follows strands supported input string formats.

This function can load a tool based on a string in the following ways:

1.  Local file path to a module based tool: `./path/to/module/tool.py`
2.  Module import path 2.1. Path to a module based tool: `my_package.my_tool` 2.2. Path to a module with multiple AgentTool instances (@tool decorated): `tests.fixtures.say_tool` 2.3. Path to a module and a specific function: `tests.fixtures.say_tool:say`

#### load\_tools\_from\_file\_path

```python
def load_tools_from_file_path(tool_path: str) -> list[AgentTool]
```

Defined in: [src/strands/tools/loader.py:99](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/loader.py#L99)

Load module from specified path, and then load tools from that module.

This function attempts to load the passed in path as a python module, and if it succeeds, then it tries to import strands tool(s) from that module.

#### load\_tools\_from\_module\_path

```python
def load_tools_from_module_path(module_tool_path: str) -> list[AgentTool]
```

Defined in: [src/strands/tools/loader.py:120](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/loader.py#L120)

Load strands tool from a module path.

Example module paths: my.module.path my.module.path:tool\_name

#### load\_tools\_from\_module

```python
def load_tools_from_module(module: ModuleType,
                           module_name: str) -> list[AgentTool]
```

Defined in: [src/strands/tools/loader.py:151](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/loader.py#L151)

Load tools from a module.

First checks if the passed in module has instances of DecoratedToolFunction classes as attributes to the module. If so, then it returns them as a list of tools. If not, then it attempts to load the module as a module based tool.

## ToolLoader

```python
class ToolLoader()
```

Defined in: [src/strands/tools/loader.py:195](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/loader.py#L195)

Handles loading of tools from different sources.

#### load\_python\_tools

```python
@staticmethod
def load_python_tools(tool_path: str, tool_name: str) -> list[AgentTool]
```

Defined in: [src/strands/tools/loader.py:199](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/loader.py#L199)

DEPRECATED: Load a Python tool module and return all discovered function-based tools as a list.

This method always returns a list of AgentTool (possibly length 1). It is the canonical API for retrieving multiple tools from a single Python file.

#### load\_python\_tool

```python
@staticmethod
def load_python_tool(tool_path: str, tool_name: str) -> AgentTool
```

Defined in: [src/strands/tools/loader.py:278](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/loader.py#L278)

DEPRECATED: Load a Python tool module and return a single AgentTool for backwards compatibility.

Use `load_python_tools` to retrieve all tools defined in a .py file (returns a list). This function will emit a `DeprecationWarning` and return the first discovered tool.

#### load\_tool

```python
@classmethod
def load_tool(cls, tool_path: str, tool_name: str) -> AgentTool
```

Defined in: [src/strands/tools/loader.py:297](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/loader.py#L297)

DEPRECATED: Load a single tool based on its file extension for backwards compatibility.

Use `load_tools` to retrieve all tools defined in a file (returns a list). This function will emit a `DeprecationWarning` and return the first discovered tool.

#### load\_tools

```python
@classmethod
def load_tools(cls, tool_path: str, tool_name: str) -> list[AgentTool]
```

Defined in: [src/strands/tools/loader.py:317](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/loader.py#L317)

DEPRECATED: Load tools from a file based on its file extension.

**Arguments**:

-   `tool_path` - Path to the tool file.
-   `tool_name` - Name of the tool.

**Returns**:

A single Tool instance.

**Raises**:

-   `FileNotFoundError` - If the tool file does not exist.
-   `ValueError` - If the tool file has an unsupported extension.
-   `Exception` - For other errors during tool loading.