Experimental

The Context Manager strategy API is experimental and may change in future versions.

The SDK estimates how much of the model’s context window is in use so it can trigger compression before overflow. Three pieces work together: the context window limit, token counting, and utilization estimation.

## Context window limit

The threshold check requires the model’s context window size. The SDK auto-populates `context_window_limit``contextWindowLimit` from the shared model info for known models.

(( tab "Python" ))
Override it manually for models not in the [shared model info](https://github.com/strands-agents/harness-sdk/blob/main/shared/model-info.json):

```python
model = BedrockModel(
    model_id="my-custom-model",
    context_window_limit=128_000,
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Override it manually for models not in the [shared model info](https://github.com/strands-agents/harness-sdk/blob/main/shared/model-info.json):

```typescript
import { BedrockModel } from '@strands-agents/sdk'

const model = new BedrockModel({
  modelId: 'my-custom-model',
  contextWindowLimit: 128_000,
})
```
(( /tab "TypeScript" ))

Inaccurate compression with default fallback

If `context_window_limit``contextWindowLimit` is not set and the model ID is not in the shared model info, the SDK falls back to a default of 200,000 tokens. When the actual context window is significantly different, compression thresholds will not behave correctly.

## Token estimation

The agent estimates input tokens using the following strategy:

1.  **Known baseline**: reads `input_tokens + output_tokens``inputTokens + outputTokens` from the last assistant message’s usage metadata
2.  **Delta estimation**: estimates tokens for new messages added since that baseline using the model’s `count_tokens()``countTokens()` method
3.  **Cold start fallback**: when no prior usage metadata exists (first call or after session restore), estimates all messages via `count_tokens()``countTokens()`

The `count_tokens()``countTokens()` method uses a character-based heuristic by default (characters / 4 for text, characters / 2 for JSON). Some model providers support native token counting APIs for exact counts. For an example in both SDKs, see [Amazon Bedrock token counting](/docs/user-guide/sdk/model-providers/amazon-bedrock/index.md#token-counting).

## Utilization estimation

The Model base class provides an `estimate_utilization(input_tokens)``estimateUtilization(inputTokens)` method that computes the fraction of the context window consumed by a given input token count:

(( tab "Python" ))
```python
ratio = model.estimate_utilization(
    input_tokens=projected_tokens,
)
# ratio is 0-1+ (above 1.0 means overflow)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { BedrockModel } from '@strands-agents/sdk'

const ratio = model.estimateUtilization(projectedTokens)
// ratio is 0-1+ (above 1.0 means overflow)
```
(( /tab "TypeScript" ))

The method divides `input_tokens``inputTokens` by the model’s `context_window_limit``contextWindowLimit`, falling back to the 200,000 default with a warning when not configured. A return value above 1.0 means overflow.

Both the built-in [context management modes](/docs/user-guide/sdk/context-management/built-in-modes/index.md) and the [conversation managers](/docs/user-guide/sdk/agents/conversation-management/index.md) use this internally for compression decisions. You can also call it directly when building custom logic.

## Related pages

- [Built-in Modes](/docs/user-guide/sdk/context-management/built-in-modes/index.md) (2 shared tags)
- [Context management](/docs/user-guide/sdk/context-management/index.md) (2 shared tags)
- [Custom Strategies](/docs/user-guide/sdk/context-management/custom-strategies/index.md) (2 shared tags)
- [Strategy Presets](/docs/user-guide/sdk/context-management/presets/index.md) (2 shared tags)
- [Context Offloader](/docs/user-guide/sdk/plugins/context-offloader/index.md) (2 shared tags)
- [Conversation Management](/docs/user-guide/sdk/agents/conversation-management/index.md) (2 shared tags)
- [Context Injector](/docs/user-guide/sdk/plugins/context-injector/index.md) (1 shared tag)
- [Coherence evaluator](/docs/user-guide/evals-sdk/evaluators/coherence_evaluator/index.md) (1 shared tag)
- [Conciseness evaluator](/docs/user-guide/evals-sdk/evaluators/conciseness_evaluator/index.md) (1 shared tag)
- [Goal success rate evaluator](/docs/user-guide/evals-sdk/evaluators/goal_success_rate_evaluator/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/models/model.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/model.py)

### TypeScript

- [harness-sdk/strands-ts/src/models/model.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts)
