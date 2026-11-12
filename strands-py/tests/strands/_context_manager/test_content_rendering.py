"""Tests for messages and tool results rendered as content blocks that can go back into model input."""

import json

from strands._context_manager.content_rendering import (
    flatten_messages_to_content,
    tool_result_to_content_blocks,
)
from strands.types.content import ContentBlock, Message
from strands.types.tools import ToolResult

_BYTES = b"\x01"
_IMAGE = ContentBlock(image={"format": "png", "source": {"bytes": _BYTES}})


class TestFlattenMessagesToContent:
    def test_excludes_reasoning_blocks(self):
        messages = [
            Message(
                role="assistant",
                content=[
                    ContentBlock(reasoningContent={"reasoningText": {"text": "plan", "signature": "sig"}}),
                    ContentBlock(text="hi"),
                ],
            )
        ]

        assert flatten_messages_to_content(messages) == [
            ContentBlock(text="\n---\n[assistant]"),
            ContentBlock(text="hi"),
        ]

    def test_skips_the_role_marker_for_a_message_with_only_reasoning(self):
        messages = [
            Message(
                role="assistant",
                content=[ContentBlock(reasoningContent={"reasoningText": {"text": "plan", "signature": "sig"}})],
            ),
            Message(role="user", content=[ContentBlock(text="next")]),
        ]

        assert flatten_messages_to_content(messages) == [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="next"),
        ]

    def test_leaves_out_injected_text(self):
        messages = [
            Message(
                role="user",
                content=[
                    ContentBlock(text="fix the build"),
                    ContentBlock(injected={"text": "<todos>v1</todos>", "source": "strands:todos:injector"}),
                ],
            )
        ]

        assert flatten_messages_to_content(messages) == [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="fix the build"),
        ]

    def test_passes_only_text_images_and_documents_through_and_renders_the_rest_as_text(self):
        messages = [
            Message(
                role="user",
                content=[
                    ContentBlock(guardContent={"text": {"text": "guarded text", "qualifiers": []}}),
                    ContentBlock(video={"format": "mp4", "source": {"bytes": _BYTES}}),
                    ContentBlock(audio={"format": "mp3", "source": {"bytes": _BYTES}}),
                    _IMAGE,
                    ContentBlock(cachePoint={"type": "default"}),
                    ContentBlock(
                        toolResult=ToolResult(
                            toolUseId="call_1",
                            status="success",
                            content=[{"json": {"ok": True}}, {"video": {"format": "mp4", "source": {"bytes": _BYTES}}}],
                        )
                    ),
                ],
            ),
            Message(
                role="assistant",
                content=[ContentBlock(citationsContent={"citations": [], "content": [{"text": "cited answer"}]})],
            ),
        ]

        assert flatten_messages_to_content(messages) == [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="guarded text"),
            ContentBlock(text="[video omitted]"),
            ContentBlock(text="[audio omitted]"),
            _IMAGE,
            ContentBlock(text="[tool result]"),
            ContentBlock(text=json.dumps({"ok": True}, indent=2)),
            ContentBlock(text="[video omitted]"),
            ContentBlock(text="\n---\n[assistant]"),
            ContentBlock(text="cited answer"),
        ]

    def test_renders_a_summary_block_as_its_text(self):
        messages = [
            Message(
                role="assistant",
                content=[ContentBlock(summary={"provider": "anthropic", "signature": "sig", "text": "earlier facts"})],
            )
        ]

        assert flatten_messages_to_content(messages) == [
            ContentBlock(text="\n---\n[assistant]"),
            ContentBlock(text="earlier facts"),
        ]


class TestFlattenMessagesWithToolCalls:
    # guards against tool-use blocks reaching the summarizer in a user turn (#5291)
    HISTORY = [
        Message(role="user", content=[ContentBlock(text="fix the build")]),
        Message(
            role="assistant",
            content=[ContentBlock(toolUse={"name": "shell", "toolUseId": "call_1", "input": {"command": "ls"}})],
        ),
        Message(
            role="user",
            content=[
                ContentBlock(
                    toolResult=ToolResult(toolUseId="call_1", status="success", content=[{"text": "a.ts b.ts"}])
                )
            ],
        ),
    ]

    def test_renders_tool_calls_and_their_results_as_labeled_text(self):
        assert flatten_messages_to_content(self.HISTORY) == [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="fix the build"),
            ContentBlock(text="\n---\n[assistant]"),
            ContentBlock(text='[tool call: shell] {"command": "ls"}'),
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result: shell]"),
            ContentBlock(text="a.ts b.ts"),
        ]

    def test_labels_error_results_and_results_without_a_matching_call(self):
        messages = [
            Message(
                role="user",
                content=[
                    ContentBlock(
                        toolResult=ToolResult(toolUseId="call_2", status="error", content=[{"text": "not found"}])
                    ),
                    ContentBlock(toolResult=ToolResult(toolUseId="call_3", status="success", content=[{"text": "ok"}])),
                ],
            ),
            Message(
                role="assistant",
                content=[ContentBlock(toolUse={"name": "shell", "toolUseId": "call_1", "input": {"command": "ls"}})],
            ),
            Message(
                role="user",
                content=[
                    ContentBlock(
                        toolResult=ToolResult(toolUseId="call_1", status="error", content=[{"text": "denied"}])
                    )
                ],
            ),
        ]

        assert flatten_messages_to_content(messages) == [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result (error)]"),
            ContentBlock(text="not found"),
            ContentBlock(text="[tool result]"),
            ContentBlock(text="ok"),
            ContentBlock(text="\n---\n[assistant]"),
            ContentBlock(text='[tool call: shell] {"command": "ls"}'),
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result: shell (error)]"),
            ContentBlock(text="denied"),
        ]


class TestToolResultToContentBlocks:
    def test_converts_text_content(self):
        assert tool_result_to_content_blocks([{"text": "hello"}]) == [ContentBlock(text="hello")]

    def test_passes_through_images(self):
        image = {"image": {"format": "png", "source": {"bytes": b"\x01\x02\x03"}}}
        assert tool_result_to_content_blocks([image]) == [ContentBlock(image=image["image"])]

    def test_converts_json_content_to_text(self):
        content = [{"text": "plain text"}, {"json": {"key": "value", "count": 42}}]

        assert tool_result_to_content_blocks(content) == [
            ContentBlock(text="plain text"),
            ContentBlock(text='{\n  "key": "value",\n  "count": 42\n}'),
        ]
