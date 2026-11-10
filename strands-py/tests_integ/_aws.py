"""Shared AWS configuration for integration tests."""

from __future__ import annotations

import os


def resolve_region(region: str | None = None) -> str:
    """Resolve the AWS region to use for test infrastructure.

    Checks, in order: the explicit ``region`` argument, then ``AWS_REGION``,
    then ``AWS_DEFAULT_REGION``, falling back to ``us-east-1``.
    """
    return region or os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
