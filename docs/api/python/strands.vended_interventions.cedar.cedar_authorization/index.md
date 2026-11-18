Cedar authorization intervention handler.

#### TypeAndId

A Cedar entity identifier with ‘type’ and ‘id’ keys.

#### PrincipalResolver

Resolves a principal from invocation\_state. Return None to deny (fail-closed).

#### ContextEnricher

Injects extra fields into context.session. Receives {‘tool\_name’, ‘tool\_input’, ‘invocation\_state’}.

## CedarAuthorization

```python
class CedarAuthorization(InterventionHandler)
```

Defined in: [src/strands/vended\_interventions/cedar/cedar\_authorization.py:72](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/cedar/cedar_authorization.py#L72)

Cedar authorization intervention handler.

Evaluates Cedar policies before each tool call. Each tool maps to a Cedar action, with context structured as `\{input: <tool_args>, session: \{hour_utc, call_count, ...}}`.

Call counts are persisted to `agent.state` under the key `"cedar-authorization"` so they survive handler recreation and are included in session snapshots. Counts are tracked per agent, so agents that share one handler instance (such as a parent and its subagents) each have their own budget.

Example::

cedar = CedarAuthorization( policies=‘permit(principal, action == Action::“search”, resource);’ ) agent = Agent(interventions=\[cedar\], tools=\[search\_tool\])

#### on\_error

```python
@property
def on_error() -> OnError
```

Defined in: [src/strands/vended\_interventions/cedar/cedar\_authorization.py:94](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/cedar/cedar_authorization.py#L94)

What to do when this handler throws.

#### \_\_init\_\_

```python
def __init__(*,
             policies: str,
             tools: list[ToolDefinition] | None = None,
             entities: list[dict[str, Any]] | str | None = None,
             schema: str | None = None,
             principal: TypeAndId | None = None,
             principal_resolver: PrincipalResolver | None = None,
             context_enricher: ContextEnricher | None = None,
             on_error: OnError = "throw") -> None
```

Defined in: [src/strands/vended\_interventions/cedar/cedar\_authorization.py:98](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/cedar/cedar_authorization.py#L98)

Initialize the Cedar authorization handler.

**Arguments**:

-   `policies` - Inline Cedar policy text or path to a .cedar file.
    
-   `tools` - MCP tool definitions for auto schema generation.
    
-   `entities` - Entity data as inline list, JSON string, or path to .json file.
    
-   `schema` - Cedar schema as inline text or path to .cedarschema file.
    
-   `principal` - Static principal identity.
    
-   `principal_resolver` - Dynamic principal resolver from invocation\_state.
    
-   `context_enricher` - Callback to inject extra fields into context.session.
    
-   `on_error` - What to do when `principal_resolver` or `context_enricher` raises: `'throw'` (default) re-raises, `'deny'` denies the tool call (fail-closed, recommended alternative to the default).
    
    **Warning:** `'proceed'` is fail-open. When a callback raises, the tool call runs without any Cedar authorization check. Never use it when the agent relies on Cedar to enforce access.
    

#### before\_tool\_call

```python
def before_tool_call(event: BeforeToolCallEvent,
                     **kwargs: Any) -> Proceed | Deny
```

Defined in: [src/strands/vended\_interventions/cedar/cedar\_authorization.py:160](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/cedar/cedar_authorization.py#L160)

Evaluate Cedar policy before tool execution.

#### reload

```python
def reload() -> None
```

Defined in: [src/strands/vended\_interventions/cedar/cedar\_authorization.py:235](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/cedar/cedar_authorization.py#L235)

Reload policies/entities/schema from disk. Validates before committing.

#### reset\_call\_counts

```python
def reset_call_counts(agent: Agent | None = None) -> None
```

Defined in: [src/strands/vended\_interventions/cedar/cedar\_authorization.py:255](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/cedar/cedar_authorization.py#L255)

Clear rate-limit call counters, including those persisted in agent.state.

**Arguments**:

-   `agent` - Clear only this agent’s counts. If omitted, clears the counts of every agent this handler tracks.