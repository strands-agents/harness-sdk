Decision-model primitive — see `team/designs/0020-decision-models.md`.

#### \_\_getattr\_\_

```python
def __getattr__(name: str) -> Any
```

Defined in: [src/strands/decisions/**init**.py:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/__init__.py#L28)

Lazy load provider-backed decision models only when accessed.

This keeps `import strands` from importing `httpx` (and its optional dependencies) eagerly.