"""Integration tests for the integrations catalog feed published by the site."""

from typing import get_args

from strands_mcp_server.utils import integrations

from .conftest import integ_marks

pytestmark = integ_marks


def test_live_feed_values_are_known():
    entries = integrations.get_integrations()

    assert entries
    assert {e["integrationType"] for e in entries} <= set(get_args(integrations.IntegrationType))
    assert {e["maintainedBy"] for e in entries} <= set(get_args(integrations.Maintainer))
    assert {e["sdk"] for e in entries} <= set(get_args(integrations.Sdk))
    assert {lang for e in entries for lang in e["languages"]} <= set(get_args(integrations.Language))
