from __future__ import annotations

from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from recording import Recording, check_invariants, record
from scripted_model import ScriptedModel

from strands_harness import create_harness

_USAGE_ATTRIBUTES = {
    "inputTokens": "gen_ai.usage.input_tokens",
    "outputTokens": "gen_ai.usage.output_tokens",
    "cacheReadInputTokens": "gen_ai.usage.cache_read.input_tokens",
    "cacheWriteInputTokens": "gen_ai.usage.cache_creation.input_tokens",
}


def _tree(spans: tuple[ReadableSpan, ...], parent_id: int | None = None) -> list[tuple[str, list]]:
    """The spans whose parent span id is ``parent_id``, each as ``(name, its own children)``."""
    return [
        (span.name, _tree(spans, span.context.span_id))
        for span in spans
        if (span.parent.span_id if span.parent else None) == parent_id
    ]


def _turn_with_tool_call(tmp_path, monkeypatch, *, memory: bool) -> tuple[Recording, tuple[ReadableSpan, ...]]:
    monkeypatch.chdir(tmp_path)
    # A host that disables the OTel SDK would turn the provider below into a no-op.
    monkeypatch.delenv("OTEL_SDK_DISABLED", raising=False)
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    steps = [[("write", {"path": str(tmp_path / "notes.txt"), "content": "alpha\n"})], "Wrote the notes."]
    # With memory on, the turn ends with a fact-extraction request; "[]" answers "nothing to remember".
    model = ScriptedModel([*steps, "[]"] if memory else steps)
    agent = create_harness(model=model, memory=memory, callback_handler=None)
    # The SDK tracer is a process-wide singleton bound to the global provider; point it at this one instead.
    monkeypatch.setattr(agent.tracer, "tracer", provider.get_tracer("scenario"))
    recording = record(agent)

    agent("Write the notes.")

    model.assert_exhausted()
    check_invariants(recording, agent, auxiliary_calls=int(memory))
    return recording, exporter.get_finished_spans()


def test_nests_model_and_tool_spans_under_the_agent_span_and_reports_usage_with_cache_tokens_on_model_spans(
    tmp_path, monkeypatch
):
    recording, spans = _turn_with_tool_call(tmp_path, monkeypatch, memory=False)

    tru_tree = _tree(spans)
    exp_tree = [
        (
            "invoke_agent Strands Agents",
            [
                ("execute_event_loop_cycle", [("chat", []), ("execute_tool write", [])]),
                ("execute_event_loop_cycle", [("chat", [])]),
            ],
        )
    ]
    assert tru_tree == exp_tree

    chat_spans = [span for span in spans if span.name == "chat"]
    tru_usage = [{name: span.attributes[name] for name in _USAGE_ATTRIBUTES.values()} for span in chat_spans]
    exp_usage = [{name: call.usage[key] for key, name in _USAGE_ATTRIBUTES.items()} for call in recording.calls]
    assert tru_usage == exp_usage
    agent_span = next(span for span in spans if span.name.startswith("invoke_agent"))
    tru_total = {name: agent_span.attributes[name] for name in _USAGE_ATTRIBUTES.values()}
    exp_total = {name: sum(call.usage[key] for call in recording.calls) for key, name in _USAGE_ATTRIBUTES.items()}
    assert tru_total == exp_total
    assert recording.calls[1].usage["cacheReadInputTokens"] > 0
    assert recording.calls[1].usage["cacheWriteInputTokens"] > 0


def test_keeps_every_span_of_a_turn_in_one_trace(tmp_path, monkeypatch):
    _recording, spans = _turn_with_tool_call(tmp_path, monkeypatch, memory=True)

    # Fact extraction is background work that the SDK starts as its own root span on purpose.
    extraction = {span.context.span_id for span in spans if span.name == "memory.extract"}
    turn = [
        span
        for span in spans
        if span.context.span_id not in extraction and not (span.parent and span.parent.span_id in extraction)
    ]
    assert {"memory.inject", "memory.search"} <= {span.name for span in turn}
    assert len({span.context.trace_id for span in turn}) == 1
