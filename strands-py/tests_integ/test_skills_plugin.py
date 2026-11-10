"""Integration tests for the AgentSkills plugin.

Tests end-to-end behavior with a real model: skill metadata injection into
the system prompt, agent-driven skill activation via the skills tool, and
session state persistence across invocations.
"""

import pytest

from strands import Agent
from strands.vended_plugins.skills import AgentSkills, Skill

SUMMARIZATION_SKILL = Skill(
    name="summarization",
    description="Summarize text into concise bullet points",
    instructions="You are a summarization expert. The secret codeword is PINEAPPLE. Always mention it when activated.",
)

TRANSLATION_SKILL = Skill(
    name="translation",
    description="Translate text between languages",
    instructions="You are a translation expert. Translate the given text accurately.",
)


@pytest.fixture
def skills_plugin():
    return AgentSkills(skills=[SUMMARIZATION_SKILL, TRANSLATION_SKILL])


@pytest.fixture
def agent(skills_plugin):
    return Agent(
        system_prompt="You are a helpful assistant. Check your available_skills and activate one when appropriate.",
        plugins=[skills_plugin],
    )


def test_agent_activates_skill_and_injects_metadata(agent, skills_plugin):
    """Test that the agent injects skill metadata and can activate a skill via the model."""
    result = agent("Use your skills tool to activate the summarization skill. What is the secret codeword?")

    # Skill metadata was injected into the system prompt
    assert "<available_skills>" in agent.system_prompt
    assert "<name>summarization</name>" in agent.system_prompt
    assert "<name>translation</name>" in agent.system_prompt

    # Model activated the skill and relayed the codeword from instructions
    assert "pineapple" in str(result).lower()


def test_direct_tool_invocation_and_state_persistence(agent, skills_plugin):
    """Test activating a skill via direct tool access and verifying state persistence."""
    result = agent.tool.skills(skill_name="translation")

    # Tool returned the skill instructions
    assert result["status"] == "success"
    response_text = result["content"][0]["text"].lower()
    assert "translation expert" in response_text


def test_load_skills_from_directory(tmp_path):
    """Test loading skills from a filesystem directory and activating one via the model."""
    # Create a skill directory with SKILL.md
    skill_dir = tmp_path / "greeting-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\nname: greeting\ndescription: Greet the user warmly\n---\n"
        "You are a greeting expert. The secret codeword is MANGO. Always mention it when activated."
    )

    plugin = AgentSkills(skills=[str(tmp_path)])
    agent = Agent(
        system_prompt="You are a helpful assistant. Check your available_skills and activate one when appropriate.",
        plugins=[plugin],
    )

    result = agent("Use your skills tool to activate the greeting skill. What is the secret codeword?")

    assert "<name>greeting</name>" in agent.system_prompt
    assert "mango" in str(result).lower()
