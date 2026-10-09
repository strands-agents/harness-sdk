"""Observe model chunks before default usage values and consumer processing are applied."""

from time import perf_counter

from ..telemetry.metrics import ModelInvocationMetric
from ..types.streaming import StopReason, StreamEvent


class _ModelInvocationMetrics:
    def __init__(self) -> None:
        self._start = perf_counter()
        self._last_chunk: float | None = None
        self._output_tokens: int | None = None
        self._saw_message_stop = False

    def observe(self, chunk: StreamEvent) -> None:
        self._last_chunk = perf_counter()
        self._saw_message_stop |= "messageStop" in chunk
        usage = chunk.get("metadata", {}).get("usage", {})
        if "outputTokens" in usage:
            self._output_tokens = usage["outputTokens"]

    def finish(self, stop_reason: StopReason, model_id: str | None) -> ModelInvocationMetric | None:
        if stop_reason == "cancelled" or not self._saw_message_stop or self._last_chunk is None:
            return None
        return ModelInvocationMetric(self._output_tokens, self._last_chunk - self._start, model_id)
