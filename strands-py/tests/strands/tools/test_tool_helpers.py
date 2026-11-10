"""Tests for tool helper functions."""

from strands.tools._tool_helpers import generate_missing_tool_result_content


class TestGenerateMissingToolResultContent:
    """Tests for generate_missing_tool_result_content function."""

    def test_single_tool_use_id(self):
        """Test generating content for a single tool use ID."""
        tool_use_ids = ["tool_123"]
        result = generate_missing_tool_result_content(tool_use_ids)

        assert len(result) == 1
        assert "toolResult" in result[0]
        assert result[0]["toolResult"]["toolUseId"] == "tool_123"
        assert result[0]["toolResult"]["status"] == "error"
        assert result[0]["toolResult"]["content"] == [{"text": "Tool was interrupted."}]

    def test_multiple_tool_use_ids(self):
        """Test generating content for multiple tool use IDs."""
        tool_use_ids = ["tool_123", "tool_456", "tool_789"]
        result = generate_missing_tool_result_content(tool_use_ids)

        assert len(result) == 3
        for i, tool_id in enumerate(tool_use_ids):
            assert "toolResult" in result[i]
            assert result[i]["toolResult"]["toolUseId"] == tool_id
            assert result[i]["toolResult"]["status"] == "error"

    def test_empty_list(self):
        """Test generating content for empty list."""
        result = generate_missing_tool_result_content([])
        assert result == []
