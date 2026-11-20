"""Tests for the message trimming module."""

from typing import Any

import pytest

from strands._context_manager.message_trimming import _holds_run, remove_messages
from strands.types.content import ContentBlock, Message, Messages


def _text(role: str, text: str) -> Message:
    return Message(role=role, content=[ContentBlock(text=text)])


def _texts(messages: Messages) -> list[str]:
    return [block["text"] for message in messages for block in message["content"] if "text" in block]


def _history() -> Messages:
    return [
        _text("user", "task"),
        _text("assistant", "old1"),
        _text("user", "old2"),
        _text("assistant", "old3"),
        _text("user", "recent"),
    ]


class _MutatingModel:
    """A model whose token counting removes ``victim_index``, standing in for a pass running concurrently."""

    def __init__(self, messages: Messages, victim_index: int | None) -> None:
        self._messages = messages
        self._victim_index = victim_index
        self._fired = False
        self.context_window_limit = 10_000

    def estimate_utilization(self, tokens: int) -> float:
        return tokens / self.context_window_limit

    async def count_tokens(self, messages: Messages, **_kwargs: Any) -> int:
        if self._victim_index is not None and not self._fired:
            self._fired = True
            del self._messages[self._victim_index]
        return 100


async def _drop(messages: Messages, selected: Messages, model: Any) -> bool:
    return await remove_messages(messages, selected, model, lambda tokens: f"[Dropped {tokens}]", "drop", None)


class TestHoldsRun:
    def test_holds_a_run_at_its_own_index(self):
        messages = _history()

        assert _holds_run(messages, 1, messages[1:3]) is True

    def test_rejects_a_run_that_moved(self):
        messages = _history()

        assert _holds_run(messages, 2, messages[1:3]) is False

    def test_rejects_a_run_reaching_past_the_history(self):
        messages = _history()

        assert _holds_run(messages, 3, [*messages[3:], _text("user", "never added")]) is False

    def test_compares_by_identity_rather_than_equality(self):
        messages = _history()

        assert _holds_run(messages, 1, [_text("assistant", "old1")]) is False


class TestRemoveMessages:
    """A run is selected before the token count it is measured by, so the history can change in between."""

    @pytest.mark.asyncio
    async def test_replaces_a_run_whose_messages_all_remain(self):
        messages = _history()
        selected = [messages[1], messages[2]]

        assert await _drop(messages, selected, _MutatingModel(messages, None)) is True

        # The marker joins the assistant message beside the gap rather than becoming one of its own.
        assert _texts(messages) == ["task", "old3", "[Dropped 100]", "recent"]

    @pytest.mark.asyncio
    async def test_keeps_the_history_when_the_run_head_leaves_during_the_count(self):
        messages = _history()
        selected = [messages[1], messages[2]]

        assert await _drop(messages, selected, _MutatingModel(messages, 1)) is False

        # The head's removal is the only one: the run is no longer there to replace, so nothing else is taken.
        assert _texts(messages) == ["task", "old2", "old3", "recent"]

    @pytest.mark.asyncio
    async def test_keeps_unselected_messages_when_the_run_is_broken_up_during_the_count(self):
        messages = _history()
        selected = [messages[1], messages[2]]

        assert await _drop(messages, selected, _MutatingModel(messages, 2)) is False

        # Removing the run by its length from the surviving head would reach past it into messages nobody selected.
        assert _texts(messages) == ["task", "old1", "old3", "recent"]
