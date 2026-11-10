"""Tests for the ``Agent.sandbox`` getter.

A configured sandbox is returned as-is; an unconfigured agent falls back to a per-agent
:class:`NotASandboxLocalEnvironment`. Each
agent gets its own default instance so state can't leak across agents. The browser-throw
case has no Python analog (core Python always runs on a host), so it is omitted.
"""

import pytest

from strands import Agent, tool
from strands.sandbox.docker import DockerSandbox
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment


def _registered(agent: Agent) -> list[str]:
    """Names of tools registered on the agent."""
    return list(agent.tool_registry.registry.keys())


def test_returns_configured_sandbox():
    sandbox = NotASandboxLocalEnvironment()
    assert Agent(model="nonsense", sandbox=sandbox).sandbox is sandbox


def test_falls_back_to_host_default_when_unconfigured():
    assert isinstance(Agent(model="nonsense").sandbox, NotASandboxLocalEnvironment)


def test_default_is_stable_within_one_agent():
    # All reads on a single agent return the same instance (tools share one sandbox).
    agent = Agent(model="nonsense")
    assert agent.sandbox is agent.sandbox


def test_default_is_not_shared_across_agents():
    # Each agent gets its own host default, so a future stateful default can't leak across agents.
    assert Agent(model="nonsense").sandbox is not Agent(model="nonsense").sandbox


def test_invalid_sandbox_raises_type_error():
    # Bad input is rejected at construction rather than silently falling back to the host default.
    with pytest.raises(TypeError, match="sandbox must be a Sandbox instance"):
        Agent(model="nonsense", sandbox="not-a-sandbox")


# ---- tool vending ----


def test_configured_sandbox_vends_prefixed_tools():
    # A configured sandbox registers its tools (named by the sandbox's get_tools implementation).
    agent = Agent(model="nonsense", sandbox=DockerSandbox("my-container"))
    registered = _registered(agent)
    assert "sandbox_shell" in registered
    assert "sandbox_file_editor" in registered


def test_host_default_vends_nothing():
    # The unconfigured host default must not auto-register any tools.
    agent = Agent(model="nonsense")
    assert _registered(agent) == []


def test_user_registered_tool_wins_over_vended():
    # A user tool with the same (prefixed) name is kept; the vended one is skipped.
    @tool(name="sandbox_shell")
    def sandbox_shell(x: str) -> str:
        """User tool that shadows the vended shell.

        Args:
            x: ignored.
        """
        return x

    agent = Agent(model="nonsense", tools=[sandbox_shell], sandbox=DockerSandbox("my-container"))
    assert agent.tool_registry.registry["sandbox_shell"] is sandbox_shell
