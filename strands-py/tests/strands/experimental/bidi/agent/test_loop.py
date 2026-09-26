import asyncio
import unittest.mock
import warnings

import pytest
import pytest_asyncio

from strands import ToolContext, tool
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.agent.loop import _ReaderError
from strands.experimental.bidi.hooks import BidiAgentStopEvent, BidiBeforeConnectionRestartEvent
from strands.experimental.bidi.hooks import BidiBargeInEvent as BidiBargeInHookEvent
from strands.experimental.bidi.hooks import BidiResponseStopEvent as BidiResponseStopHookEvent
from strands.experimental.bidi.models import BidiModel, ConnectionTimeoutError
from strands.experimental.bidi.types import (
    BidiAudioDeltaEvent,
    BidiBargeInEvent,
    BidiConnectionRestartEvent,
    BidiConnectionStopEvent,
    BidiConnectionWarningEvent,
    BidiMessage,
    BidiReasoningBlockEvent,
    BidiReasoningDeltaEvent,
    BidiReasoningStartEvent,
    BidiReasoningStopEvent,
    BidiResponseStartEvent,
    BidiResponseStopEvent,
    BidiTextBlockEvent,
    BidiTextDeltaEvent,
    BidiTextStartEvent,
    BidiTextStopEvent,
    BidiTranscriptBlockEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
    BidiUsageEvent,
)
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent, MessageAddedEvent, MessageUpdatedEvent
from strands.types._events import ToolResultEvent, ToolResultMessageEvent, ToolUseStreamEvent
from strands.types.content import TextBlock
from strands.types.media import ImageBlock
from strands.types.tools import ToolResultBlock
from tests.fixtures.mock_hook_provider import MockHookProvider


@pytest.fixture
def time_tool():
    @tool(name="time_tool")
    async def func():
        return "12:00"

    return func


@pytest.fixture
def agent(time_tool):
    model = unittest.mock.AsyncMock(spec=BidiModel)
    model.get_connection_config.return_value = {}
    model.send.return_value = None
    model.restart = unittest.mock.AsyncMock()
    return BidiAgent(model=model, tools=[time_tool])


@pytest_asyncio.fixture
async def loop(agent):
    return agent._loop


@pytest_asyncio.fixture
async def streaming_agent(time_tool):
    agent = BidiAgent(model=_StreamModel(), tools=[time_tool])
    await agent.start()
    try:
        yield agent
    finally:
        await agent.stop()


@pytest.mark.asyncio
async def test_response_stop_hook(agent, agenerator):
    hooks = MockHookProvider([BidiResponseStopHookEvent])
    agent.hooks.add_hook(hooks)
    completion = BidiResponseStopEvent(response_id="response-1")
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion]))

    await agent.start()
    try:
        async for event in agent.receive():
            if event == completion:
                break
    finally:
        await agent.stop()

    tru_events = hooks.events_received
    exp_events = [BidiResponseStopHookEvent(agent=agent, response_id="response-1")]
    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_response_without_transcripts_does_not_add_transcript_messages(streaming_agent):
    agent = streaming_agent
    reader = agent.receive()
    hooks = MockHookProvider([MessageAddedEvent, MessageUpdatedEvent])
    agent.hooks.add_hook(hooks)
    for event in [
        BidiResponseStartEvent("response"),
        BidiAudioDeltaEvent("audio", "pcm", 24000, 1, content_id="audio"),
    ]:
        await agent.model.emit(event)
        assert await anext(reader) == event
    assert agent.messages == []
    assert hooks.events_received == []

    call = {"toolUseId": "lookup", "name": "lookup", "input": {}}
    with unittest.mock.patch.object(agent._loop, "_run_tool", new_callable=unittest.mock.AsyncMock):
        for event in [
            ToolUseStreamEvent(current_tool_use=call, delta=""),
            BidiResponseStopEvent("response"),
        ]:
            await agent.model.emit(event)
            assert await anext(reader) == event
    exp_messages = [
        {"role": "assistant", "content": [{"toolUse": call}], "tracking_id": unittest.mock.ANY},
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "lookup",
                        "status": "success",
                        "content": [{"text": "Tool call started. Its result will follow in a separate tool exchange."}],
                    }
                }
            ],
            "metadata": {"custom": {"bidi": {"kind": "tool_dispatch", "tool_use_id": "lookup"}}},
            "tracking_id": unittest.mock.ANY,
        },
    ]
    assert agent.messages == exp_messages
    assert hooks.events_received == [MessageAddedEvent(agent=agent, message=message) for message in exp_messages]
    await reader.aclose()


@pytest.mark.asyncio
async def test_text_and_reasoning_keep_separate_history_blocks(streaming_agent):
    agent = streaming_agent
    reader = agent.receive()
    exp_events = [
        BidiResponseStartEvent("response"),
        BidiReasoningStartEvent("reasoning"),
        BidiTextStartEvent("text"),
        BidiTranscriptStartEvent("assistant", "speech"),
        BidiReasoningDeltaEvent("Checking", "reasoning"),
        BidiTextDeltaEvent("Written", "text"),
        BidiTranscriptDeltaEvent("Spoken", "assistant", "speech"),
        BidiReasoningDeltaEvent(" the facts.", "reasoning"),
        BidiTranscriptDeltaEvent(" answer.", "assistant", "speech"),
        BidiTextDeltaEvent(" answer.", "text"),
        BidiTranscriptStopEvent("assistant", "speech"),
        BidiTranscriptBlockEvent("Spoken answer.", "assistant", "speech"),
        BidiTextStopEvent("text"),
        BidiTextBlockEvent("Written answer.", "text"),
        BidiReasoningStopEvent("reasoning"),
        BidiReasoningBlockEvent("Checking the facts.", "reasoning"),
        BidiResponseStopEvent("response"),
    ]
    for event in exp_events:
        if not isinstance(event, (BidiTextBlockEvent, BidiReasoningBlockEvent, BidiTranscriptBlockEvent)):
            await agent.model.emit(event)
    tru_events = [await anext(reader) for _ in exp_events]
    assert tru_events == exp_events
    tru_messages = agent.messages
    exp_messages = [
        {
            "role": "assistant",
            "content": [{"reasoningContent": {"reasoningText": {"text": "Checking the facts."}}}],
            "metadata": {"custom": {"bidi": {"kind": "reasoning", "status": "complete"}}},
            "tracking_id": unittest.mock.ANY,
        },
        {
            "role": "assistant",
            "content": [{"text": "Written answer."}],
            "metadata": {"custom": {"bidi": {"kind": "text", "status": "complete"}}},
            "tracking_id": unittest.mock.ANY,
        },
        {
            "role": "assistant",
            "content": [{"text": "Spoken answer."}],
            "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "complete"}}},
            "tracking_id": unittest.mock.ANY,
        },
    ]
    assert tru_messages == exp_messages
    await reader.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("reasoning", [False, True])
async def test_unfinished_text_preserves_received_content(streaming_agent, reasoning):
    agent = streaming_agent
    reader = agent.receive()
    start_event = BidiReasoningStartEvent if reasoning else BidiTextStartEvent
    delta_event = BidiReasoningDeltaEvent if reasoning else BidiTextDeltaEvent
    events = [start_event("content"), delta_event("Partial text", "content")]
    for event in events:
        await agent.model.emit(event)
        assert await anext(reader) == event
    await agent.stop()
    exp_content = (
        [{"reasoningContent": {"reasoningText": {"text": "Partial text"}}}] if reasoning else [{"text": "Partial text"}]
    )
    exp_message = {
        "role": "assistant",
        "content": exp_content,
        "metadata": {"custom": {"bidi": {"kind": "reasoning" if reasoning else "text", "status": "incomplete"}}},
        "tracking_id": unittest.mock.ANY,
    }
    assert agent.messages == [exp_message]
    await reader.aclose()


@pytest.mark.asyncio
async def test_receive_executes_tools_before_late_transcription(agent):
    hooks = MockHookProvider([MessageAddedEvent])
    agent.hooks.add_hook(hooks)
    result_sent = asyncio.Event()
    tool_use = {"toolUseId": "tool-b", "name": "time_tool", "input": {}}
    request = ToolUseStreamEvent(current_tool_use=tool_use, delta="")
    request["response_id"] = "a"
    audio = BidiAudioDeltaEvent("audio-a", "pcm", 24000, 1, content_id="audio")
    start_a = BidiResponseStartEvent("a")
    start_b = BidiResponseStartEvent("b")
    answer_a = BidiTranscriptBlockEvent("Checking.", "assistant", content_id="a")
    answer_b = BidiTranscriptBlockEvent("It is noon.", "assistant", content_id="b")
    delta_a = BidiTranscriptDeltaEvent("Checking.", "assistant", content_id="a")
    delta_b = BidiTranscriptDeltaEvent("It is noon.", "assistant", content_id="b")
    complete_a = BidiResponseStopEvent("a")
    complete_b = BidiResponseStopEvent("b")
    transcript = BidiTranscriptBlockEvent("What time is it?", "user", content_id="speech-a")
    transcript_delta = BidiTranscriptDeltaEvent("What time is it?", "user", content_id="speech-a")

    async def send(content, **kwargs):
        assert content == BidiMessage(
            content=[ToolResultBlock(tool_use_id="tool-b", status="success", content=[{"text": "12:00"}])]
        )
        result_sent.set()

    async def receive():
        yield BidiTranscriptStartEvent("user", content_id="speech-a")
        for event in [
            start_a,
            audio,
            BidiTranscriptStartEvent("assistant", content_id="a"),
            delta_a,
            BidiTranscriptStopEvent("assistant", "a"),
            request,
        ]:
            yield event
        await result_sent.wait()
        for event in [
            transcript_delta,
            BidiTranscriptStopEvent("user", "speech-a"),
            complete_a,
            start_b,
            BidiTranscriptStartEvent("assistant", content_id="b"),
            delta_b,
            BidiTranscriptStopEvent("assistant", "b"),
            complete_b,
        ]:
            yield event

    agent.model.receive = receive
    agent.model.send.side_effect = send
    await agent.start()
    reader = agent.receive()
    try:
        assert await anext(reader) == BidiTranscriptStartEvent("user", content_id="speech-a")
        assert await anext(reader) == start_a
        assert await anext(reader) == audio
        tru_events = []

        async def collect():
            async for event in reader:
                tru_events.append(event)
                if event == complete_b:
                    break

        await asyncio.wait_for(collect(), 1)
        result = {"toolUseId": "tool-b", "status": "success", "content": [{"text": "12:00"}]}
        exp_events = [
            BidiTranscriptStartEvent("assistant", content_id="a"),
            delta_a,
            BidiTranscriptStopEvent("assistant", "a"),
            answer_a,
            request,
            ToolResultEvent(result),
            ToolResultMessageEvent(
                {
                    "role": "user",
                    "content": [{"toolResult": result}],
                    "metadata": {"custom": {"bidi": {"kind": "tool_result", "tool_use_id": "tool-b"}}},
                    "tracking_id": unittest.mock.ANY,
                }
            ),
            transcript_delta,
            BidiTranscriptStopEvent("user", "speech-a"),
            transcript,
            complete_a,
            start_b,
            BidiTranscriptStartEvent("assistant", content_id="b"),
            delta_b,
            BidiTranscriptStopEvent("assistant", "b"),
            answer_b,
            complete_b,
        ]
        assert tru_events == exp_events
        assert [message["content"] for message in agent.messages] == [
            [{"text": "What time is it?"}],
            [{"text": "Checking."}],
            [{"toolUse": tool_use}],
            [
                {
                    "toolResult": {
                        "toolUseId": "tool-b",
                        "status": "success",
                        "content": [{"text": "Tool call started. Its result will follow in a separate tool exchange."}],
                    }
                }
            ],
            [{"toolUse": tool_use}],
            [{"toolResult": result}],
            [{"text": "It is noon."}],
        ]
        exp_added = []
        for message in agent.messages:
            if message.get("metadata", {}).get("custom", {}).get("bidi", {}).get("kind") == "transcript":
                message = {
                    **message,
                    "content": [],
                    "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "pending"}}},
                }
            exp_added.append(MessageAddedEvent(agent=agent, message=message))
        assert hooks.events_received == exp_added
    finally:
        await reader.aclose()
        await agent.stop()


@pytest.mark.asyncio
async def test_receive_barge_in_does_not_wait_for_transcription(agent, agenerator):
    start_a = BidiResponseStartEvent("a")
    complete_a = BidiResponseStopEvent("a")
    start_b = BidiResponseStartEvent("b")
    audio_b = BidiAudioDeltaEvent("cancelled", "pcm", 24000, 1, content_id="audio")
    barge_in = BidiBargeInEvent("user_speech")
    complete_b = BidiResponseStopEvent("b")
    transcript = BidiTranscriptBlockEvent("Earlier question.", "user", content_id="speech-a")
    native_events = [
        BidiTranscriptStartEvent("user", content_id="speech-a"),
        start_a,
        BidiTranscriptDeltaEvent("Earlier question.", "user", "speech-a"),
        BidiTranscriptStopEvent("user", "speech-a"),
        complete_a,
        start_b,
        audio_b,
        barge_in,
        complete_b,
    ]
    agent.model.receive = lambda: agenerator(native_events)
    hooks = MockHookProvider([BidiBargeInHookEvent])
    agent.hooks.add_hook(hooks)
    await agent.start()
    reader = agent.receive()
    try:
        exp_events = [*native_events[:4], transcript, *native_events[4:]]
        tru_events = [await asyncio.wait_for(anext(reader), 1) for _ in exp_events]
        assert tru_events == exp_events
        assert hooks.events_received == [BidiBargeInHookEvent(agent=agent, reason="user_speech")]
    finally:
        await reader.aclose()
        await agent.stop()


@pytest.mark.asyncio
async def test_receive_transcription_failure_raises_and_marks_message_incomplete(agent):
    start = BidiTranscriptStartEvent("user", content_id="speech-a")
    partial = BidiTranscriptDeltaEvent("Incomplete", "user", content_id="speech-a")

    async def receive():
        yield start
        yield partial
        raise RuntimeError("Transcription failed.")

    agent.model.receive = receive
    await agent.start()
    reader = agent.receive()
    try:
        exp_events = [start, partial]
        tru_events = [await anext(reader) for _ in exp_events]
        assert tru_events == exp_events
        with pytest.raises(RuntimeError, match="Transcription failed."):
            await anext(reader)
        exp_messages = [
            {
                "role": "user",
                "content": [{"text": "[Transcript unavailable.]"}],
                "tracking_id": unittest.mock.ANY,
                "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "incomplete"}}},
            }
        ]
        assert agent.messages == exp_messages
    finally:
        await reader.aclose()
        await agent.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("restart", [False, True])
async def test_completed_messages_survive_connection_end(agent, agenerator, restart):
    start_a = BidiResponseStartEvent("a")
    answer_a = BidiTranscriptBlockEvent("Answer A.", "assistant", content_id="a")
    warning = BidiConnectionWarningEvent(time_left_s=10)
    events = [
        start_a,
        BidiTranscriptStartEvent("assistant", content_id="a"),
        BidiTranscriptDeltaEvent("Answer A.", "assistant", "a"),
        BidiTranscriptStopEvent("assistant", "a"),
        BidiResponseStopEvent("a"),
        BidiResponseStartEvent("b"),
        BidiAudioDeltaEvent("old audio", "pcm", 24000, 1, content_id="audio"),
        BidiTranscriptStartEvent("assistant", content_id="b"),
        BidiTranscriptDeltaEvent("Answer B.", "assistant", "b"),
        BidiTranscriptStopEvent("assistant", "b"),
        BidiResponseStopEvent("b"),
        warning,
    ]
    agent.model.receive = lambda: agenerator(events)
    await agent.start()
    reader = agent.receive()
    try:
        exp_events = [*events[:4], answer_a]
        assert [await anext(reader) for _ in exp_events] == exp_events
        await agent.send(TextBlock("Question B."))
        exp_events = [*events[4:10], BidiTranscriptBlockEvent("Answer B.", "assistant", "b"), *events[10:]]
        assert [await anext(reader) for _ in exp_events] == exp_events
        exp_content = [[{"text": "Answer A."}], [{"text": "Question B."}], [{"text": "Answer B."}]]
        assert [message["content"] for message in agent.messages] == exp_content

        if restart:
            new_events = [
                BidiResponseStartEvent("b"),
                BidiAudioDeltaEvent("new audio", "pcm", 24000, 1, content_id="audio"),
                BidiResponseStopEvent("b"),
            ]
            agent.model.receive = lambda: agenerator(new_events)
            await agent._loop._restart_connection(None, agent._loop._generation)
            assert [await anext(reader) for _ in new_events] == new_events
        else:
            await agent.stop()

        assert [message["content"] for message in agent.messages] == exp_content
    finally:
        await reader.aclose()
        if agent._started:
            await agent.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content", [TextBlock("Typed question"), ImageBlock(format="jpeg", source={"bytes": b"image"})]
)
async def test_send_complete_input_does_not_wait_for_transcripts(streaming_agent, content):
    agent = streaming_agent
    start = BidiResponseStartEvent("response")
    input_start = BidiTranscriptStartEvent("user", content_id="speech")
    assistant = BidiTranscriptBlockEvent("Answer", "assistant", content_id="response")
    complete = BidiResponseStopEvent("response")
    user = BidiTranscriptBlockEvent("Spoken question", "user", content_id="speech")
    reader = agent.receive()
    try:
        for event in [input_start, start]:
            await agent.model.emit(event)
            assert await anext(reader) == event
        await agent.send(content)
        exp_messages = [
            {
                "role": "user",
                "content": [],
                "tracking_id": unittest.mock.ANY,
                "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "pending"}}},
            },
            {"role": "user", "content": [content.to_dict()], "tracking_id": unittest.mock.ANY},
        ]
        assert agent.messages == exp_messages
        assistant_start = BidiTranscriptStartEvent("assistant", content_id="response")
        await agent.model.emit(assistant_start)
        assert await anext(reader) == assistant_start
        for event in [assistant, user]:
            delta = BidiTranscriptDeltaEvent(event.transcript, event.role, event.content_id)
            stop = BidiTranscriptStopEvent(event.role, event.content_id)
            for model_event in [delta, stop]:
                await agent.model.emit(model_event)
                assert await anext(reader) == model_event
            assert await anext(reader) == event
            exp_message = {
                "role": event.role,
                "content": [{"text": event.transcript}],
                "tracking_id": unittest.mock.ANY,
                "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "complete"}}},
            }
            if event.role == "user":
                exp_messages[0] = exp_message
            else:
                exp_messages.append(exp_message)
            assert agent.messages == exp_messages
        await agent.model.emit(complete)
        assert await anext(reader) == complete
        assert agent.messages == exp_messages
    finally:
        await reader.aclose()


@pytest.mark.asyncio
async def test_model_processes_transcripts_before_consumer_reads(loop, agent, agenerator):
    question = BidiTranscriptBlockEvent("Question", "user", content_id="speech")
    answer = BidiTranscriptBlockEvent("Answer", "assistant", content_id="response")
    answer_processed = asyncio.Event()

    async def on_update(event: MessageUpdatedEvent):
        if event.message["role"] == "assistant":
            answer_processed.set()

    agent.add_hook(on_update)
    starts = [
        BidiTranscriptStartEvent("user", content_id="speech"),
        BidiTranscriptStartEvent("assistant", content_id="response"),
    ]
    deltas = [
        BidiTranscriptDeltaEvent("Question", "user", "speech"),
        BidiTranscriptDeltaEvent("Answer", "assistant", "response"),
    ]
    agent.model.receive = lambda: agenerator(
        [*starts, *deltas, BidiTranscriptStopEvent("user", "speech"), BidiTranscriptStopEvent("assistant", "response")]
    )
    await loop.start()
    reader = loop.receive()
    try:
        assert [await anext(reader) for _ in starts] == starts
        assert [await anext(reader) for _ in deltas] == deltas
        assert await anext(reader) == BidiTranscriptStopEvent("user", "speech")
        await asyncio.wait_for(answer_processed.wait(), 2)
        exp_messages = [
            {
                "role": event.role,
                "content": [{"text": event.transcript}],
                "tracking_id": unittest.mock.ANY,
                "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "complete"}}},
            }
            for event in (question, answer)
        ]
        assert agent.messages == exp_messages
        assert not loop._model_task.done()
        assert await anext(reader) == question
        assert await anext(reader) == BidiTranscriptStopEvent("assistant", "response")
        assert await anext(reader) == answer
    finally:
        await reader.aclose()
        await loop.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("superseded", [False, True])
@pytest.mark.parametrize(
    "stream_event,hook_type",
    [
        (BidiResponseStopEvent(response_id="r1"), BidiResponseStopHookEvent),
        (BidiBargeInEvent(reason="user_speech"), BidiBargeInHookEvent),
        (BidiTranscriptStartEvent(role="assistant", content_id="assistant-transcript"), MessageAddedEvent),
    ],
)
async def test_model_event_waits_for_hook_and_checks_generation(
    loop, agent, agenerator, stream_event, hook_type, superseded
):
    hook_started = asyncio.Event()
    finish_hook = asyncio.Event()

    async def on_event(event):
        hook_started.set()
        await finish_hook.wait()

    agent.hooks.add_callback(hook_type, on_event)
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([stream_event]))
    await loop.start()
    reader = loop.receive()
    read_task = asyncio.create_task(anext(reader))
    try:
        await asyncio.wait_for(hook_started.wait(), timeout=2)
        assert not read_task.done()
        if superseded:
            loop._generation += 1
            loop._response_active = True
            loop._update_turn_state()
        finish_hook.set()
        if superseded:
            closed = BidiConnectionStopEvent(connection_id="c", reason="user_request")
            await loop._event_queue.put(closed)
            assert await asyncio.wait_for(read_task, 2) == closed
            assert loop._response_active
            assert not loop._turn_complete.is_set()
        else:
            assert await asyncio.wait_for(read_task, 2) == stream_event
    finally:
        finish_hook.set()
        read_task.cancel()
        await asyncio.gather(read_task, return_exceptions=True)
        await reader.aclose()
        await loop.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("superseded", [False, True])
async def test_tool_starts_after_request_is_queued(loop, agent, superseded):
    tool_use = {"toolUseId": "tool-1", "name": "time_tool", "input": {}}
    exp_tool_messages = [
        {"role": "assistant", "content": [{"toolUse": tool_use}], "tracking_id": unittest.mock.ANY},
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "tool-1",
                        "status": "success",
                        "content": [{"text": "Tool call started. Its result will follow in a separate tool exchange."}],
                    }
                }
            ],
            "metadata": {"custom": {"bidi": {"kind": "tool_dispatch", "tool_use_id": "tool-1"}}},
            "tracking_id": unittest.mock.ANY,
        },
    ]
    request = ToolUseStreamEvent(current_tool_use=tool_use, delta="")
    first = BidiTranscriptStartEvent(role="assistant", content_id="assistant-transcript")
    request_waiting = asyncio.Event()
    tool_started = asyncio.Event()

    async def receive():
        yield first
        request_waiting.set()
        yield request

    agent.model.receive = receive
    with unittest.mock.patch.object(loop, "_run_tool", new_callable=unittest.mock.AsyncMock) as run_tool:
        run_tool.side_effect = lambda *_: tool_started.set()
        await loop.start()
        reader = loop.receive()
        try:
            await asyncio.wait_for(request_waiting.wait(), 2)
            run_tool.assert_not_called()
            assert agent.messages[1:] == exp_tool_messages
            if superseded:
                loop._generation += 1
                loop._event_queue.get_nowait()
                await asyncio.wait_for(loop._model_task, 2)
                closed = BidiConnectionStopEvent(connection_id="c", reason="user_request")
                closing = asyncio.create_task(loop._event_queue.put(closed))
                assert await asyncio.wait_for(anext(reader), 2) == request
                assert await asyncio.wait_for(anext(reader), 2) == closed
                await closing
                run_tool.assert_not_called()
            else:
                assert await anext(reader) == first
                await asyncio.wait_for(loop._model_task, 2)
                await asyncio.wait_for(tool_started.wait(), 2)
                run_tool.assert_awaited_once_with(tool_use, loop._generation)

                assert await anext(reader) == request
            assert agent.messages[0]["content"] == [{"text": "[Transcript unavailable.]"}]
            assert agent.messages[1:] == exp_tool_messages
        finally:
            await reader.aclose()
            await loop.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("cleanup_fails", [False, True])
async def test_agent_stop_hook(agent, agenerator, cleanup_fails):
    hooks = MockHookProvider([BidiAgentStopEvent, BidiResponseStopHookEvent])
    agent.hooks.add_hook(hooks)
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    if cleanup_fails:
        agent.model.stop.side_effect = RuntimeError("cleanup failed")

    await agent.start()
    assert hooks.events_received == []
    if cleanup_fails:
        with pytest.raises(RuntimeError, match="cleanup failed"):
            await agent.stop()
    else:
        await agent.stop()

    agent.model.stop.assert_awaited_once()
    tru_events = hooks.events_received
    exp_events = [BidiAgentStopEvent(agent=agent)]
    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_bidi_agent_loop_receive_restart_connection(loop, agent, agenerator):
    timeout_error = ConnectionTimeoutError("test timeout", test_restart_config=1)
    close_event = BidiConnectionStopEvent(connection_id="test", reason="complete")

    agent.model.receive = unittest.mock.Mock(side_effect=[timeout_error, agenerator([close_event])])

    invocation_state = {"custom_data": "preserved"}
    await loop.start(invocation_state=invocation_state)

    tru_events = []
    async for event in loop.receive():
        tru_events.append(event)
        if len(tru_events) >= 2:
            break

    exp_events = [
        BidiConnectionRestartEvent(reason="timeout", timeout_error=timeout_error),
        close_event,
    ]
    assert tru_events == exp_events
    assert loop._invocation_state is invocation_state

    # The reactive path restarts through the provider method and forwards the timeout config.
    assert agent.model.start.call_count == 1
    agent.model.restart.assert_called_once_with(
        agent.system_prompt,
        agent.tool_registry.get_all_tool_specs(),
        agent.messages,
        test_restart_config=1,
    )


@pytest.mark.asyncio
async def test_reactive_restart_failure_yields_event_before_raising(loop, agent, agenerator):
    """A failed reactive restart still notifies the caller before surfacing the failure."""
    timeout_error = ConnectionTimeoutError("test timeout")
    restart_error = RuntimeError("restart failed")
    agent.model.get_connection_config.return_value = {}
    agent.model.receive = unittest.mock.Mock(side_effect=timeout_error)
    agent.model.restart.side_effect = restart_error

    await loop.start()
    consumer = loop.receive()

    event = await consumer.__anext__()
    assert event == BidiConnectionRestartEvent(reason="timeout", timeout_error=timeout_error)
    with pytest.raises(RuntimeError, match="restart failed"):
        await consumer.__anext__()

    await loop.stop()


@pytest.mark.asyncio
async def test_bidi_agent_loop_auto_reconnect_default_on(loop, agent, agenerator):
    """Auto reconnect is the default: a timeout triggers reconnect without any opt-in."""
    # An empty connection config uses the default reconnect behavior.
    agent.model.get_connection_config.return_value = {}
    timeout_error = ConnectionTimeoutError("test timeout")
    close_event = BidiConnectionStopEvent(connection_id="test", reason="complete")
    agent.model.receive = unittest.mock.Mock(side_effect=[timeout_error, agenerator([close_event])])

    await loop.start()

    received = []
    async for event in loop.receive():
        received.append(event)
        if len(received) >= 2:
            break

    agent.model.restart.assert_called_once()


@pytest.mark.asyncio
async def test_bidi_agent_loop_auto_reconnect_opt_out_surfaces_timeout(loop, agent, agenerator):
    """A provider opting out with auto_reconnect=False surfaces the timeout instead of reconnecting."""
    agent.model.get_connection_config.return_value = {"auto_reconnect": False}
    timeout_error = ConnectionTimeoutError("test timeout")
    agent.model.receive = unittest.mock.Mock(side_effect=[timeout_error, agenerator([])])

    await loop.start()

    with pytest.raises(ConnectionTimeoutError):
        async for _ in loop.receive():
            pass

    agent.model.restart.assert_not_called()


@pytest.mark.asyncio
async def test_bidi_agent_loop_proactive_reconnect_before_deadline(loop, agent, agenerator):
    """A declared limit arms the timer, which emits a warning and reconnects proactively."""
    agent.model.get_connection_config.return_value = {"restart_after_s": 5}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    # Drive timing without wall time: the first cycle's sleeps return immediately; the re-armed
    # cycle after the swap parks, so exactly one proactive reconnect fires.
    sleep_count = 0

    async def fake_sleep(_seconds):
        nonlocal sleep_count
        sleep_count += 1
        if sleep_count > 2:
            await asyncio.Event().wait()
        await asyncio.sleep(0)

    loop._reconnect_timer._sleep = fake_sleep

    await loop.start()

    # The proactive timer emits the warning and scheduled restart on the bounded event stream.
    warning = await loop._event_queue.get()
    assert warning == BidiConnectionWarningEvent(time_left_s=5)

    restart = await loop._event_queue.get()
    assert restart == BidiConnectionRestartEvent(reason="scheduled", turn_interrupted=False)

    agent.model.restart.assert_called()

    await loop.stop()


@pytest.mark.asyncio
async def test_scheduled_restart_event_emitted_before_model_restart(loop, agent, agenerator):
    """The scheduled restart event precedes provider restart and new-connection output."""
    agent.model.get_connection_config.return_value = {}
    output = BidiTranscriptDeltaEvent(
        delta="new-connection output", role="assistant", content_id="assistant-transcript"
    )
    start = BidiTranscriptStartEvent("assistant", "assistant-transcript")
    agent.model.receive = unittest.mock.Mock(side_effect=[agenerator([]), agenerator([start, output])])
    order = []

    await loop.start()
    loop._reconnect_timer.cancel()

    original_put = loop._event_queue.put

    async def recording_put(event):
        if isinstance(event, BidiConnectionRestartEvent):
            order.append("event")
        await original_put(event)

    agent.model.restart.side_effect = lambda *_args, **_kwargs: order.append("restart")

    with unittest.mock.patch.object(loop._event_queue, "put", side_effect=recording_put):
        await loop._on_reconnect_deadline()

    assert order == ["event", "restart"]
    restart = await loop._event_queue.get()
    assert restart == BidiConnectionRestartEvent(reason="scheduled", turn_interrupted=False)
    assert await asyncio.wait_for(loop._event_queue.get(), timeout=2.0) is start
    assert await asyncio.wait_for(loop._event_queue.get(), timeout=2.0) is output

    await loop.stop()


@pytest.mark.asyncio
async def test_no_proactive_timer_when_restart_after_not_positive(loop, agent, agenerator):
    """A non-positive restart_after_s must not arm a zero-deadline hot reconnect loop."""
    agent.model.get_connection_config.return_value = {"restart_after_s": 0}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    await loop.start()

    assert loop._reconnect_timer._task is None  # proactive disabled; reactive path remains

    await loop.stop()


@pytest.mark.asyncio
async def test_bidi_agent_loop_no_timer_without_declared_limit(loop, agent, agenerator):
    """A provider that declares no limit arms no proactive timer; reconnect stays reactive-only."""
    agent.model.get_connection_config.return_value = {}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    await loop.start()

    assert loop._reconnect_timer._task is None

    await loop.stop()


@pytest.mark.asyncio
async def test_bidi_agent_loop_no_timer_when_auto_reconnect_disabled(loop, agent, agenerator):
    """auto_reconnect=False is the only opt-out: no proactive timer arms."""
    agent.model.get_connection_config.return_value = {"restart_after_s": 420, "auto_reconnect": False}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    await loop.start()

    assert loop._reconnect_timer._task is None

    await loop.stop()


class _NonRestartableModel(BidiModel):
    """A provider without an optimized restart implementation."""

    def __init__(self):
        self.started: list = []
        self.stopped = 0

    def update_config(self, **model_config): ...

    def get_config(self):
        return {"model_id": "test-model"}

    async def start(self, system_prompt=None, tools=None, messages=None, **kwargs):
        self.started.append(system_prompt)

    async def stop(self):
        self.stopped += 1

    def receive(self): ...

    async def send(self, content): ...


@pytest.mark.asyncio
async def test_restart_falls_back_to_stop_start_when_provider_is_not_restartable():
    """A non-restartable provider is restarted through stop() and start()."""
    model = _NonRestartableModel()
    agent = BidiAgent(model=model, system_prompt="hi")

    await agent._loop._restart_model({})

    assert model.stopped == 1
    assert model.started == ["hi"]  # start() called once with the agent's system prompt


class _StreamModel(BidiModel):
    """Reader blocks on a live 'stream' and raises when stop() closes it, like Nova/awscrt.

    The reader is terminated by the stream closing (an OSError), not by a force-cancel, so
    a reconnect must fence that error instead of forwarding it to the consumer.
    """

    def __init__(self):
        self.restart_calls = 0
        self._closed = asyncio.Event()
        self._inbox: asyncio.Queue = asyncio.Queue()

    def update_config(self, **model_config): ...

    def get_config(self):
        return {"model_id": "test-model"}

    async def start(self, system_prompt=None, tools=None, messages=None, **kwargs):
        self._closed = asyncio.Event()
        self._inbox = asyncio.Queue()

    async def stop(self):
        self._closed.set()

    async def restart(self, system_prompt=None, tools=None, messages=None, **kwargs):
        self.restart_calls += 1
        await self.stop()
        await self.start(system_prompt, tools, messages, **kwargs)

    async def send(self, content):
        return None

    async def emit(self, event):
        await self._inbox.put(event)

    async def receive(self):
        closed, inbox = self._closed, self._inbox
        while True:
            getter = asyncio.ensure_future(inbox.get())
            waiter = asyncio.ensure_future(closed.wait())
            done, pending = await asyncio.wait({getter, waiter}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            if waiter in done:
                getter.cancel()
                raise OSError("stream closed")
            yield getter.result()


@pytest.mark.asyncio
async def test_reconnect_fences_superseded_reader_stream_close_error():
    """Reconnect closes the old stream (reader raises); that error must not leak to the consumer."""
    model = _StreamModel()
    agent = BidiAgent(model=model, system_prompt="hi")
    loop = agent._loop

    await loop.start()

    first = BidiConnectionStopEvent(connection_id="first", reason="complete")
    await model.emit(first)
    assert await loop._event_queue.get() is first

    # Proactive-style restart closes the old stream, so the old
    # reader raises OSError. It is superseded, so that error must be dropped, not queued.
    await loop._restart_connection(None, loop._generation)
    assert model.restart_calls == 1

    second = BidiConnectionStopEvent(connection_id="second", reason="complete")
    await model.emit(second)
    # The new connection's event arrives; a leaked OSError would have surfaced here instead.
    assert await loop._event_queue.get() is second

    await loop.stop()


@pytest.mark.asyncio
async def test_stale_reader_event_does_not_corrupt_state_across_reconnect():
    """Usage is recorded before enqueueing and must not be counted again after a reconnect."""
    model = _StreamModel()
    model.usage_is_cumulative = True  # like Nova: usage events report a running total
    agent = BidiAgent(model=model, system_prompt="hi")
    loop = agent._loop

    await loop.start()
    loop._reconnect_timer.cancel()

    await model.emit(BidiUsageEvent(input_tokens=60, output_tokens=40, total_tokens=100))
    await model.emit(BidiUsageEvent(input_tokens=90, output_tokens=60, total_tokens=150))
    for _ in range(30):
        await asyncio.sleep(0)
    # Both cumulative updates are recorded; put(usage2) is suspended on the full queue.
    assert loop._accumulated_total_tokens == 150

    swap = asyncio.create_task(loop._restart_connection(None, loop._generation))
    for _ in range(30):
        await asyncio.sleep(0)
    await loop._event_queue.get()  # drain, unblocking the old reader's put(usage2)
    await swap
    for _ in range(30):
        await asyncio.sleep(0)

    # Resuming the old reader must not record usage2 onto the new connection a second time.
    assert loop._accumulated_total_tokens == 150

    await loop.stop()


async def _feed_after_drain(loop, event):
    """Put ``event`` once the queue has drained (so a maxsize-1 put does not block)."""
    while loop._event_queue.qsize() > 0:
        await asyncio.sleep(0)
    await loop._event_queue.put(event)


@pytest.mark.asyncio
async def test_stale_reader_error_is_dropped_not_raised(loop, agent, agenerator):
    """A generic error from a superseded reader must be dropped, not surfaced into the new connection.

    Without the generation tag, a stale error re-raised by receive() kills the healthy, just-swapped
    session.
    """
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    await loop.start()
    loop._reconnect_timer.cancel()

    # An error raised on a superseded (older) generation.
    await loop._event_queue.put(_ReaderError(loop._generation - 1, OSError("stale connection error")))

    sentinel = BidiConnectionStopEvent(connection_id="after-stale-error", reason="complete")
    feed = asyncio.create_task(_feed_after_drain(loop, sentinel))
    # receive() must drop the stale error and go on to the next event, not raise it.
    result = await asyncio.wait_for(loop.receive().__anext__(), timeout=2.0)
    assert result is sentinel
    await feed

    await loop.stop()


@pytest.mark.asyncio
async def test_current_reader_error_is_surfaced(loop, agent, agenerator):
    """A genuine error from the current reader must still surface to the consumer."""
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    await loop.start()
    loop._reconnect_timer.cancel()

    await loop._event_queue.put(_ReaderError(loop._generation, OSError("live connection error")))

    with pytest.raises(OSError, match="live connection error"):
        await asyncio.wait_for(loop.receive().__anext__(), timeout=2.0)

    await loop.stop()


@pytest.mark.asyncio
async def test_stale_reactive_timeout_dropped_after_proactive_swap(loop, agent, agenerator):
    """A timeout raised on an old generation, dequeued after a proactive swap, must not reconnect again."""
    agent.model.get_connection_config.return_value = {}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    await loop.start()
    loop._reconnect_timer.cancel()

    stale_generation = loop._generation
    await loop._restart_connection(None, loop._generation)  # a proactive swap advances the generation
    restarts = agent.model.restart.call_count

    # A timeout tagged with the pre-swap generation is now stale; receive() must drop it.
    await loop._event_queue.put(_ReaderError(stale_generation, ConnectionTimeoutError("stale timeout")))

    sentinel = BidiConnectionStopEvent(connection_id="after-stale-timeout", reason="complete")
    feed = asyncio.create_task(_feed_after_drain(loop, sentinel))
    result = await asyncio.wait_for(loop.receive().__anext__(), timeout=2.0)
    assert result is sentinel
    await feed
    assert agent.model.restart.call_count == restarts  # no second restart from the stale timeout

    await loop.stop()


@pytest.mark.asyncio
async def test_reactive_timeout_during_scheduled_restart_emits_no_duplicate(loop, agent, agenerator):
    """A timeout cannot emit another restart event after a scheduled restart is accepted."""
    agent.model.get_connection_config.return_value = {}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    hook_started = asyncio.Event()
    release_hook = asyncio.Event()

    async def block_restart(_event):
        hook_started.set()
        await release_hook.wait()

    agent.hooks.add_callback(BidiBeforeConnectionRestartEvent, block_restart)

    await loop.start()
    loop._reconnect_timer.cancel()
    generation = loop._generation

    deadline = asyncio.create_task(loop._on_reconnect_deadline())
    await hook_started.wait()

    consumer = loop.receive()
    scheduled = await consumer.__anext__()
    assert scheduled == BidiConnectionRestartEvent(reason="scheduled")

    await loop._event_queue.put(_ReaderError(generation, ConnectionTimeoutError("duplicate timeout")))
    next_event = asyncio.create_task(consumer.__anext__())
    await asyncio.sleep(0)
    assert not next_event.done()

    sentinel = BidiTranscriptDeltaEvent(
        delta="after duplicate timeout", role="assistant", content_id="assistant-transcript"
    )
    await loop._event_queue.put(sentinel)
    assert await asyncio.wait_for(next_event, timeout=2.0) is sentinel

    release_hook.set()
    await deadline
    agent.model.restart.assert_called_once()

    await loop.stop()


@pytest.mark.asyncio
async def test_connection_events_share_bounded_event_queue(loop, agent, agenerator):
    """Connection events preserve FIFO order and backpressure on the size-one event queue."""
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    await loop.start()
    loop._reconnect_timer.cancel()

    data = BidiTranscriptDeltaEvent(delta="new-connection output", role="assistant", content_id="assistant-transcript")
    await loop._event_queue.put(data)
    warning_put = asyncio.create_task(loop._on_reconnect_warning(10))
    await asyncio.sleep(0)
    assert not warning_put.done()

    first = await asyncio.wait_for(loop.receive().__anext__(), timeout=2.0)
    assert first is data
    await warning_put

    second = await asyncio.wait_for(loop.receive().__anext__(), timeout=2.0)
    assert second == BidiConnectionWarningEvent(time_left_s=10)
    assert loop._event_queue.maxsize == 1

    await loop.stop()


@pytest.mark.asyncio
async def test_connection_event_delivered_while_consumer_idle(loop, agent, agenerator):
    """A connection event emitted while the queue is empty wakes receive()."""
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    await loop.start()
    loop._reconnect_timer.cancel()

    consumer = loop.receive()

    async def emit():
        await asyncio.sleep(0)
        await loop._on_reconnect_warning(10)

    asyncio.create_task(emit())
    first = await asyncio.wait_for(consumer.__anext__(), timeout=2.0)
    assert first == BidiConnectionWarningEvent(time_left_s=10)

    await loop.stop()


@pytest.mark.asyncio
async def test_tool_result_not_sent_when_completed_during_reconnect(agenerator):
    """A tool completing inside the reconnect window must not deliver its result to the new connection.

    The gen re-check after the send gate reopens guards this; the window is opened by a
    suspending before-restart hook (a public extension point).
    """
    order = []
    release_tool = asyncio.Event()

    @tool
    async def slow_tool():
        await release_tool.wait()
        return "result"

    model = unittest.mock.AsyncMock(spec=BidiModel)
    model.restart = unittest.mock.AsyncMock(side_effect=lambda *a, **k: order.append("restart"))
    model.get_connection_config.return_value = {}
    model.send.return_value = "input"
    model.send.side_effect = lambda event: order.append("send")
    model.receive = unittest.mock.Mock(return_value=agenerator([]))

    agent = BidiAgent(model=model, tools=[slow_tool], system_prompt="hi")
    loop = agent._loop
    await loop.start()
    loop._reconnect_timer.cancel()

    async def drain():
        async for _ in loop.receive():
            pass

    drain_task = asyncio.create_task(drain())
    tool_use = {"toolUseId": "t1", "name": "slow_tool", "input": {}}
    tool_task = asyncio.create_task(loop._run_tool(tool_use, loop._generation))
    for _ in range(10):
        await asyncio.sleep(0)

    async def before_restart_hook(event):
        # Release the tool mid-reconnect: the gate is closed but the generation not yet bumped.
        release_tool.set()
        for _ in range(50):
            await asyncio.sleep(0)

    agent.hooks.add_callback(BidiBeforeConnectionRestartEvent, before_restart_hook)

    await loop._restart_connection(None, loop._generation)
    await asyncio.wait_for(tool_task, timeout=2)
    drain_task.cancel()

    assert "send" not in order, f"stale tool result sent to new connection: {order}"


@pytest.mark.asyncio
async def test_stale_reactive_restart_ignored_after_proactive_swap(agent, agenerator):
    """A stale timeout restart (raised for an old generation) must not tear down the new connection."""
    agent.model.get_connection_config.return_value = {}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    loop = agent._loop
    await loop.start()
    loop._reconnect_timer.cancel()

    stale_generation = loop._generation
    await loop._restart_connection(None, loop._generation)  # a proactive swap advances the generation
    assert loop._generation == stale_generation + 1
    restarts = agent.model.restart.call_count

    await loop._restart_connection(ConnectionTimeoutError("stale"), stale_generation)
    assert agent.model.restart.call_count == restarts  # stale trigger ignored

    await loop.stop()


@pytest.mark.asyncio
async def test_deadline_callback_does_not_reconnect_after_stop(agent, agenerator):
    """A proactive deadline callback in flight during stop() must not reconnect the model."""
    agent.model.get_connection_config.return_value = {"restart_after_s": 415}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    loop = agent._loop
    await loop.start()
    loop._reconnect_timer.cancel()

    loop._response_active = True  # mid-turn: the callback waits for the boundary
    loop._update_turn_state()

    deadline_task = asyncio.create_task(loop._on_reconnect_deadline())
    for _ in range(10):
        await asyncio.sleep(0)

    await loop.stop()  # stop() releases the boundary wait; the callback no-ops on _started
    await asyncio.wait_for(deadline_task, timeout=2)

    agent.model.restart.assert_not_called()
    assert loop._event_queue.empty()


@pytest.mark.asyncio
async def test_deadline_callback_does_not_restart_after_stop_while_queue_full(agent, agenerator):
    """A restart blocked on event backpressure must not restart the model after stop()."""
    agent.model.get_connection_config.return_value = {}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    loop = agent._loop
    await loop.start()
    loop._reconnect_timer.cancel()

    queued = BidiTranscriptDeltaEvent(delta="queued", role="assistant", content_id="assistant-transcript")
    await loop._event_queue.put(queued)
    deadline_task = asyncio.create_task(loop._on_reconnect_deadline())
    for _ in range(10):
        await asyncio.sleep(0)
        if loop._reconnecting:
            break
    assert loop._reconnecting

    await loop.stop()
    assert loop._event_queue.get_nowait() is queued
    await asyncio.wait_for(deadline_task, timeout=2)

    agent.model.restart.assert_not_called()
    assert loop._event_queue.get_nowait() == BidiConnectionRestartEvent(reason="scheduled", turn_interrupted=False)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content",
    [
        [TextBlock("hello")],
        [ImageBlock(format="jpeg", source={"bytes": b"image"})],
        [TextBlock("hello"), TextBlock("world")],
    ],
)
async def test_send_complete_input_marks_turn_awaiting_response(loop, agent, agenerator, content):
    """Complete user input keeps scheduled reconnects waiting for a response."""
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    await loop.start()

    await loop.send(BidiMessage(content=content))
    assert loop._awaiting_response is True
    assert not loop._turn_complete.is_set()  # a proactive reconnect would now wait

    await loop.stop()


@pytest.mark.asyncio
async def test_user_transcript_start_marks_turn_awaiting_response(loop, agent):
    """User transcript start keeps scheduled reconnects waiting before any text arrives."""
    start = BidiTranscriptStartEvent(role="user", content_id="speech")
    partial = BidiTranscriptDeltaEvent(delta="what's the", role="user", content_id="speech")
    send_delta = asyncio.Event()

    async def receive():
        yield start
        await send_delta.wait()
        yield partial
        await asyncio.Event().wait()

    agent.model.receive = receive

    await loop.start()
    reader = loop.receive()
    assert await anext(reader) == start
    assert loop._awaiting_response is True
    assert not loop._turn_complete.is_set()

    send_delta.set()
    assert await anext(reader) == partial

    assert loop._awaiting_response is True
    assert not loop._turn_complete.is_set()  # a proactive reconnect would now wait for the reply
    assert agent.messages == [
        {
            "role": "user",
            "content": [],
            "tracking_id": unittest.mock.ANY,
            "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "pending"}}},
        }
    ]

    await reader.aclose()
    await loop.stop()


@pytest.mark.asyncio
async def test_assistant_transcript_does_not_mark_awaiting_response(loop, agent, agenerator):
    """A model (assistant) transcript is output, not an owed user turn, so it must not hold."""
    start = BidiTranscriptStartEvent(role="assistant", content_id="assistant-transcript")
    partial = BidiTranscriptDeltaEvent(delta="hi there", role="assistant", content_id="assistant-transcript")
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([start, partial]))

    await loop.start()
    reader = loop.receive()
    assert [await anext(reader) for _ in range(2)] == [start, partial]

    assert loop._awaiting_response is False
    assert loop._turn_complete.is_set()

    await reader.aclose()
    await loop.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("delta_after_response", [False, True])
async def test_response_stop_clears_awaiting_response(loop, agent, agenerator, delta_after_response):
    """User transcript deltas do not reopen a completed turn."""
    partial = BidiTranscriptDeltaEvent(delta="earlier question", role="user", content_id="speech")
    response_stop = BidiResponseStopEvent(response_id="r1")
    events = [
        BidiResponseStartEvent(response_id="r1"),
        BidiTranscriptStartEvent(role="user", content_id="speech"),
        *([response_stop, partial] if delta_after_response else [partial, response_stop]),
        BidiTranscriptStopEvent(role="user", content_id="speech"),
    ]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator(events))

    await loop.start()
    reader = loop.receive()
    exp_events = [*events, BidiTranscriptBlockEvent("earlier question", "user", "speech")]
    assert [await anext(reader) for _ in exp_events] == exp_events
    assert loop._awaiting_response is False
    assert loop._turn_complete.is_set()  # turn is idle, so a proactive reconnect fires immediately

    await reader.aclose()
    await loop.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["user", "assistant"])
@pytest.mark.parametrize("final_text", ["Hello there", ""])
async def test_transcript_stop_updates_reserved_message(streaming_agent, role, final_text):
    agent = streaming_agent
    reader = agent.receive()
    hooks = MockHookProvider([MessageAddedEvent, MessageUpdatedEvent])
    agent.hooks.add_hook(hooks)
    start = BidiTranscriptStartEvent(role, content_id="speech")
    await agent.model.emit(start)
    assert await anext(reader) == start
    placeholder = agent.messages[0]

    for event in [
        BidiTranscriptDeltaEvent(final_text, role, content_id="speech"),
        BidiTranscriptStopEvent(role, content_id="speech"),
    ]:
        await agent.model.emit(event)
        assert await anext(reader) == event

    exp_message = {
        **placeholder,
        "content": [{"text": final_text}],
        "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "complete"}}},
    }
    assert agent.messages == [exp_message]
    assert placeholder["content"] == []
    assert hooks.events_received == [
        MessageAddedEvent(agent, placeholder),
        MessageUpdatedEvent(agent, placeholder["tracking_id"], exp_message),
    ]
    assert await anext(reader) == BidiTranscriptBlockEvent(final_text, role, "speech")
    await reader.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("second_role", ["user", "assistant"])
async def test_transcripts_finish_in_their_reserved_order(streaming_agent, second_role):
    agent = streaming_agent
    reader = agent.receive()
    starts = [
        BidiTranscriptStartEvent("user", content_id="speech"),
        BidiTranscriptStartEvent(second_role, content_id="second"),
    ]
    for event in starts:
        await agent.model.emit(event)
        assert await anext(reader) == event
    placeholders = agent.messages.copy()
    await agent.send("Typed follow-up")

    events = [
        BidiTranscriptDeltaEvent("Second transcript", second_role, "second"),
        BidiTranscriptStopEvent(second_role, "second"),
        BidiResponseStopEvent("response"),
        BidiTranscriptDeltaEvent("Question", "user", "speech"),
        BidiTranscriptStopEvent("user", "speech"),
    ]
    for event in events:
        await agent.model.emit(event)
    exp_events = [
        *events[:2],
        BidiTranscriptBlockEvent("Second transcript", second_role, "second"),
        *events[2:],
        BidiTranscriptBlockEvent("Question", "user", "speech"),
    ]
    assert [await anext(reader) for _ in exp_events] == exp_events

    exp_messages = [
        {
            **message,
            "content": [{"text": text}],
            "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "complete"}}},
        }
        for message, text in zip(placeholders, ("Question", "Second transcript"), strict=True)
    ]
    exp_messages.append({"role": "user", "content": [{"text": "Typed follow-up"}], "tracking_id": unittest.mock.ANY})
    assert agent.messages == exp_messages
    await reader.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("restart", [False, True])
async def test_unfinished_transcripts_end_with_the_connection(streaming_agent, restart):
    agent = streaming_agent
    reader = agent.receive()
    start = BidiTranscriptStartEvent("user", content_id="speech")
    for event in [start, BidiTranscriptDeltaEvent("Unfinished", "user", content_id="speech")]:
        await agent.model.emit(event)
        assert await anext(reader) == event
    placeholder = agent.messages[0]

    if restart:
        await agent._loop._restart_connection(None, agent._loop._generation)
    else:
        await agent.stop()

    exp_message = {
        **placeholder,
        "content": [{"text": "[Transcript unavailable.]"}],
        "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "incomplete"}}},
    }
    assert agent.messages == [exp_message]
    if restart:
        for event in [
            start,
            BidiTranscriptDeltaEvent("New question", "user", "speech"),
            BidiTranscriptStopEvent("user", "speech"),
        ]:
            await agent.model.emit(event)
            assert await anext(reader) == event
        assert await anext(reader) == BidiTranscriptBlockEvent("New question", "user", "speech")
        assert agent.messages == [
            exp_message,
            {
                "role": "user",
                "content": [{"text": "New question"}],
                "tracking_id": unittest.mock.ANY,
                "metadata": {"custom": {"bidi": {"kind": "transcript", "status": "complete"}}},
            },
        ]
        assert agent.messages[1]["tracking_id"] != placeholder["tracking_id"]
    await reader.aclose()


@pytest.mark.asyncio
async def test_transcript_stop_raises_when_message_removed(streaming_agent):
    agent = streaming_agent
    reader = agent.receive()
    hooks = MockHookProvider([MessageUpdatedEvent])
    agent.hooks.add_hook(hooks)
    start = BidiTranscriptStartEvent("user", content_id="speech")
    await agent.model.emit(start)
    assert await anext(reader) == start
    agent.messages.clear()
    stop = BidiTranscriptStopEvent("user", content_id="speech")
    await agent.model.emit(stop)
    with pytest.raises(RuntimeError, match="message not found in history"):
        await anext(reader)
    assert agent.messages == []
    assert hooks.events_received == []
    await reader.aclose()


@pytest.mark.asyncio
async def test_forced_swap_flags_interrupted_turn(agent, agenerator):
    """A swap forced while a turn is owed sets turn_interrupted so the app can re-prompt."""
    agent.model.get_connection_config.return_value = {"restart_after_s": 415}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    loop = agent._loop
    await loop.start()
    loop._reconnect_timer.cancel()

    loop._response_active = True  # a turn is in progress and will not complete in time
    loop._update_turn_state()

    # Force the turn-alignment wait to time out immediately (no wall-clock wait).
    with unittest.mock.patch("strands.experimental.bidi.agent.loop._MODEL_RESTART_TURN_TIMEOUT_S", 0):
        await loop._on_reconnect_deadline()

    restart = await loop._event_queue.get()
    assert restart == BidiConnectionRestartEvent(reason="scheduled", turn_interrupted=True)

    await loop.stop()


@pytest.mark.asyncio
async def test_proactive_reconnect_waits_for_turn_boundary(loop, agent, agenerator):
    """A proactive reconnect defers until the in-progress turn completes (turn alignment)."""
    # The real timer is cancelled so the deadline is driven manually; the turn state is set
    # directly, and _await_turn_boundary waits up to _MODEL_RESTART_TURN_TIMEOUT_S for the boundary.
    agent.model.get_connection_config.return_value = {"restart_after_s": 60}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    await loop.start()
    loop._reconnect_timer.cancel()

    # Mid-response: not at a turn boundary.
    loop._response_active = True
    loop._update_turn_state()

    deadline = asyncio.create_task(loop._on_reconnect_deadline())
    for _ in range(10):
        await asyncio.sleep(0)
    assert not agent.model.restart.called  # held: the turn has not finished

    # Turn completes -> boundary reached -> reconnect proceeds.
    loop._response_active = False
    loop._update_turn_state()
    await deadline
    assert agent.model.restart.called

    await loop.stop()


@pytest.mark.asyncio
async def test_bidi_agent_loop_restart_hook_reports_reason(loop, agent, agenerator):
    """The reactive path reports reason='timeout' with the error; proactive reports 'scheduled' with None."""
    from strands.experimental.bidi.hooks import BidiBeforeConnectionRestartEvent

    before_events = []
    agent.hooks.add_callback(
        BidiBeforeConnectionRestartEvent, lambda event: before_events.append((event.reason, event.timeout_error))
    )
    agent.model.get_connection_config.return_value = {}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    await loop.start()

    timeout_error = ConnectionTimeoutError("boom")
    await loop._restart_connection(timeout_error, loop._generation)
    await loop._restart_connection(None, loop._generation)

    assert before_events[0] == ("timeout", timeout_error)
    assert before_events[1] == ("scheduled", None)

    await loop.stop()


@pytest.mark.asyncio
async def test_bidi_agent_loop_reconnect_is_reentrancy_guarded(loop, agent, agenerator):
    """A second trigger arriving while a reconnect is in flight is a no-op, not a racing duplicate."""
    agent.model.get_connection_config.return_value = {}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    # Block the restart so the first call holds the guard while the second is attempted.
    release = asyncio.Event()
    restart_calls = 0

    async def blocking_restart(*_args, **_kwargs):
        nonlocal restart_calls
        restart_calls += 1
        await release.wait()

    agent.model.restart = blocking_restart

    await loop.start()

    first = asyncio.create_task(loop._restart_connection(None, loop._generation))
    for _ in range(10):
        await asyncio.sleep(0)
        if restart_calls == 1:
            break

    # First restart is now suspended mid-flight, still holding the guard.
    await loop._restart_connection(None, loop._generation)
    assert restart_calls == 1

    release.set()
    await first
    assert restart_calls == 1

    await loop.stop()


@pytest.mark.asyncio
async def test_bidi_agent_loop_proactive_reconnect_completes_when_reconnect_suspends(loop, agent, agenerator):
    """The proactive reconnect runs on the timer's task, so it must not cancel itself mid-flight.

    Guards against the timer cancelling the very task running its deadline callback: with a
    reconnect that actually suspends, a self-cancel would abort the swap and leave the gate closed.
    """
    agent.model.get_connection_config.return_value = {"restart_after_s": 5}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    restart_done = False

    async def suspending_restart(*_args, **_kwargs):
        nonlocal restart_done
        await asyncio.sleep(0)  # genuine suspension after the timer fires its deadline
        restart_done = True

    agent.model.restart = suspending_restart

    # Drive timing without wall time: the first cycle fires immediately, the re-armed cycle parks.
    sleep_count = 0

    async def fake_sleep(_seconds):
        nonlocal sleep_count
        sleep_count += 1
        if sleep_count > 2:
            await asyncio.Event().wait()
        await asyncio.sleep(0)

    loop._reconnect_timer._sleep = fake_sleep

    await loop.start()

    # Drain notification events like a real consumer, so the proactive path is not blocked
    # enqueuing the warning/restart events on the size-1 queue before it reconnects.
    for _ in range(50):
        await asyncio.sleep(0)
        while not loop._event_queue.empty():
            loop._event_queue.get_nowait()
        if restart_done:
            break

    assert restart_done
    assert loop._send_gate.is_set()

    await loop.stop()


@pytest.mark.asyncio
async def test_bidi_agent_loop_cumulative_usage_not_double_counted(loop, agent, agenerator):
    """Cumulative providers replace running counts rather than summing successive totals."""
    from strands.experimental.bidi.types import BidiUsageEvent

    agent.model.usage_is_cumulative = True
    events = [
        BidiUsageEvent(input_tokens=100, output_tokens=50, total_tokens=150),
        BidiUsageEvent(input_tokens=250, output_tokens=120, total_tokens=370),
    ]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator(events))

    await loop.start()

    received = []
    async for event in loop.receive():
        received.append(event)
        if len(received) >= 2:
            break

    # Latest cumulative total wins (370), not the sum of the two events (520).
    assert loop._accumulated_input_tokens == 250
    assert loop._accumulated_output_tokens == 120
    assert loop._accumulated_total_tokens == 370

    await loop.stop()


@pytest.mark.asyncio
async def test_bidi_agent_loop_receive_tool_use(loop, agent, agenerator):
    tool_use = {"toolUseId": "t1", "name": "time_tool", "input": {}}
    tool_result = {"toolUseId": "t1", "status": "success", "content": [{"text": "12:00"}]}

    tool_use_event = ToolUseStreamEvent(current_tool_use=tool_use, delta="")
    tool_result_event = ToolResultEvent(tool_result)

    agent.model.receive = unittest.mock.Mock(return_value=agenerator([tool_use_event]))

    await loop.start()

    tru_events = []
    async for event in loop.receive():
        tru_events.append(event)
        if len(tru_events) >= 3:
            break

    tool_use_message = {"role": "assistant", "content": [{"toolUse": tool_use}], "tracking_id": unittest.mock.ANY}
    result_message = {
        "role": "user",
        "content": [{"toolResult": tool_result}],
        "metadata": {"custom": {"bidi": {"kind": "tool_result", "tool_use_id": "t1"}}},
        "tracking_id": unittest.mock.ANY,
    }
    exp_events = [
        tool_use_event,
        tool_result_event,
        ToolResultMessageEvent(result_message),
    ]
    assert tru_events == exp_events

    exp_messages = [
        tool_use_message,
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t1",
                        "status": "success",
                        "content": [{"text": "Tool call started. Its result will follow in a separate tool exchange."}],
                    }
                }
            ],
            "metadata": {"custom": {"bidi": {"kind": "tool_dispatch", "tool_use_id": "t1"}}},
            "tracking_id": unittest.mock.ANY,
        },
        tool_use_message,
        result_message,
    ]
    assert agent.messages == exp_messages

    await asyncio.sleep(0)
    agent.model.send.assert_awaited_once_with(
        BidiMessage(content=[ToolResultBlock(tool_use_id="t1", status="success", content=tool_result["content"])])
    )


@pytest.mark.asyncio
async def test_tool_exchanges_remain_paired_when_results_finish_out_of_order(streaming_agent):
    agent = streaming_agent
    released = {name: asyncio.Event() for name in ("first", "second")}

    @tool
    async def delayed(name: str) -> str:
        """Wait until the caller releases this tool."""
        await released[name].wait()
        return name

    agent.tool_registry.register_tool(delayed)
    reader = agent.receive()
    calls = [{"toolUseId": name, "name": delayed.tool_name, "input": {"name": name}} for name in released]
    exp_messages = []
    try:
        for call in calls:
            request = ToolUseStreamEvent(current_tool_use=call, delta="")
            await agent.model.emit(request)
            assert await asyncio.wait_for(anext(reader), 2) == request
            dispatch = {"toolUseId": call["toolUseId"], "status": "success", "content": unittest.mock.ANY}
            exp_messages.extend([("assistant", [{"toolUse": call}]), ("user", [{"toolResult": dispatch}])])

        for event in [
            BidiTranscriptStartEvent("assistant", content_id="answer"),
            BidiTranscriptDeltaEvent("I can answer while those run.", "assistant", content_id="answer"),
            BidiTranscriptStopEvent("assistant", content_id="answer"),
        ]:
            await agent.model.emit(event)
            assert await asyncio.wait_for(anext(reader), 2) == event
        assert await anext(reader) == BidiTranscriptBlockEvent(
            "I can answer while those run.", "assistant", content_id="answer"
        )
        exp_messages.append(("assistant", [{"text": "I can answer while those run."}]))

        for call in reversed(calls):
            name = call["toolUseId"]
            released[name].set()
            result = {"toolUseId": name, "status": "success", "content": [{"text": name}]}
            assert await asyncio.wait_for(anext(reader), 2) == ToolResultEvent(result)
            assert isinstance(await asyncio.wait_for(anext(reader), 2), ToolResultMessageEvent)
            exp_messages.extend([("assistant", [{"toolUse": call}]), ("user", [{"toolResult": result}])])

        assert [(message["role"], message["content"]) for message in agent.messages] == exp_messages
    finally:
        await reader.aclose()


@pytest.mark.asyncio
async def test_bidi_agent_loop_tool_result_not_sent_after_reconnect(loop, agent, agenerator):
    """A tool completing after a reconnect records its result but does not send it.

    The tool_use_id is scoped to the connection that issued the call; sending the result to
    the reconnected connection would be rejected by the provider (e.g. Nova
    "Not expecting a tool result") and end the session.
    """
    tool_use = {"toolUseId": "t1", "name": "time_tool", "input": {}}

    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    await loop.start()

    # A reconnect during tool execution advances the connection generation.
    issuing_generation = loop._generation
    loop._generation += 1

    # Drain the event queue (maxsize=1) so _run_tool's puts do not block.
    async def drain():
        async for _ in loop.receive():
            pass

    drain_task = asyncio.create_task(drain())
    try:
        await loop._run_tool(tool_use, issuing_generation)
        await asyncio.sleep(0)
    finally:
        drain_task.cancel()

    # The completed exchange is recorded for the provider's reconnect replay...
    assert [message["role"] for message in agent.messages] == ["assistant", "user"]
    assert agent.messages[0]["content"] == [{"toolUse": tool_use}]
    assert agent.messages[-1]["content"] == [
        {
            "toolResult": {
                "toolUseId": "t1",
                "status": "success",
                "content": [{"text": "12:00"}],
            }
        }
    ]
    # ...but the stale result is not sent to the reconnected connection.
    agent.model.send.assert_not_called()


@pytest.mark.asyncio
async def test_bidi_agent_loop_request_state_initialized_for_tools(loop, agent, agenerator):
    """Test that request_state is initialized in invocation_state before tool execution.

    This ensures request_state exists for tools that may need it via invocation_state,
    even when invocation_state is not provided by the user.
    """
    tool_use = {"toolUseId": "t2", "name": "time_tool", "input": {}}
    tool_use_event = ToolUseStreamEvent(current_tool_use=tool_use, delta="")

    agent.model.receive = unittest.mock.Mock(return_value=agenerator([tool_use_event]))

    # Start without providing invocation_state
    await loop.start()

    tru_events = []
    async for event in loop.receive():
        tru_events.append(event)
        if len(tru_events) >= 3:
            break

    # Verify tool executed successfully
    tool_result_event = tru_events[1]
    assert isinstance(tool_result_event, ToolResultEvent)
    assert tool_result_event.tool_result["status"] == "success"

    # Verify request_state was initialized in invocation_state
    assert "request_state" in loop._invocation_state
    assert isinstance(loop._invocation_state["request_state"], dict)


@pytest.mark.asyncio
async def test_bidi_agent_loop_stop_event_loop_flag(agent, agenerator):
    """Test that the stop_event_loop flag in request_state gracefully closes the connection.

    This simulates a tool (like strands_tools.stop) setting the flag via invocation_state.
    """
    # Use a tool that modifies invocation_state to set the stop flag
    # We'll mock the tool executor to simulate this behavior
    loop = agent._loop

    tool_use = {"toolUseId": "t3", "name": "time_tool", "input": {}}
    tool_use_event = ToolUseStreamEvent(current_tool_use=tool_use, delta="")

    agent.model.receive = unittest.mock.Mock(return_value=agenerator([tool_use_event]))

    # Start with request_state that already has stop_event_loop=True
    # This simulates a tool having set it during execution
    await loop.start(invocation_state={"request_state": {"stop_event_loop": True}})

    tru_events = []
    async for event in loop.receive():
        tru_events.append(event)

    # Should receive: tool_use_event, tool_result_event, tool_result_message, connection_stop
    assert len(tru_events) == 4

    # Verify tool executed successfully
    tool_result_event = tru_events[1]
    assert isinstance(tool_result_event, ToolResultEvent)
    assert tool_result_event.tool_result["status"] == "success"

    # Verify connection stop event was emitted
    connection_stop_event = tru_events[3]
    assert isinstance(connection_stop_event, BidiConnectionStopEvent)
    assert connection_stop_event["reason"] == "user_request"

    # Verify model.send was NOT called (tool result not sent to model)
    agent.model.send.assert_not_called()


@pytest.mark.asyncio
async def test_bidi_agent_loop_stop_conversation_deprecated_but_works(loop, agent, agenerator):
    """Test that stop_conversation tool still works but emits a deprecation warning.

    The stop_conversation tool is deprecated in favor of request_state["stop_event_loop"],
    but should continue to work for backward compatibility via the name-based check.
    """
    from strands.experimental.bidi.tools import stop_conversation

    agent.tool_registry.register_tool(stop_conversation)

    tool_use = {"toolUseId": "t5", "name": "stop_conversation", "input": {}}
    tool_use_event = ToolUseStreamEvent(current_tool_use=tool_use, delta="")

    agent.model.receive = unittest.mock.Mock(return_value=agenerator([tool_use_event]))

    await loop.start()

    tru_events = []
    with warnings.catch_warnings(record=True) as caught_warnings:
        warnings.simplefilter("always")
        async for event in loop.receive():
            tru_events.append(event)

    # Should receive: tool_use_event, tool_result_event, tool_result_message, connection_stop
    assert len(tru_events) == 4

    # Verify tool executed successfully
    tool_result_event = tru_events[1]
    assert isinstance(tool_result_event, ToolResultEvent)
    assert tool_result_event.tool_result["status"] == "success"
    assert "Ending conversation" in tool_result_event.tool_result["content"][0]["text"]

    # Verify connection stop event was emitted
    connection_stop_event = tru_events[3]
    assert isinstance(connection_stop_event, BidiConnectionStopEvent)
    assert connection_stop_event["reason"] == "user_request"

    # Verify model.send was NOT called (tool result not sent to model)
    agent.model.send.assert_not_called()

    # Verify deprecation warnings were emitted (from both the tool itself and the loop name check)
    deprecation_warnings = [w for w in caught_warnings if issubclass(w.category, DeprecationWarning)]
    assert len(deprecation_warnings) >= 1
    assert any("stop_conversation" in str(w.message).lower() for w in deprecation_warnings)


@pytest.mark.asyncio
@pytest.mark.parametrize("invocation_state", [{}, {"custom_data": "preserved"}])
async def test_tools_share_invocation_state(agent, agenerator, invocation_state):
    """Tools, hooks, and the caller share state throughout the invocation."""
    exp_state = {**invocation_state, "call_count": 2, "request_state": {}}
    tool_states = []

    @tool(context=True)
    async def count_calls(tool_context: ToolContext) -> str:
        """Count calls in the shared invocation state."""
        state = tool_context.invocation_state
        tool_states.append(state)
        state["call_count"] = state.get("call_count", 0) + 1
        return str(state["call_count"])

    agent.tool_registry.register_tool(count_calls)
    hooks = MockHookProvider([BeforeToolCallEvent, AfterToolCallEvent])
    agent.hooks.add_hook(hooks)
    tool_uses = [{"toolUseId": f"call-{number}", "name": count_calls.tool_name, "input": {}} for number in (1, 2)]
    agent.model.receive = unittest.mock.Mock(
        return_value=agenerator([ToolUseStreamEvent(current_tool_use=tool_use, delta="") for tool_use in tool_uses])
    )

    await agent.start(invocation_state=invocation_state)
    tru_results = []
    try:
        async for event in agent.receive():
            if isinstance(event, ToolResultMessageEvent):
                tru_results.append(event["message"]["content"][0]["toolResult"])
                if len(tru_results) == len(tool_uses):
                    break
    finally:
        await agent.stop()

    exp_results = [
        {"toolUseId": f"call-{number}", "status": "success", "content": [{"text": str(number)}]} for number in (1, 2)
    ]
    assert tru_results == exp_results
    assert all(state is invocation_state for state in tool_states)
    assert len(hooks.events_received) == 2 * len(tool_uses)
    assert all(event.invocation_state is invocation_state for event in hooks.events_received)
    tru_state = {key: invocation_state[key] for key in exp_state}
    assert tru_state == exp_state


@pytest.mark.asyncio
async def test_bidi_agent_loop_send_appends_user_text_message(loop, agent, agenerator):
    agent.model.receive = lambda: agenerator([])
    await loop.start()
    try:
        await loop.send(BidiMessage(content=[TextBlock("injected context")]))
        assert agent.messages == [
            {
                "role": "user",
                "content": [{"text": "injected context"}],
                "tracking_id": unittest.mock.ANY,
            }
        ]
    finally:
        await loop.stop()
