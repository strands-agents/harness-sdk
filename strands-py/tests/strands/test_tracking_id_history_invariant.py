"""Every message added to history carries a durable tracking_id, including via non-append paths.

Most messages get their tracking_id at the append chokepoint, but several paths add a message to
history *outside* it — the classic summarizing conversation manager, the agentic
``summarize_context`` tool, sliding-window truncation, intervention Guide injection, and
session-restore repair. These exercise each path end to end through a real ``Agent`` (real event
loop, mock model) and assert the guarantee: after any of these operations, **every** message in
``agent.messages`` carries a non-empty ``tracking_id``. A new non-append path added without
assigning an id fails here.
"""

import tempfile

import pytest

from strands import Agent
from strands._context_manager.modes.agentic.agentic_context import summarize_context
from strands.agent.conversation_manager import (
    SlidingWindowConversationManager,
    SummarizingConversationManager,
)
from strands.interventions.actions import Guide, Proceed
from strands.interventions.handler import InterventionHandler
from strands.session.file_session_manager import FileSessionManager
from strands.types.content import Message
from strands.types.exceptions import ContextWindowOverflowException
from strands.types.session import SessionAgent, SessionMessage
from tests.fixtures.mocked_model_provider import MockedModelProvider


def _assistant(text: str) -> Message:
    return {"role": "assistant", "content": [{"text": text}]}


def _assert_all_have_tracking_id(messages: list[Message], context: str) -> None:
    for index, message in enumerate(messages):
        tracking_id = message.get("tracking_id")
        assert isinstance(tracking_id, str) and tracking_id, (
            f"{context}: message[{index}] (role={message.get('role')}) has no tracking_id: {message}"
        )
    ids = [message["tracking_id"] for message in messages]
    assert len(set(ids)) == len(ids), f"{context}: tracking_ids are not unique: {ids}"


class _ReusableReplyModel(MockedModelProvider):
    """A mock model that returns the same reply for any number of turns.

    ``MockedModelProvider`` indexes ``agent_responses`` without a bounds guard, so a fixed-length
    list flaks with ``IndexError`` if a turn makes more model calls than the test anticipated. This
    pins to a single seeded reply, so the number of turns (or model calls per turn) is irrelevant —
    failures land on the invariant assertion, never on running the provider off the end of its list.
    """

    def __init__(self, reply_text: str = "Reply"):
        super().__init__([_assistant(reply_text)])

    async def stream(self, *args, **kwargs):
        self.index = 0  # never advance past the single seeded reply
        async for event in super().stream(*args, **kwargs):
            yield event


class _OverflowOnceModel(_ReusableReplyModel):
    """Overflows exactly once, on the first stream call after ``arm()`` is called.

    Drives the reactive summarization path deterministically without hand-counting model calls:
    the test seeds history, calls ``arm()``, then makes one more turn — the next model call raises
    ``ContextWindowOverflowException``, the agent runs ``reduce_context`` (which calls the model
    again to generate a summary), then retries. Because the trigger is armed explicitly rather than
    pinned to a call index, the test does not break if the event loop changes how many model calls a
    turn makes.
    """

    def __init__(self, reply_text: str = "Reply"):
        super().__init__(reply_text)
        self._armed = False

    def arm(self) -> None:
        """Arm a single overflow on the next stream call."""
        self._armed = True

    async def stream(self, *args, **kwargs):
        if self._armed:
            self._armed = False
            raise ContextWindowOverflowException("simulated context overflow")
        async for event in super().stream(*args, **kwargs):
            yield event


class _GuideOnceHandler(InterventionHandler):
    """Injects a Guide message after the first model call, then proceeds.

    The Guide injection pushes a user message straight into agent.messages, bypassing the append
    chokepoint (interventions/registry.py) — a site that must assign a tracking_id itself.
    """

    name = "guide-once"

    def __init__(self):
        self._guided = False

    async def after_model_call(self, event):
        if not self._guided:
            self._guided = True
            return Guide(feedback="be more specific")
        return Proceed()


@pytest.mark.asyncio
async def test_no_idless_messages_after_summarization():
    model = _OverflowOnceModel("Reply")
    manager = SummarizingConversationManager(summary_ratio=0.5, preserve_recent_messages=2)
    agent = Agent(model=model, conversation_manager=manager)

    for index in range(6):
        await agent.invoke_async(f"Message {index}")

    model.arm()  # next model call overflows → reduce_context summarizes → retry succeeds
    await agent.invoke_async("Trigger overflow")

    # Robust signal that summarization actually ran: the manager holds the generated summary, and
    # that summary is present in history — rather than inferring reduction from a message count.
    assert manager._summary_message is not None, "expected summarization to run"
    assert manager._summary_message in agent.messages, "expected the summary to be spliced into history"
    _assert_all_have_tracking_id(agent.messages, "after summarization")


@pytest.mark.asyncio
async def test_no_idless_messages_after_agentic_summarize_context(alist):
    # The agentic ``summarize_context`` tool generates a summary and splices it straight into
    # agent.messages — a different non-append site from the classic SummarizingConversationManager.
    # The pre-seeded history is assigned directly (bypassing the append chokepoint), so those
    # messages are intentionally id-less; the invariant under test is that the *summary* the tool
    # creates carries a tracking_id.
    # Invoke the tool directly (as the model would), so the agent only needs .model and .messages.
    model = MockedModelProvider([_assistant("Summary of older messages")])
    agent = Agent(model=model)
    agent.messages = [_assistant(f"Message {index}") for index in range(20)]

    tool_use = {"toolUseId": "t1", "name": summarize_context.tool_name, "input": {"keep_recent": 4}}
    await alist(summarize_context.stream(tool_use, {"agent": agent}))

    summary_messages = [
        message
        for message in agent.messages
        if any(block.get("text") == "Summary of older messages" for block in message["content"])
    ]
    assert summary_messages, "expected the agentic tool to splice in a summary message"
    for message in summary_messages:
        tracking_id = message.get("tracking_id")
        assert isinstance(tracking_id, str) and tracking_id, f"agentic summary message has no tracking_id: {message}"


@pytest.mark.asyncio
async def test_ad_hoc_appended_message_is_backfilled_on_next_turn():
    # A caller mutating agent.messages directly bypasses the append chokepoint, so the message has
    # no tracking id when added. The per-turn backfill assigns one before the next model call.
    model = _ReusableReplyModel()
    agent = Agent(model=model)

    agent.messages.append({"role": "user", "content": [{"text": "ad-hoc, added directly"}]})
    assert "tracking_id" not in agent.messages[-1]  # no id yet — bypassed the chokepoint

    await agent.invoke_async("Next turn")

    _assert_all_have_tracking_id(agent.messages, "after ad-hoc append + turn")


@pytest.mark.asyncio
async def test_no_idless_messages_after_sliding_window_truncation():
    model = _ReusableReplyModel()
    agent = Agent(model=model, conversation_manager=SlidingWindowConversationManager(window_size=6))

    for index in range(10):
        await agent.invoke_async(f"Message {index}")

    assert len(agent.messages) <= 6, "expected sliding window to trim history"
    _assert_all_have_tracking_id(agent.messages, "after sliding-window truncation")


@pytest.mark.asyncio
async def test_no_idless_messages_after_intervention_guide():
    # Two model turns: the first triggers the Guide (retry), the second and third complete the retry.
    model = MockedModelProvider([_assistant("First"), _assistant("Second"), _assistant("Third")])
    agent = Agent(model=model, interventions=[_GuideOnceHandler()])

    await agent.invoke_async("Message 0")

    # The guide handler injected a user message straight into history (bypass site). The injected
    # text is the handler-prefixed feedback (e.g. "[guide-once] be more specific"), so match on the
    # feedback substring rather than the exact string.
    guide_messages = [
        message
        for message in agent.messages
        if message["role"] == "user"
        and any("be more specific" in block.get("text", "") for block in message["content"])
    ]
    assert guide_messages, "expected the Guide handler to inject a message"
    _assert_all_have_tracking_id(agent.messages, "after intervention Guide injection")


@pytest.mark.asyncio
async def test_no_idless_messages_after_session_restore_repair():
    # Persist a broken history — an orphaned toolUse with no following toolResult — then restore into
    # a fresh agent. _fix_broken_tool_use synthesizes a toolResult user message during restore; it
    # must carry a tracking_id even though it never goes through the append chokepoint.
    with tempfile.TemporaryDirectory() as storage:
        session = FileSessionManager(session_id="s1", storage_dir=storage)
        session.create_agent(
            "s1",
            SessionAgent(
                agent_id="a1",
                state={},
                conversation_manager_state=SlidingWindowConversationManager().get_state(),
            ),
        )

        orphaned = [
            {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "orphan-1", "name": "tool", "input": {}}}],
            },
            {"role": "user", "content": [{"text": "Next message with no toolResult for the toolUse"}]},
        ]
        # Persist the broken messages directly through the session repository.
        for index, message in enumerate(orphaned):
            session.create_message("s1", "a1", SessionMessage.from_message(message, index))

        restored_session = FileSessionManager(session_id="s1", storage_dir=storage)
        restored_agent = Agent(
            model=MockedModelProvider([_assistant("unused")]), session_manager=restored_session, agent_id="a1"
        )

        # The synthesized toolResult message was inserted between the toolUse and the next message.
        # Only the synthesized message is asserted here: the two messages persisted directly above
        # (bypassing the append chokepoint) are intentionally left id-less by the no-backfill design,
        # so the invariant under test is that the *repair* message carries a tracking_id.
        synthesized = [
            message
            for message in restored_agent.messages
            if message["role"] == "user" and any("toolResult" in block for block in message["content"])
        ]
        assert synthesized, "expected session restore to synthesize a repair toolResult message"
        for message in synthesized:
            tracking_id = message.get("tracking_id")
            assert isinstance(tracking_id, str) and tracking_id, (
                f"synthesized repair message has no tracking_id: {message}"
            )


@pytest.mark.asyncio
async def test_no_idless_messages_after_combined_multi_turn_flow():
    # A longer flow: several turns plus a summarization reduction in one conversation.
    model = _OverflowOnceModel("Reply")
    manager = SummarizingConversationManager(summary_ratio=0.4, preserve_recent_messages=2)
    agent = Agent(model=model, conversation_manager=manager)

    for index in range(8):
        await agent.invoke_async(f"Turn {index}")

    model.arm()
    await agent.invoke_async("Final turn that overflows")

    assert manager._summary_message is not None, "expected summarization to run in the combined flow"
    _assert_all_have_tracking_id(agent.messages, "after combined multi-turn flow")
