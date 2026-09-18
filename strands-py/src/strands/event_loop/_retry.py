"""Compatibility imports for the model retry strategy.

Public retry APIs live in :mod:`strands.retry`.
"""

import asyncio as asyncio

from ..retry import ModelRetryStrategy as ModelRetryStrategy

__all__ = ["ModelRetryStrategy"]
