"""Integration tests for the stash: what an offload strategy leaves behind, and what it retrieves."""

import unittest.mock

import pytest

from strands._context_manager.content_rendering import flatten_messages_to_content
from strands._context_manager.context_manager import ContextManager
from strands._context_manager.message_trimming import repair_alternation
from strands._context_manager.placeholder import is_offloaded, offload_placeholder
from strands._context_manager.retrieval_tool import RETRIEVAL_TOOL_NAME, _create_retrieval_tool
from strands._context_manager.strategies.offload import Offload
from strands.models._summarize import SummarizeResult
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult, ToolUse
from tests.fixtures.context_manager_helpers import heuristic_model, make_agent, make_context, make_tool_result_message


async def _stash_all(stash, messages: Messages) -> None:
    """Stash every message as the eager hook does on arrival."""
    for message in messages:
        await stash.store_message(message)


async def _retrieve(stash, reference, max_result_tokens=None, **inputs):
    """What ``retrieve_context`` returns for a reference."""
    tool = _create_retrieval_tool(stash, max_result_tokens)
    return await tool._tool_func({"toolUseId": "t1", "input": {"reference": reference, **inputs}})


def _text_message(role: str, text: str, tracking_id: str) -> Message:
    return Message(role=role, content=[ContentBlock(text=text)], tracking_id=tracking_id)


def _tool_result_content(message: Message) -> list:
    """The items of the tool result a message's first block holds."""
    return message["content"][0]["toolResult"]["content"]


def _marker_of(messages: Messages) -> ContentBlock:
    """The first placeholder standing in for removed messages."""
    return next(block for message in messages for block in message["content"] if is_offloaded(block))


class TestContextManagerToolRegistration:
    def test_provides_retrieve_context_once_the_agent_is_initialized(self, storage):
        manager = ContextManager()
        agent = make_agent()
        agent.storage = storage

        manager.init_agent(agent)

        assert [tool.tool_name for tool in manager.tools] == [RETRIEVAL_TOOL_NAME]

    def test_provides_no_retrieval_tool_when_the_stash_is_disabled(self, storage):
        manager = ContextManager(stash=False)
        agent = make_agent()
        agent.storage = storage

        manager.init_agent(agent)

        assert manager.stash is None
        assert manager.tools == []


class TestTruncateWithStash:
    @pytest.mark.asyncio
    async def test_resolves_the_reference_of_a_block_a_history_edit_moved_into_another_message(self, stash):
        big = "x" * 20000
        messages = [
            _text_message("user", "q", "u0"),
            _text_message("assistant", "short", "a1"),
            _text_message("assistant", big, "a2"),
        ]
        await _stash_all(stash, messages)
        # Merges a2 into a1: the big block is now a1_1, while it was stored on arrival as a2_0.
        repair_alternation(messages)

        await Offload.truncate("assistant_text", {"preview_tokens": 10}).apply(make_context(messages, stash=stash))

        placeholder = messages[1]["content"][1]
        assert placeholder["offloaded"]["ref"] == "a1_1"
        assert (await _retrieve(stash, "a1_1"))["content"] == [{"text": big}]

    @pytest.mark.asyncio
    async def test_persists_original_content_before_truncating(self, stash):
        large_text = "important data " * 1000
        messages = [make_tool_result_message(large_text)]
        await _stash_all(stash, messages)

        acted = await Offload.truncate("tool_results").apply(make_context(messages, stash=stash))

        assert acted is True
        assert await stash.take_snapshot() == {"tool-123_0": {"text": large_text}}

    @pytest.mark.asyncio
    async def test_leaves_a_placeholder_referencing_the_tool_result_in_the_preview(self, stash):
        messages = [make_tool_result_message("x" * 20000)]
        await _stash_all(stash, messages)

        await Offload.truncate("tool_results").apply(make_context(messages, stash=stash))

        placeholder = _tool_result_content(messages[0])[0]
        assert placeholder["offloaded"] == {"method": "truncate", "ref": "tool-123", "tokens": 5000}
        assert placeholder["text"].endswith(" [ref: tool-123]")

    @pytest.mark.asyncio
    async def test_never_stores_a_seeded_placeholder_under_the_original_key(self, stash):
        seeded = offload_placeholder("truncate", "[Truncated: 1 block, ~7,500 tokens] preview", "tool-123")
        tool_result = ToolResult(toolUseId="tool-123", status="success", content=[seeded])
        messages = [Message(role="user", content=[ContentBlock(toolResult=tool_result)])]
        await _stash_all(stash, messages)

        await Offload.drop("tool_results").apply(make_context(messages, stash=stash))

        assert _tool_result_content(messages[0]) == [
            offload_placeholder("drop", "[Dropped: ~15 tokens]", "tool-123", 15)
        ]
        assert await stash.list() == []
        unresolvable = 'Error: reference not found: tool-123. Pass only the <id> from the placeholder\'s "[ref: <id>]".'
        assert (await _retrieve(stash, "tool-123"))["content"] == [{"text": unresolvable}]

    @pytest.mark.asyncio
    async def test_lets_a_later_strategy_act_on_an_already_truncated_result(self, stash):
        original = "x" * 20000
        messages = [make_tool_result_message(original)]
        await _stash_all(stash, messages)
        context = make_context(messages, stash=stash)
        await Offload.truncate("tool_results", {"preview_tokens": 10}).apply(context)

        acted_again = await Offload.drop("tool_results").apply(context)

        assert acted_again is True
        # The preview is ~32 tokens, so the marker reports the 5,000 the truncate placeholder stood for as well.
        assert _tool_result_content(messages[0]) == [
            offload_placeholder("drop", "[Dropped: ~5,032 tokens]", "tool-123", 5032)
        ]
        assert (await _retrieve(stash, "tool-123"))["content"] == [{"text": original}]

    @pytest.mark.asyncio
    async def test_leaves_a_placeholder_without_a_reference_when_no_stash_is_configured(self):
        messages = [make_tool_result_message("x" * 20000)]

        await Offload.truncate("tool_results").apply(make_context(messages))

        placeholder = _tool_result_content(messages[0])[0]
        assert placeholder["offloaded"] == {"method": "truncate", "tokens": 5000}
        assert "[ref:" not in placeholder["text"]


class TestDropWithStash:
    @pytest.mark.asyncio
    async def test_persists_original_content_before_dropping(self, stash):
        large_text = "critical information " * 500
        messages = [make_tool_result_message(large_text)]
        await _stash_all(stash, messages)

        acted = await Offload.drop("tool_results").apply(make_context(messages, stash=stash))

        assert acted is True
        assert await stash.take_snapshot() == {"tool-123_0": {"text": large_text}}

    @pytest.mark.asyncio
    async def test_leaves_a_placeholder_referencing_the_tool_result_as_the_drop_marker(self, stash):
        messages = [make_tool_result_message("x" * 20000)]
        await _stash_all(stash, messages)

        await Offload.drop("tool_results").apply(make_context(messages, stash=stash))

        assert _tool_result_content(messages[0]) == [
            offload_placeholder("drop", "[Dropped: ~5,000 tokens]", "tool-123", 5000)
        ]

    @pytest.mark.asyncio
    async def test_marks_removed_messages_with_a_placeholder_that_retrieves_them(self, stash):
        first = _text_message("assistant", "first answer", "m1")
        second = _text_message("user", "second question", "m2")
        messages = [_text_message("user", "start", "m0"), first, second, _text_message("assistant", "final", "m3")]
        await _stash_all(stash, messages)
        strategy = Offload.drop("*").when(context_utilization="50%")

        acted = await strategy.apply(make_context(messages, stash=stash, utilization=0.9))

        assert acted is True
        marker = offload_placeholder("drop", "[Dropped: earlier messages, ~7 tokens]", "removed-m1", 7)
        assert [message["content"] for message in messages] == [
            [{"text": "start"}],
            [{"text": "final"}, marker],
        ]
        assert (await _retrieve(stash, "removed-m1"))["content"] == [
            {"text": "\n---\n[assistant]"},
            {"text": "first answer"},
            {"text": "\n---\n[user]"},
            {"text": "second question"},
        ]
        searched = await _retrieve(stash, "removed-m1", pattern="second")
        assert "second question" in searched["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_leaves_a_marker_without_a_reference_when_there_is_no_stash(self):
        messages = [
            make_tool_result_message("a", "t0"),
            Message(role="assistant", content=[ContentBlock(text="mid")]),
            Message(role="user", content=[ContentBlock(text="next")]),
            Message(role="assistant", content=[ContentBlock(text="final")]),
        ]

        await Offload.drop("*").when(context_utilization="50%").apply(make_context(messages, utilization=0.9))

        assert messages[-1]["content"] == [
            {"text": "final"},
            offload_placeholder("drop", "[Dropped: earlier messages, ~2 tokens]", None, 2),
        ]


_COMPACTION = ContentBlock(summary={"provider": "anthropic", "text": "compacted"})
"""The summary a server-side-capable model returns."""


def _server_side_history() -> Messages:
    """A history whose messages 1 through 3 a server-side summary replaces, ``preserve_recent`` keeping the last."""
    texts = [("user", "start"), ("assistant", "first answer"), ("user", "second question")]
    texts += [("assistant", "final"), ("user", "latest")]
    return [_text_message(role, text, f"m{index}") for index, (role, text) in enumerate(texts)]


def _server_side_model():
    """A model that reports the server-side summary capability and returns ``_COMPACTION``."""
    model = heuristic_model(summarize=unittest.mock.AsyncMock(return_value=SummarizeResult(content=[_COMPACTION])))
    model.model_info.capabilities.server_side_summary = True
    return model


class TestServerSideSummaryWithStash:
    def _strategy(self):
        return Offload.summarize("*").when(context_utilization="50%", preserve_recent=1)

    @pytest.mark.asyncio
    async def test_leaves_a_placeholder_that_retrieves_every_message_it_stands_for(self, stash):
        messages = _server_side_history()
        # Message 0 stays in the array but a compaction block stops it being sent, so the summary stands for it too.
        covered = messages[:4]
        await _stash_all(stash, messages)
        context = make_context(messages, stash=stash, utilization=0.9, model=_server_side_model())

        acted = await self._strategy().apply(context)

        assert acted is True
        # The placeholder follows the summary: a provider sending it as a compaction block rejects content before one.
        assert [message["content"] for message in messages] == [
            [{"text": "start"}],
            [
                _COMPACTION,
                offload_placeholder("summarize", "[Summarized: earlier messages, ~11 tokens]", "removed-m0", 11),
            ],
            [{"text": "latest"}],
        ]
        assert (await _retrieve(stash, "removed-m0"))["content"] == flatten_messages_to_content(covered)

    @pytest.mark.asyncio
    async def test_stands_on_its_own_when_the_stash_write_fails(self, stash):
        stash.store_removed = unittest.mock.AsyncMock(side_effect=RuntimeError("storage unavailable"))
        messages = _server_side_history()
        context = make_context(messages, stash=stash, utilization=0.9, model=_server_side_model())

        await self._strategy().apply(context)

        assert [message["content"] for message in messages] == [
            [{"text": "start"}],
            [_COMPACTION],
            [{"text": "latest"}],
        ]


class TestOneReferencePerPlaceholder:
    @staticmethod
    def _conversation() -> Messages:
        texts = ["q1", "a1", "q2", "a2", "q3", "a3", "q4", "a4"]
        return [
            _text_message("user" if index % 2 == 0 else "assistant", text, f"m{index}")
            for index, text in enumerate(texts)
        ]

    @pytest.mark.asyncio
    async def test_references_a_multi_item_tool_result_by_its_tool_use_id(self, stash):
        items = [{"text": "first " * 2000}, {"text": "second"}]
        tool_result = ToolResult(toolUseId="tool-1", status="success", content=items)
        messages = [Message(role="user", content=[ContentBlock(toolResult=tool_result)])]
        await _stash_all(stash, messages)

        await Offload.drop("tool_results").apply(make_context(messages, stash=stash))

        assert _tool_result_content(messages[0]) == [
            offload_placeholder("drop", "[Dropped: ~3,002 tokens]", "tool-1", 3002)
        ]
        assert (await _retrieve(stash, "tool-1", max_result_tokens=1_000_000))["content"] == items

    @pytest.mark.asyncio
    async def test_stashes_a_block_not_yet_stored_under_its_current_key(self, stash):
        messages = [make_tool_result_message("x" * 20000, "tool-1")]

        await Offload.drop("tool_results").apply(make_context(messages, stash=stash))

        assert await stash.take_snapshot() == {"tool-1_0": {"text": "x" * 20000}}

    # Truncate keeps the oldest message within its preview budget, so its elided run starts one message later.
    @pytest.mark.parametrize(
        ("method", "strategy", "first"),
        [("drop", Offload.drop("*"), 1), ("truncate", Offload.truncate("*", {"preview_tokens": 2}), 2)],
        ids=["drop", "truncate"],
    )
    @pytest.mark.asyncio
    async def test_a_message_level_marker_references_the_removed_messages(self, stash, method, strategy, first):
        messages = self._conversation()
        original = list(messages)
        context = make_context(messages, stash=stash, utilization=0.9)

        await strategy.when(context_utilization="50%").apply(context)

        # Copies and merges reuse blocks, so a message none of whose blocks are left was removed.
        kept = {id(block) for message in messages for block in message["content"]}
        removed = [message for message in original if not any(id(block) in kept for block in message["content"])]
        assert removed[0] is original[first]
        reference = f"removed-m{first}"
        tokens = await context.agent.model.count_tokens(removed)
        marker = _marker_of(messages)
        assert marker["offloaded"] == {"method": method, "ref": reference, "tokens": tokens}
        assert marker["text"].endswith(f" [ref: {reference}]")
        retrieved = await _retrieve(stash, reference, max_result_tokens=1_000_000)
        assert retrieved["content"] == flatten_messages_to_content(removed)

    @pytest.mark.asyncio
    async def test_leaves_a_message_level_marker_without_a_reference_when_the_stash_write_fails(self, stash):
        stash.store_removed = unittest.mock.AsyncMock(side_effect=RuntimeError("storage unavailable"))
        messages = self._conversation()

        await (
            Offload.drop("*")
            .when(context_utilization="50%")
            .apply(make_context(messages, stash=stash, utilization=0.9))
        )

        assert _marker_of(messages) == offload_placeholder("drop", "[Dropped: earlier messages, ~6 tokens]", None, 6)


class TestBinaryContentStashing:
    @pytest.mark.asyncio
    async def test_stashes_image_content_from_tool_results(self, stash):
        image = {"image": {"format": "png", "source": {"bytes": b"\x89PNG\r\n\x1a\n"}}}
        tool_result = ToolResult(toolUseId="tool-img", status="success", content=[image])
        messages = [Message(role="user", content=[ContentBlock(toolResult=tool_result)])]
        await _stash_all(stash, messages)

        acted = await Offload.drop("tool_results").apply(make_context(messages, stash=stash))

        assert acted is True
        assert await stash.take_snapshot() == {
            "tool-img_0": {"image": {"format": "png", "source": {"bytes": "iVBORw0KGgo="}}}
        }

    @pytest.mark.asyncio
    async def test_stashes_each_item_of_a_mixed_tool_result_under_its_own_key(self, stash):
        image = {"image": {"format": "jpeg", "source": {"bytes": b"\xff\xd8"}}}
        tool_result = ToolResult(
            toolUseId="tool-mixed", status="success", content=[{"text": "description of image"}, image]
        )
        messages = [Message(role="user", content=[ContentBlock(toolResult=tool_result)])]
        await _stash_all(stash, messages)

        await Offload.drop("tool_results").apply(make_context(messages, stash=stash))

        assert await stash.take_snapshot() == {
            "tool-mixed_0": {"text": "description of image"},
            "tool-mixed_1": {"image": {"format": "jpeg", "source": {"bytes": "/9g="}}},
        }


class TestRetrievalLoopPrevention:
    @staticmethod
    def _retrieval_exchange(text: str) -> Messages:
        tool_use = ToolUse(toolUseId="call-1", name=RETRIEVAL_TOOL_NAME, input={})
        tool_result = ToolResult(toolUseId="call-1", status="success", content=[{"text": text}])
        return [
            Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]),
            Message(role="user", content=[ContentBlock(toolResult=tool_result)]),
        ]

    @pytest.mark.asyncio
    async def test_leaves_retrieve_context_results_alone_while_the_stash_is_active(self, stash):
        retrieved = "retrieved content " * 1000
        messages = self._retrieval_exchange(retrieved)

        acted = await Offload.truncate("tool_results").apply(make_context(messages, stash=stash))

        assert acted is False
        assert _tool_result_content(messages[1]) == [{"text": retrieved}]

    @pytest.mark.asyncio
    async def test_offloads_retrieve_context_results_when_no_stash_is_configured(self):
        messages = self._retrieval_exchange("retrieved content " * 1000)

        acted = await Offload.truncate("tool_results").apply(make_context(messages))

        assert acted is True
