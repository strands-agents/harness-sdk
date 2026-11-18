Tools for converting Pydantic models to Bedrock tools.

#### convert\_pydantic\_to\_tool\_spec

```python
def convert_pydantic_to_tool_spec(model: type[BaseModel],
                                  description: str | None = None) -> ToolSpec
```

Defined in: [src/strands/tools/structured\_output/structured\_output\_utils.py:305](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/structured_output/structured_output_utils.py#L305)

Converts a Pydantic model to a tool description for the Amazon Bedrock Converse API.

Handles optional vs. required fields, resolves $refs, and uses docstrings.

**Arguments**:

-   `model` - The Pydantic model class to convert
-   `description` - Optional description of the tool’s purpose

**Returns**:

-   `ToolSpec` - Dict containing the Bedrock tool specification