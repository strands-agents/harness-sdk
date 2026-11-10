import pytest

from strands import Agent, tool
from strands.hooks import (
    AfterInvocationEvent,
    AfterModelCallEvent,
    AfterToolCallEvent,
    AgentInitializedEvent,
    BeforeInvocationEvent,
    BeforeModelCallEvent,
    BeforeToolCallEvent,
    HookProvider,
    MessageAddedEvent,
)


@pytest.fixture
def callback_names():
    return []


@pytest.fixture
def hook_provider(callback_names):
    class TestHook(HookProvider):
        def register_hooks(self, registry):
            registry.add_callback(AfterInvocationEvent, self.after_invocation)
            registry.add_callback(AfterInvocationEvent, self.after_invocation_async)
            registry.add_callback(AfterModelCallEvent, self.after_model_call)
            registry.add_callback(AfterModelCallEvent, self.after_model_call_async)
            registry.add_callback(AfterToolCallEvent, self.after_tool_call)
            registry.add_callback(AfterToolCallEvent, self.after_tool_call_async)
            registry.add_callback(AgentInitializedEvent, self.agent_initialized)
            registry.add_callback(BeforeInvocationEvent, self.before_invocation)
            registry.add_callback(BeforeInvocationEvent, self.before_invocation_async)
            registry.add_callback(BeforeModelCallEvent, self.before_model_call)
            registry.add_callback(BeforeModelCallEvent, self.before_model_call_async)
            registry.add_callback(BeforeToolCallEvent, self.before_tool_call)
            registry.add_callback(BeforeToolCallEvent, self.before_tool_call_async)
            registry.add_callback(MessageAddedEvent, self.message_added)
            registry.add_callback(MessageAddedEvent, self.message_added_async)

        def after_invocation(self, _event):
            callback_names.append("after_invocation")

        async def after_invocation_async(self, _event):
            callback_names.append("after_invocation_async")

        def after_model_call(self, _event):
            callback_names.append("after_model_call")

        async def after_model_call_async(self, _event):
            callback_names.append("after_model_call_async")

        def after_tool_call(self, _event):
            callback_names.append("after_tool_call")

        async def after_tool_call_async(self, _event):
            callback_names.append("after_tool_call_async")

        def agent_initialized(self, _event):
            callback_names.append("agent_initialized")

        async def agent_initialized_async(self, _event):
            callback_names.append("agent_initialized_async")

        def before_invocation(self, _event):
            callback_names.append("before_invocation")

        async def before_invocation_async(self, _event):
            callback_names.append("before_invocation_async")

        def before_model_call(self, _event):
            callback_names.append("before_model_call")

        async def before_model_call_async(self, _event):
            callback_names.append("before_model_call_async")

        def before_tool_call(self, _event):
            callback_names.append("before_tool_call")

        async def before_tool_call_async(self, _event):
            callback_names.append("before_tool_call_async")

        def message_added(self, _event):
            callback_names.append("message_added")

        async def message_added_async(self, _event):
            callback_names.append("message_added_async")

    return TestHook()


@pytest.fixture
def time_tool():
    @tool(name="time_tool")
    def tool_() -> str:
        return "12:00"

    return tool_


@pytest.fixture
def agent(hook_provider, time_tool):
    return Agent(hooks=[hook_provider], tools=[time_tool])


def test_events(agent, callback_names):
    agent("What time is it?")

    tru_callback_names = callback_names
    exp_callback_names = [
        "agent_initialized",
        "before_invocation",
        "before_invocation_async",
        "message_added",
        "message_added_async",
        "before_model_call",
        "before_model_call_async",
        "after_model_call_async",
        "after_model_call",
        "message_added",
        "message_added_async",
        "before_tool_call",
        "before_tool_call_async",
        "after_tool_call_async",
        "after_tool_call",
        "message_added",
        "message_added_async",
        "before_model_call",
        "before_model_call_async",
        "after_model_call_async",
        "after_model_call",
        "message_added",
        "message_added_async",
        "after_invocation_async",
        "after_invocation",
    ]
    assert tru_callback_names == exp_callback_names
