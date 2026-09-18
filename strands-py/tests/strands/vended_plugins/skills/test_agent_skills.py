"""Tests for the AgentSkills plugin.

Filesystem skill sources are loaded through the agent's sandbox at
``init_agent`` time, so tests that use path-based skills construct a real
``NotASandboxLocalEnvironment`` on the mock agent, call ``await
plugin.init_agent(agent)``, and assert via ``get_available_skills(agent)`` (the
per-agent skill set). Skill instances and URLs remain available at construction
via ``get_available_skills()`` with no agent.

"""

import logging
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from strands.hooks.events import BeforeInvocationEvent, BeforeModelCallEvent
from strands.hooks.registry import HookRegistry
from strands.plugins.registry import _PluginRegistry
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.types.tools import ToolContext
from strands.vended_plugins.skills.agent_skills import AgentSkills
from strands.vended_plugins.skills.skill import Skill


def _make_skill(name: str = "test-skill", description: str = "A test skill", instructions: str = "Do the thing."):
    """Helper to create a Skill instance."""
    return Skill(name=name, description=description, instructions=instructions)


def _make_skill_dir(parent: Path, name: str, description: str = "A test skill") -> Path:
    """Helper to create a skill directory with SKILL.md."""
    skill_dir = parent / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    content = f"---\nname: {name}\ndescription: {description}\n---\n# Instructions for {name}\n"
    (skill_dir / "SKILL.md").write_text(content)
    return skill_dir


def _mock_agent():
    """Create a mock agent for testing.

    Exposes a real ``NotASandboxLocalEnvironment`` as ``.sandbox`` so filesystem
    skill loading and resource listing exercise the actual sandbox code paths,
    exposing a real sandbox (which returns the
    default host sandbox).
    """
    agent = MagicMock()
    agent._system_prompt = "You are an agent."
    agent._system_prompt_content = [{"text": "You are an agent."}]

    # Make system_prompt and system_prompt_content properties behave like the real Agent
    type(agent).system_prompt = property(
        lambda self: self._system_prompt,
        lambda self, value: _set_system_prompt(self, value),
    )
    type(agent).system_prompt_content = property(lambda self: self._system_prompt_content)

    agent.hooks = HookRegistry()
    agent.add_hook = MagicMock(
        side_effect=lambda callback, event_type=None: agent.hooks.add_callback(event_type, callback)
    )
    agent.tool_registry = MagicMock()
    agent.tool_registry.process_tools = MagicMock(return_value=["skills"])

    # Real host sandbox: filesystem skills load through it (not a MagicMock).
    agent.sandbox = NotASandboxLocalEnvironment()

    # Use a real dict-backed state so get/set work correctly
    state_store: dict[str, object] = {}
    agent.state = MagicMock()
    agent.state.get = MagicMock(side_effect=lambda key: state_store.get(key))
    agent.state.set = MagicMock(side_effect=lambda key, value: state_store.__setitem__(key, value))
    return agent


def _mock_tool_context(agent: MagicMock) -> ToolContext:
    """Create a mock ToolContext with the given agent."""
    tool_use = {"toolUseId": "test-id", "name": "skills", "input": {}}
    return ToolContext(tool_use=tool_use, agent=agent, invocation_state={"agent": agent})


def _set_system_prompt(agent: MagicMock, value: str | list | None) -> None:
    """Simulate the Agent.system_prompt setter."""
    if isinstance(value, str):
        agent._system_prompt = value
        agent._system_prompt_content = [{"text": value}]
    elif isinstance(value, list):
        text_parts = [block["text"] for block in value if "text" in block]
        agent._system_prompt = "\n".join(text_parts) if text_parts else None
        agent._system_prompt_content = value
    elif value is None:
        agent._system_prompt = None
        agent._system_prompt_content = None


class TestSkillsPluginInit:
    """Tests for AgentSkills initialization."""

    def test_init_with_skill_instances(self):
        """Test initialization with Skill instances (available without an agent)."""
        skill = _make_skill()
        plugin = AgentSkills(skills=[skill])

        assert len(plugin.get_available_skills()) == 1
        assert plugin.get_available_skills()[0].name == "test-skill"

    @pytest.mark.asyncio
    async def test_init_with_filesystem_paths(self, tmp_path):
        """Test initialization with filesystem paths (loaded per-agent via sandbox)."""
        _make_skill_dir(tmp_path, "fs-skill")
        plugin = AgentSkills(skills=[str(tmp_path / "fs-skill")])
        agent = _mock_agent()
        await plugin.init_agent(agent)

        assert len(plugin.get_available_skills(agent)) == 1
        assert plugin.get_available_skills(agent)[0].name == "fs-skill"

    @pytest.mark.asyncio
    async def test_init_with_parent_directory(self, tmp_path):
        """Test initialization with a parent directory containing skills."""
        _make_skill_dir(tmp_path, "skill-a")
        _make_skill_dir(tmp_path, "skill-b")
        plugin = AgentSkills(skills=[tmp_path])
        agent = _mock_agent()
        await plugin.init_agent(agent)

        assert len(plugin.get_available_skills(agent)) == 2

    @pytest.mark.asyncio
    async def test_init_with_mixed_sources(self, tmp_path):
        """Test initialization with mixed skill sources."""
        _make_skill_dir(tmp_path, "fs-skill")
        direct_skill = _make_skill(name="direct-skill", description="Direct")
        plugin = AgentSkills(skills=[str(tmp_path / "fs-skill"), direct_skill])
        agent = _mock_agent()
        await plugin.init_agent(agent)

        assert len(plugin.get_available_skills(agent)) == 2
        names = {s.name for s in plugin.get_available_skills(agent)}
        assert names == {"fs-skill", "direct-skill"}

    @pytest.mark.asyncio
    async def test_init_skips_nonexistent_paths(self, tmp_path):
        """Test that nonexistent paths are skipped gracefully."""
        plugin = AgentSkills(skills=[str(tmp_path / "nonexistent")])
        agent = _mock_agent()
        await plugin.init_agent(agent)
        assert len(plugin.get_available_skills(agent)) == 0

    @pytest.mark.asyncio
    async def test_init_with_malformed_skill_md(self, tmp_path):
        """Test that a path with a malformed SKILL.md is skipped gracefully."""
        bad_dir = tmp_path / "bad-skill"
        bad_dir.mkdir()
        (bad_dir / "SKILL.md").write_text("totally broken, no frontmatter at all")
        plugin = AgentSkills(skills=[str(bad_dir)])
        agent = _mock_agent()
        await plugin.init_agent(agent)
        assert len(plugin.get_available_skills(agent)) == 0

    @pytest.mark.asyncio
    async def test_init_loads_valid_siblings_despite_malformed(self, tmp_path):
        """Test that valid skills load from a parent dir containing malformed siblings."""
        _make_skill_dir(tmp_path, "good-skill")
        bad_dir = tmp_path / "bad-skill"
        bad_dir.mkdir()
        (bad_dir / "SKILL.md").write_text("no frontmatter")
        plugin = AgentSkills(skills=[tmp_path])
        agent = _mock_agent()
        await plugin.init_agent(agent)

        skills = plugin.get_available_skills(agent)
        assert len(skills) == 1
        assert skills[0].name == "good-skill"

    def test_init_empty_skills(self):
        """Test initialization with empty skills list."""
        plugin = AgentSkills(skills=[])
        assert plugin.get_available_skills() == []

    def test_name_attribute(self):
        """Test that the plugin has the correct name."""
        plugin = AgentSkills(skills=[])
        assert plugin.name == "agent_skills"

    def test_custom_state_key(self):
        """Test initialization with a custom state key."""
        plugin = AgentSkills(skills=[], state_key="custom_key")
        assert plugin._state_key == "custom_key"

    def test_custom_max_resource_files(self):
        """Test initialization with a custom max resource files limit."""
        plugin = AgentSkills(skills=[], max_resource_files=50)
        assert plugin._max_resource_files == 50


class TestSkillsPluginInitAgent:
    """Tests for the init_agent method and plugin registry integration."""

    def test_registers_tool(self):
        """Test that the plugin registry registers the skills tool."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()

        registry = _PluginRegistry(agent)
        registry.add_and_init(plugin)

        agent.tool_registry.process_tools.assert_called_once()

    def test_registers_hooks(self):
        """Test that the plugin registry registers hook callbacks."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()

        registry = _PluginRegistry(agent)
        registry.add_and_init(plugin)

        assert agent.hooks.has_callbacks()

    @pytest.mark.asyncio
    async def test_does_not_store_agent_reference(self):
        """Test that init_agent does not store the agent on the plugin."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()

        await plugin.init_agent(agent)

        assert not hasattr(plugin, "_agent")


class TestSkillsPluginProperties:
    """Tests for AgentSkills properties."""

    def test_available_skills_getter_returns_copy(self):
        """Test that get_available_skills returns a copy of the list."""
        skill = _make_skill()
        plugin = AgentSkills(skills=[skill])

        skills_list = plugin.get_available_skills()
        skills_list.append(_make_skill(name="another-skill", description="Another"))

        assert len(plugin.get_available_skills()) == 1

    def test_available_skills_setter(self):
        """Test setting skills via set_available_skills."""
        plugin = AgentSkills(skills=[_make_skill()])

        new_skill = _make_skill(name="new-skill", description="New")
        plugin.set_available_skills([new_skill])

        assert len(plugin.get_available_skills()) == 1
        assert plugin.get_available_skills()[0].name == "new-skill"

    @pytest.mark.asyncio
    async def test_set_available_skills_with_paths(self, tmp_path):
        """Test setting skills via set_available_skills with filesystem paths."""
        plugin = AgentSkills(skills=[_make_skill()])
        _make_skill_dir(tmp_path, "fs-skill")

        plugin.set_available_skills([str(tmp_path / "fs-skill")])
        agent = _mock_agent()
        await plugin.init_agent(agent)

        assert len(plugin.get_available_skills(agent)) == 1
        assert plugin.get_available_skills(agent)[0].name == "fs-skill"

    @pytest.mark.asyncio
    async def test_set_available_skills_with_mixed_sources(self, tmp_path):
        """Test setting skills via set_available_skills with mixed sources."""
        plugin = AgentSkills(skills=[])
        _make_skill_dir(tmp_path, "fs-skill")
        direct = _make_skill(name="direct", description="Direct")

        plugin.set_available_skills([str(tmp_path / "fs-skill"), direct])
        agent = _mock_agent()
        await plugin.init_agent(agent)

        assert len(plugin.get_available_skills(agent)) == 2
        names = {s.name for s in plugin.get_available_skills(agent)}
        assert names == {"fs-skill", "direct"}


class TestSkillsTool:
    """Tests for the skills tool method."""

    @pytest.mark.asyncio
    async def test_activate_skill(self):
        """Test activating a skill returns its instructions."""
        skill = _make_skill(instructions="Full instructions here.")
        plugin = AgentSkills(skills=[skill])
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        result = await plugin.skills(skill_name="test-skill", tool_context=tool_context)

        assert "Full instructions here." in result

    @pytest.mark.asyncio
    async def test_activate_nonexistent_skill(self):
        """Test activating a nonexistent skill returns error message."""
        skill = _make_skill()
        plugin = AgentSkills(skills=[skill])
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        result = await plugin.skills(skill_name="nonexistent", tool_context=tool_context)

        assert "not found" in result
        assert "test-skill" in result

    @pytest.mark.asyncio
    async def test_activate_replaces_previous(self):
        """Test that activating a new skill replaces the previous one."""
        skill1 = _make_skill(name="skill-a", description="A", instructions="A instructions")
        skill2 = _make_skill(name="skill-b", description="B", instructions="B instructions")
        plugin = AgentSkills(skills=[skill1, skill2])
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        result_a = await plugin.skills(skill_name="skill-a", tool_context=tool_context)
        assert "A instructions" in result_a

        result_b = await plugin.skills(skill_name="skill-b", tool_context=tool_context)
        assert "B instructions" in result_b

    @pytest.mark.asyncio
    async def test_activate_without_name(self):
        """Test activating without a skill name returns error."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        result = await plugin.skills(skill_name="", tool_context=tool_context)

        assert "required" in result.lower()

    @pytest.mark.asyncio
    async def test_activate_tracks_in_agent_state(self):
        """Test that activating a skill records it in agent state."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        await plugin.skills(skill_name="test-skill", tool_context=tool_context)

        assert plugin.get_activated_skills(agent) == ["test-skill"]

    @pytest.mark.asyncio
    async def test_activate_multiple_tracks_order(self):
        """Test that multiple activations are tracked in order."""
        skill_a = _make_skill(name="skill-a", description="A", instructions="A")
        skill_b = _make_skill(name="skill-b", description="B", instructions="B")
        plugin = AgentSkills(skills=[skill_a, skill_b])
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        await plugin.skills(skill_name="skill-a", tool_context=tool_context)
        await plugin.skills(skill_name="skill-b", tool_context=tool_context)

        assert plugin.get_activated_skills(agent) == ["skill-a", "skill-b"]

    @pytest.mark.asyncio
    async def test_activate_same_skill_twice_deduplicates(self):
        """Test that re-activating a skill moves it to the end without duplicates."""
        skill_a = _make_skill(name="skill-a", description="A", instructions="A")
        skill_b = _make_skill(name="skill-b", description="B", instructions="B")
        plugin = AgentSkills(skills=[skill_a, skill_b])
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        await plugin.skills(skill_name="skill-a", tool_context=tool_context)
        await plugin.skills(skill_name="skill-b", tool_context=tool_context)
        await plugin.skills(skill_name="skill-a", tool_context=tool_context)

        assert plugin.get_activated_skills(agent) == ["skill-b", "skill-a"]

    def test_get_activated_skills_empty_by_default(self):
        """Test that get_activated_skills returns empty list when nothing activated."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()

        assert plugin.get_activated_skills(agent) == []

    @pytest.mark.asyncio
    async def test_get_activated_skills_returns_copy(self):
        """Test that get_activated_skills returns a copy, not a reference."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        await plugin.skills(skill_name="test-skill", tool_context=tool_context)
        result = plugin.get_activated_skills(agent)
        result.append("injected")

        assert plugin.get_activated_skills(agent) == ["test-skill"]


class TestSystemPromptInjection:
    """Tests for system prompt injection via hooks."""

    @pytest.mark.asyncio
    async def test_before_invocation_appends_skills_xml(self):
        """Test that before_invocation appends skills XML to system prompt."""
        skill = _make_skill()
        plugin = AgentSkills(skills=[skill])
        agent = _mock_agent()

        event = BeforeInvocationEvent(agent=agent)
        await plugin._on_before_invocation(event)

        assert "<available_skills>" in agent.system_prompt
        assert "<name>test-skill</name>" in agent.system_prompt
        assert "<description>A test skill</description>" in agent.system_prompt

    @pytest.mark.asyncio
    async def test_before_invocation_preserves_existing_prompt(self):
        """Test that existing system prompt content is preserved."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()
        agent._system_prompt = "Original prompt."
        agent._system_prompt_content = [{"text": "Original prompt."}]

        event = BeforeInvocationEvent(agent=agent)
        await plugin._on_before_invocation(event)

        assert agent.system_prompt.startswith("Original prompt.")
        assert "<available_skills>" in agent.system_prompt

    @pytest.mark.asyncio
    async def test_repeated_invocations_do_not_accumulate(self):
        """Test that repeated invocations rebuild from current prompt without accumulation."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()
        agent._system_prompt = "Original prompt."
        agent._system_prompt_content = [{"text": "Original prompt."}]

        event = BeforeInvocationEvent(agent=agent)
        await plugin._on_before_invocation(event)
        first_prompt = agent.system_prompt

        await plugin._on_before_invocation(event)
        second_prompt = agent.system_prompt

        assert first_prompt == second_prompt

    @pytest.mark.asyncio
    async def test_no_skills_injects_empty_message(self):
        """Test that a 'no skills available' message is injected when no skills are loaded."""
        plugin = AgentSkills(skills=[])
        agent = _mock_agent()
        original_prompt = "Original prompt."
        agent._system_prompt = original_prompt
        agent._system_prompt_content = [{"text": original_prompt}]

        event = BeforeInvocationEvent(agent=agent)
        await plugin._on_before_invocation(event)

        assert "No skills are currently available" in agent.system_prompt
        assert agent.system_prompt.startswith("Original prompt.")

    @pytest.mark.asyncio
    async def test_none_system_prompt_handled(self):
        """Test handling when system prompt is None."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()
        agent._system_prompt = None
        agent._system_prompt_content = None

        event = BeforeInvocationEvent(agent=agent)
        await plugin._on_before_invocation(event)

        assert "<available_skills>" in agent.system_prompt

    @pytest.mark.asyncio
    async def test_preserves_other_plugin_modifications(self):
        """Test that modifications by other plugins/hooks are preserved."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()
        agent._system_prompt = "Original prompt."
        agent._system_prompt_content = [{"text": "Original prompt."}]

        event = BeforeInvocationEvent(agent=agent)
        await plugin._on_before_invocation(event)

        # Simulate another plugin modifying the prompt
        agent.system_prompt = agent.system_prompt + "\n\nExtra context from another plugin."

        await plugin._on_before_invocation(event)

        assert "Extra context from another plugin." in agent.system_prompt
        assert "<available_skills>" in agent.system_prompt

    @pytest.mark.asyncio
    async def test_uses_public_system_prompt_setter(self):
        """Test that the hook uses the public system_prompt setter."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()
        agent._system_prompt = "Original."
        agent._system_prompt_content = [{"text": "Original."}]

        event = BeforeInvocationEvent(agent=agent)
        await plugin._on_before_invocation(event)

        # The public setter should have been used via the content-block path:
        # original block is preserved and the skills XML is appended as a new block.
        assert len(agent.system_prompt_content) == 2
        assert agent.system_prompt_content[0] == {"text": "Original."}
        assert "<available_skills>" in agent.system_prompt_content[1]["text"]

    @pytest.mark.asyncio
    async def test_preserves_cache_points_in_system_prompt(self):
        """Test that cachePoint blocks in the system prompt are preserved after injection."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()
        agent._system_prompt = "Base instructions."
        agent._system_prompt_content = [
            {"text": "Base instructions."},
            {"cachePoint": {"type": "default"}},
        ]

        expected_skills_xml = plugin._generate_skills_xml(agent)

        event = BeforeInvocationEvent(agent=agent)
        await plugin._on_before_invocation(event)

        # Exact block structure: original text, cachePoint, skills XML
        assert agent.system_prompt_content == [
            {"text": "Base instructions."},
            {"cachePoint": {"type": "default"}},
            {"text": expected_skills_xml},
        ]

        # Repeated invocation: identical result, no accumulation
        await plugin._on_before_invocation(event)
        assert agent.system_prompt_content == [
            {"text": "Base instructions."},
            {"cachePoint": {"type": "default"}},
            {"text": expected_skills_xml},
        ]

    @pytest.mark.asyncio
    async def test_warns_when_previous_xml_not_found(self, caplog):
        """Test that a warning is logged when the previously injected XML is missing from the prompt."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()
        agent._system_prompt = "Original prompt."
        agent._system_prompt_content = [{"text": "Original prompt."}]

        event = BeforeInvocationEvent(agent=agent)
        await plugin._on_before_invocation(event)

        # Completely replace the system prompt, removing the injected XML
        agent.system_prompt = "Totally new prompt."

        with caplog.at_level(logging.WARNING):
            await plugin._on_before_invocation(event)

        assert "unable to find previously injected skills XML in system prompt" in caplog.text
        assert "<available_skills>" in agent.system_prompt


class TestStringPathInjection:
    """Tests for the string-path branch of _on_before_invocation (system_prompt_content is None)."""

    @pytest.mark.asyncio
    async def test_string_path_replaces_previous_xml(self):
        """Test that old injected XML is replaced when found in the string prompt."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()

        old_xml = "\n\n<old>xml</old>"
        agent._system_prompt = f"Base prompt.{old_xml}"
        agent._system_prompt_content = None
        agent.state.set(plugin._state_key, {"last_injected_xml": old_xml})

        event = BeforeInvocationEvent(agent=agent)
        await plugin._on_before_invocation(event)

        assert "<old>xml</old>" not in agent.system_prompt
        assert "<available_skills>" in agent.system_prompt
        assert agent.system_prompt.startswith("Base prompt.")

    @pytest.mark.asyncio
    async def test_string_path_warns_when_previous_xml_not_found(self, caplog):
        """Test that a warning is logged when old XML is missing from the string prompt."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()

        agent._system_prompt = "Totally new prompt."
        agent._system_prompt_content = None
        agent.state.set(plugin._state_key, {"last_injected_xml": "\n\n<old>xml</old>"})

        event = BeforeInvocationEvent(agent=agent)
        with caplog.at_level(logging.WARNING):
            await plugin._on_before_invocation(event)

        assert "unable to find previously injected skills XML in system prompt" in caplog.text
        assert "<available_skills>" in agent.system_prompt


class TestSkillsXmlGeneration:
    """Tests for _generate_skills_xml."""

    def test_single_skill(self):
        """Test XML generation with a single skill."""
        plugin = AgentSkills(skills=[_make_skill()])
        xml = plugin._generate_skills_xml()

        assert "<available_skills>" in xml
        assert "</available_skills>" in xml
        assert "<name>test-skill</name>" in xml
        assert "<description>A test skill</description>" in xml

    def test_multiple_skills(self):
        """Test XML generation with multiple skills."""
        skills = [
            _make_skill(name="skill-a", description="Skill A"),
            _make_skill(name="skill-b", description="Skill B"),
        ]
        plugin = AgentSkills(skills=skills)
        xml = plugin._generate_skills_xml()

        assert "<name>skill-a</name>" in xml
        assert "<name>skill-b</name>" in xml

    def test_empty_skills(self):
        """Test XML generation with no skills includes 'no skills available' message."""
        plugin = AgentSkills(skills=[])
        xml = plugin._generate_skills_xml()

        assert "<available_skills>" in xml
        assert "No skills are currently available" in xml
        assert "</available_skills>" in xml

    def test_location_included_when_path_set(self, tmp_path):
        """Test that location element is included when skill has a path."""
        skill = _make_skill()
        skill.path = tmp_path / "test-skill"
        plugin = AgentSkills(skills=[skill])
        xml = plugin._generate_skills_xml()

        assert f"<location>{tmp_path / 'test-skill' / 'SKILL.md'}</location>" in xml

    def test_location_omitted_when_path_none(self):
        """Test that location element is omitted for programmatic skills."""
        skill = _make_skill()
        assert skill.path is None
        plugin = AgentSkills(skills=[skill])
        xml = plugin._generate_skills_xml()

        assert "<location>" not in xml

    def test_escapes_xml_special_characters(self):
        """Test that XML special characters in names and descriptions are escaped."""
        skill = _make_skill(name="a<b>&c", description="Use <tools> & more")
        plugin = AgentSkills(skills=[skill])
        xml = plugin._generate_skills_xml()

        assert "<name>a&lt;b&gt;&amp;c</name>" in xml
        assert "<description>Use &lt;tools&gt; &amp; more</description>" in xml


class TestSkillResponseFormat:
    """Tests for _format_skill_response."""

    @pytest.mark.asyncio
    async def test_instructions_only(self):
        """Test response with just instructions."""
        skill = _make_skill(instructions="Do the thing.")
        plugin = AgentSkills(skills=[skill])
        result = await plugin._format_skill_response(skill, NotASandboxLocalEnvironment())

        assert result == "Do the thing."

    @pytest.mark.asyncio
    async def test_no_instructions(self):
        """Test response when skill has no instructions."""
        skill = _make_skill(instructions="")
        plugin = AgentSkills(skills=[skill])
        result = await plugin._format_skill_response(skill, NotASandboxLocalEnvironment())

        assert "no instructions available" in result.lower()

    @pytest.mark.asyncio
    async def test_includes_allowed_tools(self):
        """Test response includes allowed tools when set."""
        skill = _make_skill(instructions="Do the thing.")
        skill.allowed_tools = ["Bash", "Read"]
        plugin = AgentSkills(skills=[skill])
        result = await plugin._format_skill_response(skill, NotASandboxLocalEnvironment())

        assert "Do the thing." in result
        assert "Allowed tools: Bash, Read" in result

    @pytest.mark.asyncio
    async def test_includes_compatibility(self):
        """Test response includes compatibility when set."""
        skill = _make_skill(instructions="Do the thing.")
        skill.compatibility = "Requires docker"
        plugin = AgentSkills(skills=[skill])
        result = await plugin._format_skill_response(skill, NotASandboxLocalEnvironment())

        assert "Compatibility: Requires docker" in result

    @pytest.mark.asyncio
    async def test_includes_location(self, tmp_path):
        """Test response includes location when path is set."""
        skill = _make_skill(instructions="Do the thing.")
        skill.path = tmp_path / "test-skill"
        plugin = AgentSkills(skills=[skill])
        result = await plugin._format_skill_response(skill, NotASandboxLocalEnvironment())

        assert f"Location: {tmp_path / 'test-skill' / 'SKILL.md'}" in result

    @pytest.mark.asyncio
    async def test_all_metadata(self, tmp_path):
        """Test response with all metadata fields."""
        skill = _make_skill(instructions="Do the thing.")
        skill.allowed_tools = ["Bash"]
        skill.compatibility = "Requires git"
        skill.path = tmp_path / "test-skill"
        plugin = AgentSkills(skills=[skill])
        result = await plugin._format_skill_response(skill, NotASandboxLocalEnvironment())

        assert "Do the thing." in result
        assert "---" in result
        assert "Allowed tools: Bash" in result
        assert "Compatibility: Requires git" in result
        assert "Location:" in result

    @pytest.mark.asyncio
    async def test_includes_resource_listing(self, tmp_path):
        """Test response includes resource files from optional directories."""
        skill_dir = tmp_path / "test-skill"
        skill_dir.mkdir()
        (skill_dir / "scripts").mkdir()
        (skill_dir / "scripts" / "extract.py").write_text("# extract")
        (skill_dir / "references").mkdir()
        (skill_dir / "references" / "REFERENCE.md").write_text("# ref")

        skill = _make_skill(instructions="Do the thing.")
        skill.path = skill_dir
        plugin = AgentSkills(skills=[skill])
        result = await plugin._format_skill_response(skill, NotASandboxLocalEnvironment())

        assert "Available resources:" in result
        assert "scripts/extract.py" in result
        assert "references/REFERENCE.md" in result

    @pytest.mark.asyncio
    async def test_no_resources_when_no_path(self):
        """Test that resources section is omitted for programmatic skills."""
        skill = _make_skill(instructions="Do the thing.")
        plugin = AgentSkills(skills=[skill])
        result = await plugin._format_skill_response(skill, NotASandboxLocalEnvironment())

        assert "Available resources:" not in result

    @pytest.mark.asyncio
    async def test_no_resources_when_dirs_empty(self, tmp_path):
        """Test that resources section is omitted when optional dirs don't exist."""
        skill_dir = tmp_path / "test-skill"
        skill_dir.mkdir()

        skill = _make_skill(instructions="Do the thing.")
        skill.path = skill_dir
        plugin = AgentSkills(skills=[skill])
        result = await plugin._format_skill_response(skill, NotASandboxLocalEnvironment())

        assert "Available resources:" not in result

    @pytest.mark.asyncio
    async def test_resource_listing_truncated(self, tmp_path):
        """Test that resource listing is truncated at the max file limit."""
        skill_dir = tmp_path / "test-skill"
        scripts_dir = skill_dir / "scripts"
        scripts_dir.mkdir(parents=True)
        for i in range(55):
            (scripts_dir / f"script_{i:03d}.py").write_text(f"# script {i}")

        skill = _make_skill(instructions="Do the thing.")
        skill.path = skill_dir
        plugin = AgentSkills(skills=[skill])
        result = await plugin._format_skill_response(skill, NotASandboxLocalEnvironment())

        assert "Available resources:" in result
        assert "truncated at 20 files" in result


class TestResolveSkills:
    """Tests for _resolve_skills and per-agent path loading."""

    def test_resolve_skill_instances(self):
        """Test resolving Skill instances (pass-through into base skills)."""
        skill = _make_skill()
        plugin = AgentSkills(skills=[skill])

        assert len(plugin._skills) == 1
        assert plugin._skills["test-skill"] is skill

    def test_filesystem_paths_deferred_not_in_base_skills(self, tmp_path):
        """Test that filesystem paths are deferred, not resolved into base skills at construction."""
        _make_skill_dir(tmp_path, "path-skill")
        plugin = AgentSkills(skills=[tmp_path / "path-skill"])

        # Deferred: not in base _skills, collected in _skill_paths instead
        assert len(plugin._skills) == 0
        assert len(plugin._skill_paths) == 1

    @pytest.mark.asyncio
    async def test_resolve_skill_directory_path(self, tmp_path):
        """Test loading a path to a skill directory through the sandbox."""
        _make_skill_dir(tmp_path, "path-skill")
        plugin = AgentSkills(skills=[tmp_path / "path-skill"])
        agent = _mock_agent()
        await plugin.init_agent(agent)

        skills = {s.name for s in plugin.get_available_skills(agent)}
        assert "path-skill" in skills

    @pytest.mark.asyncio
    async def test_resolve_parent_directory_path(self, tmp_path):
        """Test loading a path to a parent directory through the sandbox."""
        _make_skill_dir(tmp_path, "child-a")
        _make_skill_dir(tmp_path, "child-b")
        plugin = AgentSkills(skills=[tmp_path])
        agent = _mock_agent()
        await plugin.init_agent(agent)

        assert len(plugin.get_available_skills(agent)) == 2

    @pytest.mark.asyncio
    async def test_resolve_skill_md_file_path(self, tmp_path):
        """Test loading a path to a SKILL.md file through the sandbox."""
        skill_dir = _make_skill_dir(tmp_path, "file-skill")
        plugin = AgentSkills(skills=[skill_dir / "SKILL.md"])
        agent = _mock_agent()
        await plugin.init_agent(agent)

        skills = {s.name for s in plugin.get_available_skills(agent)}
        assert "file-skill" in skills

    @pytest.mark.asyncio
    async def test_resolve_nonexistent_path(self, tmp_path):
        """Test that nonexistent paths are skipped."""
        plugin = AgentSkills(skills=[str(tmp_path / "ghost")])
        agent = _mock_agent()
        await plugin.init_agent(agent)
        assert len(plugin.get_available_skills(agent)) == 0


class TestResolveUrlSkills:
    """Tests for _resolve_skills with URL sources."""

    _SKILL_MODULE = "strands.vended_plugins.skills.skill"
    _SAMPLE_CONTENT = "---\nname: url-skill\ndescription: A URL skill\n---\n# Instructions\n"

    def _mock_urlopen(self, content):
        """Create a mock urlopen context manager returning the given content."""
        mock_response = MagicMock()
        mock_response.read.return_value = content.encode("utf-8")
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        return mock_response

    def test_resolve_url_source(self):
        """Test resolving a URL string as a skill source (available without an agent)."""
        from unittest.mock import patch

        with patch(
            f"{self._SKILL_MODULE}.urllib.request.urlopen", return_value=self._mock_urlopen(self._SAMPLE_CONTENT)
        ):
            plugin = AgentSkills(skills=["https://example.com/SKILL.md"])

        assert len(plugin.get_available_skills()) == 1
        assert plugin.get_available_skills()[0].name == "url-skill"

    @pytest.mark.asyncio
    async def test_resolve_mixed_url_and_local(self, tmp_path):
        """Test resolving a mix of URL and local filesystem sources."""
        from unittest.mock import patch

        _make_skill_dir(tmp_path, "local-skill")

        with patch(
            f"{self._SKILL_MODULE}.urllib.request.urlopen", return_value=self._mock_urlopen(self._SAMPLE_CONTENT)
        ):
            plugin = AgentSkills(
                skills=[
                    "https://example.com/SKILL.md",
                    str(tmp_path / "local-skill"),
                ]
            )

        agent = _mock_agent()
        await plugin.init_agent(agent)

        assert len(plugin.get_available_skills(agent)) == 2
        names = {s.name for s in plugin.get_available_skills(agent)}
        assert names == {"url-skill", "local-skill"}

    def test_resolve_url_failure_skips_gracefully(self, caplog):
        """Test that a failed URL fetch is skipped with a warning."""
        import logging
        import urllib.error
        from unittest.mock import patch

        with (
            patch(
                f"{self._SKILL_MODULE}.urllib.request.urlopen",
                side_effect=urllib.error.HTTPError(
                    url="https://example.com", code=404, msg="Not Found", hdrs=None, fp=None
                ),
            ),
            caplog.at_level(logging.WARNING),
        ):
            plugin = AgentSkills(skills=["https://example.com/broken/SKILL.md"])

        assert len(plugin.get_available_skills()) == 0
        assert "failed to load skill from URL" in caplog.text

    def test_resolve_duplicate_url_skills_warns(self, caplog):
        """Test that duplicate skill names from URLs log a warning."""
        import logging
        from unittest.mock import patch

        with (
            patch(
                f"{self._SKILL_MODULE}.urllib.request.urlopen",
                return_value=self._mock_urlopen(self._SAMPLE_CONTENT),
            ),
            caplog.at_level(logging.WARNING),
        ):
            plugin = AgentSkills(
                skills=[
                    "https://example.com/a/SKILL.md",
                    "https://example.com/b/SKILL.md",
                ]
            )

        assert len(plugin.get_available_skills()) == 1
        assert "duplicate skill name" in caplog.text


class TestImports:
    """Tests for module imports."""

    def test_import_skill_from_strands(self):
        """Test importing Skill from top-level strands package."""
        from strands import Skill as S

        assert S is Skill

    def test_import_from_skills_package(self):
        """Test importing from strands.vended_plugins.skills package."""
        from strands.vended_plugins.skills import AgentSkills, Skill

        assert Skill is not None
        assert AgentSkills is not None

    def test_skills_plugin_is_plugin_subclass(self):
        """Test that AgentSkills is a subclass of the Plugin ABC."""
        from strands.plugins import Plugin

        assert issubclass(AgentSkills, Plugin)

    def test_skills_plugin_isinstance_check(self):
        """Test that AgentSkills instances pass isinstance check against Plugin."""
        from strands.plugins import Plugin

        plugin = AgentSkills(skills=[])
        assert isinstance(plugin, Plugin)


def _make_skill_dir_named(parent: Path, dir_name: str, skill_name: str) -> Path:
    """Create a skill directory whose SKILL.md ``name`` differs from the directory name."""
    skill_dir = parent / dir_name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(f"---\nname: {skill_name}\ndescription: A skill\n---\n# Body\n")
    return skill_dir


class TestSkillPathLoadingEdgeCases:
    """Coverage for sandbox path-loading branches: name/dir mismatch and resource nesting."""

    @pytest.mark.asyncio
    async def test_name_dir_mismatch_warns_but_loads(self, tmp_path, caplog):
        # Non-strict: a skill whose name doesn't match its directory loads with a warning.
        _make_skill_dir_named(tmp_path, dir_name="wrong-dir", skill_name="actual-name")
        plugin = AgentSkills(skills=[str(tmp_path / "wrong-dir")])
        agent = _mock_agent()
        with caplog.at_level(logging.WARNING):
            await plugin.init_agent(agent)
        assert "does not match parent directory name" in caplog.text
        assert {s.name for s in plugin.get_available_skills(agent)} == {"actual-name"}

    @pytest.mark.asyncio
    async def test_name_dir_mismatch_strict_skips(self, tmp_path):
        # Strict: the mismatch raises, is caught per-skill, and the skill is skipped.
        _make_skill_dir_named(tmp_path, dir_name="wrong-dir", skill_name="actual-name")
        plugin = AgentSkills(skills=[str(tmp_path / "wrong-dir")], strict=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        assert plugin.get_available_skills(agent) == []

    @pytest.mark.asyncio
    async def test_lists_nested_resource_directories(self, tmp_path):
        # Resource listing recurses into subdirectories under scripts/.
        skill_dir = _make_skill_dir(tmp_path, "nested-skill")
        nested = skill_dir / "scripts" / "helpers"
        nested.mkdir(parents=True)
        (nested / "util.py").write_text("# util")
        skill = _make_skill(name="nested-skill")
        skill.path = skill_dir
        result = await AgentSkills(skills=[skill])._format_skill_response(skill, NotASandboxLocalEnvironment())
        assert "scripts/helpers/util.py" in result


class TestSetStateField:
    """Coverage for the agent-state type guard."""

    def test_rejects_non_dict_state(self):
        plugin = AgentSkills(skills=[])
        agent = _mock_agent()
        agent.state.set(plugin._state_key, "not-a-dict")
        with pytest.raises(TypeError, match="expected dict for state key"):
            plugin._set_state_field(agent, "k", "v")


class TestDynamicLoadingConfiguration:
    """Tests for the dynamic_loading flag and per-configuration tool variants."""

    def test_default_exposes_activate_variant(self):
        """Default configuration exposes one tool named skills, backed by the skills method."""
        plugin = AgentSkills(skills=[_make_skill()])

        assert len(plugin.tools) == 1
        assert plugin.tools[0].tool_name == "skills"
        assert plugin.tools[0].__name__ == "skills"

    def test_dynamic_exposes_action_variant(self):
        """dynamic_loading=True exposes one tool named skills, backed by dynamic_skills."""
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)

        assert len(plugin.tools) == 1
        assert plugin.tools[0].tool_name == "skills"
        assert plugin.tools[0].__name__ == "dynamic_skills"

    def test_dynamic_loading_is_keyword_only(self):
        """dynamic_loading must be passed as a keyword argument."""
        with pytest.raises(TypeError):
            AgentSkills([_make_skill()], "agent_skills", 20, False, True)  # type: ignore[misc]


class TestDynamicSkillsToolActivate:
    """Tests for the activate action of the dynamic skills tool variant."""

    @pytest.mark.asyncio
    async def test_activate_returns_instructions(self):
        """The activate action matches the default variant's behaviour."""
        skill = _make_skill(instructions="Full instructions here.")
        plugin = AgentSkills(skills=[skill], dynamic_loading=True)
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        result = await plugin.dynamic_skills(action="activate", skill_name="test-skill", tool_context=tool_context)

        assert "Full instructions here." in result

    @pytest.mark.asyncio
    async def test_activate_tracks_in_agent_state(self):
        """Activation through the dynamic variant is tracked like the default variant."""
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        await plugin.dynamic_skills(action="activate", skill_name="test-skill", tool_context=tool_context)

        assert plugin.get_activated_skills(agent) == ["test-skill"]

    @pytest.mark.asyncio
    async def test_activate_without_name(self):
        """Activating without a skill name returns an error listing available skills."""
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        result = await plugin.dynamic_skills(action="activate", tool_context=tool_context)

        assert "required" in result.lower()

    @pytest.mark.asyncio
    async def test_unknown_action(self):
        """An unknown action returns an error listing the valid actions."""
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        result = await plugin.dynamic_skills(action="explode", tool_context=tool_context)  # type: ignore[arg-type]

        assert "unknown action" in result.lower()
        assert "activate" in result and "load" in result and "unload" in result


class TestDynamicSkillsToolLoad:
    """Tests for the load action of the dynamic skills tool variant."""

    @pytest.mark.asyncio
    async def test_load_adds_skills(self, tmp_path):
        """Loading a parent directory registers its skills and reports them."""
        repo_skills = tmp_path / "repo" / "skills"
        _make_skill_dir(repo_skills, "repo-skill-a")
        _make_skill_dir(repo_skills, "repo-skill-b")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        tool_context = _mock_tool_context(agent)

        result = await plugin.dynamic_skills(action="load", path=str(repo_skills), tool_context=tool_context)

        assert "Loaded 2 skill(s)" in result
        assert "repo-skill-a" in result and "repo-skill-b" in result
        names = {s.name for s in plugin.get_available_skills(agent)}
        assert {"test-skill", "repo-skill-a", "repo-skill-b"} <= names

    @pytest.mark.asyncio
    async def test_loaded_skill_is_activatable(self, tmp_path):
        """A dynamically loaded skill can be activated like a configured one."""
        _make_skill_dir(tmp_path, "repo-skill")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        tool_context = _mock_tool_context(agent)

        await plugin.dynamic_skills(action="load", path=str(tmp_path), tool_context=tool_context)
        result = await plugin.dynamic_skills(action="activate", skill_name="repo-skill", tool_context=tool_context)

        assert "Instructions for repo-skill" in result

    @pytest.mark.asyncio
    async def test_load_records_path_in_state(self, tmp_path):
        """A successful load records the path in agent state for session persistence."""
        _make_skill_dir(tmp_path, "repo-skill")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        tool_context = _mock_tool_context(agent)

        await plugin.dynamic_skills(action="load", path=str(tmp_path), tool_context=tool_context)

        state_data = agent.state.get("agent_skills")
        assert state_data["dynamic_paths"] == [str(tmp_path)]

    @pytest.mark.asyncio
    async def test_load_requires_path(self):
        """The load action without a path returns an error."""
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        result = await plugin.dynamic_skills(action="load", tool_context=tool_context)

        assert "requires a 'path'" in result

    @pytest.mark.asyncio
    async def test_load_nonexistent_path(self, tmp_path):
        """Loading a path with no skills reports what was expected and records nothing."""
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        tool_context = _mock_tool_context(agent)

        result = await plugin.dynamic_skills(action="load", path=str(tmp_path / "missing"), tool_context=tool_context)

        assert "No skills found" in result
        state_data = agent.state.get("agent_skills")
        assert not (state_data or {}).get("dynamic_paths")

    @pytest.mark.asyncio
    async def test_load_trailing_slash_normalized(self, tmp_path):
        """Loading with a trailing slash and unloading without one refer to the same path."""
        _make_skill_dir(tmp_path, "repo-skill")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        tool_context = _mock_tool_context(agent)

        await plugin.dynamic_skills(action="load", path=f"{tmp_path}/", tool_context=tool_context)
        result = await plugin.dynamic_skills(action="unload", path=str(tmp_path), tool_context=tool_context)

        assert "Unloaded 1 skill(s)" in result

    @pytest.mark.asyncio
    async def test_reload_refreshes_path(self, tmp_path):
        """Re-loading a path picks up new skills and drops deleted ones."""
        import shutil

        _make_skill_dir(tmp_path, "old-skill")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        tool_context = _mock_tool_context(agent)

        await plugin.dynamic_skills(action="load", path=str(tmp_path), tool_context=tool_context)
        shutil.rmtree(tmp_path / "old-skill")
        _make_skill_dir(tmp_path, "new-skill")

        result = await plugin.dynamic_skills(action="load", path=str(tmp_path), tool_context=tool_context)

        assert "new-skill" in result
        assert "Removed on refresh: old-skill" in result
        names = {s.name for s in plugin.get_available_skills(agent)}
        assert "new-skill" in names
        assert "old-skill" not in names

    @pytest.mark.asyncio
    async def test_dynamic_skill_cannot_shadow_configured(self, tmp_path):
        """A dynamic skill whose name collides with a configured skill is skipped."""
        _make_skill_dir(tmp_path, "test-skill", description="An impostor")
        configured = _make_skill(instructions="Configured instructions.")
        plugin = AgentSkills(skills=[configured], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        tool_context = _mock_tool_context(agent)

        result = await plugin.dynamic_skills(action="load", path=str(tmp_path), tool_context=tool_context)

        assert "collides with a configured skill" in result
        assert "test-skill" in result
        activated = await plugin.dynamic_skills(action="activate", skill_name="test-skill", tool_context=tool_context)
        assert "Configured instructions." in activated
        assert plugin.get_dynamic_skills(agent) == {}

    @pytest.mark.asyncio
    async def test_collision_between_dynamic_paths_most_recent_wins(self, tmp_path):
        """When two dynamic paths provide the same skill name, the most recent load wins."""
        path_a = tmp_path / "a"
        path_b = tmp_path / "b"
        _make_skill_dir(path_a, "shared-skill", description="From A")
        _make_skill_dir(path_b, "shared-skill", description="From B")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        tool_context = _mock_tool_context(agent)

        await plugin.dynamic_skills(action="load", path=str(path_a), tool_context=tool_context)
        await plugin.dynamic_skills(action="load", path=str(path_b), tool_context=tool_context)

        skill = next(s for s in plugin.get_available_skills(agent) if s.name == "shared-skill")
        assert skill.description == "From B"
        assert plugin.get_dynamic_skills(agent)["shared-skill"] == str(path_b)


class TestDynamicSkillsToolUnload:
    """Tests for the unload action of the dynamic skills tool variant."""

    @pytest.mark.asyncio
    async def test_unload_removes_skills_and_state(self, tmp_path):
        """Unloading removes the path's skills and its state record."""
        _make_skill_dir(tmp_path, "repo-skill")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        tool_context = _mock_tool_context(agent)

        await plugin.dynamic_skills(action="load", path=str(tmp_path), tool_context=tool_context)
        result = await plugin.dynamic_skills(action="unload", path=str(tmp_path), tool_context=tool_context)

        assert "Unloaded 1 skill(s)" in result
        names = {s.name for s in plugin.get_available_skills(agent)}
        assert "repo-skill" not in names
        assert "test-skill" in names
        state_data = agent.state.get("agent_skills")
        assert state_data["dynamic_paths"] == []

    @pytest.mark.asyncio
    async def test_unload_unknown_path(self, tmp_path):
        """Unloading a path that contributed nothing returns a hint with loaded paths."""
        _make_skill_dir(tmp_path, "repo-skill")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        tool_context = _mock_tool_context(agent)

        await plugin.dynamic_skills(action="load", path=str(tmp_path), tool_context=tool_context)
        result = await plugin.dynamic_skills(action="unload", path="/nope", tool_context=tool_context)

        assert "No skills are loaded from '/nope'" in result
        assert str(tmp_path) in result

    @pytest.mark.asyncio
    async def test_unload_requires_path(self):
        """The unload action without a path returns an error."""
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        tool_context = _mock_tool_context(agent)

        result = await plugin.dynamic_skills(action="unload", tool_context=tool_context)

        assert "requires a 'path'" in result


class TestDynamicSkillsPersistence:
    """Tests for restoring dynamic skills from agent state across runs."""

    @pytest.mark.asyncio
    async def test_restore_on_init_agent(self, tmp_path):
        """A fresh plugin instance restores dynamic skills recorded in agent state."""
        _make_skill_dir(tmp_path, "repo-skill")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        agent.state.set("agent_skills", {"dynamic_paths": [str(tmp_path)]})

        await plugin.init_agent(agent)

        names = {s.name for s in plugin.get_available_skills(agent)}
        assert "repo-skill" in names
        assert plugin.get_dynamic_skills(agent) == {"repo-skill": str(tmp_path)}

    @pytest.mark.asyncio
    async def test_restore_fail_soft_on_missing_path(self, tmp_path):
        """A recorded path that no longer exists loads nothing but stays recorded."""
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        agent.state.set("agent_skills", {"dynamic_paths": [str(tmp_path / "gone")]})

        await plugin.init_agent(agent)

        names = {s.name for s in plugin.get_available_skills(agent)}
        assert names == {"test-skill"}
        state_data = agent.state.get("agent_skills")
        assert state_data["dynamic_paths"] == [str(tmp_path / "gone")]

    @pytest.mark.asyncio
    async def test_programmatic_load_unload_without_flag(self, tmp_path):
        """load_skills_for / unload_skills_for work regardless of dynamic_loading."""
        _make_skill_dir(tmp_path, "repo-skill")
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()
        await plugin.init_agent(agent)

        added = await plugin.load_skills_for(agent, tmp_path)
        assert added == ["repo-skill"]
        assert "repo-skill" in {s.name for s in plugin.get_available_skills(agent)}

        removed = plugin.unload_skills_for(agent, tmp_path)
        assert removed == ["repo-skill"]
        assert "repo-skill" not in {s.name for s in plugin.get_available_skills(agent)}


class TestDynamicSkillsInjection:
    """Tests for system prompt injection behaviour with dynamic loading."""

    @pytest.mark.asyncio
    async def test_usage_hint_present_in_dynamic_mode(self):
        """The injected block opens with a usage hint when dynamic loading is enabled."""
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()

        await plugin._on_before_invocation(BeforeInvocationEvent(agent=agent))

        assert "<usage>" in agent.system_prompt
        assert 'action="load"' in agent.system_prompt

    @pytest.mark.asyncio
    async def test_usage_hint_present_when_no_skills(self):
        """The usage hint appears even when no skills are loaded yet."""
        plugin = AgentSkills(skills=[], dynamic_loading=True)
        agent = _mock_agent()

        await plugin._on_before_invocation(BeforeInvocationEvent(agent=agent))

        assert "<usage>" in agent.system_prompt
        assert "No skills are currently available." in agent.system_prompt

    def test_default_xml_unchanged(self):
        """Default configuration produces the exact same XML as before (no usage hint)."""
        skill = _make_skill()
        plugin = AgentSkills(skills=[skill])

        xml = plugin._generate_skills_xml()

        assert xml == (
            "<available_skills>\n"
            "<skill>\n"
            "<name>test-skill</name>\n"
            "<description>A test skill</description>\n"
            "</skill>\n"
            "</available_skills>"
        )

    @pytest.mark.asyncio
    async def test_before_model_call_reinjects_after_load(self, tmp_path):
        """A mid-invocation load appears in the system prompt on the next model call."""
        _make_skill_dir(tmp_path, "repo-skill")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        await plugin._on_before_invocation(BeforeInvocationEvent(agent=agent))
        assert "repo-skill" not in agent.system_prompt

        tool_context = _mock_tool_context(agent)
        await plugin.dynamic_skills(action="load", path=str(tmp_path), tool_context=tool_context)
        await plugin._on_before_model_call(BeforeModelCallEvent(agent=agent))

        assert "<name>repo-skill</name>" in agent.system_prompt
        # And it does not accumulate blocks on repeated calls
        first = agent.system_prompt
        await plugin._on_before_model_call(BeforeModelCallEvent(agent=agent))
        assert agent.system_prompt == first

    @pytest.mark.asyncio
    async def test_before_model_call_noop_in_default_mode(self):
        """The before-model-call hook does nothing in the default configuration."""
        plugin = AgentSkills(skills=[_make_skill()])
        agent = _mock_agent()
        original = agent.system_prompt

        await plugin._on_before_model_call(BeforeModelCallEvent(agent=agent))

        assert agent.system_prompt == original

    @pytest.mark.asyncio
    async def test_unload_disappears_from_prompt(self, tmp_path):
        """An unloaded skill disappears from the system prompt on the next model call."""
        _make_skill_dir(tmp_path, "repo-skill")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        tool_context = _mock_tool_context(agent)

        await plugin.dynamic_skills(action="load", path=str(tmp_path), tool_context=tool_context)
        await plugin._on_before_model_call(BeforeModelCallEvent(agent=agent))
        assert "<name>repo-skill</name>" in agent.system_prompt

        await plugin.dynamic_skills(action="unload", path=str(tmp_path), tool_context=tool_context)
        await plugin._on_before_model_call(BeforeModelCallEvent(agent=agent))
        assert "<name>repo-skill</name>" not in agent.system_prompt


class TestDynamicSkillsSessionRestore:
    """Regression tests for the session-manager restore ordering.

    Session managers replace ``agent.state`` wholesale on ``AgentInitializedEvent``,
    which fires AFTER plugin ``init_agent`` already ran, so recorded dynamic paths
    are only visible at hook time. The hooks reconcile them.
    """

    @pytest.mark.asyncio
    async def test_state_replaced_after_init_restores_on_before_invocation(self, tmp_path):
        """Dynamic paths that appear in state after init_agent load on the invocation hook."""
        _make_skill_dir(tmp_path, "restored-skill")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)  # state is empty at this point, like a real Agent

        # Simulate RepositorySessionManager.initialize replacing the state wholesale.
        agent.state.set(plugin._state_key, {"dynamic_paths": [str(tmp_path)]})

        await plugin._on_before_invocation(BeforeInvocationEvent(agent=agent))

        assert "restored-skill" in plugin.get_dynamic_skills(agent)
        assert "restored-skill" in agent.system_prompt

    @pytest.mark.asyncio
    async def test_state_replaced_after_init_restores_on_before_model_call(self, tmp_path):
        """The model-call hook reconciles too, so mid-invocation state is honoured."""
        _make_skill_dir(tmp_path, "restored-skill")
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)

        agent.state.set(plugin._state_key, {"dynamic_paths": [str(tmp_path)]})

        await plugin._on_before_model_call(BeforeModelCallEvent(agent=agent))

        assert "restored-skill" in plugin.get_dynamic_skills(agent)

    @pytest.mark.asyncio
    async def test_missing_recorded_path_is_retried_until_it_appears(self, tmp_path):
        """A recorded path that does not exist yet is fail-soft and retried on later hooks."""
        plugin = AgentSkills(skills=[], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        missing = tmp_path / "not-cloned-yet"
        agent.state.set(plugin._state_key, {"dynamic_paths": [str(missing)]})

        await plugin._on_before_invocation(BeforeInvocationEvent(agent=agent))
        assert plugin.get_dynamic_skills(agent) == {}

        _make_skill_dir(missing, "late-skill")
        await plugin._on_before_model_call(BeforeModelCallEvent(agent=agent))
        assert "late-skill" in plugin.get_dynamic_skills(agent)

    @pytest.mark.asyncio
    async def test_reconcile_does_not_refresh_contributing_paths(self, tmp_path):
        """Hooks only load missing paths; refreshing a live path stays an explicit action."""
        skill_dir = _make_skill_dir(tmp_path, "live-skill")
        plugin = AgentSkills(skills=[], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        await plugin.dynamic_skills(action="load", path=str(tmp_path), tool_context=_mock_tool_context(agent))
        assert "live-skill" in plugin.get_dynamic_skills(agent)

        (skill_dir / "SKILL.md").unlink()  # would disappear on an implicit refresh
        await plugin._on_before_invocation(BeforeInvocationEvent(agent=agent))

        assert "live-skill" in plugin.get_dynamic_skills(agent)


class TestDynamicSkillsRobustness:
    """Edge cases raised in pre-PR critic review."""

    @pytest.mark.asyncio
    async def test_corrupted_dynamic_paths_state_is_ignored(self):
        """A non-list dynamic_paths value (corrupted persisted state) is ignored fail-soft."""
        plugin = AgentSkills(skills=[_make_skill()], dynamic_loading=True)
        agent = _mock_agent()
        agent.state.set(plugin._state_key, {"dynamic_paths": "/etc/not-a-list"})

        await plugin._on_before_invocation(BeforeInvocationEvent(agent=agent))

        assert plugin.get_dynamic_skills(agent) == {}

    def test_normalize_path_edge_cases(self):
        """Root paths survive normalization; trailing slashes and whitespace are stripped."""
        from strands.vended_plugins.skills.agent_skills import _normalize_dynamic_path

        assert _normalize_dynamic_path("./repo/skills/") == "./repo/skills"
        assert _normalize_dynamic_path("  ./repo/skills  ") == "./repo/skills"
        assert _normalize_dynamic_path("/") == "/"
        assert _normalize_dynamic_path("///") == "/"
        assert _normalize_dynamic_path("   ") == ""

    def test_subclass_extra_tools_are_preserved(self):
        """Filtering the skills tool variants must not drop @tool methods added by subclasses."""
        from strands.tools.decorator import tool as tool_decorator

        class ExtendedSkills(AgentSkills):
            @tool_decorator
            def extra(self) -> str:
                """An extra subclass tool."""
                return "extra"

        for dynamic in (False, True):
            plugin = ExtendedSkills(skills=[_make_skill()], dynamic_loading=dynamic)
            names = sorted(t.tool_name for t in plugin.tools)
            assert names == ["extra", "skills"]
            variant = next(t for t in plugin.tools if t.tool_name == "skills")
            assert variant.__name__ == ("dynamic_skills" if dynamic else "skills")

    @pytest.mark.asyncio
    async def test_unload_after_override_removes_skill_outright(self, tmp_path):
        """Unloading an overriding path does not resurrect the overridden version."""
        path_a = tmp_path / "a"
        path_b = tmp_path / "b"
        _make_skill_dir(path_a, "shared-skill", description="from A")
        _make_skill_dir(path_b, "shared-skill", description="from B")
        plugin = AgentSkills(skills=[], dynamic_loading=True)
        agent = _mock_agent()
        await plugin.init_agent(agent)
        tool_context = _mock_tool_context(agent)

        await plugin.dynamic_skills(action="load", path=str(path_a), tool_context=tool_context)
        await plugin.dynamic_skills(action="load", path=str(path_b), tool_context=tool_context)
        assert plugin.get_dynamic_skills(agent)["shared-skill"] == str(path_b)

        result = await plugin.dynamic_skills(action="unload", path=str(path_b), tool_context=tool_context)

        assert "shared-skill" in result
        assert "shared-skill" not in plugin.get_dynamic_skills(agent)
        assert "shared-skill" not in {s.name for s in plugin.get_available_skills(agent)}
