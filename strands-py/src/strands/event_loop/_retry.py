"""Re-export of ``ModelRetryStrategy`` from its legacy import path; the implementation lives in ``strands.retry``."""

from ..retry.model_retry_strategy import ModelRetryStrategy

__all__ = ["ModelRetryStrategy"]
