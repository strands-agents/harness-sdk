This module implements the central event loop.

The event loop allows agents to:

1.  Process conversation messages
2.  Execute tools based on model requests
3.  Handle errors and recovery strategies
4.  Manage recursive execution cycles

#### MAX\_DELAY

4 minutes

#### event\_loop\_cycle

```python
async def event_loop_cycle(
    agent: "Agent",
    invocation_state: dict[str, Any],
    structured_output_context: StructuredOutputContext | None = None,
    limits: Limits | None = None,
    *,
    invocation_context: InvocationContext | None = None
) -> AsyncGenerator[TypedEvent, None]
```

Defined in: [src/strands/event\_loop/event\_loop.py:160](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/event_loop.py#L160)

Execute a single cycle of the event loop.

This core function processes a single conversation turn, handling model inference, tool execution, and error recovery. It manages the entire lifecycle of a conversation turn, including:

1.  Initializing cycle state and metrics
2.  Checking execution limits
3.  Processing messages with the model
4.  Handling tool execution requests
5.  Managing recursive calls for multi-turn tool interactions
6.  Collecting and reporting metrics
7.  Error handling and recovery

**Arguments**:

-   `agent` - The agent for which the cycle is being executed.
    
-   `invocation_state` - Additional arguments including:
    
    -   request\_state: State maintained across cycles
    -   event\_loop\_cycle\_id: Unique ID for this cycle
    -   event\_loop\_cycle\_span: Current tracing Span for this cycle
-   `structured_output_context` - Optional context for structured output management.
    
-   `limits` - Deprecated; pass `invocation_context` instead. Limits for this cycle, applied on top of `invocation_context`’s.
    
-   `invocation_context` - The request this cycle runs in; a fresh one when omitted. Its limits are checked at the top of this cycle (after tools from the previous cycle have run to completion). See :class:`~strands.types.agent.Limits`.
    

**Yields**:

Model and tool stream events. The final `EventLoopStopEvent` payload (`event["stop"]`) is a 7-tuple:

-   StopReason: Reason the model stopped generating (e.g., “tool\_use”, “checkpoint”)
-   Message: The generated message from the model
-   EventLoopMetrics: Updated metrics for the event loop
-   Any: Updated request state
-   Sequence\[Interrupt\] | None: Interrupts raised during the cycle, if any
-   BaseModel | None: Structured output result, if any
-   Checkpoint | None: Checkpoint captured when stop\_reason == “checkpoint”

**Raises**:

-   `EventLoopException` - If an error occurs during execution
-   `ContextWindowOverflowException` - If the input is too large for the model

#### recurse\_event\_loop

```python
async def recurse_event_loop(
    agent: "Agent",
    invocation_state: dict[str, Any],
    structured_output_context: StructuredOutputContext | None = None,
    limits: Limits | None = None,
    *,
    invocation_context: InvocationContext | None = None
) -> AsyncGenerator[TypedEvent, None]
```

Defined in: [src/strands/event\_loop/event\_loop.py:528](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/event_loop.py#L528)

Make a recursive call to event\_loop\_cycle with the current state.

This function is used when the event loop needs to continue processing after tool execution.

**Arguments**:

-   `agent` - Agent for which the recursive call is being made.
-   `invocation_state` - Arguments to pass through event\_loop\_cycle
-   `structured_output_context` - Optional context for structured output management.
-   `limits` - Deprecated; pass `invocation_context` instead. Limits for the cycle, applied on top of `invocation_context`’s.
-   `invocation_context` - The request this cycle runs in.

**Yields**:

Results from event\_loop\_cycle where the last result contains:

-   StopReason: Reason the model stopped generating
-   Message: The generated message from the model
-   EventLoopMetrics: Updated metrics for the event loop
-   Any: Updated request state