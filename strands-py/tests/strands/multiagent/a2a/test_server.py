"""Tests for the A2AServer class."""

from collections import OrderedDict
from unittest.mock import patch

import pytest
from a2a.types import AgentCapabilities, AgentCard, AgentSkill
from fastapi import FastAPI
from starlette.applications import Starlette

from strands.multiagent.a2a.server import A2AServer

# Tests here intentionally exercise the deprecated single-agent path.
pytestmark = pytest.mark.filterwarnings("ignore:Passing a single 'agent'.*:DeprecationWarning")


def test_a2a_agent_initialization(mock_strands_agent):
    """Test that A2AServer initializes correctly with default values."""
    # Mock tool registry for default skills
    mock_tool_config = {"test_tool": {"name": "test_tool", "description": "A test tool"}}
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    a2a_agent = A2AServer(mock_strands_agent)

    assert a2a_agent.strands_agent == mock_strands_agent
    assert a2a_agent.name == "Test Agent"
    assert a2a_agent.description == "A test agent for unit testing"
    assert a2a_agent.host == "127.0.0.1"
    assert a2a_agent.port == 9000
    assert a2a_agent.http_url == "http://127.0.0.1:9000/"
    assert a2a_agent.version == "0.0.1"
    assert isinstance(a2a_agent.capabilities, AgentCapabilities)
    assert len(a2a_agent.agent_skills) == 1
    assert a2a_agent.agent_skills[0].name == "test_tool"


def test_a2a_agent_initialization_with_custom_values(mock_strands_agent):
    """Test that A2AServer initializes correctly with custom values."""
    a2a_agent = A2AServer(
        mock_strands_agent,
        host="127.0.0.1",
        port=8080,
        version="1.0.0",
    )

    assert a2a_agent.host == "127.0.0.1"
    assert a2a_agent.port == 8080
    assert a2a_agent.http_url == "http://127.0.0.1:8080/"
    assert a2a_agent.version == "1.0.0"
    assert a2a_agent.capabilities.streaming is True


def test_a2a_agent_initialization_with_streaming_always_enabled(mock_strands_agent):
    """Test that A2AServer always initializes with streaming enabled."""
    a2a_agent = A2AServer(mock_strands_agent)

    assert a2a_agent.capabilities.streaming is True


def test_a2a_agent_initialization_with_custom_skills(mock_strands_agent):
    """Test that A2AServer initializes correctly with custom skills."""

    custom_skills = [
        AgentSkill(name="custom_skill", id="custom_skill", description="A custom skill", tags=["test"]),
        AgentSkill(name="another_skill", id="another_skill", description="Another custom skill", tags=[]),
    ]

    a2a_agent = A2AServer(
        mock_strands_agent,
        skills=custom_skills,
    )

    assert a2a_agent.agent_skills == custom_skills
    assert len(a2a_agent.agent_skills) == 2
    assert a2a_agent.agent_skills[0].name == "custom_skill"
    assert a2a_agent.agent_skills[1].name == "another_skill"


def test_public_agent_card(mock_strands_agent):
    """Test that public_agent_card returns a valid AgentCard."""
    # Mock empty tool registry for this test
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    card = a2a_agent.public_agent_card

    assert isinstance(card, AgentCard)
    assert card.name == "Test Agent"
    assert card.description == "A test agent for unit testing"
    assert card.url == "http://127.0.0.1:9000/"
    assert card.version == "0.0.1"
    assert card.default_input_modes == ["text"]
    assert card.default_output_modes == ["text"]
    assert card.skills == []
    assert card.capabilities == a2a_agent.capabilities


def test_public_agent_card_with_missing_name(mock_strands_agent):
    """Test that public_agent_card raises ValueError when name is missing."""
    mock_strands_agent.name = ""
    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    with pytest.raises(ValueError, match="A2A agent name cannot be None or empty"):
        _ = a2a_agent.public_agent_card


def test_public_agent_card_with_missing_description(mock_strands_agent):
    """Test that public_agent_card raises ValueError when description is missing."""
    mock_strands_agent.description = ""
    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    with pytest.raises(ValueError, match="A2A agent description cannot be None or empty"):
        _ = a2a_agent.public_agent_card


def test_agent_skills_empty_registry(mock_strands_agent):
    """Test that agent_skills returns an empty list when no tools are registered."""
    # Mock empty tool registry
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent)
    skills = a2a_agent.agent_skills

    assert isinstance(skills, list)
    assert len(skills) == 0


def test_agent_skills_with_single_tool(mock_strands_agent):
    """Test that agent_skills returns correct skills for a single tool."""
    # Mock tool registry with one tool
    mock_tool_config = {"calculator": {"name": "calculator", "description": "Performs basic mathematical calculations"}}
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    a2a_agent = A2AServer(mock_strands_agent)
    skills = a2a_agent.agent_skills

    assert isinstance(skills, list)
    assert len(skills) == 1

    skill = skills[0]
    assert skill.name == "calculator"
    assert skill.id == "calculator"
    assert skill.description == "Performs basic mathematical calculations"
    assert skill.tags == []


def test_agent_skills_with_multiple_tools(mock_strands_agent):
    """Test that agent_skills returns correct skills for multiple tools."""
    # Mock tool registry with multiple tools
    mock_tool_config = {
        "calculator": {"name": "calculator", "description": "Performs basic mathematical calculations"},
        "weather": {"name": "weather", "description": "Gets current weather information"},
        "file_reader": {"name": "file_reader", "description": "Reads and processes files"},
    }
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    a2a_agent = A2AServer(mock_strands_agent)
    skills = a2a_agent.agent_skills

    assert isinstance(skills, list)
    assert len(skills) == 3

    # Check that all tools are converted to skills
    skill_names = [skill.name for skill in skills]
    assert "calculator" in skill_names
    assert "weather" in skill_names
    assert "file_reader" in skill_names

    # Check specific skill properties
    for skill in skills:
        assert skill.name == skill.id  # id should match name
        assert isinstance(skill.description, str)
        assert len(skill.description) > 0
        assert skill.tags == []


def test_agent_skills_with_complex_tool_config(mock_strands_agent):
    """Test that agent_skills handles complex tool configurations correctly."""
    # Mock tool registry with complex tool configuration
    mock_tool_config = {
        "advanced_calculator": {
            "name": "advanced_calculator",
            "description": "Advanced mathematical operations including trigonometry and statistics",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "operation": {"type": "string", "description": "The operation to perform"},
                        "values": {"type": "array", "description": "Array of numbers"},
                    },
                }
            },
        }
    }
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    a2a_agent = A2AServer(mock_strands_agent)
    skills = a2a_agent.agent_skills

    assert isinstance(skills, list)
    assert len(skills) == 1

    skill = skills[0]
    assert skill.name == "advanced_calculator"
    assert skill.id == "advanced_calculator"
    assert skill.description == "Advanced mathematical operations including trigonometry and statistics"
    assert skill.tags == []


def test_agent_skills_preserves_tool_order(mock_strands_agent):
    """Test that agent_skills preserves the order of tools from the registry."""
    # Mock tool registry with ordered tools

    mock_tool_config = OrderedDict(
        [
            ("tool_a", {"name": "tool_a", "description": "First tool"}),
            ("tool_b", {"name": "tool_b", "description": "Second tool"}),
            ("tool_c", {"name": "tool_c", "description": "Third tool"}),
        ]
    )
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    a2a_agent = A2AServer(mock_strands_agent)
    skills = a2a_agent.agent_skills

    assert len(skills) == 3
    assert skills[0].name == "tool_a"
    assert skills[1].name == "tool_b"
    assert skills[2].name == "tool_c"


def test_agent_skills_handles_missing_description(mock_strands_agent):
    """Test that agent_skills handles tools with missing description gracefully."""
    # Mock tool registry with tool missing description
    mock_tool_config = {
        "incomplete_tool": {
            "name": "incomplete_tool"
            # Missing description
        }
    }
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    a2a_agent = A2AServer(mock_strands_agent)

    # This should raise a KeyError when accessing agent_skills due to missing description
    with pytest.raises(KeyError):
        _ = a2a_agent.agent_skills


def test_agent_skills_handles_missing_name(mock_strands_agent):
    """Test that agent_skills handles tools with missing name gracefully."""
    # Mock tool registry with tool missing name
    mock_tool_config = {
        "incomplete_tool": {
            "description": "A tool without a name"
            # Missing name
        }
    }
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    a2a_agent = A2AServer(mock_strands_agent)

    # This should raise a KeyError when accessing agent_skills due to missing name
    with pytest.raises(KeyError):
        _ = a2a_agent.agent_skills


def test_agent_skills_setter(mock_strands_agent):
    """Test that agent_skills setter works correctly."""

    # Mock tool registry for initial setup
    mock_tool_config = {"test_tool": {"name": "test_tool", "description": "A test tool"}}
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    a2a_agent = A2AServer(mock_strands_agent)

    # Initially should get skills from tools (lazy loaded)
    initial_skills = a2a_agent.agent_skills
    assert len(initial_skills) == 1
    assert initial_skills[0].name == "test_tool"

    # Set new skills using setter
    new_skills = [
        AgentSkill(name="new_skill", id="new_skill", description="A new skill", tags=["new"]),
        AgentSkill(name="another_new_skill", id="another_new_skill", description="Another new skill", tags=[]),
    ]

    a2a_agent.agent_skills = new_skills

    # Verify skills were updated
    assert a2a_agent.agent_skills == new_skills
    assert len(a2a_agent.agent_skills) == 2
    assert a2a_agent.agent_skills[0].name == "new_skill"
    assert a2a_agent.agent_skills[1].name == "another_new_skill"


def test_get_skills_from_tools_method(mock_strands_agent):
    """Test the _get_skills_from_tools method directly."""
    # Mock tool registry with multiple tools
    mock_tool_config = {
        "calculator": {"name": "calculator", "description": "Performs basic mathematical calculations"},
        "weather": {"name": "weather", "description": "Gets current weather information"},
    }
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    a2a_agent = A2AServer(mock_strands_agent)
    skills = a2a_agent._get_skills_from_tools()

    assert isinstance(skills, list)
    assert len(skills) == 2

    skill_names = [skill.name for skill in skills]
    assert "calculator" in skill_names
    assert "weather" in skill_names

    for skill in skills:
        assert skill.name == skill.id
        assert isinstance(skill.description, str)
        assert len(skill.description) > 0
        assert skill.tags == []


def test_initialization_with_none_skills_uses_tools(mock_strands_agent):
    """Test that passing skills=None uses tools from the agent."""
    mock_tool_config = {"test_tool": {"name": "test_tool", "description": "A test tool"}}
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    a2a_agent = A2AServer(mock_strands_agent, skills=None)

    # Should get skills from tools (lazy loaded)
    skills = a2a_agent.agent_skills
    assert len(skills) == 1
    assert skills[0].name == "test_tool"
    assert skills[0].description == "A test tool"


def test_initialization_with_empty_skills_list(mock_strands_agent):
    """Test that passing an empty skills list works correctly."""
    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    # Should have empty skills list
    skills = a2a_agent.agent_skills
    assert isinstance(skills, list)
    assert len(skills) == 0


def test_lazy_loading_behavior(mock_strands_agent):
    """Test that skills are only loaded from tools when accessed and no explicit skills are provided."""
    mock_tool_config = {"test_tool": {"name": "test_tool", "description": "A test tool"}}
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    # Create agent without explicit skills
    a2a_agent = A2AServer(mock_strands_agent)

    # Verify that _agent_skills is None initially (not loaded yet)
    assert a2a_agent._agent_skills is None

    # Access agent_skills property - this should trigger lazy loading
    skills = a2a_agent.agent_skills

    # Verify skills were loaded from tools
    assert len(skills) == 1
    assert skills[0].name == "test_tool"

    # Verify that _agent_skills is still None (lazy loading doesn't cache)
    assert a2a_agent._agent_skills is None


def test_explicit_skills_override_tools(mock_strands_agent):
    """Test that explicitly provided skills override tool-based skills."""

    # Mock tool registry with tools
    mock_tool_config = {"test_tool": {"name": "test_tool", "description": "A test tool"}}
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    # Provide explicit skills
    explicit_skills = [AgentSkill(name="explicit_skill", id="explicit_skill", description="An explicit skill", tags=[])]

    a2a_agent = A2AServer(mock_strands_agent, skills=explicit_skills)

    # Should use explicit skills, not tools
    skills = a2a_agent.agent_skills
    assert len(skills) == 1
    assert skills[0].name == "explicit_skill"
    assert skills[0].description == "An explicit skill"


def test_skills_not_loaded_during_initialization(mock_strands_agent):
    """Test that skills are not loaded from tools during initialization."""
    # Create a mock that would raise an exception if called
    mock_strands_agent.tool_registry.get_all_tools_config.side_effect = Exception("Should not be called during init")

    # This should not raise an exception because tools are not accessed during initialization
    a2a_agent = A2AServer(mock_strands_agent)

    # Verify that _agent_skills is None
    assert a2a_agent._agent_skills is None

    # Reset the mock to return proper data for when skills are actually accessed
    mock_tool_config = {"test_tool": {"name": "test_tool", "description": "A test tool"}}
    mock_strands_agent.tool_registry.get_all_tools_config.side_effect = None
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = mock_tool_config

    # Now accessing skills should work
    skills = a2a_agent.agent_skills
    assert len(skills) == 1
    assert skills[0].name == "test_tool"


def test_public_agent_card_with_custom_skills(mock_strands_agent):
    """Test that public_agent_card includes custom skills."""

    custom_skills = [
        AgentSkill(name="custom_skill", id="custom_skill", description="A custom skill", tags=["test"]),
    ]

    a2a_agent = A2AServer(mock_strands_agent, skills=custom_skills)
    card = a2a_agent.public_agent_card

    assert card.skills == custom_skills
    assert len(card.skills) == 1
    assert card.skills[0].name == "custom_skill"


def test_to_starlette_app(mock_strands_agent):
    """Test that to_starlette_app returns a Starlette application."""
    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    app = a2a_agent.to_starlette_app()

    assert isinstance(app, Starlette)


def test_to_fastapi_app(mock_strands_agent):
    """Test that to_fastapi_app returns a FastAPI application."""
    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    app = a2a_agent.to_fastapi_app()

    assert isinstance(app, FastAPI)


@patch("uvicorn.run")
def test_serve_with_starlette(mock_run, mock_strands_agent):
    """Test that serve starts a Starlette server by default."""
    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    a2a_agent.serve()

    mock_run.assert_called_once()
    args, kwargs = mock_run.call_args
    assert isinstance(args[0], Starlette)
    assert kwargs["host"] == "127.0.0.1"
    assert kwargs["port"] == 9000


@patch("uvicorn.run")
def test_serve_with_fastapi(mock_run, mock_strands_agent):
    """Test that serve starts a FastAPI server when specified."""
    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    a2a_agent.serve(app_type="fastapi")

    mock_run.assert_called_once()
    args, kwargs = mock_run.call_args
    assert isinstance(args[0], FastAPI)
    assert kwargs["host"] == "127.0.0.1"
    assert kwargs["port"] == 9000


@patch("uvicorn.run")
def test_serve_with_custom_kwargs(mock_run, mock_strands_agent):
    """Test that serve passes additional kwargs to uvicorn.run."""
    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    a2a_agent.serve(log_level="debug", reload=True)

    mock_run.assert_called_once()
    _, kwargs = mock_run.call_args
    assert kwargs["log_level"] == "debug"
    assert kwargs["reload"] is True


def test_executor_created_correctly(mock_strands_agent):
    """Test that the executor is created correctly."""
    from strands.multiagent.a2a.executor import StrandsA2AExecutor

    a2a_agent = A2AServer(mock_strands_agent)

    assert isinstance(a2a_agent.request_handler.agent_executor, StrandsA2AExecutor)
    assert a2a_agent.request_handler.agent_executor.agent == mock_strands_agent


def test_server_forwards_max_contexts_to_executor(mock_strands_agent):
    """max_contexts passed to A2AServer is forwarded to the executor."""
    a2a_agent = A2AServer(mock_strands_agent, max_contexts=42)

    assert a2a_agent.request_handler.agent_executor._max_contexts == 42


def test_server_factory_mode_derives_card_and_isolates(mock_strands_agent):
    """A2AServer(agent_factory=...) derives card metadata and runs the executor in factory mode."""
    from strands.multiagent.a2a.executor import StrandsA2AExecutor

    a2a_agent = A2AServer(agent_factory=lambda context_id: mock_strands_agent)

    assert a2a_agent.name == mock_strands_agent.name
    assert a2a_agent.description == mock_strands_agent.description
    executor = a2a_agent.request_handler.agent_executor
    assert isinstance(executor, StrandsA2AExecutor)
    assert executor.agent is None  # factory mode keeps no shared agent


@patch("uvicorn.run", side_effect=KeyboardInterrupt)
def test_serve_handles_keyboard_interrupt(mock_run, mock_strands_agent, caplog):
    """Test that serve handles KeyboardInterrupt gracefully."""
    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    a2a_agent.serve()

    assert "Strands A2A server shutdown requested (KeyboardInterrupt)" in caplog.text
    assert "Strands A2A server has shutdown" in caplog.text


@patch("uvicorn.run", side_effect=Exception("Test exception"))
def test_serve_handles_general_exception(mock_run, mock_strands_agent, caplog):
    """Test that serve handles general exceptions gracefully."""
    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    a2a_agent.serve()

    assert "Strands A2A server encountered exception" in caplog.text
    assert "Strands A2A server has shutdown" in caplog.text


def test_initialization_with_http_url_no_path(mock_strands_agent):
    """Test initialization with http_url containing no path."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(
        mock_strands_agent, host="0.0.0.0", port=8080, http_url="http://my-alb.amazonaws.com", skills=[]
    )

    assert a2a_agent.host == "0.0.0.0"
    assert a2a_agent.port == 8080
    assert a2a_agent.http_url == "http://my-alb.amazonaws.com/"
    assert a2a_agent.public_base_url == "http://my-alb.amazonaws.com"
    assert a2a_agent.mount_path == ""


def test_initialization_with_http_url_with_path(mock_strands_agent):
    """Test initialization with http_url containing a path for mounting."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(
        mock_strands_agent, host="0.0.0.0", port=8080, http_url="http://my-alb.amazonaws.com/agent1", skills=[]
    )

    assert a2a_agent.host == "0.0.0.0"
    assert a2a_agent.port == 8080
    assert a2a_agent.http_url == "http://my-alb.amazonaws.com/agent1/"
    assert a2a_agent.public_base_url == "http://my-alb.amazonaws.com"
    assert a2a_agent.mount_path == "/agent1"


def test_initialization_with_https_url(mock_strands_agent):
    """Test initialization with HTTPS URL."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, http_url="https://my-alb.amazonaws.com/secure-agent", skills=[])

    assert a2a_agent.http_url == "https://my-alb.amazonaws.com/secure-agent/"
    assert a2a_agent.public_base_url == "https://my-alb.amazonaws.com"
    assert a2a_agent.mount_path == "/secure-agent"


def test_initialization_with_http_url_with_port(mock_strands_agent):
    """Test initialization with http_url containing explicit port."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, http_url="http://my-server.com:8080/api/agent", skills=[])

    assert a2a_agent.http_url == "http://my-server.com:8080/api/agent/"
    assert a2a_agent.public_base_url == "http://my-server.com:8080"
    assert a2a_agent.mount_path == "/api/agent"


def test_parse_public_url_method(mock_strands_agent):
    """Test the _parse_public_url method directly."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}
    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    # Test various URL formats
    base_url, mount_path = a2a_agent._parse_public_url("http://example.com/path")
    assert base_url == "http://example.com"
    assert mount_path == "/path"

    base_url, mount_path = a2a_agent._parse_public_url("https://example.com:443/deep/path")
    assert base_url == "https://example.com:443"
    assert mount_path == "/deep/path"

    base_url, mount_path = a2a_agent._parse_public_url("http://example.com/")
    assert base_url == "http://example.com"
    assert mount_path == ""

    base_url, mount_path = a2a_agent._parse_public_url("http://example.com")
    assert base_url == "http://example.com"
    assert mount_path == ""


def test_public_agent_card_with_http_url(mock_strands_agent):
    """Test that public_agent_card uses the http_url when provided."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, http_url="https://my-alb.amazonaws.com/agent1", skills=[])

    card = a2a_agent.public_agent_card

    assert isinstance(card, AgentCard)
    assert card.url == "https://my-alb.amazonaws.com/agent1/"
    assert card.name == "Test Agent"
    assert card.description == "A test agent for unit testing"


def test_agent_card_url_defaults_to_http_url(mock_strands_agent):
    """Test that agent_card_url defaults to http_url."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, http_url="https://my-alb.amazonaws.com/agent1", skills=[])
    assert a2a_agent.agent_card_url == "https://my-alb.amazonaws.com/agent1/"  # Adds trailing slash at the end


def test_agent_card_url_override(mock_strands_agent):
    """Test that agent_card_url can be overridden to a custom value."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, http_url="https://my-alb.amazonaws.com/agent1", skills=[])
    a2a_agent.agent_card_url = "https://my-alb.amazonaws.com/agent1"  # Override to URL without trailing slash

    assert a2a_agent.agent_card_url == "https://my-alb.amazonaws.com/agent1"
    card = a2a_agent.public_agent_card
    assert card.url == "https://my-alb.amazonaws.com/agent1"


def test_to_starlette_app_with_mounting(mock_strands_agent):
    """Test that to_starlette_app creates mounted app when mount_path exists."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, http_url="http://example.com/agent1", skills=[])

    app = a2a_agent.to_starlette_app()

    assert isinstance(app, Starlette)


def test_to_starlette_app_without_mounting(mock_strands_agent):
    """Test that to_starlette_app creates regular app when no mount_path."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, http_url="http://example.com", skills=[])

    app = a2a_agent.to_starlette_app()

    assert isinstance(app, Starlette)


def test_to_fastapi_app_with_mounting(mock_strands_agent):
    """Test that to_fastapi_app creates mounted app when mount_path exists."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, http_url="http://example.com/agent1", skills=[])

    app = a2a_agent.to_fastapi_app()

    assert isinstance(app, FastAPI)


def test_to_fastapi_app_without_mounting(mock_strands_agent):
    """Test that to_fastapi_app creates regular app when no mount_path."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, http_url="http://example.com", skills=[])

    app = a2a_agent.to_fastapi_app()

    assert isinstance(app, FastAPI)


def test_backwards_compatibility_without_http_url(mock_strands_agent):
    """Test that the old behavior is preserved when http_url is not provided."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, host="localhost", port=9000, skills=[])

    # Should behave exactly like before
    assert a2a_agent.host == "localhost"
    assert a2a_agent.port == 9000
    assert a2a_agent.http_url == "http://localhost:9000/"
    assert a2a_agent.public_base_url == "http://localhost:9000"
    assert a2a_agent.mount_path == ""

    # Agent card should use the traditional URL
    card = a2a_agent.public_agent_card
    assert card.url == "http://localhost:9000/"


def test_mount_path_logging(mock_strands_agent, caplog):
    """Test that mounting logs the correct message."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, http_url="http://example.com/test-agent", skills=[])

    # Test Starlette app mounting logs
    caplog.clear()
    a2a_agent.to_starlette_app()
    assert "Mounting A2A server at path: /test-agent" in caplog.text

    # Test FastAPI app mounting logs
    caplog.clear()
    a2a_agent.to_fastapi_app()
    assert "Mounting A2A server at path: /test-agent" in caplog.text


def test_http_url_trailing_slash_handling(mock_strands_agent):
    """Test that trailing slashes in http_url are handled correctly."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    # Test with trailing slash
    a2a_agent1 = A2AServer(mock_strands_agent, http_url="http://example.com/agent1/", skills=[])

    # Test without trailing slash
    a2a_agent2 = A2AServer(mock_strands_agent, http_url="http://example.com/agent1", skills=[])

    # Both should result in the same normalized URL
    assert a2a_agent1.http_url == "http://example.com/agent1/"
    assert a2a_agent2.http_url == "http://example.com/agent1/"
    assert a2a_agent1.mount_path == "/agent1"
    assert a2a_agent2.mount_path == "/agent1"


def test_serve_at_root_default_behavior(mock_strands_agent):
    """Test default behavior extracts mount path from http_url."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    server = A2AServer(mock_strands_agent, http_url="http://my-alb.com/agent1", skills=[])

    assert server.mount_path == "/agent1"
    assert server.http_url == "http://my-alb.com/agent1/"


def test_serve_at_root_overrides_mounting(mock_strands_agent):
    """Test serve_at_root=True overrides automatic path mounting."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    server = A2AServer(mock_strands_agent, http_url="http://my-alb.com/agent1", serve_at_root=True, skills=[])

    assert server.mount_path == ""  # Should be empty despite path in URL
    assert server.http_url == "http://my-alb.com/agent1/"  # Public URL unchanged


def test_serve_at_root_with_no_path(mock_strands_agent):
    """Test serve_at_root=True when no path in URL (redundant but valid)."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    server = A2AServer(mock_strands_agent, host="localhost", port=8080, serve_at_root=True, skills=[])

    assert server.mount_path == ""
    assert server.http_url == "http://localhost:8080/"


def test_serve_at_root_complex_path(mock_strands_agent):
    """Test serve_at_root=True with complex nested paths."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    server = A2AServer(
        mock_strands_agent, http_url="http://api.example.com/v1/agents/my-agent", serve_at_root=True, skills=[]
    )

    assert server.mount_path == ""
    assert server.http_url == "http://api.example.com/v1/agents/my-agent/"


def test_serve_at_root_fastapi_mounting_behavior(mock_strands_agent):
    """Test FastAPI mounting behavior with serve_at_root."""
    from fastapi.testclient import TestClient

    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    # Normal mounting
    server_mounted = A2AServer(mock_strands_agent, http_url="http://my-alb.com/agent1", skills=[])
    app_mounted = server_mounted.to_fastapi_app()
    client_mounted = TestClient(app_mounted)

    # Should work at mounted path
    response = client_mounted.get("/agent1/.well-known/agent.json")
    assert response.status_code == 200

    # Should not work at root
    response = client_mounted.get("/.well-known/agent.json")
    assert response.status_code == 404


def test_serve_at_root_fastapi_root_behavior(mock_strands_agent):
    """Test FastAPI serve_at_root behavior."""
    from fastapi.testclient import TestClient

    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    # Serve at root
    server_root = A2AServer(mock_strands_agent, http_url="http://my-alb.com/agent1", serve_at_root=True, skills=[])
    app_root = server_root.to_fastapi_app()
    client_root = TestClient(app_root)

    # Should work at root
    response = client_root.get("/.well-known/agent.json")
    assert response.status_code == 200

    # Should not work at mounted path (since we're serving at root)
    response = client_root.get("/agent1/.well-known/agent.json")
    assert response.status_code == 404


def test_serve_at_root_starlette_behavior(mock_strands_agent):
    """Test Starlette serve_at_root behavior."""
    from starlette.testclient import TestClient

    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    # Normal mounting
    server_mounted = A2AServer(mock_strands_agent, http_url="http://my-alb.com/agent1", skills=[])
    app_mounted = server_mounted.to_starlette_app()
    client_mounted = TestClient(app_mounted)

    # Should work at mounted path
    response = client_mounted.get("/agent1/.well-known/agent.json")
    assert response.status_code == 200

    # Serve at root
    server_root = A2AServer(mock_strands_agent, http_url="http://my-alb.com/agent1", serve_at_root=True, skills=[])
    app_root = server_root.to_starlette_app()
    client_root = TestClient(app_root)

    # Should work at root
    response = client_root.get("/.well-known/agent.json")
    assert response.status_code == 200


def test_serve_at_root_alb_scenarios(mock_strands_agent):
    """Test common ALB deployment scenarios."""
    from fastapi.testclient import TestClient

    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    # ALB with path preservation
    server_preserved = A2AServer(mock_strands_agent, http_url="http://my-alb.amazonaws.com/agent1", skills=[])
    app_preserved = server_preserved.to_fastapi_app()
    client_preserved = TestClient(app_preserved)

    # Container receives /agent1/.well-known/agent.json
    response = client_preserved.get("/agent1/.well-known/agent.json")
    assert response.status_code == 200
    agent_data = response.json()
    assert agent_data["url"] == "http://my-alb.amazonaws.com/agent1/"

    # ALB with path stripping
    server_stripped = A2AServer(
        mock_strands_agent, http_url="http://my-alb.amazonaws.com/agent1", serve_at_root=True, skills=[]
    )
    app_stripped = server_stripped.to_fastapi_app()
    client_stripped = TestClient(app_stripped)

    # Container receives /.well-known/agent.json (path stripped by ALB)
    response = client_stripped.get("/.well-known/agent.json")
    assert response.status_code == 200
    agent_data = response.json()
    assert agent_data["url"] == "http://my-alb.amazonaws.com/agent1/"


def test_serve_at_root_edge_cases(mock_strands_agent):
    """Test edge cases for serve_at_root parameter."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    # Root path in URL
    server1 = A2AServer(mock_strands_agent, http_url="http://example.com/", skills=[])
    assert server1.mount_path == ""

    # serve_at_root should be redundant but not cause issues
    server2 = A2AServer(mock_strands_agent, http_url="http://example.com/", serve_at_root=True, skills=[])
    assert server2.mount_path == ""

    # Multiple nested paths
    server3 = A2AServer(
        mock_strands_agent, http_url="http://api.example.com/v1/agents/team1/agent1", serve_at_root=True, skills=[]
    )
    assert server3.mount_path == ""
    assert server3.http_url == "http://api.example.com/v1/agents/team1/agent1/"


def test_to_starlette_app_with_app_kwargs(mock_strands_agent):
    """Test that to_starlette_app passes app_kwargs to the Starlette constructor."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    app = a2a_agent.to_starlette_app(app_kwargs={"debug": True})

    assert isinstance(app, Starlette)
    assert app.debug is True


def test_to_fastapi_app_with_app_kwargs(mock_strands_agent):
    """Test that to_fastapi_app passes app_kwargs to the FastAPI constructor."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    app = a2a_agent.to_fastapi_app(app_kwargs={"title": "Custom Agent Title"})

    assert isinstance(app, FastAPI)
    assert app.title == "Custom Agent Title"


@patch("uvicorn.run")
def test_serve_with_overridden_host_port_updates_agent_card_url(mock_run, mock_strands_agent):
    """Test that serve() with host/port overrides updates the agent card URL.

    This test verifies the fix for issue #1258 where specifying host/port in serve()
    did not update the agent card URL, causing clients to fail when trying to connect.
    """
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    # Verify initial URL from constructor defaults
    assert a2a_agent.http_url == "http://127.0.0.1:9000/"
    assert a2a_agent.public_base_url == "http://127.0.0.1:9000"

    # Call serve with different host and port
    a2a_agent.serve(host="localhost", port=9210)

    # Verify URL was updated to match the actual serve parameters
    assert a2a_agent.http_url == "http://localhost:9210/"
    assert a2a_agent.public_base_url == "http://localhost:9210"
    assert a2a_agent.host == "localhost"
    assert a2a_agent.port == 9210

    # Verify the agent card reflects the updated URL
    card = a2a_agent.public_agent_card
    assert card.url == "http://localhost:9210/"

    # Verify uvicorn was called with the overridden parameters
    mock_run.assert_called_once()
    _, kwargs = mock_run.call_args
    assert kwargs["host"] == "localhost"
    assert kwargs["port"] == 9210


@patch("uvicorn.run")
def test_serve_with_overridden_port_only_updates_url(mock_run, mock_strands_agent):
    """Test that serve() with only port override updates the agent card URL."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    # Call serve with different port only
    a2a_agent.serve(port=8080)

    # Verify URL was updated with the new port
    assert a2a_agent.http_url == "http://127.0.0.1:8080/"
    assert a2a_agent.port == 8080

    # Verify uvicorn was called with the correct parameters
    mock_run.assert_called_once()
    _, kwargs = mock_run.call_args
    assert kwargs["host"] == "127.0.0.1"
    assert kwargs["port"] == 8080


@patch("uvicorn.run")
def test_serve_with_overridden_host_only_updates_url(mock_run, mock_strands_agent):
    """Test that serve() with only host override updates the agent card URL."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, skills=[])

    # Call serve with different host only
    a2a_agent.serve(host="0.0.0.0")

    # Verify URL was updated with the new host
    assert a2a_agent.http_url == "http://0.0.0.0:9000/"
    assert a2a_agent.host == "0.0.0.0"

    # Verify uvicorn was called with the correct parameters
    mock_run.assert_called_once()
    _, kwargs = mock_run.call_args
    assert kwargs["host"] == "0.0.0.0"
    assert kwargs["port"] == 9000


@patch("uvicorn.run")
def test_serve_with_explicit_http_url_does_not_override_url(mock_run, mock_strands_agent):
    """Test that serve() with host/port does not override explicitly set http_url.

    When a user explicitly sets http_url in the constructor (e.g., for load balancer scenarios),
    the serve() method should NOT override the URL even if host/port are provided.
    """
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    # Create server with explicit http_url (simulating load balancer scenario)
    a2a_agent = A2AServer(
        mock_strands_agent,
        host="0.0.0.0",
        port=8080,
        http_url="https://my-alb.amazonaws.com/agent1",
        skills=[],
    )

    # Verify initial URL is the explicit one
    assert a2a_agent.http_url == "https://my-alb.amazonaws.com/agent1/"
    assert a2a_agent._http_url_explicit is True

    # Call serve with different host/port (the local binding)
    a2a_agent.serve(host="0.0.0.0", port=9000)

    # Verify URL was NOT changed (explicit http_url should be preserved)
    assert a2a_agent.http_url == "https://my-alb.amazonaws.com/agent1/"
    assert a2a_agent.public_base_url == "https://my-alb.amazonaws.com"

    # But host/port should still be updated for the actual binding
    assert a2a_agent.host == "0.0.0.0"
    assert a2a_agent.port == 9000

    # Verify the agent card still shows the public URL
    card = a2a_agent.public_agent_card
    assert card.url == "https://my-alb.amazonaws.com/agent1/"


@patch("uvicorn.run")
def test_serve_without_overrides_does_not_change_url(mock_run, mock_strands_agent):
    """Test that serve() without host/port parameters does not modify the URL."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    a2a_agent = A2AServer(mock_strands_agent, host="localhost", port=8000, skills=[])

    # Verify initial URL
    assert a2a_agent.http_url == "http://localhost:8000/"

    # Call serve without overrides
    a2a_agent.serve()

    # Verify URL was NOT changed
    assert a2a_agent.http_url == "http://localhost:8000/"
    assert a2a_agent.host == "localhost"
    assert a2a_agent.port == 8000


def test_http_url_explicit_flag_set_correctly(mock_strands_agent):
    """Test that _http_url_explicit flag is set correctly during initialization."""
    mock_strands_agent.tool_registry.get_all_tools_config.return_value = {}

    # Without explicit http_url
    server1 = A2AServer(mock_strands_agent, skills=[])
    assert server1._http_url_explicit is False

    # With explicit http_url
    server2 = A2AServer(mock_strands_agent, http_url="http://example.com/agent", skills=[])
    assert server2._http_url_explicit is True
