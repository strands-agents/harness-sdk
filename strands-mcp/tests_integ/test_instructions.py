"""Integration tests for the server instructions against live documentation."""

import re

import pytest

from strands_mcp_server.server import INSTRUCTIONS

from .conftest import integ_marks

pytestmark = integ_marks

INSTRUCTION_DOC_URLS = re.findall(r"https://strandsagents\.com/\S+?\.md", INSTRUCTIONS)


def test_instructions_reference_doc_pages():
    assert INSTRUCTION_DOC_URLS


@pytest.mark.parametrize("url", INSTRUCTION_DOC_URLS)
def test_instruction_url_is_in_catalog(live_cache, url):
    assert url in live_cache.get_url_titles()
