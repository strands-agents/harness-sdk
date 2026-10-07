Subagent tool for delegating a task to a child agent at runtime.

Provides :func:`make_subagent` (a factory that lets the developer pin safety limits and authority modes). Each call resolves the model’s arguments through the authority-mode system (see :mod:`~strands.multiagent.spec`), builds a child agent via an :data:`AgentBuilder`, runs it, and streams the result back.

#### make\_subagent

```python
def make_subagent(*,
                  builder: AgentBuilder | None = None,
                  presets: Mapping[str, Preset] | None = None,
                  default_preset: str | None = None,
                  instructions: Open | Choice | Fixed | None = None,
                  tools: Choice | Fixed | Inherit | None = None,
                  mcp_servers: Choice | Fixed | Inherit | None = None,
                  model: Inherit | Choice | Fixed | None = None,
                  context: Fixed | Choice | None = None,
                  max_depth: int = DEFAULT_SUBAGENT_MAX_DEPTH,
                  name: str = "subagent") -> AgentTool
```

Defined in: [src/strands/vended\_tools/subagent/subagent.py:366](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/subagent/subagent.py#L366)

Build a `subagent` tool whose schema is derived from the axis modes and presets.

Each axis accepts a policy from :mod:`~strands.multiagent.spec` that controls what the model sees and can supply. Omitted axes use sensible defaults.

**Raises**:

-   `ValueError` - If *max\_depth* < 1, *name* is empty, or a `Choice` axis violates its constraints (empty options, `multiple=False` for tools).

#### subagent

Pre-built subagent tool with default settings (generalist preset, all axes using defaults).