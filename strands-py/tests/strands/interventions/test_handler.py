"""Tests for InterventionHandler base class."""

import unittest.mock

import pytest

from strands.hooks.events import AfterModelCallEvent, BeforeToolCallEvent
from strands.interrupt import _InterruptState
from strands.interventions.handler import InterventionHandler


class NoOpHandler(InterventionHandler):
    name = "no-op"


class ToolOnlyHandler(InterventionHandler):
    name = "tool-only"

    async def before_tool_call(self, event):
        from strands.interventions.actions import Deny

        return Deny(reason="blocked")


@pytest.fixture
def agent():
    instance = unittest.mock.Mock()
    instance._interrupt_state = _InterruptState()
    instance.messages = []
    return instance


class TestInterventionHandler:
    def test_default_methods_return_proceed(self, agent):
        handler = NoOpHandler()

        event = BeforeToolCallEvent(
            agent=agent,
            selected_tool=None,
            tool_use={"toolUseId": "test", "name": "test", "input": {}},
            invocation_state={},
        )
        result = handler.before_tool_call(event)
        assert result.type == "proceed"

        model_event = AfterModelCallEvent(
            agent=agent,
            invocation_state={},
        )
        result = handler.after_model_call(model_event)
        assert result.type == "proceed"

    def test_override_detection_via_class_comparison(self):
        no_op = NoOpHandler()
        tool_only = ToolOnlyHandler()

        assert type(no_op).before_tool_call is InterventionHandler.before_tool_call
        assert type(no_op).after_model_call is InterventionHandler.after_model_call

        assert type(tool_only).before_tool_call is not InterventionHandler.before_tool_call
        assert type(tool_only).after_model_call is InterventionHandler.after_model_call

    def test_name_is_required(self):
        with pytest.raises(TypeError):

            class BadHandler(InterventionHandler):
                pass

            BadHandler()

    def test_on_error_defaults_to_throw(self):
        handler = NoOpHandler()
        assert handler.on_error == "throw"
