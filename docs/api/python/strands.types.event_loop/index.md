Event loop-related type definitions for the SDK.

## Usage

```python
class Usage(TypedDict)
```

Defined in: [src/strands/types/event\_loop.py:8](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/event_loop.py#L8)

Token usage information for model interactions.

**Attributes**:

-   `inputTokens` - Number of tokens sent in the request to the model.
-   `outputTokens` - Number of tokens that the model generated for the request.
-   `totalTokens` - Total number of tokens (input + output).
-   `cacheReadInputTokens` - Number of tokens read from cache (optional).
-   `cacheWriteInputTokens` - Number of tokens written to cache (optional).

## Metrics

```python
class Metrics(TypedDict)
```

Defined in: [src/strands/types/event\_loop.py:26](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/event_loop.py#L26)

Performance metrics for model interactions.

**Attributes**:

-   `latencyMs` *int* - Latency of the model request in milliseconds.
-   `timeToFirstByteMs` *int* - Latency from sending model request to first content chunk (contentBlockDelta or contentBlockStart) from the model in milliseconds.

#### StopReason

Reason for the model ending its response generation.

-   “cancelled”: Agent execution was cancelled via agent.cancel()
-   “checkpoint”: Agent paused for durable checkpoint persistence
-   “content\_filtered”: Content was filtered due to policy violation
-   “end\_turn”: Normal completion of the response
-   “guardrail\_intervened”: Guardrail system intervened
-   “interrupt”: Agent was interrupted for human input
-   “limit\_output\_tokens”: Agent loop stopped because the `limits["output_tokens"]` cap was reached
-   “limit\_structured\_output\_attempts”: Agent loop stopped because the `limits["structured_output_attempts"]` cap was reached
-   “limit\_total\_tokens”: Agent loop stopped because the `limits["total_tokens"]` cap was reached
-   “limit\_turns”: Agent loop stopped because the `limits["turns"]` cap was reached
-   “max\_tokens”: The model provider’s per-call output cap was reached
-   “stop\_sequence”: Stop sequence encountered
-   “tool\_use”: Model requested to use a tool