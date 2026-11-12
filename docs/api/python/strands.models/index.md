SDK model providers.

This package includes an abstract base Model class along with concrete implementations for specific providers.

#### \_\_getattr\_\_

```python
def __getattr__(name: str) -> Any
```

Defined in: [src/strands/models/**init**.py:49](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/__init__.py#L49)

Lazy load model implementations only when accessed.

This defers the import of optional dependencies until actually needed.