"""Tests for messages sent to an Agent during and between invocations."""

import asyncio
import copy
import threading

import pytest

from strands import Agent, tool
from strands.handlers.callback_handler import null_callback_handler
from strands.hooks import BeforeModelCallEvent, MessageAddedEvent
from strands.interrupt import Interrupt, InterruptException
from strands.session.repository_session_manager import RepositorySessionManager
from strands.types.content import ContentBlock, Message
from strands.types.exceptions import ConcurrencyException
from tests.fixtures.mock_session_repository import MockedSessionRepository
from tests.fixtures.mocked_model_provider import MockedModelProvider


@pytest.mark.asyncio
async def test_send_idle_delivers_fifo_on_next_invocation() -> None:
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "answer"}]}])
    agent = Agent(model=model, callback_handler=null_callback_handler)
    delivered: list[Message] = []
    agent.add_hook(lambda event: delivered.append(copy.deepcopy(event.message)), MessageAddedEvent)

    content: list[ContentBlock] = [{"text": "second"}]
    agent.send("first")
    agent.send(content)
    content[0]["text"] = "changed"

    assert agent.messages == []
    assert agent._inbox.has_messages()
    await agent.invoke_async("initial")

    tru_text = [message["content"][0].get("text") for message in agent.messages]
    exp_text = ["initial", "first", "second", "answer"]
    assert tru_text == exp_text
    assert [message["content"][0].get("text") for message in delivered] == exp_text
    assert not agent._inbox.has_messages()


@pytest.mark.asyncio
async def test_send_messages_restore_without_duplicate_user_input() -> None:
    repository = MockedSessionRepository()
    agent = Agent(
        agent_id="inbox-agent",
        model=MockedModelProvider([{"role": "assistant", "content": [{"text": "answer"}]}]),
        session_manager=RepositorySessionManager("inbox-session", repository),
        callback_handler=null_callback_handler,
    )
    agent.send("first")
    agent.send("second")

    await agent.invoke_async("initial")

    restored = Agent(
        agent_id="inbox-agent",
        model=MockedModelProvider([]),
        session_manager=RepositorySessionManager("inbox-session", repository),
        callback_handler=null_callback_handler,
    )
    tru_text = [message["content"][0].get("text") for message in restored.messages]
    exp_text = ["initial", "first", "second", "answer"]
    assert tru_text == exp_text


@pytest.mark.asyncio
async def test_send_during_tool_runs_at_next_model_boundary() -> None:
    tool_started = asyncio.Event()
    release_tool = asyncio.Event()

    @tool
    async def slow_tool() -> str:
        tool_started.set()
        await release_tool.wait()
        return "tool done"

    model = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "tool-1", "name": "slow_tool", "input": {}}}],
            },
            {"role": "assistant", "content": [{"text": "answer"}]},
        ]
    )
    agent = Agent(model=model, tools=[slow_tool], callback_handler=null_callback_handler)

    invocation = asyncio.create_task(agent.invoke_async("initial"))
    await asyncio.wait_for(tool_started.wait(), timeout=5)
    await asyncio.to_thread(agent.send, "during tool")
    assert agent._inbox.has_messages()
    assert all(message["content"] != [{"text": "during tool"}] for message in agent.messages)
    with pytest.raises(ConcurrencyException):
        await agent.invoke_async("concurrent")

    release_tool.set()
    await asyncio.wait_for(invocation, timeout=5)

    tru_roles = [message["role"] for message in agent.messages]
    exp_roles = ["user", "assistant", "user", "user", "assistant"]
    assert tru_roles == exp_roles
    assert agent.messages[-2]["content"] == [{"text": "during tool"}]


@pytest.mark.asyncio
async def test_wait_wakes_for_cross_thread_send() -> None:
    agent = Agent(model=MockedModelProvider([]), callback_handler=null_callback_handler)
    waiter = asyncio.create_task(agent._inbox.wait())
    await asyncio.sleep(0)

    await asyncio.to_thread(agent.send, "hello")
    await asyncio.wait_for(waiter, timeout=5)

    assert agent._inbox.has_messages()


@pytest.mark.asyncio
async def test_wait_wakes_on_another_event_loop() -> None:
    agent = Agent(model=MockedModelProvider([]), callback_handler=null_callback_handler)
    waiting = threading.Event()

    async def wait_on_worker_loop() -> None:
        waiting.set()
        await agent._inbox.wait()

    waiter = asyncio.create_task(asyncio.to_thread(lambda: asyncio.run(wait_on_worker_loop())))
    assert await asyncio.to_thread(waiting.wait, 5)
    agent.send("hello")
    await asyncio.wait_for(waiter, timeout=5)

    assert agent._inbox.has_messages()


@pytest.mark.asyncio
async def test_send_remains_queued_when_model_call_is_cancelled_by_hook() -> None:
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "answer"}]}])
    agent = Agent(model=model, callback_handler=null_callback_handler)
    calls = 0

    def cancel_first_model_call(event: BeforeModelCallEvent) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            event.cancel = True

    agent.add_hook(cancel_first_model_call, BeforeModelCallEvent)
    agent.send("queued")

    await agent.invoke_async("first")
    assert agent._inbox.has_messages()
    await agent.invoke_async("second")

    tru_text = [message["content"][0].get("text") for message in agent.messages]
    exp_text = ["first", "model call denied by hook", "second", "queued", "answer"]
    assert tru_text == exp_text


@pytest.mark.asyncio
async def test_send_remains_queued_after_invocation_cancellation() -> None:
    model = MockedModelProvider([{"role": "assistant", "content": [{"text": "answer"}]}])
    agent = Agent(model=model, callback_handler=null_callback_handler)
    cancel_signal = threading.Event()
    cancel_signal.set()
    agent.send("queued")

    result = await agent.invoke_async("first", cancel_signal=cancel_signal)

    assert result.stop_reason == "cancelled"
    assert agent._inbox.has_messages()


@pytest.mark.asyncio
async def test_send_remains_queued_after_model_hook_interrupt() -> None:
    agent = Agent(model=MockedModelProvider([]), callback_handler=null_callback_handler)

    def interrupt_model_call(event: BeforeModelCallEvent) -> None:
        raise InterruptException(Interrupt(id="test", name="inbox-test"))

    agent.add_hook(interrupt_model_call, BeforeModelCallEvent)
    agent.send("queued")

    result = await agent.invoke_async("first")

    assert result.stop_reason == "interrupt"
    assert agent._inbox.has_messages()


def test_load_snapshot_discards_undelivered_messages() -> None:
    agent = Agent(model=MockedModelProvider([]), callback_handler=null_callback_handler)
    snapshot = agent.take_snapshot(preset="session")
    agent.send("queued")

    agent.load_snapshot(snapshot)

    assert not agent._inbox.has_messages()


@pytest.mark.parametrize("message", [[], 42, [{"invalid": "block"}]])
def test_send_rejects_invalid_message(message: object) -> None:
    agent = Agent(model=MockedModelProvider([]), callback_handler=null_callback_handler)
    error = ValueError if message == [] else TypeError
    with pytest.raises(error):
        agent.send(message)  # type: ignore[arg-type]
    assert not agent._inbox.has_messages()


@pytest.mark.parametrize("block", [{"toolUse": {}}, {"toolResult": {}}])
def test_send_rejects_tool_protocol_blocks_before_enqueue(block) -> None:
    agent = Agent(model=MockedModelProvider([]), callback_handler=null_callback_handler)
    with pytest.raises(ValueError, match="tool-use or tool-result"):
        agent.send([block])
    assert not agent._inbox.has_messages()
