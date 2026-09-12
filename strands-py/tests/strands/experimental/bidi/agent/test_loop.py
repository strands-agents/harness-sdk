import asyncio
import unittest.mock
import warnings

import pytest
import pytest_asyncio

from strands import ToolContext, tool
from strands.experimental.bidi import BidiAgent
from strands.experimental.bidi.agent.loop import _ReaderError
from strands.experimental.bidi.hooks.events import BidiAgentStopEvent, BidiBeforeConnectionRestartEvent
from strands.experimental.bidi.hooks.events import BidiInterruptionEvent as BidiInterruptionHookEvent
from strands.experimental.bidi.hooks.events import BidiResponseCompleteEvent as BidiResponseCompleteHookEvent
from strands.experimental.bidi.models import BidiModel, BidiModelTimeoutError
from strands.experimental.bidi.types.events import (
    BidiConnectionCloseEvent,
    BidiConnectionRestartEvent,
    BidiConnectionWarningEvent,
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTextInputEvent,
    BidiToolUsesCompleteEvent,
    BidiTranscriptCompleteEvent,
    BidiTranscriptStreamEvent,
    BidiUsageEvent,
)
from strands.hooks import AfterToolCallEvent, AfterToolsEvent, BeforeToolCallEvent, BeforeToolsEvent, MessageAddedEvent
from strands.tools.executors import ConcurrentToolExecutor, SequentialToolExecutor
from strands.types._events import ToolResultEvent, ToolResultMessageEvent, ToolUseStreamEvent
from tests.fixtures.mock_hook_provider import MockHookProvider


def _tool_group_event(*tool_uses):
    return BidiToolUsesCompleteEvent(
        {"role": "assistant", "content": [{"toolUse": tool_use} for tool_use in tool_uses]}
    )


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
    model.restart = unittest.mock.AsyncMock()
    return BidiAgent(model=model, tools=[time_tool])


@pytest_asyncio.fixture
async def loop(agent):
    return agent._loop


@pytest.mark.asyncio
@pytest.mark.parametrize("stop_reason", ["complete", "interrupted", "error", "tool_use"])
async def test_response_complete_hook(agent, agenerator, stop_reason):
    hooks = MockHookProvider([BidiResponseCompleteHookEvent])
    agent.hooks.add_hook(hooks)
    completion = BidiResponseCompleteEvent(response_id="response-1", stop_reason=stop_reason)
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion]))

    await agent.start()
    try:
        async for event in agent.receive():
            if event == completion:
                break
    finally:
        await agent.stop()

    tru_events = hooks.events_received
    exp_events = [BidiResponseCompleteHookEvent(agent=agent, response_id="response-1", stop_reason=stop_reason)]
    assert tru_events == exp_events


@pytest.mark.asyncio
@pytest.mark.parametrize("superseded", [False, True])
@pytest.mark.parametrize(
    "stream_event,hook_type",
    [
        (BidiResponseCompleteEvent(response_id="r1", stop_reason="complete"), BidiResponseCompleteHookEvent),
        (BidiInterruptionEvent(reason="user_speech"), BidiInterruptionHookEvent),
        (BidiTranscriptCompleteEvent(transcript="Hello", role="assistant"), MessageAddedEvent),
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
    try:
        await asyncio.wait_for(hook_started.wait(), timeout=2)
        assert loop._event_queue.empty()

        if superseded:
            # A new connection starts a response while the old reader is awaiting a hook.
            loop._generation += 1
            loop._response_active = True
            loop._update_turn_state()

        finish_hook.set()
        await asyncio.wait_for(loop._model_task, timeout=2)
        if superseded:
            assert loop._event_queue.empty()
            assert loop._response_active
            assert not loop._turn_complete.is_set()
        else:
            assert loop._event_queue.get_nowait() == stream_event
    finally:
        finish_hook.set()
        await loop.stop()


@pytest.mark.asyncio
async def test_tool_stream_event_is_visibility_only(loop, agent, agenerator):
    tool_use = {"toolUseId": "tool-1", "name": "time_tool", "input": {}}
    request = ToolUseStreamEvent(current_tool_use=tool_use, delta="")
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([request]))
    with unittest.mock.patch.object(loop, "_run_tools", new_callable=unittest.mock.AsyncMock) as run_tools:
        await loop.start()
        try:
            await asyncio.wait_for(loop._model_task, timeout=2)
            assert loop._event_queue.get_nowait() == request
            run_tools.assert_not_called()
        finally:
            await loop.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("superseded", [False, True])
async def test_tool_group_starts_after_completion_event_is_queued(loop, agent, superseded):
    tool_use = {"toolUseId": "tool-1", "name": "time_tool", "input": {}}
    completion = _tool_group_event(tool_use)
    first = BidiTextInputEvent(text="first")
    completion_available = asyncio.Event()

    async def receive():
        yield first
        completion_available.set()
        yield completion

    started = asyncio.Event()

    async def run_tools(message, generation):
        assert not loop._turn_complete.is_set()
        started.set()
        loop._end_tool_batch()

    agent.model.receive = receive
    with unittest.mock.patch.object(loop, "_run_tools", new=run_tools):
        await loop.start()
        try:
            await asyncio.wait_for(completion_available.wait(), timeout=2)
            assert not started.is_set()
            if superseded:
                loop._generation += 1

            assert loop._event_queue.get_nowait() == first
            await asyncio.wait_for(loop._model_task, timeout=2)
            assert loop._event_queue.get_nowait() == completion
            if superseded:
                assert not started.is_set()
            else:
                await asyncio.wait_for(started.wait(), timeout=2)
        finally:
            await loop.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("cleanup_fails", [False, True])
async def test_agent_stop_hook(agent, agenerator, cleanup_fails):
    hooks = MockHookProvider([BidiAgentStopEvent, BidiResponseCompleteHookEvent])
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
    timeout_error = BidiModelTimeoutError("test timeout", test_restart_config=1)
    text_event = BidiTextInputEvent(text="test after restart")

    agent.model.receive = unittest.mock.Mock(side_effect=[timeout_error, agenerator([text_event])])

    invocation_state = {"custom_data": "preserved"}
    await loop.start(invocation_state=invocation_state)

    tru_events = []
    async for event in loop.receive():
        tru_events.append(event)
        if len(tru_events) >= 2:
            break

    exp_events = [
        BidiConnectionRestartEvent(reason="timeout", timeout_error=timeout_error),
        text_event,
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
    timeout_error = BidiModelTimeoutError("test timeout")
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
    timeout_error = BidiModelTimeoutError("test timeout")
    text_event = BidiTextInputEvent(text="after restart")
    agent.model.receive = unittest.mock.Mock(side_effect=[timeout_error, agenerator([text_event])])

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
    timeout_error = BidiModelTimeoutError("test timeout")
    agent.model.receive = unittest.mock.Mock(side_effect=[timeout_error, agenerator([])])

    await loop.start()

    with pytest.raises(BidiModelTimeoutError):
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
    output = BidiTextInputEvent(text="new-connection output")
    agent.model.receive = unittest.mock.Mock(side_effect=[agenerator([]), agenerator([output])])
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

    async def send_tool_results(self, message): ...


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

    async def send_tool_results(self, message):
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

    first = BidiTextInputEvent(text="first")
    await model.emit(first)
    assert await loop._event_queue.get() is first

    # Proactive-style restart closes the old stream, so the old
    # reader raises OSError. It is superseded, so that error must be dropped, not queued.
    await loop._restart_connection(None, loop._generation)
    assert model.restart_calls == 1

    second = BidiTextInputEvent(text="second")
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

    sentinel = BidiTextInputEvent(text="after stale error")
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
    await loop._event_queue.put(_ReaderError(stale_generation, BidiModelTimeoutError("stale timeout")))

    sentinel = BidiTextInputEvent(text="after stale timeout")
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

    await loop._event_queue.put(_ReaderError(generation, BidiModelTimeoutError("duplicate timeout")))
    next_event = asyncio.create_task(consumer.__anext__())
    await asyncio.sleep(0)
    assert not next_event.done()

    sentinel = BidiTextInputEvent(text="after duplicate timeout")
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

    data = BidiTextInputEvent(text="new-connection output")
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
    model.send_tool_results.side_effect = lambda message: order.append("send")
    model.receive = unittest.mock.Mock(return_value=agenerator([]))

    agent = BidiAgent(model=model, tools=[slow_tool], system_prompt="hi")
    loop = agent._loop
    await loop.start()
    loop._reconnect_timer.cancel()

    async def drain():
        while True:
            await loop._event_queue.get()

    drain_task = asyncio.create_task(drain())
    tool_use = {"toolUseId": "t1", "name": "slow_tool", "input": {}}
    loop._begin_tool_batch()
    tool_task = asyncio.create_task(loop._run_tools(_tool_group_event(tool_use).message, loop._generation))
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

    await loop._restart_connection(BidiModelTimeoutError("stale"), stale_generation)
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

    queued = BidiTextInputEvent(text="queued")
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
async def test_send_user_text_marks_turn_awaiting_response(loop, agent, agenerator):
    """A user text turn owes a reply, so it holds the turn boundary like a finished audio turn."""
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    await loop.start()

    await loop.send(BidiTextInputEvent(text="hello", role="user"))
    assert loop._awaiting_response is True
    assert not loop._turn_complete.is_set()  # a proactive reconnect would now wait

    await loop.stop()


@pytest.mark.asyncio
async def test_send_assistant_text_does_not_mark_awaiting_response(loop, agent, agenerator):
    """Injected assistant context is not an owed user turn and must not hold the boundary."""
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    await loop.start()

    await loop.send(BidiTextInputEvent(text="injected context", role="assistant"))
    assert loop._awaiting_response is False
    assert loop._turn_complete.is_set()

    await loop.stop()


@pytest.mark.asyncio
async def test_user_transcript_marks_turn_awaiting_response(loop, agent, agenerator):
    """An incremental user transcript owes a reply but is not committed to history."""
    partial = BidiTranscriptStreamEvent(delta="what's the", role="user")
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([partial]))

    await loop.start()
    for _ in range(10):
        await asyncio.sleep(0)

    assert loop._awaiting_response is True
    assert not loop._turn_complete.is_set()  # a proactive reconnect would now wait for the reply
    assert agent.messages == []  # non-final transcript is not committed to history

    await loop.stop()


@pytest.mark.asyncio
async def test_assistant_transcript_does_not_mark_awaiting_response(loop, agent, agenerator):
    """A model (assistant) transcript is output, not an owed user turn, so it must not hold."""
    partial = BidiTranscriptStreamEvent(delta="hi there", role="assistant")
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([partial]))

    await loop.start()
    for _ in range(10):
        await asyncio.sleep(0)

    assert loop._awaiting_response is False

    await loop.stop()


@pytest.mark.asyncio
async def test_response_complete_clears_awaiting_response(loop, agent, agenerator):
    """A completed reply clears the awaited-response latch, so a user transcript that lagged into
    the reply does not leave the turn falsely open (which would burn the alignment wait and flag a
    spurious turn_interrupted)."""
    events = [
        BidiResponseStartEvent(response_id="r1"),
        # A lagging user input transcript arrives during the reply and re-latches awaiting.
        BidiTranscriptStreamEvent(
            delta="earlier question",
            role="user",
        ),
        BidiResponseCompleteEvent(response_id="r1", stop_reason="complete"),
    ]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator(events))

    await loop.start()
    # Drain through the reply so all three events are applied (the event queue has maxsize=1, so a
    # reader with no consumer would stall after the first event).
    async for event in loop.receive():
        if isinstance(event, BidiResponseCompleteEvent):
            break
    assert loop._awaiting_response is False
    assert loop._turn_complete.is_set()  # turn is idle, so a proactive reconnect fires immediately

    await loop.stop()


def test_tool_use_ids_can_only_be_admitted_once_per_generation(loop):
    tool_uses = [{"toolUseId": "tool-1", "name": "time_tool", "input": {}}]

    loop._reserve_tool_use_ids(tool_uses, loop._generation)

    with pytest.raises(ValueError, match="tool-1.*already admitted"):
        loop._reserve_tool_use_ids(tool_uses, loop._generation)


def test_tool_use_admission_rejects_duplicate_ids_within_batch(loop):
    tool_uses = [
        {"toolUseId": "tool-1", "name": "time_tool", "input": {}},
        {"toolUseId": "tool-1", "name": "time_tool", "input": {}},
    ]

    with pytest.raises(ValueError, match="tool-1.*already admitted"):
        loop._reserve_tool_use_ids(tool_uses, loop._generation)

    assert loop._admitted_tool_use_ids[loop._generation] == set()


def test_tool_use_admission_rejects_superseded_generation(loop):
    with pytest.raises(RuntimeError, match="superseded connection"):
        loop._reserve_tool_use_ids(
            [{"toolUseId": "tool-1", "name": "time_tool", "input": {}}],
            loop._generation - 1,
        )


def test_obsolete_tool_use_admissions_are_discarded(loop):
    current_generation = loop._generation
    loop._admitted_tool_use_ids = {
        current_generation - 1: {"stale"},
        current_generation: {"current"},
    }

    loop._discard_obsolete_tool_admissions()

    assert loop._admitted_tool_use_ids == {current_generation: {"current"}}


def test_tool_batch_holds_turn_boundary_until_final_release(loop):
    loop._begin_tool_batch()
    loop._begin_tool_batch()

    assert loop._tool_batches_in_flight == 2
    assert not loop._turn_complete.is_set()

    loop._end_tool_batch()
    assert loop._tool_batches_in_flight == 1
    assert not loop._turn_complete.is_set()

    loop._end_tool_batch()
    assert loop._tool_batches_in_flight == 0
    assert loop._turn_complete.is_set()


def test_reset_turn_state_preserves_active_tool_batch(loop):
    loop._response_active = True
    loop._awaiting_response = True
    loop._begin_tool_batch()

    loop._reset_turn_state()

    assert loop._response_active is False
    assert loop._awaiting_response is False
    assert loop._tool_batches_in_flight == 1
    assert not loop._turn_complete.is_set()


def test_tool_batch_accounting_rejects_underflow(loop):
    with pytest.raises(RuntimeError, match="underflow"):
        loop._end_tool_batch()


@pytest.mark.parametrize("response_active,awaiting_response", [(True, False), (False, True)])
def test_final_tool_batch_release_preserves_other_open_turn_state(loop, response_active, awaiting_response):
    loop._begin_tool_batch()
    loop._response_active = response_active
    loop._awaiting_response = awaiting_response

    loop._end_tool_batch()

    assert loop._tool_batches_in_flight == 0
    assert not loop._turn_complete.is_set()


@pytest.mark.asyncio
async def test_transcript_complete_appends_one_message(loop, agent, agenerator):
    """A complete transcript is committed to history exactly once."""
    complete = BidiTranscriptCompleteEvent(transcript="Hello there", role="assistant")
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([complete]))

    await loop.start()
    async for event in loop.receive():
        if isinstance(event, BidiTranscriptCompleteEvent):
            break
    for _ in range(10):
        await asyncio.sleep(0)

    assert len(agent.messages) == 1
    assert agent.messages[0]["role"] == "assistant"
    assert agent.messages[0]["content"] == [{"text": "Hello there"}]

    await loop.stop()


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
    from strands.experimental.bidi.hooks.events import BidiBeforeConnectionRestartEvent

    before_events = []
    agent.hooks.add_callback(
        BidiBeforeConnectionRestartEvent, lambda event: before_events.append((event.reason, event.timeout_error))
    )
    agent.model.get_connection_config.return_value = {}
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))

    await loop.start()

    timeout_error = BidiModelTimeoutError("boom")
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
    from strands.experimental.bidi.types.events import BidiUsageEvent

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
    completion_event = _tool_group_event(tool_use)
    tool_result_event = ToolResultEvent(tool_result)

    agent.model.receive = unittest.mock.Mock(return_value=agenerator([tool_use_event, completion_event]))

    await loop.start()

    tru_events = []
    async for event in loop.receive():
        tru_events.append(event)
        if len(tru_events) >= 4:
            break

    exp_events = [
        tool_use_event,
        completion_event,
        tool_result_event,
        # The message is assigned a durable tracking_id when appended to history.
        ToolResultMessageEvent(
            {"role": "user", "content": [{"toolResult": tool_result}], "tracking_id": unittest.mock.ANY}
        ),
    ]
    assert tru_events == exp_events

    tru_messages = agent.messages
    exp_messages = [
        {"role": "assistant", "content": [{"toolUse": tool_use}], "tracking_id": unittest.mock.ANY},
        {"role": "user", "content": [{"toolResult": tool_result}], "tracking_id": unittest.mock.ANY},
    ]
    assert tru_messages == exp_messages

    agent.model.send_tool_results.assert_awaited_once_with(tru_messages[1])


@pytest.mark.asyncio
async def test_batch_hooks_and_per_tool_hooks_fire_once_for_group(agent, agenerator):
    @tool(name="first_tool")
    async def first_tool():
        return "first"

    @tool(name="second_tool")
    async def second_tool():
        return "second"

    agent.tool_registry.register_tool(first_tool)
    agent.tool_registry.register_tool(second_tool)
    tool_uses = [
        {"toolUseId": "second-id", "name": "second_tool", "input": {}},
        {"toolUseId": "first-id", "name": "first_tool", "input": {}},
    ]
    completion = _tool_group_event(*tool_uses)
    hooks = MockHookProvider([BeforeToolsEvent, BeforeToolCallEvent, AfterToolCallEvent, AfterToolsEvent])
    agent.hooks.add_hook(hooks)
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion]))

    await agent.start()
    try:
        async for event in agent.receive():
            if isinstance(event, ToolResultMessageEvent):
                result_message = event["message"]
                break
    finally:
        await agent.stop()

    assert hooks.event_types_received.count(BeforeToolsEvent) == 1
    assert hooks.event_types_received.count(AfterToolsEvent) == 1
    assert hooks.event_types_received.count(BeforeToolCallEvent) == 2
    assert hooks.event_types_received.count(AfterToolCallEvent) == 2
    assert [block["toolResult"]["toolUseId"] for block in result_message["content"]] == [
        "second-id",
        "first-id",
    ]
    before_batch = next(event for event in hooks.events_received if isinstance(event, BeforeToolsEvent))
    after_batch = next(event for event in hooks.events_received if isinstance(event, AfterToolsEvent))
    assert before_batch.message is completion.message
    assert after_batch.message["role"] == result_message["role"]
    assert after_batch.message["content"] == result_message["content"]
    agent.model.send_tool_results.assert_awaited_once_with(result_message)


@pytest.mark.asyncio
async def test_before_tools_cancellation_skips_per_tool_hooks(agent, agenerator):
    tool_uses = [
        {"toolUseId": "first-id", "name": "time_tool", "input": {}},
        {"toolUseId": "second-id", "name": "time_tool", "input": {}},
    ]
    completion = _tool_group_event(*tool_uses)
    hooks = MockHookProvider([BeforeToolsEvent, BeforeToolCallEvent, AfterToolCallEvent, AfterToolsEvent])
    agent.hooks.add_hook(hooks)
    agent.hooks.add_callback(BeforeToolsEvent, lambda event: setattr(event, "cancel", "blocked by policy"))
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion]))

    await agent.start()
    results = []
    try:
        async for event in agent.receive():
            if isinstance(event, ToolResultEvent):
                results.append(event.tool_result)
            if isinstance(event, ToolResultMessageEvent):
                result_message = event["message"]
                break
    finally:
        await agent.stop()

    assert hooks.event_types_received.count(BeforeToolsEvent) == 1
    assert hooks.event_types_received.count(AfterToolsEvent) == 1
    assert BeforeToolCallEvent not in hooks.event_types_received
    assert AfterToolCallEvent not in hooks.event_types_received
    assert results == [
        {
            "toolUseId": tool_use["toolUseId"],
            "status": "error",
            "content": [{"text": "blocked by policy"}],
        }
        for tool_use in tool_uses
    ]
    agent.model.send_tool_results.assert_awaited_once_with(result_message)


@pytest.mark.asyncio
async def test_invalid_tool_name_becomes_grouped_result_and_fires_after_tools(agent, agenerator):
    tool_use = {"toolUseId": "invalid-id", "name": "invalid tool name", "input": {}}
    hooks = MockHookProvider([BeforeToolsEvent, BeforeToolCallEvent, AfterToolCallEvent, AfterToolsEvent])
    agent.hooks.add_hook(hooks)
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([_tool_group_event(tool_use)]))

    await agent.start()
    try:
        async for event in agent.receive():
            if isinstance(event, ToolResultMessageEvent):
                result = event["message"]["content"][0]["toolResult"]
                break
    finally:
        await agent.stop()

    assert result["toolUseId"] == "invalid-id"
    assert result["status"] == "error"
    assert "invalid" in result["content"][0]["text"].lower()
    assert hooks.event_types_received == [BeforeToolsEvent, AfterToolsEvent]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "executor,expected_max_active",
    [(SequentialToolExecutor(), 1), (ConcurrentToolExecutor(), 2)],
)
async def test_bidi_uses_configured_tool_executor_strategy(agent, agenerator, executor, expected_max_active):
    active = 0
    max_active = 0

    async def run_probe():
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.02)
        active -= 1
        return "done"

    @tool(name="probe_one")
    async def probe_one():
        return await run_probe()

    @tool(name="probe_two")
    async def probe_two():
        return await run_probe()

    agent.tool_executor = executor
    agent.tool_registry.register_tool(probe_one)
    agent.tool_registry.register_tool(probe_two)
    tool_uses = [
        {"toolUseId": "one", "name": "probe_one", "input": {}},
        {"toolUseId": "two", "name": "probe_two", "input": {}},
    ]
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([_tool_group_event(*tool_uses)]))

    await agent.start()
    try:
        async for event in agent.receive():
            if isinstance(event, ToolResultMessageEvent):
                break
    finally:
        await agent.stop()

    assert max_active == expected_max_active


@pytest.mark.asyncio
async def test_duplicate_completion_event_executes_tool_once(agent, agenerator):
    calls = 0

    @tool(name="count_once")
    async def count_once():
        nonlocal calls
        calls += 1
        return "done"

    agent.tool_registry.register_tool(count_once)
    completion = _tool_group_event({"toolUseId": "once", "name": "count_once", "input": {}})
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion, completion]))

    await agent.start()
    try:
        with pytest.raises(ValueError, match="already admitted"):
            async for _ in agent.receive():
                pass
    finally:
        await agent.stop()

    assert calls == 1


@pytest.mark.asyncio
async def test_batch_release_runs_when_before_tools_hook_raises(agent, agenerator):
    agent.hooks.add_callback(BeforeToolsEvent, lambda event: (_ for _ in ()).throw(RuntimeError("hook failed")))
    completion = _tool_group_event({"toolUseId": "tool-1", "name": "time_tool", "input": {}})
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion]))

    await agent.start()
    try:
        with pytest.raises(RuntimeError, match="hook failed"):
            async for _ in agent.receive():
                pass
        assert agent._loop._tool_batches_in_flight == 0
        assert agent._loop._turn_complete.is_set()
    finally:
        await agent.stop()


@pytest.mark.asyncio
async def test_before_tools_interrupt_has_no_after_tools_pair(agent, agenerator):
    events = []

    def before(event):
        events.append(type(event))
        event.interrupt("approval", reason="approval required")

    agent.hooks.add_callback(BeforeToolsEvent, before)
    agent.hooks.add_callback(AfterToolsEvent, lambda event: events.append(type(event)))
    completion = _tool_group_event({"toolUseId": "tool-1", "name": "time_tool", "input": {}})
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion]))

    await agent.start()
    try:
        with pytest.raises(RuntimeError, match="tool interrupts are not supported in bidi"):
            async for _ in agent.receive():
                pass
    finally:
        await agent.stop()

    assert events == [BeforeToolsEvent]
    agent.model.send_tool_results.assert_not_awaited()


@pytest.mark.asyncio
async def test_per_tool_interrupt_fires_after_tools_without_partial_send(agent, agenerator):
    events = []
    agent.hooks.add_callback(BeforeToolsEvent, lambda event: events.append(type(event)))
    agent.hooks.add_callback(AfterToolsEvent, lambda event: events.append(type(event)))
    agent.hooks.add_callback(
        BeforeToolCallEvent,
        lambda event: event.interrupt("approval", reason="approval required"),
    )
    completion = _tool_group_event({"toolUseId": "tool-1", "name": "time_tool", "input": {}})
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion]))

    await agent.start()
    try:
        with pytest.raises(RuntimeError, match="tool interrupts are not supported in bidi"):
            async for _ in agent.receive():
                pass
    finally:
        await agent.stop()

    assert events == [BeforeToolsEvent, AfterToolsEvent]
    assert agent.messages == []
    agent.model.send_tool_results.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "end_turn,expected_content",
    [
        (True, [{"text": "Turn ended early by hook after tool execution"}]),
        ("finished by hook", [{"text": "finished by hook"}]),
        ([{"text": "structured finish"}], [{"text": "structured finish"}]),
    ],
)
async def test_after_tools_end_turn_records_and_closes_without_provider_send(
    agent, agenerator, end_turn, expected_content
):
    def end_after_tools(event):
        event.end_turn = end_turn

    agent.hooks.add_callback(AfterToolsEvent, end_after_tools)
    completion = _tool_group_event({"toolUseId": "tool-1", "name": "time_tool", "input": {}})
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion]))

    await agent.start()
    received = []
    try:
        async for event in agent.receive():
            received.append(event)
    finally:
        await agent.stop()

    close_event = received[-1]
    assert isinstance(close_event, BidiConnectionCloseEvent)
    assert close_event.reason == "complete"
    assert [message["role"] for message in agent.messages] == ["assistant", "user", "assistant"]
    assert agent.messages[-1]["content"] == expected_content
    agent.model.send_tool_results.assert_not_awaited()


@pytest.mark.asyncio
async def test_end_turn_takes_precedence_over_stop_event_loop(agent, agenerator):
    agent.hooks.add_callback(AfterToolsEvent, lambda event: setattr(event, "end_turn", True))
    completion = _tool_group_event({"toolUseId": "tool-1", "name": "time_tool", "input": {}})
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion]))

    await agent.start(invocation_state={"request_state": {"stop_event_loop": True}})
    try:
        async for event in agent.receive():
            if isinstance(event, BidiConnectionCloseEvent):
                close_event = event
    finally:
        await agent.stop()

    assert close_event.reason == "complete"
    agent.model.send_tool_results.assert_not_awaited()


@pytest.mark.asyncio
async def test_provider_send_failure_is_surfaced_once_after_history_is_recorded(agent, agenerator):
    completion = _tool_group_event({"toolUseId": "tool-1", "name": "time_tool", "input": {}})
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion]))
    agent.model.send_tool_results.side_effect = RuntimeError("provider write failed")

    await agent.start()
    try:
        with pytest.raises(RuntimeError, match="provider write failed"):
            async for _ in agent.receive():
                pass
    finally:
        await agent.stop()

    assert [message["role"] for message in agent.messages] == ["assistant", "user"]
    assert agent.model.send_tool_results.await_count == 1


@pytest.mark.asyncio
async def test_barge_in_does_not_cancel_admitted_tool(agent, agenerator):
    release_tool = asyncio.Event()
    calls = 0

    @tool(name="slow_barge_tool")
    async def slow_barge_tool():
        nonlocal calls
        calls += 1
        await release_tool.wait()
        return "done"

    agent.tool_registry.register_tool(slow_barge_tool)
    completion = _tool_group_event({"toolUseId": "tool-1", "name": "slow_barge_tool", "input": {}})
    interruption = BidiInterruptionEvent(reason="user_speech")
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion, interruption]))

    await agent.start()
    try:
        async for event in agent.receive():
            if event is interruption:
                release_tool.set()
            if isinstance(event, ToolResultMessageEvent):
                break
        for _ in range(20):
            if agent.model.send_tool_results.await_count == 1:
                break
            await asyncio.sleep(0)
    finally:
        release_tool.set()
        await agent.stop()

    assert calls == 1
    agent.model.send_tool_results.assert_awaited_once()


@pytest.mark.asyncio
async def test_tool_batch_cancellation_releases_boundary_without_opening_send_gate(agent, agenerator):
    completion = _tool_group_event({"toolUseId": "tool-1", "name": "time_tool", "input": {}})
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([]))
    loop = agent._loop

    await agent.start()
    loop._send_gate.clear()
    loop._begin_tool_batch()
    task = asyncio.create_task(loop._run_tools(completion.message, loop._generation))
    try:
        while len(agent.messages) < 2:
            await asyncio.wait_for(loop._event_queue.get(), timeout=2)

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert loop._tool_batches_in_flight == 0
        assert loop._turn_complete.is_set()
        assert not loop._send_gate.is_set()
        agent.model.send_tool_results.assert_not_awaited()
    finally:
        await agent.stop()


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

    # Drain the event queue (maxsize=1) so _run_tools's puts do not block.
    async def drain():
        while True:
            await loop._event_queue.get()

    drain_task = asyncio.create_task(drain())
    try:
        loop._begin_tool_batch()
        await loop._run_tools(_tool_group_event(tool_use).message, issuing_generation)
        await asyncio.sleep(0)
    finally:
        drain_task.cancel()

    # The completed exchange is recorded for the provider's reconnect replay...
    assert len(agent.messages) == 2
    assert agent.messages[0]["role"] == "assistant"
    assert agent.messages[0]["content"] == [{"toolUse": tool_use}]
    assert agent.messages[1]["content"][0]["toolResult"]["toolUseId"] == "t1"
    # ...but the stale result is not sent to the reconnected connection.
    agent.model.send_tool_results.assert_not_awaited()


@pytest.mark.asyncio
async def test_bidi_agent_loop_request_state_initialized_for_tools(loop, agent, agenerator):
    """Test that request_state is initialized in invocation_state before tool execution.

    This ensures request_state exists for tools that may need it via invocation_state,
    even when invocation_state is not provided by the user.
    """
    tool_use = {"toolUseId": "t2", "name": "time_tool", "input": {}}
    completion_event = _tool_group_event(tool_use)

    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion_event]))

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
    completion_event = _tool_group_event(tool_use)

    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion_event]))

    # Start with request_state that already has stop_event_loop=True
    # This simulates a tool having set it during execution
    await loop.start(invocation_state={"request_state": {"stop_event_loop": True}})

    tru_events = []
    async for event in loop.receive():
        tru_events.append(event)

    # Should receive: completion_event, tool_result_event, tool_result_message, connection_close
    assert len(tru_events) == 4

    # Verify tool executed successfully
    tool_result_event = tru_events[1]
    assert isinstance(tool_result_event, ToolResultEvent)
    assert tool_result_event.tool_result["status"] == "success"

    # Verify connection close event was emitted
    connection_close_event = tru_events[3]
    assert isinstance(connection_close_event, BidiConnectionCloseEvent)
    assert connection_close_event["reason"] == "user_request"

    # Verify model.send was NOT called (tool result not sent to model)
    agent.model.send_tool_results.assert_not_awaited()


@pytest.mark.asyncio
async def test_bidi_agent_loop_stop_conversation_deprecated_but_works(loop, agent, agenerator):
    """Test that stop_conversation tool still works but emits a deprecation warning.

    The stop_conversation tool is deprecated in favor of request_state["stop_event_loop"],
    but should continue to work for backward compatibility via the name-based check.
    """
    from strands.experimental.bidi.tools import stop_conversation

    agent.tool_registry.register_tool(stop_conversation)

    tool_use = {"toolUseId": "t5", "name": "stop_conversation", "input": {}}
    completion_event = _tool_group_event(tool_use)

    agent.model.receive = unittest.mock.Mock(return_value=agenerator([completion_event]))

    await loop.start()

    tru_events = []
    with warnings.catch_warnings(record=True) as caught_warnings:
        warnings.simplefilter("always")
        async for event in loop.receive():
            tru_events.append(event)

    # Should receive: completion_event, tool_result_event, tool_result_message, connection_close
    assert len(tru_events) == 4

    # Verify tool executed successfully
    tool_result_event = tru_events[1]
    assert isinstance(tool_result_event, ToolResultEvent)
    assert tool_result_event.tool_result["status"] == "success"
    assert "Ending conversation" in tool_result_event.tool_result["content"][0]["text"]

    # Verify connection close event was emitted
    connection_close_event = tru_events[3]
    assert isinstance(connection_close_event, BidiConnectionCloseEvent)
    assert connection_close_event["reason"] == "user_request"

    # Verify model.send was NOT called (tool result not sent to model)
    agent.model.send_tool_results.assert_not_awaited()

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
    agent.model.receive = unittest.mock.Mock(return_value=agenerator([_tool_group_event(*tool_uses)]))

    await agent.start(invocation_state=invocation_state)
    tru_results = []
    try:
        async for event in agent.receive():
            if isinstance(event, ToolResultMessageEvent):
                tru_results.extend(block["toolResult"] for block in event["message"]["content"])
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
async def test_bidi_agent_loop_send_respects_event_role(loop, agent):
    agent.model.start = unittest.mock.AsyncMock()
    agent.model.send = unittest.mock.AsyncMock()
    await loop.start()
    await loop.send(BidiTextInputEvent(text="injected context", role="assistant"))
    assert agent.messages[-1] == {
        "role": "assistant",
        "content": [{"text": "injected context"}],
        "tracking_id": unittest.mock.ANY,
    }
