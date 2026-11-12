"""Tests for the offload strategies: what a target acts on, when conditions fire, and the markers left behind."""

import copy
import logging
import math
import re
import unittest.mock

import pytest

from strands._context_manager.message_trimming import collect_removable_with_pair, insert_marker, repair_alternation
from strands._context_manager.placeholder import (
    format_dropped,
    format_dropped_messages,
    format_elided,
    offload_placeholder,
)
from strands._context_manager.strategies.offload import EmergencyTruncateStrategy, Offload
from strands._context_manager.strategies.offload.conditions import ParsedCondition, ResolvedConditions, parse_condition
from strands._context_manager.strategies.offload.target import OffloadTargetMatcher
from strands.hooks.events import MessageAddedEvent
from strands.hooks.registry import HookRegistry
from strands.models._defaults import DEFAULT_CONTEXT_WINDOW_LIMIT
from strands.models._summarize import SummarizeResult
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult, ToolUse
from tests.fixtures.context_manager_helpers import (
    heuristic_count_tokens,
    heuristic_model,
    make_agent,
    make_context,
    make_tool_result_message,
    offloaded_by,
    placeholders_in,
)

_SUMMARIZE = unittest.mock.AsyncMock(return_value=SummarizeResult(content=[ContentBlock(summary={"text": "summary"})]))
"""The summarizer every context's model shares, so a pass can assert no summary was requested."""


def _context(messages, utilization=0.5, overflow=False, context_window_limit=DEFAULT_CONTEXT_WINDOW_LIMIT):
    """A context whose model shares :data:`_SUMMARIZE` and reports ``context_window_limit`` as its window."""
    model = heuristic_model(summarize=_SUMMARIZE, context_window_limit=context_window_limit)
    return make_context(messages, utilization=utilization, overflow=overflow, model=model)


def _text(role: str, value: str) -> Message:
    return Message(role=role, content=[ContentBlock(text=value)])


def _texts_of(messages: Messages) -> list[list[str]]:
    """The text of every block of every message, message by message."""
    return [[block["text"] for block in message["content"]] for message in messages]


def _conversation(turns: int) -> Messages:
    """``turns`` alternating user/assistant messages, each holding its own number."""
    return [
        message
        for index in range(1, turns + 1)
        for message in (_text("user", f"q{index}"), _text("assistant", f"a{index}"))
    ]


def _tool_call(name: str, tool_use_id: str, text: str) -> Messages:
    """A tool use of ``name`` and the result that answers it."""
    tool_use = ToolUse(toolUseId=tool_use_id, name=name, input={})
    return [
        Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]),
        make_tool_result_message(text, tool_use_id),
    ]


def _tool_history(tokens: list[int]) -> Messages:
    """A task message followed by one tool call per result, each result ``tokens[i]`` tokens long."""
    calls = [
        message for index, size in enumerate(tokens) for message in _tool_call("read", f"tu-{index}", "x" * (size * 4))
    ]
    return [_text("user", "task"), *calls, _text("assistant", "done")]


def _result_items(messages: Messages) -> list[dict]:
    """The first item of every tool result in ``messages``."""
    return [
        block["toolResult"]["content"][0]
        for message in messages
        for block in message["content"]
        if "toolResult" in block
    ]


def _result_texts(messages: Messages) -> list[str]:
    return [item["text"] for item in _result_items(messages)]


def _result_methods(messages: Messages) -> list[str | None]:
    return [offloaded_by(item) for item in _result_items(messages)]


LARGE = "x" * (2500 * 4 + 100)
"""Text of 2,525 tokens under the heuristic count, above a 2,500-token threshold."""


class TestOffloadTruncate:
    """Tests for the preview ``Offload.truncate`` leaves, and what each target covers."""

    def test_rejects_a_token_threshold_that_the_preview_cannot_shrink_past(self):
        with pytest.raises(ValueError, match=r"block_threshold \(500\) must be greater than preview_tokens \(500\)"):
            Offload.truncate("tool_results", {"preview_tokens": 500}).when(block_threshold=500)

    @pytest.mark.parametrize(("context_window_limit", "block_threshold"), [(10_000, "5%"), (None, "0.25%")])
    def test_rejects_on_init_a_percent_threshold_that_the_preview_cannot_shrink_past(
        self, context_window_limit, block_threshold
    ):
        strategy = Offload.truncate("tool_results", {"preview_tokens": 500}).when(block_threshold=block_threshold)
        agent = _context([], context_window_limit=context_window_limit).agent

        with pytest.raises(
            ValueError,
            match=r"block_threshold \(500 tokens of the context window\) must be greater than preview_tokens \(500\)",
        ):
            strategy.init(agent)

    def test_accepts_on_init_a_percent_threshold_above_the_preview(self):
        strategy = Offload.truncate("tool_results", {"preview_tokens": 500}).when(block_threshold="6%")

        strategy.init(_context([], context_window_limit=10_000).agent)

    @pytest.mark.asyncio
    async def test_truncates_a_tool_result_larger_than_the_preview(self):
        messages = [make_tool_result_message(LARGE)]

        assert await Offload.truncate("tool_results").when().apply(_context(messages)) is True

        assert _result_methods(messages) == ["truncate"]

    @pytest.mark.asyncio
    async def test_leaves_a_tool_result_below_the_threshold_alone(self):
        messages = [make_tool_result_message("short result")]

        assert await Offload.truncate("tool_results").when(block_threshold=2500).apply(_context(messages)) is False

    @pytest.mark.parametrize(("target", "acted"), [("tool_results", False), ("tool_result_errors", True)])
    @pytest.mark.asyncio
    async def test_acts_on_an_error_result_only_for_the_error_target(self, target, acted):
        tool_result = ToolResult(toolUseId="tool-err", status="error", content=[{"text": LARGE}])
        messages = [Message(role="user", content=[ContentBlock(toolResult=tool_result)])]

        assert await Offload.truncate(target).when().apply(_context(messages)) is acted

    @pytest.mark.parametrize(("role", "target"), [("assistant", "tool_results"), ("user", "assistant_text")])
    @pytest.mark.asyncio
    async def test_leaves_text_its_target_does_not_cover_alone(self, role, target):
        messages = [Message(role=role, content=[ContentBlock(text=LARGE)])]

        assert await Offload.truncate(target).when().apply(_context(messages)) is False

    @pytest.mark.asyncio
    async def test_keeps_the_head_and_the_tail_of_what_it_previews(self):
        messages = [make_tool_result_message("HEAD" * 1000 + "MIDDLE" * 5000 + "TAIL" * 1000)]

        await Offload.truncate("tool_results", {"preview_tokens": 100}).when().apply(_context(messages))

        preview = _result_texts(messages)[0]
        assert preview.startswith("[Truncated: 1 block")
        assert "HEAD" in preview
        assert "TAIL" in preview
        assert "MIDDLE" not in preview

    @pytest.mark.asyncio
    async def test_groups_the_thousands_of_the_counts_it_reports(self):
        messages = [make_tool_result_message("x" * 1_000_000)]

        await Offload.truncate("tool_results", {"preview_tokens": 100}).when().apply(_context(messages))

        preview = _result_texts(messages)[0]
        assert "~250,000 tokens]" in preview
        assert "[... 999,600 chars elided ...]" in preview

    @pytest.mark.asyncio
    async def test_returns_false_for_an_empty_history(self):
        assert await Offload.truncate("tool_results").when().apply(_context([])) is False


class TestOffloadBuilder:
    """Tests for what ``Offload.drop``, ``Offload.truncate``, and ``Offload.summarize`` build."""

    @pytest.mark.asyncio
    async def test_drop_replaces_a_tool_result_with_a_marker_naming_its_size(self):
        messages = [make_tool_result_message("x" * 100)]

        assert await Offload.drop("tool_results").when().apply(_context(messages)) is True

        assert _result_texts(messages) == ["[Dropped: ~25 tokens]"]

    @pytest.mark.parametrize(("tool_name", "acted"), [("bash", True), ("read_file", False)])
    @pytest.mark.asyncio
    async def test_matches_a_tool_result_by_the_name_of_the_tool_use_that_asked_for_it(self, tool_name, acted):
        messages = _tool_call(tool_name, "tu-1", LARGE)

        assert await Offload.truncate(["tool::bash"]).when().apply(_context(messages)) is acted

    @pytest.mark.parametrize(
        ("method", "build"),
        [
            ("drop", lambda: Offload.drop("tool_results")),
            ("truncate", lambda: Offload.truncate("tool_results", {"preview_tokens": 500})),
            ("summarize", lambda: Offload.summarize("tool_results")),
        ],
    )
    def test_registers_one_eager_hook_for_a_strategy_without_conditions(self, method, build):
        strategy = build()
        agent = make_agent()
        agent.hooks = HookRegistry()

        strategy.init(agent)

        assert strategy.name == f"offload:{method}"
        assert len(agent.hooks._registered_callbacks.get(MessageAddedEvent, [])) == 1

    @pytest.mark.asyncio
    async def test_when_replaces_the_conditions_and_keeps_the_target_and_config(self):
        messages = _tool_history([500, 500, 500])
        bare = Offload.truncate("tool_results", {"preview_tokens": 100})

        acted = await bare.when(block_threshold=2000).when(preserve_recent=1).apply(_context(messages))

        assert acted is True
        assert _result_methods(messages) == ["truncate", "truncate", None]

    @pytest.mark.parametrize("target", ["*", "media"])
    def test_rejects_on_init_a_target_that_needs_conditions(self, target):
        strategy = Offload.drop(target)

        with pytest.raises(ValueError, match=re.escape("use .when() to set")):
            strategy.init(make_agent())

    @pytest.mark.parametrize("method", ["drop", "truncate", "summarize"])
    def test_rejects_an_empty_list_target(self, method):
        with pytest.raises(ValueError, match="Empty array target matches nothing"):
            getattr(Offload, method)([])


class TestMessageLevelWithRoleAlternation:
    """Tests for the history a message-level pass leaves behind."""

    @pytest.mark.parametrize(("target", "role"), [("assistant_text", "assistant"), ("user_text", "user")])
    @pytest.mark.asyncio
    async def test_replaces_the_text_of_every_message_of_the_role_between_the_first_and_the_last(self, target, role):
        messages = _conversation(4)

        assert await Offload.drop(target).when(context_utilization="50%").apply(_context(messages, 0.9)) is True

        assert len(messages) == 8
        for index, message in enumerate(messages):
            dropped = message["role"] == role and 0 < index < len(messages) - 1
            assert offloaded_by(message["content"][0]) == ("drop" if dropped else None)

    @pytest.mark.asyncio
    async def test_repairs_alternation_after_removing_messages(self):
        messages = _conversation(4)

        await Offload.drop("*").when(context_utilization="50%").apply(_context(messages, 0.9))

        assert all(left["role"] != right["role"] for left, right in zip(messages, messages[1:], strict=False))

    @pytest.mark.asyncio
    async def test_leaves_no_tool_result_without_the_tool_use_that_asked_for_it(self):
        messages = [_text("user", "q1"), *_tool_call("bash", "tu-1", "result"), *_conversation(3)[1:]]

        await Offload.drop("*").when(context_utilization="50%", preserve_recent=4).apply(_context(messages, 0.9))

        assert all(left["role"] != right["role"] for left, right in zip(messages, messages[1:], strict=False))
        tool_use_ids = {
            block["toolUse"]["toolUseId"] for message in messages for block in message["content"] if "toolUse" in block
        }
        result_ids = {
            block["toolResult"]["toolUseId"]
            for message in messages
            for block in message["content"]
            if "toolResult" in block
        }
        assert result_ids <= tool_use_ids

    @pytest.mark.asyncio
    async def test_keeps_a_tool_use_whose_result_preserve_recent_protects(self):
        tool_use, tool_result = _tool_call("bash", "tu-1", "result")
        q1, a1, q2, a3 = _text("user", "q1"), _text("assistant", "a1"), _text("user", "q2"), _text("assistant", "a3")
        messages = [q1, a1, q2, tool_use, tool_result, a3]
        context = _context(messages)
        removed_tokens = await context.agent.model.count_tokens([a1, q2])

        assert await Offload.drop("*").when(preserve_recent=2).apply(context) is True

        marker = offload_placeholder("drop", format_dropped_messages(removed_tokens), None, removed_tokens)
        assert messages == [q1, {**tool_use, "content": [*tool_use["content"], marker]}, tool_result, a3]
        assert messages[2] is tool_result

    @pytest.mark.asyncio
    async def test_acts_when_only_message_0_precedes_the_candidates(self):
        messages = _conversation(2)

        assert await Offload.drop("*").when(context_utilization="50%").apply(_context(messages, 0.9)) is True

        assert _texts_of(messages) == [["q1"], ["a2", "[Dropped: earlier messages, ~2 tokens]"]]

    @pytest.mark.asyncio
    async def test_leaves_a_history_that_still_starts_with_a_user_message(self):
        messages = _conversation(3)

        await Offload.drop("*").when(context_utilization="50%").apply(_context(messages, 0.9))

        assert messages[0]["role"] == "user"


class TestWildcardWithABlockThreshold:
    """Tests for ``Offload.<method>("*")`` with a block threshold, which acts on messages larger than it."""

    @staticmethod
    def _history() -> Messages:
        return [
            _text("user", "task"),
            _text("assistant", LARGE),
            _text("user", "small question"),
            _text("assistant", LARGE),
            _text("user", "next"),
        ]

    @pytest.mark.parametrize("method", ["drop", "summarize"])
    @pytest.mark.asyncio
    async def test_acts_on_large_messages_and_keeps_small_ones(self, method):
        messages = self._history()

        acted = await getattr(Offload, method)("*").when(block_threshold=2500).apply(_context(messages))

        assert acted is True
        texts = [text for texts in _texts_of(messages) for text in texts]
        assert LARGE not in texts
        assert "small question" in texts
        assert "next" in texts

    @pytest.mark.asyncio
    async def test_leaves_one_marker_for_each_run_of_removed_messages(self):
        messages = self._history()

        assert await Offload.drop("*").when(block_threshold=2500).apply(_context(messages)) is True

        assert _texts_of(messages) == [
            ["task"],
            [format_dropped_messages(2525)],
            ["small question"],
            [format_dropped_messages(2525)],
            ["next"],
        ]
        assert placeholders_in(messages) == [{"method": "drop", "tokens": 2525}, {"method": "drop", "tokens": 2525}]

    @pytest.mark.parametrize("block_threshold", [2500, "5%"])
    def test_truncate_rejects_a_block_threshold(self, block_threshold):
        with pytest.raises(ValueError, match=r"Offload.truncate\(\"\*\"\) doesn't take a block_threshold"):
            Offload.truncate("*").when(block_threshold=block_threshold)

    @pytest.mark.asyncio
    async def test_leaves_injected_text_in_place(self):
        injected = ContentBlock(injected={"text": LARGE, "source": "strands:memory-manager"})
        message = Message(role="user", content=[ContentBlock(text="ask"), injected])
        strategy = Offload.truncate("user_text", {"preview_tokens": 50}).when(block_threshold=100)

        assert await strategy.apply(_context([message])) is False

        assert message["content"] == [ContentBlock(text="ask"), injected]


_IMAGE = ContentBlock(image={"format": "png", "source": {"bytes": bytes(4000)}})
"""An image the heuristic count sizes by its JSON."""

_IMAGE_TOKENS = heuristic_count_tokens([Message(role="user", content=[_IMAGE])])


def _with_image() -> Message:
    """A user message holding text, an image, and a tool result."""
    tool_result = ToolResult(toolUseId="tool-1", status="success", content=[{"text": "x" * 4000}])
    return Message(
        role="user",
        content=[ContentBlock(text="look at this"), _IMAGE, ContentBlock(toolResult=tool_result)],
    )


class TestMediaTarget:
    """Tests for the ``"media"`` target, which acts on images and documents wherever they sit."""

    @pytest.mark.asyncio
    async def test_drops_the_media_and_leaves_text_and_tool_results_alone(self):
        message = _with_image()
        messages = [_text("user", "task"), message, _text("assistant", "answer")]
        strategy = Offload.drop("media").when(context_utilization="50%", block_threshold=10)

        assert await strategy.apply(_context(messages)) is True

        assert message["content"] == [
            ContentBlock(text="look at this"),
            offload_placeholder("drop", format_dropped(_IMAGE_TOKENS, "image"), None, _IMAGE_TOKENS),
            _with_image()["content"][2],
        ]

    @pytest.mark.asyncio
    async def test_counts_only_the_messages_holding_media_as_recent(self):
        older, newer = _with_image(), _with_image()
        messages = [_text("user", "task"), older, _text("assistant", "a"), newer, _text("assistant", "b")]

        await Offload.drop("media").when(preserve_recent=1).apply(_context(messages))

        assert offloaded_by(older["content"][1]) == "drop"
        assert newer["content"][1] == _IMAGE


async def _count_text_only(messages: Messages) -> int:
    """Count text at four characters per token, as a model that cannot size media does."""
    items = [
        item
        for message in messages
        for block in message["content"]
        for item in (block["toolResult"]["content"] if "toolResult" in block else [block])
    ]
    return sum(math.ceil(len(item["text"]) / 4) for item in items if "text" in item)


def _media_blind_context(messages: Messages):
    """A context whose model counts media as no tokens at all."""
    model = heuristic_model(count_tokens=unittest.mock.AsyncMock(side_effect=_count_text_only))
    return make_context(messages, model=model)


class TestMediaThatCountsAsNoTokens:
    """Tests for media a model's count sizes at 0, which a block threshold would otherwise keep forever."""

    @pytest.mark.parametrize(
        "conditions", [{"context_utilization": "50%"}, {"context_utilization": "50%", "block_threshold": 1000}]
    )
    @pytest.mark.asyncio
    async def test_drops_the_media(self, conditions):
        message = _with_image()
        messages = [_text("user", "task"), message, _text("assistant", "answer")]

        assert await Offload.drop("media").when(**conditions).apply(_media_blind_context(messages)) is True

        assert message["content"] == [
            ContentBlock(text="look at this"),
            offload_placeholder("drop", "[Dropped: image, removed from context after it was received]", None),
            _with_image()["content"][2],
        ]

    @pytest.mark.asyncio
    async def test_drops_a_tool_result_that_holds_only_media(self):
        tool_result = ToolResult(toolUseId="tu-1", status="success", content=[_IMAGE])
        held = Message(role="user", content=[ContentBlock(toolResult=tool_result)])
        messages = [_text("assistant", "task"), held, _text("assistant", "answer")]
        strategy = Offload.drop("tool_results").when(context_utilization="50%", block_threshold=1000)

        assert await strategy.apply(_media_blind_context(messages)) is True

        assert placeholders_in(messages) == [{"method": "drop"}]

    @pytest.mark.asyncio
    async def test_offloads_the_media_without_a_size_it_cannot_report(self):
        message = _with_image()
        messages = [_text("user", "task"), message, _text("assistant", "answer")]

        acted = await Offload.truncate("media").when(context_utilization="50%").apply(_media_blind_context(messages))

        assert acted is True
        assert message["content"][1] == offload_placeholder(
            "truncate", "[Offloaded: image, removed from context after it was received]", None
        )


class TestWithoutAThreshold:
    @pytest.mark.asyncio
    async def test_skips_empty_text_blocks(self):
        message = Message(role="assistant", content=[ContentBlock(text=""), ContentBlock(text="  \n")])

        assert await Offload.drop("assistant_text").when().apply(_context([message])) is False

        assert message["content"] == [ContentBlock(text=""), ContentBlock(text="  \n")]


def _pinned(role: str, text: str) -> Message:
    return Message(role=role, content=[ContentBlock(text=text)], metadata={"custom": {"pinned": True}})


def _all_text(messages: Messages) -> list[str]:
    return [block["text"] for message in messages for block in message["content"] if "text" in block]


class TestPinnedMessageProtection:
    """Tests for the messages a pin keeps in the history."""

    @pytest.mark.asyncio
    async def test_keeps_a_pinned_message(self):
        messages = [
            _text("user", "q1"),
            _text("assistant", "a1"),
            _pinned("user", "pinned-msg"),
            _text("assistant", "a2"),
            _text("user", "q3"),
            _text("assistant", "a3"),
        ]

        await Offload.drop("*").when(context_utilization="50%").apply(_context(messages, 0.9))

        assert "pinned-msg" in _all_text(messages)

    @pytest.mark.asyncio
    async def test_keeps_the_tool_result_of_a_pinned_tool_use(self):
        tool_use, tool_result = _tool_call("test", "tu-1", "result")
        tool_use["metadata"] = {"custom": {"pinned": True}}
        messages = [
            _text("user", "q1"),
            tool_use,
            tool_result,
            _text("assistant", "a2"),
            _text("user", "q3"),
            _text("assistant", "a3"),
        ]

        await Offload.drop("*").when(context_utilization="50%").apply(_context(messages, 0.9))

        assert tool_result in messages

    @pytest.mark.asyncio
    async def test_keeps_a_pinned_message_that_a_repaired_alternation_merges(self):
        # Pass 1 leaves the pin adjacent to a later assistant message, so pass 2 merges the two.
        messages = [
            _text("user", "q1"),
            _text("assistant", "a1"),
            _text("user", "q2"),
            _pinned("assistant", "pinned-a3"),
            _text("user", "q4"),
            _text("assistant", "a5"),
            _text("user", "q6"),
            _text("assistant", "a7"),
            _text("user", "q8"),
            _text("assistant", "a9"),
            _text("user", "q10"),
        ]
        strategy = Offload.drop("*").when(context_utilization="50%", preserve_recent=4)

        await strategy.apply(_context(messages, 0.9))
        await strategy.apply(_context(messages, 0.9))

        merged = next(message for message in messages if "pinned-a3" in _all_text([message]))
        assert merged["metadata"]["custom"]["pinned"] is True

    def test_repair_alternation_merges_metadata_the_later_message_winning(self):
        earlier_usage = {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}
        later_usage = {"inputTokens": 5, "outputTokens": 5, "totalTokens": 10}
        messages = [
            _text("user", "q1"),
            Message(
                role="assistant",
                content=[ContentBlock(text="a1")],
                tracking_id="a1",
                metadata={"usage": earlier_usage, "custom": {"pinned": True, "source": "a1"}},
            ),
            Message(
                role="assistant",
                content=[ContentBlock(text="a2")],
                metadata={"usage": later_usage, "custom": {"source": "a2", "tag": "x"}},
            ),
        ]

        repair_alternation(messages)

        assert messages[1] == Message(
            role="assistant",
            content=[ContentBlock(text="a1"), ContentBlock(text="a2")],
            tracking_id="a1",
            metadata={"usage": later_usage, "custom": {"pinned": True, "source": "a2", "tag": "x"}},
        )


class TestOverflowBypass:
    @pytest.mark.parametrize(("overflow", "acted"), [(True, True), (False, False)])
    @pytest.mark.asyncio
    async def test_fires_below_the_utilization_only_when_the_request_overflowed(self, overflow, acted):
        messages = _conversation(2)
        strategy = Offload.drop("*").when(context_utilization="85%")

        assert await strategy.apply(_context(messages, 0.5, overflow)) is acted

        assert (len(messages) < 4) is acted


class TestWithoutPreserved:
    """Tests for the matches a ``preserve_recent`` leaves to act on."""

    @pytest.mark.parametrize(
        ("preserve_recent", "count", "left"),
        [
            (3, 10, 7),
            ("70%", 10, 3),
            ("50%", 3, 1),
            ("99%", 10, 0),
            # A share that divides exactly keeps exactly that many, with no rounding up from float error.
            ("7%", 100, 93),
        ],
    )
    def test_leaves_the_matches_the_recent_ones_do_not_cover(self, preserve_recent, count, left):
        matches = list(range(count))

        assert ResolvedConditions({"preserve_recent": preserve_recent}).without_preserved(matches) == matches[:left]


class TestCollectRemovableWithPair:
    @pytest.mark.asyncio
    async def test_collects_a_tool_use_with_the_tool_result_that_follows_it(self):
        messages = [_text("user", "task"), *_tool_call("read", "tu-1", "x"), _text("assistant", "latest")]

        assert collect_removable_with_pair(messages, 1) == [messages[1], messages[2]]

    def test_never_collects_the_last_message(self):
        messages = [_text("user", "task"), _text("assistant", "a1"), _text("user", "latest")]

        assert collect_removable_with_pair(messages, 2) == []

    def test_skips_a_tool_use_whose_result_is_the_last_message(self):
        messages = [_text("user", "task"), *_tool_call("read", "tu-1", "x")]

        assert collect_removable_with_pair(messages, 1) == []


class TestInsertMarker:
    """Tests for where a marker standing in for removed messages lands."""

    _MARKER = ContentBlock(text="marker")

    def test_inserts_an_assistant_message_between_user_messages(self):
        messages = [_text("user", "task"), _text("user", "u1")]

        insert_marker(messages, 1, self._MARKER)

        assert [message["role"] for message in messages] == ["user", "assistant", "user"]
        assert messages[1]["content"] == [self._MARKER]

    def test_appends_to_the_assistant_message_before_the_gap(self):
        original = Message(
            role="assistant",
            content=[ContentBlock(text="a1")],
            tracking_id="msg-1",
            metadata={"custom": {"k": "v"}},
        )
        messages = [_text("user", "task"), original, _text("user", "u1")]

        insert_marker(messages, 2, self._MARKER)

        assert len(messages) == 3
        assert messages[1]["content"] == [ContentBlock(text="a1"), self._MARKER]
        assert messages[1]["tracking_id"] == "msg-1"
        assert messages[1]["metadata"] == {"custom": {"k": "v"}}
        assert original["content"] == [ContentBlock(text="a1")]

    def test_appends_to_the_assistant_message_after_the_gap(self):
        messages = [_text("user", "task"), _text("assistant", "a1"), _text("user", "u1")]

        insert_marker(messages, 1, self._MARKER)

        assert len(messages) == 3
        assert messages[1]["content"] == [ContentBlock(text="a1"), self._MARKER]

    @pytest.mark.parametrize(("index", "expected"), [(0, ["task", "marker", "u1"]), (5, ["task", "u1", "marker"])])
    def test_clamps_an_index_into_the_history_after_message_0(self, index, expected):
        messages = [_text("user", "task"), _text("user", "u1")]

        insert_marker(messages, index, self._MARKER)

        assert [message["content"][0]["text"] for message in messages] == expected


class TestEmergencyTruncate:
    @pytest.mark.asyncio
    async def test_leaves_a_marker_on_the_assistant_message_after_the_cut(self):
        messages = [
            _text("user", "pin"),
            _text("assistant", "a1"),
            _text("user", "u2"),
            _text("assistant", "a2"),
            _text("user", "u3"),
        ]

        assert await EmergencyTruncateStrategy().apply(_context(messages, 1.1, True)) is True

        assert [(message["role"], _all_text([message])) for message in messages] == [
            ("user", ["pin"]),
            ("assistant", ["a2", "[... earlier messages elided, ~2 tokens ...]"]),
            ("user", ["u3"]),
        ]


class TestRepeatedMessageLevelReduction:
    """Message 0 stays verbatim however many times a strategy reduces the history (#4685)."""

    _STRATEGIES = {
        "drop": lambda: Offload.drop("*").when(context_utilization="70%", preserve_recent=3),
        "drop_all": lambda: Offload.drop("*").when(context_utilization="70%"),
        "truncate": lambda: Offload.truncate("*", {"preview_tokens": 4}).when(
            context_utilization="70%", preserve_recent=3
        ),
        "truncate_all": lambda: Offload.truncate("*", {"preview_tokens": 4}).when(context_utilization="70%"),
        "emergency": EmergencyTruncateStrategy,
    }

    @staticmethod
    def _task() -> Message:
        return _pinned("user", "task")

    @staticmethod
    def _turn(index: int, text_only: bool) -> Messages:
        if text_only:
            return [_text("assistant", f"a{index}"), _text("user", f"u{index}")]
        return _tool_call("read", f"tu-{index}", "x")

    @pytest.mark.parametrize("build", _STRATEGIES.values(), ids=list(_STRATEGIES))
    @pytest.mark.parametrize("text_only", [False, True], ids=["tool_pairs", "text_only"])
    @pytest.mark.asyncio
    async def test_keeps_message_0_and_the_newest_message_over_thirty_turns(self, build, text_only):
        strategy = build()
        messages = [self._task()]

        for index in range(30):
            added = self._turn(index, text_only)
            messages.extend(added)

            await strategy.apply(_context(messages, 1.1, True))

            assert messages[-1] is added[-1]

        assert messages[0] == self._task()
        assert len(messages) < 10


class TestParseCondition:
    """Tests for the value each condition accepts."""

    _EXPECTED = {
        "context_utilization": 'a "N%" string up to "100%" or a whole token count of at least 1000',
        "preserve_recent": 'a "N%" string below "100%" or a whole message count',
    }

    @pytest.mark.parametrize(
        ("name", "raw", "parsed"),
        [
            ("context_utilization", "70%", ParsedCondition(70, True)),
            ("context_utilization", 50_000, ParsedCondition(50_000, False)),
            ("context_utilization", 1000, ParsedCondition(1000, False)),
            ("block_threshold", 2500, ParsedCondition(2500, False)),
            ("block_threshold", "5%", ParsedCondition(5, True)),
            ("preserve_recent", 4, ParsedCondition(4, False)),
            ("preserve_recent", "50%", ParsedCondition(50, True)),
        ],
    )
    def test_accepts(self, name, raw, parsed):
        assert parse_condition(name, raw) == parsed

    @pytest.mark.parametrize(
        ("name", "raw", "shown"),
        [
            ("context_utilization", 0, "0"),
            ("context_utilization", 0.5, "0.5"),
            ("context_utilization", 1, "1"),
            ("context_utilization", 1.5, "1.5"),
            ("context_utilization", "101%", '"101%"'),
            ("context_utilization", "70", '"70"'),
            ("block_threshold", -1, "-1"),
            ("block_threshold", 0, "0"),
            ("block_threshold", 0.5, "0.5"),
            ("block_threshold", "100%", '"100%"'),
            ("preserve_recent", 0.5, "0.5"),
            ("preserve_recent", 1.5, "1.5"),
            ("preserve_recent", "100%", '"100%"'),
        ],
    )
    def test_rejects(self, name, raw, shown):
        with pytest.raises(ValueError, match=f"^{re.escape(f'{name}={shown} is invalid: expected ')}"):
            parse_condition(name, raw)

    @pytest.mark.parametrize(
        ("name", "raw", "hint"),
        [
            ("context_utilization", 80, '; for 80%, write "80%"'),
            ("context_utilization", 0.8, '; for 80%, write "80%"'),
            ("context_utilization", 1, '; for 100%, write "100%"'),
            ("context_utilization", 999, ""),
            ("preserve_recent", 0.07, '; for 7%, write "7%"'),
        ],
    )
    def test_suggests_a_percent_for_a_number_that_reads_as_one(self, name, raw, hint):
        message = f"{name}={raw} is invalid: expected {self._EXPECTED[name]}{hint}"

        with pytest.raises(ValueError, match=f"^{re.escape(message)}$"):
            parse_condition(name, raw)


class TestConditionResolution:
    """Tests for the conditions a strategy resolves against an agent and its history."""

    @pytest.mark.parametrize("name", ["utilisation", "threshold", "preserveRecent"])
    def test_rejects_an_unknown_condition_name(self, name):
        # ``.when()`` takes keywords, so a name it does not define only reaches the conditions as a mapping.
        with pytest.raises(ValueError, match=f'unknown condition "{name}"'):
            ResolvedConditions({name: 0.5})

    @pytest.mark.parametrize(
        ("conditions", "context_window_limit", "utilization", "fires"),
        [
            ({"context_utilization": "70%"}, DEFAULT_CONTEXT_WINDOW_LIMIT, 0.7, True),
            ({"context_utilization": "70%"}, DEFAULT_CONTEXT_WINDOW_LIMIT, 0.69, False),
            ({"context_utilization": 50_000}, 100_000, 0.5, True),
            ({"context_utilization": 50_000}, 100_000, 0.49, False),
        ],
    )
    @pytest.mark.asyncio
    async def test_fires_once_the_utilization_is_reached(self, conditions, context_window_limit, utilization, fires):
        messages = _tool_history([2500])
        context = _context(messages, utilization, context_window_limit=context_window_limit)

        assert await Offload.drop("tool_results").when(**conditions).apply(context) is fires

    def test_rejects_on_init_a_token_count_larger_than_the_context_window(self):
        strategy = Offload.drop("*").when(context_utilization=100_001)

        with pytest.raises(ValueError, match=r"context_utilization \(100001\) is larger than the model's context"):
            strategy.init(_context([], context_window_limit=100_000).agent)

    def test_warns_when_the_model_reports_no_context_window(self, caplog):
        strategy = Offload.drop("*").when(context_utilization=500_000)

        with caplog.at_level(logging.WARNING):
            strategy.init(_context([], context_window_limit=None).agent)

        assert "context_utilization=<500000> | context_window_limit is not set" in caplog.text

    @pytest.mark.parametrize(
        ("context_window_limit", "context_utilization"), [(100_000, 100_000), (100_000, "100%"), (None, "80%")]
    )
    def test_accepts_on_init_a_utilization_within_the_context_window(self, context_window_limit, context_utilization):
        strategy = Offload.drop("*").when(context_utilization=context_utilization)

        strategy.init(_context([], context_window_limit=context_window_limit).agent)

    @pytest.mark.asyncio
    async def test_measures_a_percent_block_threshold_against_the_context_window(self):
        messages = _tool_history([100, 101])
        context = _context(messages, 0, context_window_limit=10_000)

        assert await Offload.drop("tool_results").when(block_threshold="1%").apply(context) is True

        assert _result_texts(messages) == ["x" * 400, "[Dropped: ~101 tokens]"]


_BLOCK_METHODS = {
    "drop": lambda: Offload.drop("tool_results"),
    "truncate": lambda: Offload.truncate("tool_results", {"preview_tokens": 100}),
    "summarize": lambda: Offload.summarize("tool_results"),
}


class TestToolResultsThatAlreadyHoldAPlaceholder:
    """Tests that a pass over the placeholder it already left is a no-op."""

    @staticmethod
    def _history() -> Messages:
        return [*_tool_history([1000, 1000]), _text("user", "next")]

    @pytest.mark.parametrize(("method", "build"), list(_BLOCK_METHODS.items()), ids=list(_BLOCK_METHODS))
    @pytest.mark.asyncio
    async def test_leaves_them_alone_on_a_second_pass(self, method, build):
        messages = self._history()
        strategy = build().when(context_utilization="50%")
        assert await strategy.apply(_context(messages, 0.9)) is True
        offloaded = _result_texts(messages)
        _SUMMARIZE.reset_mock()

        assert await strategy.apply(_context(messages, 0.9)) is False

        assert _result_methods(messages) == [method, method]
        assert _result_texts(messages) == offloaded
        _SUMMARIZE.assert_not_called()

    @pytest.mark.parametrize("method", ["truncate", "summarize"])
    @pytest.mark.asyncio
    async def test_leaves_a_dropped_result_alone(self, method):
        messages = self._history()
        await Offload.drop("tool_results").when(context_utilization="50%").apply(_context(messages, 0.9))
        _SUMMARIZE.reset_mock()
        strategy = _BLOCK_METHODS[method]().when(context_utilization="50%")

        assert await strategy.apply(_context(messages, 0.9)) is False

        assert _result_methods(messages) == ["drop", "drop"]
        _SUMMARIZE.assert_not_called()


class TestPlaceholdersLeftByAnotherMethod:
    @pytest.mark.asyncio
    async def test_drop_replaces_a_tool_result_holding_a_truncate_placeholder(self):
        tool_result = ToolResult(
            toolUseId="tool-123", status="success", content=[offload_placeholder("truncate", LARGE, None)]
        )
        messages = [Message(role="user", content=[ContentBlock(toolResult=tool_result)])]

        assert await Offload.drop("tool_results").apply(_context(messages)) is True

        assert _result_methods(messages) == ["drop"]

    @pytest.mark.parametrize(
        "build",
        [
            lambda: Offload.drop("assistant_text").when(block_threshold=100),
            lambda: Offload.truncate("assistant_text", {"preview_tokens": 50}).when(block_threshold=100),
        ],
        ids=["drop", "truncate"],
    )
    @pytest.mark.asyncio
    async def test_leaves_a_text_block_that_is_a_placeholder_alone(self, build):
        messages = [
            _text("user", "q"),
            Message(role="assistant", content=[offload_placeholder("summarize", LARGE, None)]),
            _text("user", "next"),
        ]
        before = copy.deepcopy(messages)

        assert await build().apply(_context(messages)) is False

        assert messages == before


_BIG = "x" * 4000

_GRANULARITY_CASES = [
    ("*", {"context_utilization": "50%"}, 0.9, "messages"),
    ("*", {"preserve_recent": 1}, 0, "messages"),
    ("*", {"block_threshold": 200, "context_utilization": "50%"}, 0.9, "large_messages"),
    ("assistant_text", {"context_utilization": "50%"}, 0.9, [1, 3]),
    ("assistant_text", {"context_utilization": "50%"}, 0.1, "nothing"),
]

_TARGET_METHODS = {
    "drop": Offload.drop,
    "truncate": lambda target: Offload.truncate(target, {"preview_tokens": 100}),
    "summarize": Offload.summarize,
}


class TestGranularity:
    """Tests that the target alone decides whether a pass acts on whole messages or on single blocks."""

    @staticmethod
    def _history() -> Messages:
        return [
            _text("user", "task"),
            _text("assistant", _BIG),
            _text("user", _BIG),
            _text("assistant", _BIG),
            _text("user", _BIG),
            _text("assistant", "end"),
            _text("user", "next"),
        ]

    @pytest.mark.parametrize(
        ("method", "target", "conditions", "utilization", "outcome"),
        [
            (method, *case)
            for method in _TARGET_METHODS
            for case in _GRANULARITY_CASES
            if method != "truncate" or "block_threshold" not in case[1]
        ],
    )
    @pytest.mark.asyncio
    async def test_acts_at_the_granularity_its_target_sets(self, method, target, conditions, utilization, outcome):
        messages = self._history()

        acted = await _TARGET_METHODS[method](target).when(**conditions).apply(_context(messages, utilization))

        if outcome == "nothing":
            assert acted is False
            assert _texts_of(messages) == _texts_of(self._history())
            return
        assert acted is True
        if isinstance(outcome, str):
            assert len(messages) < len(self._history())
            assert method in [placeholder["method"] for placeholder in placeholders_in(messages)]
            if outcome == "large_messages":
                assert "end" in [text for texts in _texts_of(messages) for text in texts]
            return
        assert len(messages) == len(self._history())
        for index in (1, 2, 3, 4):
            block = messages[index]["content"][0]
            if index in outcome:
                assert offloaded_by(block) == method
            else:
                assert block["text"] == _BIG

    @pytest.mark.parametrize("method", list(_TARGET_METHODS), ids=list(_TARGET_METHODS))
    @pytest.mark.asyncio
    async def test_leaves_the_newest_message_alone(self, method):
        messages = [*self._history()[:-1], _text("user", _BIG)]
        strategy = _TARGET_METHODS[method]("user_text").when(context_utilization="50%")

        assert await strategy.apply(_context(messages, 0.9)) is True

        assert offloaded_by(messages[2]["content"][0]) == method
        assert messages[-1]["content"][0]["text"] == _BIG

    @pytest.mark.parametrize("method", list(_TARGET_METHODS), ids=list(_TARGET_METHODS))
    @pytest.mark.asyncio
    async def test_leaves_the_first_message_alone(self, method):
        messages = [_text("user", _BIG), *self._history()[1:]]
        strategy = _TARGET_METHODS[method]("user_text").when(context_utilization="50%")

        assert await strategy.apply(_context(messages, 0.9)) is True

        assert messages[0]["content"][0]["text"] == _BIG
        assert offloaded_by(messages[2]["content"][0]) == method


class TestUnconditionedStrategyWarning:
    @pytest.mark.parametrize(
        "conditions", [{"block_threshold": 1}, {"context_utilization": "50%"}, {"preserve_recent": 1}]
    )
    def test_does_not_warn_for_a_strategy_with_conditions(self, conditions, caplog):
        strategy = Offload.drop("assistant_text").when(**conditions)

        with caplog.at_level(logging.WARNING):
            strategy.init(make_agent())

        assert caplog.text == ""

    def test_warns_once_for_a_strategy_that_acts_on_arrival(self, caplog):
        strategy = Offload.drop("assistant_text")

        with caplog.at_level(logging.WARNING):
            strategy.init(make_agent())
            strategy.init(make_agent())

        assert caplog.text.count("strategy has no conditions") == 1
        assert 'strategy=<offload:drop>, target=<"assistant_text">' in caplog.text
        assert "use .when() to set block_threshold, context_utilization, or preserve_recent" in caplog.text


class TestWholeMessageConditions:
    """Tests for the conditions ``Offload.<method>("*")`` needs before it acts."""

    @pytest.mark.parametrize("method", ["drop", "truncate", "summarize"])
    @pytest.mark.parametrize("conditions", [{}, {"preserve_recent": 0}, {"preserve_recent": "0%"}])
    def test_rejects_conditions_that_leave_it_acting_on_every_message(self, method, conditions):
        expected = (
            f'Offload.{method}("*") would act on every message; use .when() to set context_utilization,'
            " block_threshold, or a preserve_recent above 0"
        )

        with pytest.raises(ValueError, match=f"^{re.escape(expected)}$"):
            getattr(Offload, method)("*").when(**conditions)

    @pytest.mark.parametrize("method", ["drop", "truncate", "summarize"])
    @pytest.mark.parametrize(
        "conditions", [{"context_utilization": "50%"}, {"preserve_recent": 1}, {"block_threshold": 2500}]
    )
    def test_accepts_conditions_that_hold_it_back(self, method, conditions):
        if method == "truncate" and "block_threshold" in conditions:
            pytest.skip('Offload.truncate("*") takes no block_threshold')

        getattr(Offload, method)("*").when(**conditions)


class TestMediaConditions:
    """Tests for the conditions ``Offload.<method>("media")`` needs before it acts."""

    @pytest.mark.parametrize("method", ["drop", "truncate", "summarize"])
    @pytest.mark.parametrize(
        "conditions",
        [{}, {"block_threshold": 100}, {"preserve_recent": "0%"}, {"block_threshold": 100, "preserve_recent": 0}],
    )
    def test_rejects_conditions_that_act_before_the_model_sees_the_media(self, method, conditions):
        expected = (
            f'Offload.{method}("media") would remove media before the model sees it; use .when() to set'
            " context_utilization or a preserve_recent above 0"
        )

        with pytest.raises(ValueError, match=f"^{re.escape(expected)}$"):
            getattr(Offload, method)("media").when(**conditions)

    @pytest.mark.parametrize("method", ["drop", "truncate", "summarize"])
    @pytest.mark.parametrize("conditions", [{"context_utilization": "80%"}, {"preserve_recent": 1}])
    def test_accepts_conditions_that_wait_for_the_model_to_read_it(self, method, conditions):
        getattr(Offload, method)("media").when(**conditions)


class TestToolListTargets:
    def test_subtracts_the_excluded_tools_from_the_included_ones(self):
        matcher = OffloadTargetMatcher(["tool::bash", "python", "!tool::python", "!grep"])
        tool_names = {"tu-bash": "bash", "tu-python": "python"}
        message = Message(role="user", content=[])

        def result_of(tool_use_id):
            tool_result = ToolResult(toolUseId=tool_use_id, status="success", content=[{"text": "x"}])
            return ContentBlock(toolResult=tool_result)

        assert matcher.matches_block(result_of("tu-bash"), message, tool_names) is True
        assert matcher.matches_block(result_of("tu-python"), message, tool_names) is False

    def test_rejects_a_list_that_excludes_every_tool_it_includes(self):
        expected = 'Tool target ["tool::bash", "!bash"] excludes every tool it includes, so it matches nothing'

        with pytest.raises(ValueError, match=f"^{re.escape(expected)}$"):
            Offload.drop(["tool::bash", "!bash"])


class TestTruncateBlockThreshold:
    @pytest.mark.asyncio
    async def test_leaves_blocks_within_the_preview_alone_and_skips_what_it_already_truncated(self):
        messages = _tool_history([100, 2000])
        strategy = Offload.truncate("tool_results", {"preview_tokens": 100}).when()

        assert await strategy.apply(_context(messages, 0)) is True
        first_pass = _result_texts(messages)
        assert first_pass[0] == "x" * 400
        assert _result_methods(messages) == [None, "truncate"]
        assert math.ceil(len(first_pass[1]) / 4) > 100

        assert await strategy.apply(_context(messages, 0)) is False
        assert _result_texts(messages) == first_pass


def _pad(label: str) -> str:
    """``label`` padded to ten tokens under the heuristic count."""
    return label.ljust(40, ".")


class TestTruncateWholeMessages:
    """Tests for ``Offload.truncate("*")``, which keeps whole messages at the head and the tail of its budget."""

    @staticmethod
    def _history() -> Messages:
        messages = [_text("user", "task")]
        for index in range(1, 11):
            messages.append(_text("assistant" if index % 2 else "user", _pad(f"m{index}")))
        return messages

    @pytest.mark.parametrize(
        ("preview", "preview_tokens", "expected"),
        [
            ("head_tail", 40, ["task", "m1", "m2", "[... earlier messages elided, ~70 tokens ...]", "m10"]),
            ("head", 40, ["task", "m1", "m2", "m3", "m4", "[... earlier messages elided, ~50 tokens ...]", "m10"]),
            ("tail", 50, ["task", "[... earlier messages elided, ~50 tokens ...]", "m6", "m7", "m8", "m9", "m10"]),
        ],
    )
    @pytest.mark.asyncio
    async def test_elides_the_middle_of_the_history(self, preview, preview_tokens, expected):
        messages = self._history()
        config = {"preview": preview, "preview_tokens": preview_tokens}
        strategy = Offload.truncate("*", config).when(context_utilization="50%")

        assert await strategy.apply(_context(messages, 0.9)) is True

        assert _texts_of(messages) == [[_pad(value) if value.startswith("m") else value] for value in expected]

    @pytest.mark.asyncio
    async def test_elides_the_marker_another_strategy_left(self):
        messages = self._history()
        messages[3] = Message(role="assistant", content=[offload_placeholder("summarize", _pad("summary"), None)])
        strategy = Offload.truncate("*", {"preview_tokens": 40}).when(context_utilization="50%")

        assert await strategy.apply(_context(messages, 0.9)) is True

        assert _texts_of(messages) == [
            ["task"],
            [_pad("m1")],
            [_pad("m2")],
            ["[... earlier messages elided, ~70 tokens ...]"],
            [_pad("m10")],
        ]

    @pytest.mark.asyncio
    async def test_elides_a_message_holding_content_beside_its_own_earlier_marker(self):
        messages = self._history()
        marker = offload_placeholder("truncate", format_elided(20), None)
        messages[3] = Message(role="assistant", content=[ContentBlock(text=_pad("m3")), marker])
        strategy = Offload.truncate("*", {"preview_tokens": 40}).when(context_utilization="50%")

        assert await strategy.apply(_context(messages, 0.9)) is True

        assert _texts_of(messages) == [
            ["task"],
            [_pad("m1")],
            [_pad("m2")],
            ["[... earlier messages elided, ~82 tokens ...]"],
            [_pad("m10")],
        ]

    @pytest.mark.asyncio
    async def test_adds_back_the_tokens_an_elided_marker_already_stood_for(self):
        messages = self._history()
        marker = offload_placeholder("truncate", format_elided(1000), None, 1000)
        messages[3] = Message(role="assistant", content=[ContentBlock(text=_pad("m3")), marker])
        strategy = Offload.truncate("*", {"preview_tokens": 40}).when(context_utilization="50%")
        context = _context(messages, 0.9)
        elided = await context.agent.model.count_tokens(messages[3:10])

        assert await strategy.apply(context) is True

        # A marker's text is a few tokens, so without the size it recorded the new marker would under-report.
        assert _texts_of(messages) == [
            ["task"],
            [_pad("m1")],
            [_pad("m2")],
            [format_elided(elided + 1000)],
            [_pad("m10")],
        ]

    @pytest.mark.asyncio
    async def test_adds_back_the_tokens_a_truncated_tool_result_already_stood_for(self):
        messages = [
            _text("user", "task"),
            _text("assistant", _pad("m1")),
            make_tool_result_message("x" * 8000),
            _text("assistant", _pad("m3")),
            _text("user", "next"),
        ]
        context = _context(messages, 0.9)
        original = await context.agent.model.count_tokens([messages[2]])

        assert await Offload.truncate("tool_results", {"preview_tokens": 10}).apply(context) is True

        assert placeholders_in(messages) == [{"method": "truncate", "tokens": original}]
        left = await context.agent.model.count_tokens(messages[1:4])

        assert await Offload.drop("*").when(context_utilization="50%").apply(context) is True

        # A block placeholder sits inside the tool result, so the marker reports the result's size, not its preview.
        assert placeholders_in(messages) == [{"method": "drop", "tokens": left + original}]
        assert _texts_of(messages) == [["task"], [format_dropped_messages(left + original)], ["next"]]

    @pytest.mark.asyncio
    async def test_stops_once_only_its_own_marker_is_left_to_elide(self):
        messages = self._history()
        config = {"preview": "head", "preview_tokens": 40}
        strategy = Offload.truncate("*", config).when(context_utilization="50%")
        assert await strategy.apply(_context(messages, 0.9)) is True
        after_first_pass = _texts_of(messages)

        assert await strategy.apply(_context(messages, 0.9)) is False

        assert _texts_of(messages) == after_first_pass


class TestEagerHook:
    """Tests for the hook a strategy without deferring conditions registers to act on arrival."""

    @staticmethod
    def _agent(messages: Messages):
        agent = make_agent(messages)
        agent.hooks = HookRegistry()
        return agent

    @staticmethod
    async def _fire(agent, message: Message) -> None:
        callback = agent.hooks._registered_callbacks[MessageAddedEvent][0].callback
        await callback(MessageAddedEvent(agent=agent, message=message))

    @pytest.mark.parametrize(
        "strategy",
        [
            Offload.drop("*").when(context_utilization="50%"),
            Offload.drop("tool_results").when(context_utilization="50%"),
            Offload.drop("tool_results").when(preserve_recent=1),
        ],
    )
    def test_registers_no_hook_for_conditions_that_defer_to_a_pass(self, strategy):
        agent = self._agent([])

        strategy.init(agent)

        assert agent.hooks._registered_callbacks.get(MessageAddedEvent, []) == []

    @pytest.mark.asyncio
    async def test_offloads_a_block_of_the_message_that_arrived(self):
        message = make_tool_result_message("x" * 20000)
        agent = self._agent([message])
        Offload.drop("tool_results").when(block_threshold=100).init(agent)

        await self._fire(agent, message)

        assert _result_methods([message]) == ["drop"]

    @pytest.mark.asyncio
    async def test_leaves_a_pinned_message_alone(self):
        message = make_tool_result_message("x" * 20000)
        message["metadata"] = {"custom": {"pinned": True}}
        agent = self._agent([message])
        Offload.drop("tool_results").when(block_threshold=100).init(agent)

        await self._fire(agent, message)

        assert _result_methods([message]) == [None]

    @pytest.mark.asyncio
    async def test_keeps_the_history_when_the_hook_raises(self, caplog):
        message = make_tool_result_message("x" * 20000)
        agent = self._agent([message])
        strategy = Offload.drop("tool_results").when(block_threshold=100)
        strategy.init(agent)
        strategy._transform_blocks = unittest.mock.AsyncMock(side_effect=RuntimeError("hook failed"))

        with caplog.at_level(logging.WARNING):
            await self._fire(agent, message)

        assert "eager hook failed, continuing" in caplog.text
        assert _result_methods([message]) == [None]
