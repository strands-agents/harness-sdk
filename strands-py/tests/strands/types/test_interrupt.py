import unittest.mock

import pytest

from strands.interrupt import Interrupt, InterruptException, _InterruptState
from strands.types.interrupt import _Interruptible


@pytest.fixture
def interrupt():
    return Interrupt(
        id="test_id:test_name",
        name="test_name",
        reason={"reason": "test"},
        response={"response": "test"},
    )


@pytest.fixture
def agent():
    instance = unittest.mock.Mock()
    instance._interrupt_state = _InterruptState()
    return instance


@pytest.fixture
def interrupt_hook_event(agent):
    class Event(_Interruptible):
        def __init__(self):
            self.agent = agent

        def _interrupt_id(self, name):
            return f"test_id:{name}"

    return Event()


def test_interrupt_hook_event_interrupt(interrupt_hook_event):
    with pytest.raises(InterruptException) as exception:
        interrupt_hook_event.interrupt("custom_test_name", "custom test reason")

    tru_interrupt = exception.value.interrupt
    exp_interrupt = Interrupt(
        id="test_id:custom_test_name",
        name="custom_test_name",
        reason="custom test reason",
    )
    assert tru_interrupt == exp_interrupt


def test_interrupt_hook_event_interrupt_state(agent, interrupt_hook_event):
    with pytest.raises(InterruptException):
        interrupt_hook_event.interrupt("custom_test_name", "custom test reason")

    exp_interrupt = Interrupt(
        id="test_id:custom_test_name",
        name="custom_test_name",
        reason="custom test reason",
    )
    assert exp_interrupt.id in agent._interrupt_state.interrupts

    tru_interrupt = agent._interrupt_state.interrupts[exp_interrupt.id]
    assert tru_interrupt == exp_interrupt


def test_interrupt_hook_event_interrupt_response(interrupt, agent, interrupt_hook_event):
    agent._interrupt_state.interrupts[interrupt.id] = interrupt

    tru_response = interrupt_hook_event.interrupt("test_name")
    exp_response = {"response": "test"}
    assert tru_response == exp_response


def test_interrupt_hook_event_interrupt_response_empty(interrupt, agent, interrupt_hook_event):
    interrupt.response = None
    agent._interrupt_state.interrupts[interrupt.id] = interrupt

    with pytest.raises(InterruptException):
        interrupt_hook_event.interrupt("test_name")


def test_interrupt_hook_event_interrupt_response_falsey(interrupt_hook_event):
    tru_response = interrupt_hook_event.interrupt("test_name", response=False)
    exp_response = False
    assert tru_response == exp_response


def test_interrupt_hook_event_interrupt_missing_agent():
    class Event(_Interruptible):
        pass

    event = Event()
    with pytest.raises(RuntimeError, match="agent instance attribute not set"):
        event.interrupt("test_name")
