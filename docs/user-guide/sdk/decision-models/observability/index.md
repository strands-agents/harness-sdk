Every `ask` call that passes validation records an OpenTelemetry span, whichever decision model answers it. With [tracing](/docs/user-guide/sdk/observability-evaluation/traces/index.md) set up, you see each decision next to the agent’s model and tool calls. When a tool asks a decision model, the decision span nests under that tool call’s span. The span reports the tokens of that one decision; [Decisions in an agent](/docs/user-guide/sdk/decision-models/agents/index.md#token-usage) covers adding them to the agent’s request.

## Decision span

The span is named `decision`. It records everything as span attributes:

| Attribute | Value |
| --- | --- |
| `gen_ai.operation.name` | `decision` |
| `gen_ai.decision.questions` | The question ids, as a list. |
| `gen_ai.decision.answers` | The answers as a JSON string, keyed by question id. An `Uncertain` answer appears as `{"uncertain": true}`, with its reason when there is one. |
| `gen_ai.decision.latency_ms` | Time the decision model spent on the call, in milliseconds. |
| `gen_ai.usage.input_tokens` | Input tokens, when the decision model reports usage. |
| `gen_ai.usage.output_tokens` | Output tokens, when the decision model reports usage. |

The question ids are set when the span starts, so every decision span has them. The answers, latency, and token counts are set only when the decision model returns.

## Failed decisions

When the decision model raises, the span ends with an error status and records the exception. It keeps the question ids, so you can see which questions failed. Invalid questions, or an invocation context the SDK didn’t create, raise before the span starts, so they record no span. The question text and the input aren’t recorded.

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
