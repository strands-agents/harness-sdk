"""Shared retry primitives."""

import math
from dataclasses import dataclass


@dataclass(frozen=True, kw_only=True)
class RetryDecision:
    """Decision returned by a retry strategy's ``compute_retry_decision`` method.

    Attributes:
        retry: Whether to retry the failed operation. When False, the error propagates to the caller.
        wait: Seconds to wait before retrying. Required when ``retry`` is True; ignored otherwise.
    """

    retry: bool
    wait: float | None = None

    def __post_init__(self) -> None:
        """Validate the delay for a retry decision.

        Raises:
            ValueError: If ``retry`` is True and ``wait`` is missing, negative, or not finite.
        """
        if not self.retry:
            return
        if self.wait is None or not math.isfinite(self.wait) or self.wait < 0:
            raise ValueError(f"RetryDecision: wait must be a non-negative finite number (got {self.wait!r})")
