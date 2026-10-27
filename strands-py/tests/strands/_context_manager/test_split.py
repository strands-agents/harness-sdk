"""Tests for splitting large strings out of tool result content (#4741)."""

import json

import pytest

from strands._context_manager.split import field_ref, is_field_ref, split_large_strings
from strands.types.tools import ToolResultContent

BIG = "\n".join(f"line {i}" for i in range(1, 501))  # 4,391 chars, 500 lines


class TestSplitLargeStrings:
    def test_splits_large_field_of_json_text_block(self):
        item = ToolResultContent(text=json.dumps({"output": BIG, "error": "", "exit_code": 0}))
        parent, fields = split_large_strings(item, "tu_0", 1000)
        assert fields == {"fields/tu_0/output": BIG}
        assert json.loads(parent["text"]) == {
            "output": "[ref: fields/tu_0/output (500 lines, 4,391 chars)]",
            "error": "",
            "exit_code": 0,
        }

    def test_splits_large_field_of_json_block(self):
        item = ToolResultContent(json={"output": BIG, "exit_code": 0})
        parent, fields = split_large_strings(item, "tu_0", 1000)
        assert fields == {"fields/tu_0/output": BIG}
        assert parent == {"json": {"output": "[ref: fields/tu_0/output (500 lines, 4,391 chars)]", "exit_code": 0}}

    def test_splits_large_plain_text_block(self):
        parent, fields = split_large_strings(ToolResultContent(text=BIG), "tu_0", 1000)
        assert fields == {"fields/tu_0/text": BIG}
        assert parent == {"text": "[ref: fields/tu_0/text (500 lines, 4,391 chars)]"}

    def test_splits_several_fields(self):
        item = ToolResultContent(json={"stdout": BIG, "stderr": BIG.upper(), "code": 1})
        parent, fields = split_large_strings(item, "tu_0", 1000)
        assert list(fields) == ["fields/tu_0/stdout", "fields/tu_0/stderr"]
        assert parent["json"]["code"] == 1

    def test_parent_text_is_compact_json_with_non_ascii_unescaped(self):
        item = ToolResultContent(text=json.dumps({"output": BIG, "note": "héllo"}, ensure_ascii=False))
        parent, _ = split_large_strings(item, "tu_0", 1000)
        assert parent["text"] == '{"output":"[ref: fields/tu_0/output (500 lines, 4,391 chars)]","note":"héllo"}'

    @pytest.mark.parametrize(
        "item",
        [
            ToolResultContent(text="short"),
            ToolResultContent(text=json.dumps({"output": "short", "exit_code": 0})),
            ToolResultContent(json={"items": [BIG]}),
            ToolResultContent(json={"nested": {"output": BIG}}),
            ToolResultContent(json={"bad key/name": BIG}),
            ToolResultContent(json={"output": "x" * 999}),
            ToolResultContent(image={"format": "png", "source": {"bytes": b"\x89PNG"}}),
        ],
    )
    def test_leaves_other_content_unchanged(self, item):
        parent, fields = split_large_strings(item, "tu_0", 1000)
        assert parent is item
        assert fields == {}

    def test_large_text_that_is_not_a_json_object_is_split_as_text(self):
        for text in ("x" * 5000 + "{not json", json.dumps([BIG])):
            parent, fields = split_large_strings(ToolResultContent(text=text), "tu_0", 1000)
            assert fields == {"fields/tu_0/text": text}
            assert parent["text"].startswith("[ref: fields/tu_0/text (1 lines, ")

    def test_plain_text_at_threshold_is_split_but_json_text_without_large_field_is_not(self):
        parent, fields = split_large_strings(ToolResultContent(text="x" * 1000), "tu_0", 1000)
        assert fields == {"fields/tu_0/text": "x" * 1000}
        item = ToolResultContent(text=json.dumps({"a": "x" * 600, "b": "y" * 600}))
        assert split_large_strings(item, "tu_0", 1000) == (item, {})

    def test_field_ref_helpers(self):
        assert field_ref("tu_0", "output") == "fields/tu_0/output"
        assert is_field_ref("fields/tu_0/output")
        assert not is_field_ref("tu_0")
        assert not is_field_ref("fields/x_0")  # a block key whose toolUseId merely starts with "fields/"
