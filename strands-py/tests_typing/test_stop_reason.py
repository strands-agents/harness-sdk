"""Type-level contract for StopReason.

Guards https://github.com/strands-agents/harness-sdk/issues/4539: every stop reason a
provider can put on the wire must be matchable, so narrowing on one is not reported as
unreachable code.
"""

from strands.types.event_loop import StopReason


def provider_stop_reasons() -> None:
    # Anthropic's Messages API and the Bedrock Converse API both report these.
    model_context_window_exceeded: StopReason = "model_context_window_exceeded"
    refusal: StopReason = "refusal"

    _ = (model_context_window_exceeded, refusal)


def narrowing_reaches_every_branch(stop_reason: StopReason) -> str:
    # `pause_turn` is absent on purpose: AnthropicModel.stream resumes the paused turn and
    # reports `end_turn`, so it never reaches a caller.
    if stop_reason == "refusal":
        return "refused"
    if stop_reason == "model_context_window_exceeded":
        return "context window exceeded"
    return "other"
