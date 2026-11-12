"""Tests for the Todos plugin."""

from unittest.mock import MagicMock

import pytest

from strands import Agent
from strands.vended_plugins.todos import TodoItem, Todos
from strands.vended_plugins.todos.plugin import _DEFAULT_NAME


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


def test_todo_write_persists_the_list_and_reports_what_is_left(agent, todos):
    plugin = Todos()

    tru_result = plugin.todo_write._tool_func(todos=todos, tool_context=_tool_context(agent))

    assert agent.state.get("todos") == todos
    assert tru_result == "2 todos remaining\n  [completed] Read code\n  [in_progress] Writing tests\n  [pending] Ship"


def test_todo_write_renders_the_active_form_only_while_in_progress(agent, todos):
    """The active form is what the list is for: it says what is happening right now."""
    tru_result = Todos().todo_write._tool_func(todos=todos, tool_context=_tool_context(agent))

    assert "[in_progress] Writing tests" in tru_result
    assert "[completed] Read code" in tru_result
    assert "Reading code" not in tru_result


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


def test_the_plugin_registers_the_tool_and_an_injector(agent):
    agent = Agent(model=MagicMock(), callback_handler=None, plugins=[Todos()])

    assert "todo_write" in agent.tool_registry.registry
    tru_names = {plugin.name for plugin in agent._plugin_registry._plugins.values()}
    assert {_DEFAULT_NAME, f"{_DEFAULT_NAME}:injector"} <= tru_names


def test_the_name_is_configurable_so_two_instances_can_coexist():
    """The injector name derives from the plugin name; duplicate names fail registration."""
    agent = Agent(
        model=MagicMock(),
        callback_handler=None,
        plugins=[Todos(name="plan:a", state_key="a"), Todos(name="plan:b", state_key="b")],
    )

    tru_names = {plugin.name for plugin in agent._plugin_registry._plugins.values()}
    assert {"plan:a", "plan:a:injector", "plan:b", "plan:b:injector"} <= tru_names
