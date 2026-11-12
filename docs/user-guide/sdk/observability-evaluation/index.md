Once an agent leaves your laptop, the loop you watched in the terminal runs where you cannot see it. Observability is how you get that view back: the SDK emits traces of every model and tool call, performance metrics for each run, and logs from its own operation, all through OpenTelemetry so the data lands in the tools you already run. You reach for it to debug why a run went wrong, measure how fast and how expensive it is, and watch for regressions as you ship changes.

## Instrument your agent

[Observability foundations](observability/index.md)How traces, metrics, and logs fit together, and the practices that keep them useful.

[Trace agent execution](traces/index.md)Capture the full path of a run: model interactions, tool calls, and token usage.

[Read agent metrics](metrics/index.md)Track token usage, latency, tool call counts, and event loop cycles per run.

[Capture logs](logs/index.md)Set log levels and handlers to surface what the SDK does under the hood.

## Turn on tracing

The smallest step is to export traces. Configure an exporter before you create the agent, and every model and tool call it makes is captured as a span. Sending spans to the console needs no collector, so it is the fastest way to confirm tracing works before you point it at a production backend.

(( tab "Python" ))
```python
from strands import Agent
from strands.telemetry import StrandsTelemetry

# Print every span to the console; add setup_otlp_exporter() to ship to a collector
StrandsTelemetry().setup_console_exporter()

agent = Agent()
agent("What is agent observability?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { setupTracer } from '@strands-agents/sdk/telemetry'

// Print every span to the console; swap console for otlp to ship to a collector
setupTracer({ exporters: { console: true } })

const agent = new Agent()
await agent.invoke('What is agent observability?')
```
(( /tab "TypeScript" ))

Swap the console exporter for an OTLP exporter to send the same spans to Jaeger, Grafana Tempo, AWS X-Ray, Datadog, or any OpenTelemetry backend.

## Where to go next

New to agent observability? Start with [Observability foundations](/docs/user-guide/sdk/observability-evaluation/observability/index.md) for the primitives and the framework, then [turn on tracing](/docs/user-guide/sdk/observability-evaluation/traces/index.md) to see a real run end to end. From there, add [metrics](/docs/user-guide/sdk/observability-evaluation/metrics/index.md) for performance and cost and [logs](/docs/user-guide/sdk/observability-evaluation/logs/index.md) for SDK-level detail.

Watching an agent tells you what it did; measuring quality tells you whether it did the right thing. When you are ready to score behavior against a dataset, move on to [evaluation](/docs/user-guide/evals-sdk/quickstart/index.md).

## Related pages

- [Evaluating remote traces](/docs/user-guide/evals-sdk/how-to/trace_providers/index.md) (1 shared tag)
- [Metrics](/docs/user-guide/sdk/observability-evaluation/metrics/index.md) (1 shared tag)
- [Observability](/docs/user-guide/sdk/observability-evaluation/observability/index.md) (1 shared tag)
- [Task decorator](/docs/user-guide/evals-sdk/how-to/eval_task/index.md) (1 shared tag)
- [Traces](/docs/user-guide/sdk/observability-evaluation/traces/index.md) (1 shared tag)
- [Bidirectional Streaming Observability](/docs/user-guide/sdk/bidi/observability/index.md) (1 shared tag)
- [Decision model observability](/docs/user-guide/sdk/decision-models/observability/index.md) (1 shared tag)
- [Logging](/docs/user-guide/sdk/observability-evaluation/logs/index.md) (1 shared tag)
- [Operating Agents in Production](/docs/user-guide/sdk/deploy/operating-agents-in-production/index.md) (1 shared tag)
- [Root cause analysis](/docs/user-guide/evals-sdk/detectors/root_cause_analysis/index.md) (1 shared tag)
