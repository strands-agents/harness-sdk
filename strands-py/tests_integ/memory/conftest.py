"""Shared fixtures for the live Bedrock Knowledge Base integration tests.

The SSM test-infra parameters are resolved once in a session-scoped fixture
(:func:`bedrock_kb_context`) and reused across tests. Tests ``pytest.skip(...)`` when the context's
``should_skip`` flag is set (SSM unreachable or the KB id missing).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import pytest

from tests_integ._ssm import resolve_ssm_parameters, ssm_parameter_path

logger = logging.getLogger(__name__)

# SSM parameter names for the shared test infrastructure.
_SSM_PARAMS = {
    "knowledge_base_id": ssm_parameter_path("bedrock-knowledge-base", "knowledge-base-id"),
    "custom_data_source_id": ssm_parameter_path("bedrock-knowledge-base", "custom-data-source-id"),
    "s3_data_source_id": ssm_parameter_path("bedrock-knowledge-base", "s3-data-source-id"),
    "s3_bucket": ssm_parameter_path("bedrock-knowledge-base", "s3-source-bucket-name"),
}

# Optional local-dev overrides. Set these env vars to point the tests at your own resources without
# touching SSM.
_OVERRIDE_ENV = {
    "knowledge_base_id": "STRANDS_TEST_KB_ID",
    "custom_data_source_id": "STRANDS_TEST_KB_CUSTOM_DS_ID",
    "s3_data_source_id": "STRANDS_TEST_KB_S3_DS_ID",
    "s3_bucket": "STRANDS_TEST_KB_S3_BUCKET",
}


@dataclass
class BedrockKnowledgeBaseContext:
    """Resolved Bedrock KB test-infra parameters plus a skip flag."""

    should_skip: bool
    knowledge_base_id: str | None = None
    custom_data_source_id: str | None = None
    s3_data_source_id: str | None = None
    s3_bucket: str | None = None


@pytest.fixture(scope="session")
def bedrock_kb_context() -> BedrockKnowledgeBaseContext:
    """Resolve the Bedrock KB test-infra parameters once per session.

    Local-dev overrides (the ``STRANDS_TEST_KB_*`` env vars) take precedence over SSM. If SSM is
    unreachable or the knowledge base id can't be resolved, returns a context with ``should_skip`` set
    so dependent tests skip cleanly.
    """
    merged = resolve_ssm_parameters(_SSM_PARAMS, overrides=_OVERRIDE_ENV)

    if not merged.get("knowledge_base_id"):
        logger.info("Bedrock KB id not available (SSM/overrides) - KB integration tests will be skipped")
        return BedrockKnowledgeBaseContext(should_skip=True)

    return BedrockKnowledgeBaseContext(
        should_skip=False,
        knowledge_base_id=merged["knowledge_base_id"],
        custom_data_source_id=merged["custom_data_source_id"],
        s3_data_source_id=merged["s3_data_source_id"],
        s3_bucket=merged["s3_bucket"],
    )


@pytest.fixture
def cleanup_registrar() -> list:
    """A list tests append best-effort cleanup callbacks to; drained here in teardown.

    Each registered callback runs once at test teardown; exceptions are swallowed so cleanup never
    masks a real assertion failure.
    """
    callbacks: list = []
    yield callbacks
    for callback in callbacks:
        try:
            callback()
        except Exception:  # noqa: BLE001 - best-effort cleanup.
            pass
