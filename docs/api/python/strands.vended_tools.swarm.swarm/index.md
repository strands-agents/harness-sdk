Swarm meta-agent tool for spinning up a handoff-based sub-agent team at runtime.

Provides :func:`make_swarm` (a factory that lets the developer pin safety limits and authority modes) and :data:`swarm` (a default instance). The tool is a thin shim over :class:`~strands.multiagent.Swarm`: it resolves each agent spec through the authority-mode system, builds agents via an :data:`AgentBuilder`, runs the swarm, and maps the result.

#### DEFAULT\_SWARM\_DESCRIPTION

Description for the default swarm tool.

#### make\_swarm

```python
def make_swarm(
    *,
    name: str = "swarm",
    description: str = DEFAULT_SWARM_DESCRIPTION,
    builder: AgentBuilder | None = None,
    presets: Mapping[str, Preset] | None = None,
    default_preset: str | None = None,
    instructions: Open | Choice | Fixed | None = None,
    tools: Choice | Fixed | Inherit | None = None,
    model: Inherit | Choice | Fixed | None = None,
    max_agents: int = _DEFAULT_MAX_AGENTS,
    max_handoffs: int | None = None,
    max_iterations: int | None = None,
    execution_timeout: float | None = None,
    node_timeout: float | None = None,
    repetitive_handoff_detection_window: int | None = None,
    repetitive_handoff_min_unique_agents: int | None = None
) -> DecoratedFunctionTool
```

Defined in: [src/strands/vended\_tools/swarm/swarm.py:73](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/swarm/swarm.py#L73)

Create a swarm tool with developer-controlled safety limits and authority modes.

The swarm tool is a meta-agent tool: the model defines the agents it needs at runtime. Each agent spec from the model is resolved through the authority-mode system (see :mod:`~strands.multiagent.spec`), then built via `builder`. A running swarm cannot be cancelled from the parent agent. Children never receive a swarm tool, so swarms do not nest. If no swarm limits are configured, the Swarm primitive’s defaults are used.

A child’s interrupt is surfaced as an interrupt of this tool and can be resumed after a parent-agent snapshot restore.

**Arguments**:

-   `name` - Tool name shown to the model.
-   `description` - Tool description shown to the model.
-   `builder` - Callable, sync or async, that turns an :class:`AgentSpec` into an `Agent`. When `None` a default builder is used that creates an `Agent` inheriting the caller’s model with the spec’s instructions and tools.
-   `presets` - Named roles the model can select via `agent_type`.
-   `default_preset` - Preset used when the model omits `agent_type`.
-   `instructions` - Authority mode for the instructions axis.
-   `tools` - Authority mode for the tools axis.
-   `model` - Authority mode for the model axis.
-   `max_agents` - Upper bound on agents per invocation.
-   `max_handoffs` - Maximum handoffs between agents.
-   `max_iterations` - Maximum total agent invocations.
-   `execution_timeout` - Total timeout in seconds.
-   `node_timeout` - Per-agent timeout in seconds.
-   `repetitive_handoff_detection_window` - Window size for repetition detection.
-   `repetitive_handoff_min_unique_agents` - Minimum unique agents in window.

**Returns**:

A decorated tool that spins up and runs a :class:`~strands.multiagent.Swarm`.

#### swarm

Default swarm tool. Children inherit the caller’s model.