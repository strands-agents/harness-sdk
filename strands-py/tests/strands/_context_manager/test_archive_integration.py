"""Integration tests for the archive: what an offload strategy leaves behind, and what it retrieves."""

import asyncio
import unittest.mock

import pytest

from strands._context_manager.archive import Archive
from strands._context_manager.content_rendering import flatten_messages_to_content
from strands._context_manager.context_manager import ContextManager
from strands._context_manager.message_trimming import repair_alternation
from strands._context_manager.placeholder import is_offloaded, offload_placeholder
from strands._context_manager.retrieval_tool import RETRIEVAL_TOOL_NAME, _create_retrieval_tool
from strands._context_manager.strategies.offload import Offload
from strands.hooks.events import MessageAddedEvent
from strands.hooks.registry import HookRegistry
from strands.models._summarize import SummarizeResult
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult, ToolUse
from tests.fixtures.context_manager_helpers import heuristic_model, make_agent, make_context, make_tool_result_message


async def _archive_all(archive, messages: Messages) -> None:
    """Archive every message as the eager hook does on arrival."""
    for message in messages:
        await archive.store_message(message)


async def _retrieve(archive, reference, max_result_tokens=None, **inputs):
    tool = _create_retrieval_tool(archive, max_result_tokens)
    return await tool._tool_func({"toolUseId": "t1", "input": {"reference": reference, **inputs}})


def _text_message(role: str, text: str, tracking_id: str) -> Message:
    return Message(role=role, content=[ContentBlock(text=text)], tracking_id=tracking_id)


def _tool_result_content(message: Message) -> list:
    return message["content"][0]["toolResult"]["content"]


def _marker_of(messages: Messages) -> ContentBlock:
    return next(block for message in messages for block in message["content"] if is_offloaded(block))


def _reference_of(messages: Messages) -> str:
    """The reference that placeholder carries, which is fresh for every removal."""
    reference = _marker_of(messages)["offloaded"]["ref"]
    assert reference.startswith("removed-")
    return reference


class TestContextManagerToolRegistration:
    def test_provides_retrieve_context_once_the_agent_is_initialized(self, storage):
        manager = ContextManager()
        agent = make_agent()
        agent.storage = storage

        manager.init_agent(agent)

        assert [tool.tool_name for tool in manager.tools] == [RETRIEVAL_TOOL_NAME]

    def test_provides_no_retrieval_tool_when_the_archive_is_disabled(self, storage):
        manager = ContextManager(archive=False)
        agent = make_agent()
        agent.storage = storage

        manager.init_agent(agent)

        assert manager.archive is None
        assert manager.tools == []


class TestTruncateWithArchive:
    @pytest.mark.asyncio
    async def test_resolves_the_reference_of_a_block_a_history_edit_moved_into_another_message(self, archive):
        big = "x" * 20000
        messages = [
            _text_message("user", "q", "u0"),
            _text_message("assistant", "short", "a1"),
            _text_message("assistant", big, "a2"),
        ]
        await _archive_all(archive, messages)
        # Merges a2 into a1: the big block is now a1_1, while it was stored on arrival as a2_0.
        repair_alternation(messages)

        await Offload.truncate("assistant_text", {"preview_tokens": 10}).apply(make_context(messages, archive=archive))

        placeholder = messages[1]["content"][1]
        assert placeholder["offloaded"]["ref"] == "a1_1"
        assert (await _retrieve(archive, "a1_1"))["content"] == [{"text": big}]

    @pytest.mark.asyncio
    async def test_persists_original_content_before_truncating(self, archive):
        large_text = "important data " * 1000
        messages = [make_tool_result_message(large_text)]
        await _archive_all(archive, messages)

        acted = await Offload.truncate("tool_results").apply(make_context(messages, archive=archive))

        assert acted is True
        assert await archive.take_snapshot() == {"tool-123_0": {"text": large_text}}

    @pytest.mark.asyncio
    async def test_leaves_a_placeholder_referencing_the_tool_result_in_the_preview(self, archive):
        messages = [make_tool_result_message("x" * 20000)]
        await _archive_all(archive, messages)

        await Offload.truncate("tool_results").apply(make_context(messages, archive=archive))

        placeholder = _tool_result_content(messages[0])[0]
        assert placeholder["offloaded"] == {"method": "truncate", "ref": "tool-123", "tokens": 5000}
        assert placeholder["text"].endswith(" [ref: tool-123]")

    @pytest.mark.asyncio
    async def test_never_stores_a_seeded_placeholder_under_the_original_key(self, archive):
        seeded = offload_placeholder("truncate", "[Truncated: 1 block, ~7,500 tokens] preview", "tool-123")
        tool_result = ToolResult(toolUseId="tool-123", status="success", content=[seeded])
        messages = [Message(role="user", content=[ContentBlock(toolResult=tool_result)])]
        await _archive_all(archive, messages)

        await Offload.drop("tool_results").apply(make_context(messages, archive=archive))

        assert _tool_result_content(messages[0]) == [
            offload_placeholder("drop", "[Dropped: ~15 tokens]", "tool-123", 15)
        ]
        assert await archive.list() == []
        unresolvable = 'Error: reference not found: tool-123. Pass only the <id> from the placeholder\'s "[ref: <id>]".'
        assert (await _retrieve(archive, "tool-123"))["content"] == [{"text": unresolvable}]

    @pytest.mark.asyncio
    async def test_lets_a_later_strategy_act_on_an_already_truncated_result(self, archive):
        original = "x" * 20000
        messages = [make_tool_result_message(original)]
        await _archive_all(archive, messages)
        context = make_context(messages, archive=archive)
        await Offload.truncate("tool_results", {"preview_tokens": 10}).apply(context)

        acted_again = await Offload.drop("tool_results").apply(context)

        assert acted_again is True
        # The preview is ~32 tokens, so the marker reports the 5,000 the truncate placeholder stood for as well.
        assert _tool_result_content(messages[0]) == [
            offload_placeholder("drop", "[Dropped: ~5,032 tokens]", "tool-123", 5032)
        ]
        assert (await _retrieve(archive, "tool-123"))["content"] == [{"text": original}]

    @pytest.mark.asyncio
    async def test_leaves_a_placeholder_without_a_reference_when_no_archive_is_configured(self):
        messages = [make_tool_result_message("x" * 20000)]

        await Offload.truncate("tool_results").apply(make_context(messages))

        placeholder = _tool_result_content(messages[0])[0]
        assert placeholder["offloaded"] == {"method": "truncate", "tokens": 5000}
        assert "[ref:" not in placeholder["text"]


class TestDropWithArchive:
    @pytest.mark.asyncio
    async def test_persists_original_content_before_dropping(self, archive):
        large_text = "critical information " * 500
        messages = [make_tool_result_message(large_text)]
        await _archive_all(archive, messages)

        acted = await Offload.drop("tool_results").apply(make_context(messages, archive=archive))

        assert acted is True
        assert await archive.take_snapshot() == {"tool-123_0": {"text": large_text}}

    @pytest.mark.asyncio
    async def test_leaves_a_placeholder_referencing_the_tool_result_as_the_drop_marker(self, archive):
        messages = [make_tool_result_message("x" * 20000)]
        await _archive_all(archive, messages)

        await Offload.drop("tool_results").apply(make_context(messages, archive=archive))

        assert _tool_result_content(messages[0]) == [
            offload_placeholder("drop", "[Dropped: ~5,000 tokens]", "tool-123", 5000)
        ]

    @pytest.mark.asyncio
    async def test_marks_removed_messages_with_a_placeholder_that_retrieves_them(self, archive):
        first = _text_message("assistant", "first answer", "m1")
        second = _text_message("user", "second question", "m2")
        messages = [_text_message("user", "start", "m0"), first, second, _text_message("assistant", "final", "m3")]
        await _archive_all(archive, messages)
        strategy = Offload.drop("*").when(context_utilization="50%")

        acted = await strategy.apply(make_context(messages, archive=archive, utilization=0.9))

        assert acted is True
        reference = _reference_of(messages)
        marker = offload_placeholder("drop", "[Dropped: earlier messages, ~7 tokens]", reference, 7)
        assert [message["content"] for message in messages] == [
            [{"text": "start"}],
            [{"text": "final"}, marker],
        ]
        assert (await _retrieve(archive, reference))["content"] == [
            {"text": "\n---\n[assistant]"},
            {"text": "first answer"},
            {"text": "\n---\n[user]"},
            {"text": "second question"},
        ]
        searched = await _retrieve(archive, reference, pattern="second")
        assert "second question" in searched["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_leaves_a_marker_without_a_reference_when_there_is_no_archive(self):
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
    model = heuristic_model(summarize=unittest.mock.AsyncMock(return_value=SummarizeResult(content=[_COMPACTION])))
    model.model_info.capabilities.server_side_summary = True
    return model


class TestServerSideSummaryWithArchive:
    def _strategy(self):
        return Offload.summarize("*").when(context_utilization="50%", preserve_recent=1)

    @pytest.mark.asyncio
    async def test_leaves_a_placeholder_that_retrieves_every_message_it_stands_for(self, archive):
        messages = _server_side_history()
        # Message 0 stays in the array but a compaction block stops it being sent, so the summary stands for it too.
        covered = messages[:4]
        await _archive_all(archive, messages)
        context = make_context(messages, archive=archive, utilization=0.9, model=_server_side_model())

        acted = await self._strategy().apply(context)

        assert acted is True
        reference = _reference_of(messages)
        # The placeholder follows the summary: a provider sending it as a compaction block rejects content before one.
        assert [message["content"] for message in messages] == [
            [{"text": "start"}],
            [
                _COMPACTION,
                offload_placeholder("summarize", "[Summarized: earlier messages, ~11 tokens]", reference, 11),
            ],
            [{"text": "latest"}],
        ]
        assert (await _retrieve(archive, reference))["content"] == flatten_messages_to_content(covered)

    @pytest.mark.asyncio
    async def test_stands_on_its_own_when_the_archive_write_fails(self, archive):
        archive.store_removed = unittest.mock.AsyncMock(side_effect=RuntimeError("storage unavailable"))
        messages = _server_side_history()
        context = make_context(messages, archive=archive, utilization=0.9, model=_server_side_model())

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
    async def test_references_a_multi_item_tool_result_by_its_tool_use_id(self, archive):
        items = [{"text": "first " * 2000}, {"text": "second"}]
        tool_result = ToolResult(toolUseId="tool-1", status="success", content=items)
        messages = [Message(role="user", content=[ContentBlock(toolResult=tool_result)])]
        await _archive_all(archive, messages)

        await Offload.drop("tool_results").apply(make_context(messages, archive=archive))

        assert _tool_result_content(messages[0]) == [
            offload_placeholder("drop", "[Dropped: ~3,002 tokens]", "tool-1", 3002)
        ]
        assert (await _retrieve(archive, "tool-1", max_result_tokens=1_000_000))["content"] == items

    @pytest.mark.asyncio
    async def test_archives_a_block_not_yet_stored_under_its_current_key(self, archive):
        messages = [make_tool_result_message("x" * 20000, "tool-1")]

        await Offload.drop("tool_results").apply(make_context(messages, archive=archive))

        assert await archive.take_snapshot() == {"tool-1_0": {"text": "x" * 20000}}

    # Truncate keeps the oldest message within its preview budget, so its elided run starts one message later.
    @pytest.mark.parametrize(
        ("method", "strategy", "first"),
        [("drop", Offload.drop("*"), 1), ("truncate", Offload.truncate("*", {"preview_tokens": 2}), 2)],
        ids=["drop", "truncate"],
    )
    @pytest.mark.asyncio
    async def test_a_message_level_marker_references_the_removed_messages(self, archive, method, strategy, first):
        messages = self._conversation()
        original = list(messages)
        context = make_context(messages, archive=archive, utilization=0.9)

        await strategy.when(context_utilization="50%").apply(context)

        # Copies and merges reuse blocks, so a message none of whose blocks are left was removed.
        kept = {id(block) for message in messages for block in message["content"]}
        removed = [message for message in original if not any(id(block) in kept for block in message["content"])]
        assert removed[0] is original[first]
        reference = _reference_of(messages)
        tokens = await context.agent.model.count_tokens(removed)
        marker = _marker_of(messages)
        assert marker["offloaded"] == {"method": method, "ref": reference, "tokens": tokens}
        assert marker["text"].endswith(f" [ref: {reference}]")
        retrieved = await _retrieve(archive, reference, max_result_tokens=1_000_000)
        assert retrieved["content"] == flatten_messages_to_content(removed)

    @pytest.mark.asyncio
    async def test_leaves_a_message_level_marker_without_a_reference_when_the_archive_write_fails(self, archive):
        archive.store_removed = unittest.mock.AsyncMock(side_effect=RuntimeError("storage unavailable"))
        messages = self._conversation()

        await (
            Offload.drop("*")
            .when(context_utilization="50%")
            .apply(make_context(messages, archive=archive, utilization=0.9))
        )

        assert _marker_of(messages) == offload_placeholder("drop", "[Dropped: earlier messages, ~6 tokens]", None, 6)


class TestBinaryContentArchiving:
    @pytest.mark.asyncio
    async def test_archives_image_content_from_tool_results(self, archive):
        image = {"image": {"format": "png", "source": {"bytes": b"\x89PNG\r\n\x1a\n"}}}
        tool_result = ToolResult(toolUseId="tool-img", status="success", content=[image])
        messages = [Message(role="user", content=[ContentBlock(toolResult=tool_result)])]
        await _archive_all(archive, messages)

        acted = await Offload.drop("tool_results").apply(make_context(messages, archive=archive))

        assert acted is True
        assert await archive.take_snapshot() == {
            "tool-img_0": {"image": {"format": "png", "source": {"bytes": "iVBORw0KGgo="}}}
        }

    @pytest.mark.asyncio
    async def test_archives_each_item_of_a_mixed_tool_result_under_its_own_key(self, archive):
        image = {"image": {"format": "jpeg", "source": {"bytes": b"\xff\xd8"}}}
        tool_result = ToolResult(
            toolUseId="tool-mixed", status="success", content=[{"text": "description of image"}, image]
        )
        messages = [Message(role="user", content=[ContentBlock(toolResult=tool_result)])]
        await _archive_all(archive, messages)

        await Offload.drop("tool_results").apply(make_context(messages, archive=archive))

        assert await archive.take_snapshot() == {
            "tool-mixed_0": {"text": "description of image"},
            "tool-mixed_1": {"image": {"format": "jpeg", "source": {"bytes": "/9g="}}},
        }


class TestWhatAStrategyWritesToTheArchive:
    """Tests that a block reaches the archive exactly when it is replaced, and in the archive of its own agent."""

    @staticmethod
    def _attach(strategy, storage, agent_id: str):
        """An agent of its own with one oversized tool result, with ``strategy`` attached to its own archive."""
        archive = Archive(storage, "test-session", agent_id)
        agent = make_agent([make_tool_result_message("x" * 20000, f"tu-{agent_id}")])
        agent.hooks = HookRegistry()
        strategy.init(agent, archive)
        return agent, archive

    @staticmethod
    async def _fire(agent) -> None:
        callback = agent.hooks._registered_callbacks[MessageAddedEvent][0].callback
        await callback(MessageAddedEvent(agent=agent, message=agent.messages[0]))

    @pytest.mark.asyncio
    async def test_the_eager_hook_writes_to_the_archive_of_the_agent_it_fired_for(self, storage):
        # The agent attached first, so the one a strategy holding a single archive would no longer be writing to.
        strategy = Offload.drop("tool_results").when(block_threshold=100)
        first, first_archive = self._attach(strategy, storage, "first")
        _, second_archive = self._attach(strategy, storage, "second")

        await self._fire(first)

        assert await first_archive.take_snapshot() == {"tu-first_0": {"text": "x" * 20000}}
        assert await second_archive.take_snapshot() == {}

    @pytest.mark.asyncio
    async def test_a_pass_for_another_agent_does_not_move_where_the_eager_hook_writes(self, storage):
        strategy = Offload.drop("tool_results").when(block_threshold=100)
        first, first_archive = self._attach(strategy, storage, "first")
        other_archive = Archive(storage, "test-session", "other")
        other_messages = [make_tool_result_message("y" * 20000, "tu-other")]
        await strategy.apply(make_context(other_messages, archive=other_archive))

        await self._fire(first)

        assert await first_archive.take_snapshot() == {"tu-first_0": {"text": "x" * 20000}}
        assert await other_archive.list() == ["tu-other_0"]

    @pytest.mark.asyncio
    async def test_never_writes_a_block_the_strategy_leaves_in_place(self, archive):
        messages = [make_tool_result_message("already short")]

        acted = await Offload.truncate("tool_results", {"preview_tokens": 1000}).apply(
            make_context(messages, archive=archive)
        )

        assert acted is False
        assert await archive.list() == []

    @pytest.mark.asyncio
    async def test_keeps_a_run_in_the_history_when_the_archive_write_is_cancelled(self, archive):
        archive.store_removed = unittest.mock.AsyncMock(side_effect=asyncio.CancelledError)
        messages = [
            _text_message("user" if index % 2 == 0 else "assistant", f"m{index}", f"m{index}") for index in range(6)
        ]
        original = list(messages)

        with pytest.raises(asyncio.CancelledError):
            await (
                Offload.drop("*")
                .when(context_utilization="50%")
                .apply(make_context(messages, archive=archive, utilization=0.9))
            )

        assert messages == original


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
    async def test_leaves_retrieve_context_results_alone_while_the_archive_is_active(self, archive):
        retrieved = "retrieved content " * 1000
        messages = self._retrieval_exchange(retrieved)

        acted = await Offload.truncate("tool_results").apply(make_context(messages, archive=archive))

        assert acted is False
        assert _tool_result_content(messages[1]) == [{"text": retrieved}]

    @pytest.mark.asyncio
    async def test_offloads_retrieve_context_results_when_no_archive_is_configured(self):
        messages = self._retrieval_exchange("retrieved content " * 1000)

        acted = await Offload.truncate("tool_results").apply(make_context(messages))

        assert acted is True
