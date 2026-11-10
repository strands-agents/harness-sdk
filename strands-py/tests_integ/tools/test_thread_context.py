import contextvars

import pytest

from strands import Agent, tool


@pytest.fixture
def result():
    return {}


@pytest.fixture
def contextvar():
    return contextvars.ContextVar("agent")


@pytest.fixture
def context_tool(result, contextvar):
    @tool(name="context_tool")
    def tool_():
        result["context_value"] = contextvar.get("local_context")

    return tool_


@pytest.fixture
def agent(context_tool):
    return Agent(tools=[context_tool])


def test_agent_invoke_context_sharing(result, contextvar, agent):
    contextvar.set("shared_context")
    agent("Execute context_tool")

    tru_context = result["context_value"]
    exp_context = contextvar.get()
    assert tru_context == exp_context


def test_tool_call_context_sharing(result, contextvar, agent):
    contextvar.set("shared_context")
    agent.tool.context_tool()

    tru_context = result["context_value"]
    exp_context = contextvar.get()
    assert tru_context == exp_context
