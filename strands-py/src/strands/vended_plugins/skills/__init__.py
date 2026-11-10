"""AgentSkills.io integration for Strands Agents.

This module provides the AgentSkills plugin for integrating AgentSkills.io skills
into Strands agents. Skills enable progressive disclosure of instructions:
metadata is injected into the system prompt upfront, and full instructions
are loaded on demand via a tool.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_plugins.skills import Skill, AgentSkills

    # Load from filesystem via classmethods
    skill = Skill.from_file("./skills/pdf-processing")
    skills = Skill.from_directory("./skills/")

    # Or let the plugin resolve paths automatically
    plugin = AgentSkills(skills=["./skills/pdf-processing"])
    agent = Agent(plugins=[plugin])
    ```
"""

from .agent_skills import AgentSkills, SkillSource, SkillSources
from .skill import Skill

__all__ = [
    "AgentSkills",
    "Skill",
    "SkillSource",
    "SkillSources",
]
