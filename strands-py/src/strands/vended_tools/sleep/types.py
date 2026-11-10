"""Shared types and constants for the sleep tool."""

DEFAULT_MAX_DURATION = 60.0
"""Default upper bound on ``duration`` (seconds) accepted by :func:`make_sleep`."""


def sleep_description(max_duration: float) -> str:
    """Build the model-facing description with the configured max interpolated."""
    return (
        f"Pauses execution for a specified number of seconds (max {max_duration}). "
        "Cooperative and cancellable: the sleep aborts immediately when the agent "
        "invocation is cancelled. Rejects negative, NaN, infinite, or non-numeric "
        f"durations, and durations above {max_duration}."
    )


SLEEP_DESCRIPTION = sleep_description(DEFAULT_MAX_DURATION)
"""Description for the default sleep tool (60-second cap)."""
