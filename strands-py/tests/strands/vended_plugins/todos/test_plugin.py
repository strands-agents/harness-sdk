"""Tests for the Todos plugin."""

import copy
from unittest.mock import MagicMock

import pytest

from strands import Agent
from strands.middleware.stages import InvokeModelStage
from strands.vended_plugins.todos import TodoItem, Todos
from strands.vended_plugins.todos.plugin import _DEFAULT_NAME
from tests.fixtures.mocked_model_provider import MockedModelProvider


@pytest.fixture
def agent():
    return Agent(model=MagicMock(), callback_handler=None)


@pytest.fixture
def todos() -> list[TodoItem]:
    return [
        {"content": "Read code", "activeForm": "Reading code", "status": "completed"},
        {"content": "Write tests", "activeForm": "Writing tests", "status": "in_progress"},
        {"content": "Ship", "activeForm": "Shipping", "status": "pending"},
    ]


def _tool_context(agent):
    context = MagicMock()
    context.agent = agent
    return context


def _injection_context(agent):
    context = MagicMock()
    context.agent = agent
    context.state = agent.state
    context.messages = []
    return context


def _capture_requests(model: MockedModelProvider) -> list[list[dict]]:
    """Record a copy of the messages each model call receives, as the provider receives them."""
    requests: list[list[dict]] = []
    original_stream = model.stream

    async def stream(messages, *args, **kwargs):
        requests.append(copy.deepcopy(messages))
        async for event in original_stream(messages, *args, **kwargs):
            yield event

    model.stream = stream
    return requests


def _has_reminder(request: list[dict]) -> bool:
    return any("Your current todo list" in block.get("text", "") for message in request for block in message["content"])


def test_todo_write_persists_the_list_and_reports_what_is_left(agent, todos):
    plugin = Todos()

    tru_result = plugin.todo_write._tool_func(todos=todos, tool_context=_tool_context(agent))

    assert agent.state.get("todos") == todos
    assert tru_result == "2 todos remaining\n  [completed] Read code\n  [in_progress] Writing tests\n  [pending] Ship"


def test_an_in_progress_item_without_an_active_form_falls_back_to_its_content(agent):
    todos = [{"content": "Ship", "activeForm": "", "status": "in_progress"}]

    tru_result = Todos().todo_write._tool_func(todos=todos, tool_context=_tool_context(agent))

    assert tru_result == "1 todos remaining\n  [in_progress] Ship"


def test_todo_write_with_an_empty_list_clears_the_state(agent, todos):
    plugin = Todos()
    plugin.todo_write._tool_func(todos=todos, tool_context=_tool_context(agent))

    tru_result = plugin.todo_write._tool_func(todos=[], tool_context=_tool_context(agent))

    assert tru_result == "Todo list cleared"
    assert agent.state.get("todos") is None


def test_todo_write_clears_safely_when_no_list_was_ever_set(agent):
    tru_result = Todos().todo_write._tool_func(todos=[], tool_context=_tool_context(agent))

    assert tru_result == "Todo list cleared"
    assert agent.state.get("todos") is None


def test_the_reminder_renders_the_current_list(agent, todos):
    agent.state.set("todos", todos)

    tru_reminder = Todos()._render_reminder(_injection_context(agent))

    exp_reminder = (
        "<system-reminder>\nYour current todo list:\n"
        "  [completed] Read code\n  [in_progress] Writing tests\n  [pending] Ship\n"
        "Keep it up to date with todo_write as you work.\n</system-reminder>"
    )
    assert tru_reminder == exp_reminder


def test_there_is_no_reminder_when_the_list_is_empty(agent):
    assert Todos()._render_reminder(_injection_context(agent)) is None


def test_the_list_is_scoped_to_the_agent_not_the_plugin(todos):
    """One instance may be shared across agents, so the list must not live on the plugin."""
    plugin = Todos()
    first = Agent(model=MagicMock(), callback_handler=None)
    second = Agent(model=MagicMock(), callback_handler=None)

    plugin.todo_write._tool_func(todos=todos, tool_context=_tool_context(first))

    assert first.state.get("todos") == todos
    assert second.state.get("todos") is None
    assert plugin._render_reminder(_injection_context(second)) is None


def test_the_state_key_is_configurable(agent, todos):
    plugin = Todos(state_key="plan")

    plugin.todo_write._tool_func(todos=todos, tool_context=_tool_context(agent))

    assert agent.state.get("plan") == todos
    assert agent.state.get("todos") is None


def test_the_plugin_registers_its_tool():
    agent = Agent(model=MagicMock(), callback_handler=None, plugins=[Todos()])

    assert "todo_write" in agent.tool_registry.registry
    assert _DEFAULT_NAME in {plugin.name for plugin in agent._plugin_registry._plugins.values()}


def test_init_agent_registers_the_injector_as_model_input_middleware():
    agent = MagicMock()

    Todos().init_agent(agent)

    assert [call.args[0] for call in agent.add_middleware.call_args_list] == [InvokeModelStage.Input]


def test_the_plugin_name_is_configurable():
    assert Todos(name="plan").name == "plan"
    assert Todos().name == _DEFAULT_NAME


def test_the_tool_validates_the_model_facing_schema():
    """Calling ``_tool_func`` skips validation, so drive the registered tool to exercise the schema."""
    agent = Agent(model=MagicMock(), callback_handler=None, plugins=[Todos()])
    item = {"content": "Ship", "activeForm": "Shipping", "status": "pending"}

    accepted = agent.tool.todo_write(todos=[item], record_direct_tool_call=False)
    rejected = agent.tool.todo_write(todos=[{**item, "status": "nope"}], record_direct_tool_call=False)

    assert accepted["status"] == "success"
    assert rejected["status"] == "error"


def test_the_list_is_resurfaced_on_the_next_model_call_in_the_same_invocation():
    """The everyTurn trigger exists for this: under userTurn the mid-loop call carries no reminder."""
    todos = [{"content": "Run tests", "activeForm": "Running tests", "status": "in_progress"}]
    model = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "t1", "name": "todo_write", "input": {"todos": todos}}}],
            },
            {"role": "assistant", "content": [{"text": "Done"}]},
        ]
    )
    requests = _capture_requests(model)

    Agent(model=model, callback_handler=None, plugins=[Todos()])("go")

    assert [_has_reminder(request) for request in requests] == [False, True]
