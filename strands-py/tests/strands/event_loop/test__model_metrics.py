import pytest

from strands.event_loop import _model_metrics
from strands.telemetry import ModelInvocationMetric


@pytest.mark.parametrize(("usage", "exp_tokens"), [({}, None), ({"inputTokens": 3}, None), ({"outputTokens": 0}, 0)])
def test_observation_distinguishes_missing_usage_from_zero(monkeypatch, usage, exp_tokens):
    monkeypatch.setattr(_model_metrics, "perf_counter", iter([1.0, 2.0, 3.0]).__next__)
    observation = _model_metrics._ModelInvocationMetrics()
    observation.observe({"messageStop": {"stopReason": "end_turn"}})
    observation.observe({"metadata": {"usage": usage}})
    assert observation.finish("end_turn", "model") == ModelInvocationMetric(exp_tokens, 2.0, "model")


def test_observation_uses_last_explicit_usage_and_last_chunk_time(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(_model_metrics, "perf_counter", lambda: clock[0])
    observation = _model_metrics._ModelInvocationMetrics()
    for clock[0], chunk in [
        (1.0, {"metadata": {"usage": {"outputTokens": 2}}}),
        (2.0, {"metadata": {"usage": {"outputTokens": 12}}}),
        (3.0, {"messageStop": {"stopReason": "end_turn"}}),
        (4.0, {"metadata": {"metrics": {"latencyMs": 1}}}),
    ]:
        observation.observe(chunk)
    clock[0] = 100.0  # Processing after the final raw chunk is outside the measurement.
    assert observation.finish("end_turn", None) == ModelInvocationMetric(12, 4.0)


@pytest.mark.parametrize(("saw_stop", "stop_reason"), [(False, "end_turn"), (False, "cancelled"), (True, "cancelled")])
def test_incomplete_or_cancelled_stream_has_no_sample(saw_stop, stop_reason):
    observation = _model_metrics._ModelInvocationMetrics()
    observation.observe({"metadata": {"usage": {"outputTokens": 12}}})
    if saw_stop:
        observation.observe({"messageStop": {"stopReason": "end_turn"}})
    assert observation.finish(stop_reason, None) is None
