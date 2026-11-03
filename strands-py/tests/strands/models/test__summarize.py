"""Tests for the flattened transcript the base Model.summarize() sends."""

import json

from strands.models._summarize import _flatten_messages_to_content
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult, ToolUse


def _tool_result_message(content):
    return Message(
        role="user",
        content=[ContentBlock(toolResult=ToolResult(toolUseId="t1", status="success", content=content))],
    )


class TestFlattenToolResultContent:
    """Tests for flattening a tool result's content."""

    def test_passes_text_and_images_through(self):
        image = {"image": {"format": "png", "source": {"bytes": b"data"}}}
        messages = [_tool_result_message([{"text": "first"}, image, {"text": "second"}])]

        tru_result = _flatten_messages_to_content(messages)
        exp_result = [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result]"),
            ContentBlock(text="first"),
            ContentBlock(**image),
            ContentBlock(text="second"),
        ]
        assert tru_result == exp_result

    def test_renders_json_as_indented_text(self):
        messages = [_tool_result_message([{"text": "plain text"}, {"json": {"key": "value", "count": 42}}])]

        tru_result = _flatten_messages_to_content(messages)
        exp_result = [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result]"),
            ContentBlock(text="plain text"),
            ContentBlock(text='{\n  "key": "value",\n  "count": 42\n}'),
        ]
        assert tru_result == exp_result

    def test_renders_video_as_a_placeholder(self):
        messages = [
            _tool_result_message([{"text": "clip"}, {"video": {"format": "mp4", "source": {"bytes": b"data"}}}])
        ]

        tru_result = _flatten_messages_to_content(messages)
        exp_result = [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result]"),
            ContentBlock(text="clip"),
            ContentBlock(text="[video omitted]"),
        ]
        assert tru_result == exp_result


class TestFlattenMessagesToContent:
    """Tests for flattening messages to content blocks."""

    def test_adds_role_markers(self):
        messages = [
            Message(role="user", content=[ContentBlock(text="hello")]),
            Message(role="assistant", content=[ContentBlock(text="hi")]),
        ]
        tru_result = _flatten_messages_to_content(messages)
        exp_result = [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="hello"),
            ContentBlock(text="\n---\n[assistant]"),
            ContentBlock(text="hi"),
        ]
        assert tru_result == exp_result

    def test_extracts_tool_result_content(self):
        messages = [
            Message(
                role="user",
                content=[
                    ContentBlock(
                        toolResult={
                            "toolUseId": "t1",
                            "status": "success",
                            "content": [{"text": "result data"}],
                        }
                    )
                ],
            ),
        ]
        tru_result = _flatten_messages_to_content(messages)
        exp_result = [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result]"),
            ContentBlock(text="result data"),
        ]
        assert tru_result == exp_result

    def test_excludes_reasoning(self):
        messages = [
            Message(
                role="assistant",
                content=[
                    ContentBlock(reasoningContent={"reasoningText": {"text": "plan", "signature": "sig"}}),
                    ContentBlock(text="hi"),
                ],
            ),
        ]
        tru_result = _flatten_messages_to_content(messages)
        assert tru_result == [ContentBlock(text="\n---\n[assistant]"), ContentBlock(text="hi")]

    def test_skips_marker_for_reasoning_only_message(self):
        messages = [
            Message(
                role="assistant",
                content=[ContentBlock(reasoningContent={"reasoningText": {"text": "plan", "signature": "sig"}})],
            ),
            Message(role="user", content=[ContentBlock(text="next")]),
        ]
        tru_result = _flatten_messages_to_content(messages)
        assert tru_result == [ContentBlock(text="\n---\n[user]"), ContentBlock(text="next")]

    def test_passes_only_text_images_and_documents_and_renders_other_blocks_as_text(self):
        image = ContentBlock(image={"format": "png", "source": {"bytes": b"\x01"}})
        tool_result = ToolResult(
            toolUseId="call_1",
            status="success",
            content=[{"json": {"ok": True}}, {"video": {"format": "mp4", "source": {"bytes": b"\x01"}}}],
        )
        messages: Messages = [
            Message(
                role="user",
                content=[
                    ContentBlock(guardContent={"text": {"text": "guarded text", "qualifiers": []}}),
                    ContentBlock(video={"format": "mp4", "source": {"bytes": b"\x01"}}),
                    ContentBlock(audio={"format": "mp3", "source": {"bytes": b"\x01"}}),
                    image,
                    ContentBlock(cachePoint={"type": "default"}),
                    ContentBlock(toolResult=tool_result),
                ],
            ),
            Message(
                role="assistant",
                content=[ContentBlock(citationsContent={"citations": [], "content": [{"text": "cited answer"}]})],
            ),
        ]

        tru_result = _flatten_messages_to_content(messages)
        exp_result = [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="guarded text"),
            ContentBlock(text="[video omitted]"),
            ContentBlock(text="[audio omitted]"),
            image,
            ContentBlock(text="[tool result]"),
            ContentBlock(text=json.dumps({"ok": True}, indent=2)),
            ContentBlock(text="[video omitted]"),
            ContentBlock(text="\n---\n[assistant]"),
            ContentBlock(text="cited answer"),
        ]
        assert tru_result == exp_result

    def test_renders_tool_calls_and_their_results_as_labeled_text(self):
        # guards against tool-use blocks reaching the summarizer in a user turn (#5291)
        tool_use = ToolUse(toolUseId="call_1", name="shell", input={"command": "ls"})
        tool_result = ToolResult(toolUseId="call_1", status="success", content=[{"text": "a.ts b.ts"}])
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="fix the build")]),
            Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]),
            Message(role="user", content=[ContentBlock(toolResult=tool_result)]),
        ]

        tru_result = _flatten_messages_to_content(messages)
        exp_result = [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="fix the build"),
            ContentBlock(text="\n---\n[assistant]"),
            ContentBlock(text='[tool call: shell] {"command":"ls"}'),
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result: shell]"),
            ContentBlock(text="a.ts b.ts"),
        ]
        assert tru_result == exp_result

    def test_labels_error_results_and_results_without_a_matching_call(self):
        tool_use = ToolUse(toolUseId="call_1", name="shell", input={"command": "ls"})
        unmatched_error = ToolResult(toolUseId="call_2", status="error", content=[{"text": "not found"}])
        unmatched_success = ToolResult(toolUseId="call_3", status="success", content=[{"text": "ok"}])
        failed = ToolResult(toolUseId="call_1", status="error", content=[{"text": "denied"}])
        messages: Messages = [
            Message(
                role="user",
                content=[ContentBlock(toolResult=unmatched_error), ContentBlock(toolResult=unmatched_success)],
            ),
            Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]),
            Message(role="user", content=[ContentBlock(toolResult=failed)]),
        ]

        tru_result = _flatten_messages_to_content(messages)
        exp_result = [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result (error)]"),
            ContentBlock(text="not found"),
            ContentBlock(text="[tool result]"),
            ContentBlock(text="ok"),
            ContentBlock(text="\n---\n[assistant]"),
            ContentBlock(text='[tool call: shell] {"command":"ls"}'),
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result: shell (error)]"),
            ContentBlock(text="denied"),
        ]
        assert tru_result == exp_result
