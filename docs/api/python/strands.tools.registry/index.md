Tool registry.

This module provides the central registry for all tools available to the agent, including discovery, validation, and invocation capabilities.

## ToolRegistry

```python
class ToolRegistry()
```

Defined in: [src/strands/tools/registry.py:30](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L30)

Central registry for all tools available to the agent.

This class manages tool registration, validation, discovery, and invocation.

#### \_\_init\_\_

```python
def __init__(*, sort_tool_specs: bool = False) -> None
```

Defined in: [src/strands/tools/registry.py:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L36)

Initialize the tool registry.

**Arguments**:

-   `sort_tool_specs` - Return tool specs sorted by name from `get_all_tool_specs`. Defaults to False, which keeps registration order.

#### process\_tools

```python
def process_tools(tools: list[Any]) -> list[str]
```

Defined in: [src/strands/tools/registry.py:50](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L50)

Process tools list.

Process list of tools that can contain local file path string, module import path string, imported modules, @tool decorated functions, or instances of AgentTool.

**Arguments**:

-   `tools` - List of tool specifications. Can be:
    
    1.  Local file path to a module based tool: `./path/to/module/tool.py`
    2.  Module import path
    
    2.1. Path to a module based tool: `my_package.my_tool` 2.2. Path to a module with multiple AgentTool instances (@tool decorated): `tests.fixtures.say_tool` 2.3. Path to a module and a specific function: `tests.fixtures.say_tool:say`
    
    3.  A module for a module based tool
    4.  Instances of AgentTool (@tool decorated functions)
    5.  Dictionaries with name/path keys (deprecated)
    6.  Agent instances with an `as_tool()` method (auto-wrapped)

**Returns**:

List of tool names that were processed.

#### load\_tool\_from\_filepath

```python
def load_tool_from_filepath(tool_name: str, tool_path: str) -> None
```

Defined in: [src/strands/tools/registry.py:167](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L167)

DEPRECATED: Load a tool from a file path.

**Arguments**:

-   `tool_name` - Name of the tool.
-   `tool_path` - Path to the tool file.

**Raises**:

-   `FileNotFoundError` - If the tool file is not found.
-   `ValueError` - If the tool cannot be loaded.

#### get\_all\_tools\_config

```python
def get_all_tools_config() -> dict[str, Any]
```

Defined in: [src/strands/tools/registry.py:202](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L202)

Dynamically generate tool configuration by combining built-in and dynamic tools.

**Returns**:

Dictionary containing all tool configurations.

#### register\_tool

```python
def register_tool(tool: AgentTool) -> None
```

Defined in: [src/strands/tools/registry.py:242](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L242)

Register a tool function with the given name.

**Arguments**:

-   `tool` - The tool to register.

#### replace

```python
def replace(new_tool: AgentTool) -> None
```

Defined in: [src/strands/tools/registry.py:295](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L295)

Replace an existing tool with a new implementation.

This performs a swap of the tool implementation in the registry. The replacement takes effect on the next agent invocation.

**Arguments**:

-   `new_tool` - New tool implementation. Its name must match the tool being replaced.

**Raises**:

-   `ValueError` - If the tool doesn’t exist.

#### remove

```python
def remove(tool_name: str) -> None
```

Defined in: [src/strands/tools/registry.py:321](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L321)

Remove a tool by its registered name, including any dynamic registration.

Does nothing if the tool does not exist.

**Arguments**:

-   `tool_name` - Name of the tool to remove.

#### get\_tools\_dirs

```python
def get_tools_dirs() -> list[Path]
```

Defined in: [src/strands/tools/registry.py:332](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L332)

Get all tool directory paths.

**Returns**:

A list of Path objects for current working directory’s ”./tools/”.

#### discover\_tool\_modules

```python
def discover_tool_modules() -> dict[str, Path]
```

Defined in: [src/strands/tools/registry.py:352](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L352)

Discover available tool modules in all tools directories.

**Returns**:

Dictionary mapping tool names to their full paths.

#### reload\_tool

```python
def reload_tool(tool_name: str) -> None
```

Defined in: [src/strands/tools/registry.py:377](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L377)

Reload a specific tool module.

**Arguments**:

-   `tool_name` - Name of the tool to reload.

**Raises**:

-   `FileNotFoundError` - If the tool file cannot be found.
-   `ImportError` - If there are issues importing the tool module.
-   `ValueError` - If the tool specification is invalid or required components are missing.
-   `Exception` - For other errors during tool reloading.

#### initialize\_tools

```python
def initialize_tools(load_tools_from_directory: bool = False) -> None
```

Defined in: [src/strands/tools/registry.py:461](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L461)

Initialize all tools by discovering and loading them dynamically from all tool directories.

**Arguments**:

-   `load_tools_from_directory` - Whether to reload tools if changes are made at runtime.

#### get\_all\_tool\_specs

```python
def get_all_tool_specs() -> list[ToolSpec]
```

Defined in: [src/strands/tools/registry.py:568](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L568)

Get all the tool specs for all tools in this registry.

**Returns**:

A list of ToolSpecs, sorted by name when `sort_tool_specs` is set, otherwise in registration order.

#### register\_dynamic\_tool

```python
def register_dynamic_tool(tool: AgentTool) -> None
```

Defined in: [src/strands/tools/registry.py:579](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L579)

Register a tool dynamically for temporary use.

**Arguments**:

-   `tool` - The tool to register dynamically

**Raises**:

-   `ValueError` - If a tool with this name already exists

#### validate\_tool\_spec

```python
def validate_tool_spec(tool_spec: ToolSpec) -> None
```

Defined in: [src/strands/tools/registry.py:594](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L594)

Validate tool specification against required schema.

**Arguments**:

-   `tool_spec` - Tool specification to validate.

**Raises**:

-   `ValueError` - If the specification is invalid.

## NewToolDict

```python
class NewToolDict(TypedDict)
```

Defined in: [src/strands/tools/registry.py:644](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L644)

Dictionary type for adding or updating a tool in the configuration.

**Attributes**:

-   `spec` - The tool specification that defines the tool’s interface and behavior.

#### cleanup

```python
def cleanup(**kwargs: Any) -> None
```

Defined in: [src/strands/tools/registry.py:712](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/registry.py#L712)

Synchronously clean up all tool providers in this registry.