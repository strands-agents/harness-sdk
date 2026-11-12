Every `ask` call that passes validation records an OpenTelemetry span, whichever decision model answers it. With [tracing](/docs/user-guide/sdk/observability-evaluation/traces/index.md) set up, you see each decision next to the agent’s model and tool calls. When a tool asks a decision model, the decision span nests under that tool call’s span. The span reports the tokens of that one decision; [Decisions in an agent](/docs/user-guide/sdk/decision-models/agents/index.md#token-usage) covers adding them to the agent’s request.

## Decision span

The span is named `decision` and records:

| Name | Kind | Value |
| --- | --- | --- |
| `gen_ai.operation.name` | Attribute | `decision` |
| `gen_ai.decision.latency_ms` | Attribute | Time the decision model spent on the call, in milliseconds. |
| `gen_ai.usage.input_tokens` | Attribute | Input tokens, when the decision model reports usage. |
| `gen_ai.usage.output_tokens` | Attribute | Output tokens, when the decision model reports usage. |
| `gen_ai.decision.questions` | Event | The question ids. |
| `gen_ai.decision.answers` | Event | The answers as JSON, keyed by question id. An `Uncertain` answer appears as `{"uncertain": true}`, with its reason when there is one. |

When the decision model raises, the span ends with an error status and records the exception. Invalid questions, or an invocation context the SDK didn’t create, raise before the span starts. The question text and the input aren’t recorded.

## Related pages

- [Decision models](/docs/user-guide/sdk/decision-models/index.md) (1 shared tag)
- [Decisions in an agent](/docs/user-guide/sdk/decision-models/agents/index.md) (1 shared tag)
- [LLM decision model](/docs/user-guide/sdk/decision-models/models/llm/index.md) (1 shared tag)
- [Questions and answers](/docs/user-guide/sdk/decision-models/questions/index.md) (1 shared tag)
- [Supported decision models](/docs/user-guide/sdk/decision-models/models/index.md) (1 shared tag)
- [Evaluating remote traces](/docs/user-guide/evals-sdk/how-to/trace_providers/index.md) (1 shared tag)
- [Metrics](/docs/user-guide/sdk/observability-evaluation/metrics/index.md) (1 shared tag)
- [Observability](/docs/user-guide/sdk/observability-evaluation/observability/index.md) (1 shared tag)
- [Observe your agent](/docs/user-guide/sdk/observability-evaluation/index.md) (1 shared tag)
- [Task decorator](/docs/user-guide/evals-sdk/how-to/eval_task/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/decisions/decision_model.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/decision_model.py)

### TypeScript

- [harness-sdk/strands-ts/src/decisions/decision-model.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decision-model.ts)
