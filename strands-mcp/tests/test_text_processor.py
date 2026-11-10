"""Tests for markdown section parsing and summary generation."""

import pytest

from strands_mcp_server.utils.text_processor import (
    extract_preamble,
    extract_section,
    make_section_summary,
    parse_sections,
)


class TestParseSections:
    """Tests for parse_sections()."""

    def test_basic_hierarchy(self, api_reference_doc):
        tru_sections = parse_sections(api_reference_doc)

        assert len(tru_sections) == 3
        assert tru_sections[0]["id"] == "1"
        assert tru_sections[0]["title"] == "AfterModelCallEvent"
        assert tru_sections[0]["level"] == 2
        assert len(tru_sections[0]["children"]) == 2

    def test_children_have_ids_and_titles(self, api_reference_doc):
        tru_sections = parse_sections(api_reference_doc)
        tru_children = tru_sections[0]["children"]

        exp_children = [
            {"id": "1.1", "title": "should_reverse_callbacks"},
            {"id": "1.2", "title": "ModelStopResponse"},
        ]
        assert tru_children == exp_children

    def test_summaries_generated(self, api_reference_doc):
        tru_sections = parse_sections(api_reference_doc)
        tru_summary = tru_sections[0]["summary"]

        assert "Event triggered after the model invocation" in tru_summary
        assert len(tru_summary) <= 200

    def test_headers_in_code_blocks_ignored(self, headers_in_code_blocks_doc):
        tru_sections = parse_sections(headers_in_code_blocks_doc)

        tru_titles = [s["title"] for s in tru_sections]
        exp_titles = ["Configuration", "Next Section"]
        assert tru_titles == exp_titles

    def test_no_h2_headers_returns_empty(self, no_h2_doc):
        tru_sections = parse_sections(no_h2_doc)

        exp_sections = []
        assert tru_sections == exp_sections

    def test_skipped_header_levels(self, skipped_levels_doc):
        tru_sections = parse_sections(skipped_levels_doc)

        assert len(tru_sections) == 2
        assert tru_sections[0]["title"] == "Section One"
        # #### treated as direct child of ##
        assert len(tru_sections[0]["children"]) == 1
        assert tru_sections[0]["children"][0]["title"] == "Deep Child"

    def test_empty_content_returns_empty(self):
        tru_sections = parse_sections("")

        exp_sections = []
        assert tru_sections == exp_sections

    def test_empty_section_has_empty_or_fallback_summary(self, empty_section_doc):
        tru_sections = parse_sections(empty_section_doc)

        assert len(tru_sections) == 2
        assert tru_sections[0]["title"] == "Empty"
        # Empty section should produce an empty summary or a minimal fallback
        assert tru_sections[0]["summary"] == ""

    def test_section_ids_are_one_based(self, api_reference_doc):
        tru_sections = parse_sections(api_reference_doc)

        tru_ids = [s["id"] for s in tru_sections]
        exp_ids = ["1", "2", "3"]
        assert tru_ids == exp_ids

    def test_duplicate_child_names_have_unique_ids(self, duplicate_children_doc):
        tru_sections = parse_sections(duplicate_children_doc)

        assert len(tru_sections) == 2
        # Both parents have __init__() and process() children
        tru_children_a = tru_sections[0]["children"]
        tru_children_b = tru_sections[1]["children"]
        assert tru_children_a[0]["title"] == "__init__()"
        assert tru_children_b[0]["title"] == "__init__()"
        # But their IDs are unique
        assert tru_children_a[0]["id"] == "1.1"
        assert tru_children_b[0]["id"] == "2.1"


class TestMakeSectionSummary:
    """Tests for make_section_summary()."""

    def test_extracts_first_paragraph(self):
        text = "## Title\n\nFirst paragraph of content.\n\nSecond paragraph.\n"
        tru_summary = make_section_summary(text)

        assert "First paragraph of content" in tru_summary

    def test_truncates_at_max_chars(self):
        long_text = "## Title\n\n" + "A" * 500 + "\n"
        tru_summary = make_section_summary(long_text, max_chars=200)

        assert len(tru_summary) <= 200

    def test_skips_code_blocks(self):
        text = "## Title\n\n```python\ndef foo():\n    pass\n```\n\nActual content here.\n"
        tru_summary = make_section_summary(text)

        assert "def foo" not in tru_summary
        assert "Actual content" in tru_summary

    def test_empty_section_returns_fallback(self):
        text = "## Title\n\n### Child1\n\n### Child2\n"
        tru_summary = make_section_summary(text)

        # Should contain child names as fallback
        assert "Child1" in tru_summary or "Contains:" in tru_summary

    def test_strips_heading_lines_from_summary(self):
        text = "## Title\n\nActual content.\n"
        tru_summary = make_section_summary(text)

        assert not tru_summary.startswith("##")


class TestExtractSection:
    """Tests for extract_section()."""

    def test_extract_top_level_section(self, api_reference_doc):
        sections = parse_sections(api_reference_doc)
        tru_result = extract_section(api_reference_doc, "1", sections)

        assert tru_result is not None
        assert tru_result["section_id"] == "1"
        assert tru_result["section_title"] == "AfterModelCallEvent"
        assert "## AfterModelCallEvent" in tru_result["content"]
        # Should include children
        assert "### should_reverse_callbacks" in tru_result["content"]
        assert "### ModelStopResponse" in tru_result["content"]

    def test_extract_child_section(self, api_reference_doc):
        sections = parse_sections(api_reference_doc)
        tru_result = extract_section(api_reference_doc, "1.2", sections)

        assert tru_result is not None
        assert tru_result["section_title"] == "ModelStopResponse"
        assert "### ModelStopResponse" in tru_result["content"]
        # Should NOT include sibling
        assert "### should_reverse_callbacks" not in tru_result["content"]

    def test_extract_last_section(self, api_reference_doc):
        sections = parse_sections(api_reference_doc)
        tru_result = extract_section(api_reference_doc, "3", sections)

        assert tru_result is not None
        assert tru_result["section_title"] == "AgentTool"
        assert "### stream()" in tru_result["content"]

    @pytest.mark.parametrize(
        "section_id",
        ["0", "99", "abc", "3..2", "1.99"],
    )
    def test_invalid_section_returns_none(self, api_reference_doc, section_id):
        sections = parse_sections(api_reference_doc)
        tru_result = extract_section(api_reference_doc, section_id, sections)

        exp_result = None
        assert tru_result == exp_result

    def test_empty_section_id_returns_none(self, api_reference_doc):
        sections = parse_sections(api_reference_doc)
        tru_result = extract_section(api_reference_doc, "", sections)

        exp_result = None
        assert tru_result == exp_result

    def test_section_includes_header_line(self, api_reference_doc):
        sections = parse_sections(api_reference_doc)
        tru_result = extract_section(api_reference_doc, "2", sections)

        assert tru_result["content"].startswith("## AfterToolCallEvent")


class TestExtractPreamble:
    """Tests for extract_preamble()."""

    def test_extracts_content_between_h1_and_first_h2(self, api_reference_doc):
        tru_preamble = extract_preamble(api_reference_doc)

        assert "Experimental hook events" in tru_preamble
        assert "# strands.hooks.events" not in tru_preamble  # H1 stripped

    def test_strips_h1_heading_line(self):
        content = "# Title\n\nIntro paragraph.\n\n## Section\n\nBody.\n"
        tru_preamble = extract_preamble(content)

        assert tru_preamble == "Intro paragraph."
        assert "# Title" not in tru_preamble

    def test_empty_preamble_when_h2_follows_h1_immediately(self):
        content = "# Title\n\n## Section\n\nBody.\n"
        tru_preamble = extract_preamble(content)

        exp_preamble = ""
        assert tru_preamble == exp_preamble

    def test_empty_content_returns_empty(self):
        tru_preamble = extract_preamble("")

        exp_preamble = ""
        assert tru_preamble == exp_preamble

    def test_no_h2_headers_returns_content_after_h1(self):
        content = "# Title\n\nJust content, no sections.\n"
        tru_preamble = extract_preamble(content)

        assert tru_preamble == "Just content, no sections."

    def test_ignores_h2_inside_code_block(self):
        content = (
            "# Title\n\n"
            "Intro text.\n\n"
            "```python\n"
            "## This is not a real header\n"
            "```\n\n"
            "More intro.\n\n"
            "## Real Section\n\n"
            "Body.\n"
        )
        tru_preamble = extract_preamble(content)

        assert "Intro text" in tru_preamble
        assert "More intro" in tru_preamble

    def test_no_h1_returns_content_before_first_h2(self):
        content = "Some intro without title.\n\n## Section\n\nBody.\n"
        tru_preamble = extract_preamble(content)

        assert "Some intro without title" in tru_preamble
