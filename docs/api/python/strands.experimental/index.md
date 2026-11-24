Experimental features.

This module implements experimental features that are subject to change in future revisions without notice.

#### \_\_getattr\_\_

```python
def __getattr__(name: str) -> Any
```

Defined in: [src/strands/experimental/**init**.py:19](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/__init__.py#L19)

Import a deprecated alias submodule on first attribute access.

Keeps `strands.experimental.context_manager` resolving for code that imports only the parent package, which the aliases’ absence from the eager imports above would otherwise break.

**Arguments**:

-   `name` - Attribute being read.

**Returns**:

The alias module, which warns as it is imported.

**Raises**:

-   `AttributeError` - For any name that is not a deprecated alias submodule.