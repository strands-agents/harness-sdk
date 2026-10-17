# Client-observed output throughput

After an agent invocation, `result.metrics` exposes output tokens per second:

```python
result = agent("Explain the result")
print(result.metrics.average_output_tokens_per_second)
print(result.metrics.output_throughput_sample_count)

invocation = result.metrics.latest_agent_invocation
if invocation is not None:
    print(invocation.average_output_tokens_per_second)
    for cycle in invocation.cycles:
        print(cycle.output_tokens_per_second)
        for call in cycle.model_invocations:
            print(call.model_id, call.output_tokens, call.client_duration,
                  call.output_tokens_per_second)
```

`ModelInvocationMetric`, exported from `strands.telemetry`, is an immutable
record for one completed model adapter call. `client_duration` uses a monotonic
clock, from entering the terminal model streaming operation until receipt of
the last raw chunk. It includes request preparation, time to first output,
adapter-internal retries, network delays, and backpressure between chunks.
It excludes hooks and middleware outside that operation, tool execution,
event-loop retry backoff, and processing after the last chunk. This is a client
throughput measurement, not a server-side decoding speed or a count of HTTP
requests. Provider-reported `latencyMs` and existing usage metrics are unchanged.

The output count is the last explicitly supplied `outputTokens` in raw adapter
metadata. Missing usage remains `None`; an explicit zero is a valid count.
Negative/non-integer counts and non-positive/non-finite durations are unavailable.
If an adapter has already filled in a missing count with zero, the SDK cannot
distinguish that zero from an explicit report.

Only completed streams with a message stop produce a record. Failed,
cancelled, prematurely closed, and middleware-short-circuited calls do not.
A completed response subsequently retried by an after-model hook still counts:
its tokens and elapsed time represent work actually performed. Multiple calls
within a cycle remain separate records, including calls to different models.

All aggregate rates use `sum(output_tokens) / sum(client_duration)` over the
same set of valid pairs. They are not the arithmetic mean of individual rates.
`output_throughput_sample_count` reports how many calls contributed. A rate of
`None` means no valid pairs or a non-finite aggregate; a rate of `0.0` means
valid calls reported no output tokens. Rates may mix models and tokenizers, so
use per-call `model_id` when comparing models.

`result.metrics` retains the existing live, agent-lifetime semantics. Use
`latest_agent_invocation` for the latest request, or save `get_summary()` to
retain the newly added throughput records at that point. The summary contains
the rates, counts, and per-call records under each invocation's cycles. These
new records are copied into the summary; other existing summary fields retain
their existing semantics. Throughput is not added to OpenTelemetry instruments
or restored from historical session snapshots.
