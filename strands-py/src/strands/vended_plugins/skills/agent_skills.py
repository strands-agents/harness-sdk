"""AgentSkills plugin for integrating Agent Skills into Strands agents.

This module provides the AgentSkills class that extends the Plugin base class
to add Agent Skills support. The plugin registers a tool for activating
skills, and injects skill metadata into the system prompt. With
``dynamic_loading=True`` the tool also exposes ``load`` / ``unload`` actions so
the agent can register additional skills from directories in its sandbox at
runtime (for example a ``skills/`` folder inside a repository it just cloned)
and remove them again.

Filesystem skill sources are loaded through the agent's sandbox (host or
container) at ``init_agent`` time, not at construction, so each agent sees the
skills present on its own filesystem. Skill instances and ``https://`` URLs are
sandbox-independent and resolve eagerly at construction.

:meth:`Skill.from_url` is synchronous, so URLs resolve at construction and no
readiness barrier is needed. The observable effect is benign: URL skills are
"""

from __future__ import annotations

import logging
import weakref
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, TypeAlias
from xml.sax.saxutils import escape

from ...hooks.events import BeforeInvocationEvent, BeforeModelCallEvent
from ...plugins import Plugin, hook
from ...tools.decorator import tool
from ...types.content import SystemContentBlock
from ...types.tools import ToolContext
from .skill import Skill

if TYPE_CHECKING:
    from ...agent.agent import Agent
    from ...sandbox import FileInfo, Sandbox

logger = logging.getLogger(__name__)

_DEFAULT_STATE_KEY = "agent_skills"
_RESOURCE_DIRS = ("scripts", "references", "assets")
_DEFAULT_MAX_RESOURCE_FILES = 20
_MAX_RESOURCE_DEPTH = 3

_DYNAMIC_USAGE_HINT = (
    "<usage>Load additional skills from a directory in your workspace with the skills tool "
    '(action="load", path=...) - for example a skills/ folder inside a repository you cloned; '
    'action="unload" with the same path removes them. Activate any listed skill with '
    'action="activate" to receive its full instructions.</usage>'
)
"""Usage hint prepended to the injected skills block when ``dynamic_loading`` is enabled, so the
model discovers the load/unload mechanism from the prompt itself. Absent by default, keeping the
default configuration's output byte-identical to previous releases."""

SkillSource: TypeAlias = str | Path | Skill
"""A single skill source: path string, Path object, or Skill instance."""

SkillSources: TypeAlias = SkillSource | list[SkillSource]
"""One or more skill sources."""


def _normalize_sources(sources: SkillSources) -> list[SkillSource]:
    """Normalize a single source or list of sources into a list."""
    if isinstance(sources, list):
        return sources
    return [sources]


def _normalize_dynamic_path(path: str | Path) -> str:
    """Normalize a dynamic skill path for use as a stable origin key.

    Strips surrounding whitespace and trailing slashes so that ``./repo/skills`` and
    ``./repo/skills/`` refer to the same loaded path. The filesystem root (``"/"``)
    is preserved rather than stripped to the empty string. Paths use the sandbox
    convention of ``/`` separators (as everywhere else in this plugin).

    Args:
        path: The raw path provided by the agent or caller.

    Returns:
        The normalized path string (may be empty if the input was blank).
    """
    text = str(path).strip()
    if not text:
        return ""
    stripped = text.rstrip("/")
    return stripped if stripped else "/"


def _find_skill_md_name(entries: list[FileInfo]) -> str | None:
    """Find the SKILL.md filename among directory entries.

    Prefers ``SKILL.md`` over ``skill.md`` (matching :meth:`Skill.from_file`
    precedence). Returns ``None`` if neither is present.

    Args:
        entries: Directory entries from a sandbox ``list_files`` call.

    Returns:
        The SKILL.md filename, or ``None`` if not found.
    """
    for name in ("SKILL.md", "skill.md"):
        if any(not entry.is_dir and entry.name == name for entry in entries):
            return name
    return None


class AgentSkills(Plugin):
    """Plugin that integrates Agent Skills into a Strands agent.

    The AgentSkills plugin extends the Plugin base class and provides:

    1. A ``skills`` tool that allows the agent to activate skills on demand
    2. System prompt injection of available skill metadata before each invocation
    3. Session persistence of active skill state via ``agent.state``

    Skills can be provided as filesystem paths (to individual skill directories or
    parent directories containing multiple skills), ``https://`` URLs pointing to
    raw SKILL.md content, or as pre-built ``Skill`` instances.

    With ``dynamic_loading=True`` the ``skills`` tool becomes action-based, adding
    ``load`` / ``unload`` actions so the agent can register additional skills from
    directories in its sandbox at runtime (for example a ``skills/`` folder inside a
    repository it just cloned) and remove them again. Dynamically loaded paths are
    recorded in ``agent.state``, so they are restored on the next run over the same
    session (fail-soft: a path that no longer exists simply contributes nothing until
    it is re-loaded). Dynamic skills can never shadow the skills configured on the
    plugin. The matching programmatic methods (``load_skills_for`` /
    ``unload_skills_for``) are available regardless of the flag, which only controls
    the tool surface exposed to the model. Note that dynamically loaded SKILL.md
    content reaches the system prompt, so only enable the flag when sandbox contents
    are trusted (see ``dynamic_loading`` in ``__init__``).

    Filesystem paths are read through the agent's sandbox at ``init_agent`` time,
    so each agent loads the skills present on its own filesystem (host or
    container). Skill instances and URLs are sandbox-independent and resolve at
    construction. As a result, ``get_available_skills`` returns filesystem skills
    only when passed the agent they were loaded for.

    Example:
        ```python
        from strands import Agent
        from strands.vended_plugins.skills import Skill, AgentSkills

        # Load from filesystem
        plugin = AgentSkills(skills=["./skills/pdf-processing", "./skills/"])

        # Or provide Skill instances directly
        skill = Skill(name="my-skill", description="A custom skill", instructions="Do the thing")
        plugin = AgentSkills(skills=[skill])

        # Let the agent load/unload additional skills from its sandbox at runtime
        plugin = AgentSkills(skills=["./skills/"], dynamic_loading=True)

        agent = Agent(plugins=[plugin])
        ```
    """

    name = "agent_skills"

    def __init__(
        self,
        skills: SkillSources,
        state_key: str = _DEFAULT_STATE_KEY,
        max_resource_files: int = _DEFAULT_MAX_RESOURCE_FILES,
        strict: bool = False,
        *,
        dynamic_loading: bool = False,
    ) -> None:
        """Initialize the AgentSkills plugin.

        Args:
            skills: One or more skill sources. Can be a single value or a list. Each element can be:

                - A ``str`` or ``Path`` to a skill directory (containing SKILL.md)
                - A ``str`` or ``Path`` to a parent directory (containing skill subdirectories)
                - A ``Skill`` dataclass instance
                - An ``https://`` URL pointing directly to raw SKILL.md content
            state_key: Key used to store plugin state in ``agent.state``.
            max_resource_files: Maximum number of resource files to list in skill responses.
            strict: If True, raise on skill validation issues. If False (default), warn and load anyway.
            dynamic_loading: If True, expose the action-based ``skills`` tool variant with
                ``load`` / ``unload`` actions, allowing the agent to register additional skills
                from directories in its sandbox at runtime and remove them again. Defaults to
                False, which keeps the tool surface and system prompt output identical to
                previous releases.

                .. warning::
                    Skill content is injected into the system prompt (descriptions) and
                    returned verbatim on activation (instructions). ``dynamic_loading`` lets
                    the *model* pull SKILL.md content from anywhere in its sandbox - including
                    repositories it cloned - so untrusted skill content becomes a prompt
                    injection vector. Only enable it when the sandbox contents are trusted, or
                    pair it with instructions/guardrails for treating loaded skills as
                    untrusted input.
        """
        self._strict = strict
        self._state_key = state_key
        self._dynamic_loading = dynamic_loading
        self._max_resource_files = max_resource_files
        # Skill instances and URLs resolve now (both sandbox-independent and synchronous in
        # Python). Filesystem paths are deferred to init_agent, where the agent's sandbox is
        # available, so a path may resolve differently per agent (host vs. container).
        self._skills, self._skill_paths = self._resolve_skills(_normalize_sources(skills))
        # Per-agent full skill set (base skills + path-loaded skills from that agent's sandbox).
        # Per-agent map (WeakKeyDictionary) so a single plugin
        # instance can serve multiple agents without leaking references once an agent is collected.
        self._agent_skills: weakref.WeakKeyDictionary[Agent, dict[str, Skill]] = weakref.WeakKeyDictionary()
        # Per-agent origin map for dynamically loaded skills (skill name -> the sandbox path it
        # was loaded from). Skills configured on the plugin are absent from this map.
        self._dynamic_origins: weakref.WeakKeyDictionary[Agent, dict[str, str]] = weakref.WeakKeyDictionary()
        super().__init__()
        # Both configurations surface a single tool named ``skills``; only the variant matching
        # the configuration is exposed. The default uses the activate-and-return variant (the
        # ``skills`` method); ``dynamic_loading`` uses the action-based variant with load/unload
        # actions (the ``dynamic_skills`` method, published under the ``skills`` tool name). The
        # variants share a tool name, so filtering is by the defining method's name.
        # Remove only the non-matching variant (rather than keeping the matching one) so
        # additional @tool methods defined by subclasses are preserved. getattr:
        # functools.update_wrapper copies __name__ onto DecoratedFunctionTool at runtime.
        unwanted_method = "skills" if dynamic_loading else "dynamic_skills"
        self._tools = [t for t in self._tools if getattr(t, "__name__", None) != unwanted_method]

    async def init_agent(self, agent: Agent) -> None:
        """Initialize the plugin with an agent instance.

        Loads any deferred filesystem skill paths through the agent's sandbox,
        building the agent's full skill set, then restores any dynamic skill paths
        recorded in ``agent.state`` from earlier runs. Decorated hooks and tools are
        auto-registered by the plugin registry.

        Args:
            agent: The agent instance to extend with skills support.
        """
        await self._load_skill_paths(agent)
        skills = self._agent_skills.get(agent, self._skills)
        if not skills:
            logger.warning("no skills were loaded, the agent will have no skills available")
        logger.debug("skill_count=<%d> | skills plugin initialized", len(skills))

    @tool(context=True)
    async def skills(self, skill_name: str, tool_context: ToolContext) -> str:
        """Activate a skill to load its full instructions.

        Use this tool to load the complete instructions for a skill listed in
        the available_skills section of your system prompt.

        Args:
            skill_name: Name of the skill to activate.
            tool_context: Injected by the framework. Not user-facing.
        """
        return await self._activate_skill(tool_context.agent, skill_name)

    @tool(name="skills", context=True)
    async def dynamic_skills(
        self,
        action: Literal["activate", "load", "unload"],
        skill_name: str = "",
        path: str = "",
        *,
        tool_context: ToolContext,
    ) -> str:
        """Activate a skill, or load/unload additional skills from your workspace.

        Use ``activate`` to receive the complete instructions for a skill listed in the
        available_skills section of your system prompt. Beyond those, you can register
        additional skills from any directory you can reach in your workspace with ``load``
        - for example a ``skills/`` folder inside a repository you just cloned. Loaded
        skills appear in available_skills and are activated the same way; loading the same
        path again refreshes it (picking up edits and removals), and ``unload`` removes the
        skills a path contributed (if one of them had overridden a skill from another loaded
        path, re-load that path to restore its version).

        Args:
            action: ``"activate"`` to receive a skill's full instructions, ``"load"`` to
                register every skill found under ``path``, ``"unload"`` to remove the
                skills previously loaded from ``path``.
            skill_name: Name of the skill to activate (required for ``"activate"``), as
                listed in the ``<name>`` element of the available_skills section of your
                system prompt.
            path: Directory to load skills from or unload skills of (required for
                ``"load"`` / ``"unload"``). May be a skill directory (containing SKILL.md),
                a parent directory of skill directories, or a direct path to a SKILL.md
                file. Resolved in your workspace filesystem.
            tool_context: Injected by the framework. Not user-facing.
        """
        agent = tool_context.agent

        if action == "activate":
            return await self._activate_skill(agent, skill_name)

        if action in ("load", "unload"):
            normalized = _normalize_dynamic_path(path)
            if not normalized:
                return f"Error: action '{action}' requires a 'path' (a directory in your workspace)."

            if action == "load":
                added, skipped, removed = await self._load_dynamic_path(agent, normalized, persist=True)
                return self._render_load_result(normalized, added, skipped, removed)

            removed = self.unload_skills_for(agent, normalized)
            if not removed:
                loaded_paths = sorted(set(self._dynamic_origins.get(agent, {}).values()))
                hint = f" Currently loaded paths: {', '.join(loaded_paths)}." if loaded_paths else ""
                return f"No skills are loaded from '{normalized}'.{hint}"
            return f"Unloaded {len(removed)} skill(s) from '{normalized}': {', '.join(sorted(removed))}."

        return f"Error: unknown action '{action}'. Valid actions: activate, load, unload"

    async def _activate_skill(self, agent: Agent, skill_name: str) -> str:
        """Activate a skill for an agent and return its formatted instructions.

        Shared implementation behind both ``skills`` tool variants.

        Args:
            agent: The agent activating the skill.
            skill_name: Name of the skill to activate.

        Returns:
            The skill's formatted instructions, or an error message listing available skills.
        """
        skills = self._skills_for(agent)

        if not skill_name:
            available = ", ".join(skills)
            return f"Error: skill_name is required. Available skills: {available}"

        found = skills.get(skill_name)
        if found is None:
            available = ", ".join(skills)
            return f"Skill '{skill_name}' not found. Available skills: {available}"

        logger.debug("skill_name=<%s> | skill activated", skill_name)
        self._track_activated_skill(agent, skill_name)
        return await self._format_skill_response(found, agent.sandbox)

    @hook
    async def _on_before_invocation(self, event: BeforeInvocationEvent) -> None:
        """Inject skill metadata into the system prompt before each invocation.

        On first invocation for an agent (or after ``set_available_skills`` reset
        the per-agent cache), loads that agent's deferred filesystem skill paths
        through its sandbox, then injects the skills block.

        Args:
            event: The before-invocation event containing the agent reference.
        """
        agent = event.agent

        # Lazily load filesystem skills if this agent has not been initialized yet,
        # or after set_available_skills cleared the per-agent cache.
        if agent not in self._agent_skills:
            await self._load_skill_paths(agent)

        # Session managers replace agent.state wholesale AFTER init_agent ran (on
        # AgentInitializedEvent), so dynamic paths restored from a persisted session are
        # only visible now. Load any recorded path that is not contributing skills yet.
        await self._reconcile_dynamic_paths(agent)

        self._inject_skills(agent)

    @hook
    async def _on_before_model_call(self, event: BeforeModelCallEvent) -> None:
        """Re-inject the skills block before each model call when dynamic loading is enabled.

        With ``dynamic_loading`` the available skill set can change mid-invocation when the
        agent calls the ``skills`` tool with ``load`` / ``unload``. Re-injecting before every
        model call ensures the next turn's system prompt reflects the current skill set. In
        the default configuration the injected block only changes between invocations, so
        this hook is a no-op to avoid redundant work.

        Args:
            event: The before-model-call event containing the agent reference.
        """
        if not self._dynamic_loading:
            return
        if event.agent not in self._agent_skills:
            await self._load_skill_paths(event.agent)
        await self._reconcile_dynamic_paths(event.agent)
        self._inject_skills(event.agent)

    def _inject_skills(self, agent: Agent) -> None:
        """Inject the skills XML block into the agent's system prompt.

        Removes the previously injected XML block (if any) via exact match and
        appends a fresh one. Uses agent state to track the injected XML per-agent,
        so a single plugin instance can be shared across multiple agents safely.

        When the agent has a structured system prompt (list of SystemContentBlock),
        the injection is done at the block level so that cache points and other
        structured blocks are preserved. Otherwise falls back to string manipulation.

        Args:
            agent: The agent whose system prompt to update.
        """
        state_data = agent.state.get(self._state_key)
        last_injected_xml = state_data.get("last_injected_xml") if isinstance(state_data, dict) else None

        skills_xml = self._generate_skills_xml(agent)
        content = agent.system_prompt_content

        if content is not None:
            # Content-block path: preserve cache points and other structured blocks
            blocks: list[SystemContentBlock] = list(content)
            if last_injected_xml is not None:
                injected_block: SystemContentBlock = {"text": last_injected_xml}
                if injected_block in blocks:
                    blocks.remove(injected_block)
                else:
                    logger.warning("unable to find previously injected skills XML in system prompt, re-appending")
            blocks.append({"text": skills_xml})
            self._set_state_field(agent, "last_injected_xml", skills_xml)
            agent.system_prompt = blocks
        else:
            # String path: legacy behaviour for plain-string system prompts
            current_prompt = agent.system_prompt or ""
            if last_injected_xml is not None:
                if last_injected_xml in current_prompt:
                    current_prompt = current_prompt.replace(last_injected_xml, "")
                else:
                    logger.warning("unable to find previously injected skills XML in system prompt, re-appending")
            injection = f"\n\n{skills_xml}"
            new_prompt = f"{current_prompt}{injection}" if current_prompt else skills_xml
            new_injected_xml = injection if current_prompt else skills_xml
            self._set_state_field(agent, "last_injected_xml", new_injected_xml)
            agent.system_prompt = new_prompt

    def get_available_skills(self, agent: Agent | None = None) -> list[Skill]:
        """Get the list of available skills.

        Args:
            agent: When provided, returns that agent's full skill set (base skills
                plus filesystem skills loaded from its sandbox). When omitted,
                returns only the sandbox-independent base skills (Skill instances
                and URLs); filesystem skills are excluded because they are loaded
                per-agent at ``init_agent`` time.

        Returns:
            A copy of the resolved skills list.
        """
        skills = self._skills_for(agent) if agent is not None else self._skills
        return list(skills.values())

    def set_available_skills(self, skills: SkillSources) -> None:
        """Set the available skills, replacing any existing ones.

        Each element can be a ``Skill`` instance, a ``str`` or ``Path`` to a
        skill directory (containing SKILL.md), a ``str`` or ``Path`` to a
        parent directory containing skill subdirectories, or an ``https://``
        URL pointing directly to raw SKILL.md content.

        Filesystem paths are re-loaded per-agent on the next invocation. Note:
        this does not persist state or deactivate skills on any agent. Active
        skill state is managed per-agent and will be reconciled on the next tool
        call or invocation.

        Args:
            skills: One or more skill sources to resolve and set.
        """
        self._skills, self._skill_paths = self._resolve_skills(_normalize_sources(skills))
        # Drop per-agent caches so deferred paths reload against each agent's sandbox.
        # Dynamic origins are dropped with them; recorded dynamic paths in agent state
        # are re-loaded on the next invocation.
        self._agent_skills = weakref.WeakKeyDictionary()
        self._dynamic_origins = weakref.WeakKeyDictionary()

    def _skills_for(self, agent: Agent | None) -> dict[str, Skill]:
        """Return the skill set for an agent, falling back to base skills.

        An agent appears in the per-agent map once :meth:`init_agent` (or the
        before-invocation hook) has loaded its filesystem paths. Before that (or
        for agents that only use Skill instances and URLs), the base skills are
        returned.

        Args:
            agent: The agent whose skill set to retrieve, or ``None``.

        Returns:
            The agent's full skill set, or the base skills.
        """
        if agent is None:
            return self._skills
        return self._agent_skills.get(agent, self._skills)

    async def _load_skill_paths(self, agent: Agent) -> None:
        """Load deferred filesystem skill paths through the agent's sandbox.

        Mirrors :meth:`Skill.from_file` / :meth:`Skill.from_directory`: a path may
        be a SKILL.md file, a skill directory, or a parent directory of skill
        subdirectories. Per-path failures are logged and skipped so one bad skill
        does not abort its siblings. The resulting full skill set is stored in the
        per-agent map.

        Args:
            agent: The agent whose sandbox is used to read skill files.
        """
        skills = dict(self._skills)
        # Falls back to the default NotASandboxLocalEnvironment when the agent has no explicit sandbox.
        sandbox = agent.sandbox

        for skill_path in self._skill_paths:
            loaded = await self._load_skills_from_path(sandbox, str(skill_path))
            for skill_name, skill in loaded.items():
                if skill_name in skills:
                    logger.warning("name=<%s> | duplicate skill name, overwriting previous skill", skill_name)
                skills[skill_name] = skill

        self._agent_skills[agent] = skills
        self._dynamic_origins[agent] = {}
        await self._restore_dynamic_paths(agent)

    async def _load_skills_from_path(self, sandbox: Sandbox, skill_path_str: str) -> dict[str, Skill]:
        """Load skills from a single path through a sandbox.

        Mirrors :meth:`Skill.from_file` / :meth:`Skill.from_directory`: the path may
        be a SKILL.md file, a skill directory, or a parent directory of skill
        subdirectories. Per-skill failures are logged and skipped so one bad skill
        does not abort its siblings.

        Args:
            sandbox: The sandbox used to read skill files.
            skill_path_str: The path to load skills from.

        Returns:
            Mapping of skill name to loaded Skill (empty when nothing loads).
        """
        skills: dict[str, Skill] = {}

        async def load_skill(skill_dir: str, md_path: str) -> None:
            # A failure (e.g. malformed SKILL.md) is logged and skipped so it does not abort
            # sibling skills, matching Skill.from_directory's per-skill resilience.
            try:
                skill = Skill.from_content(await sandbox.read_text(md_path), strict=self._strict)
                # Set the sandbox path as-is (not host-resolved): the file may live in a container.
                # Then replicate Skill.from_file's directory-name check, which from_content does not
                # perform (Python's from_content takes no path parameter).
                skill.path = Path(skill_dir)
                if skill.path.name != skill.name:
                    msg = "name=<%s>, directory=<%s> | skill name does not match parent directory name"
                    if self._strict:
                        raise ValueError(msg % (skill.name, skill.path.name))
                    logger.warning(msg, skill.name, skill.path.name)
                if skill.name in skills:
                    logger.warning("name=<%s> | duplicate skill name, overwriting previous skill", skill.name)
                skills[skill.name] = skill
            except Exception as e:
                logger.warning("path=<%s> | failed to load skill: %s", skill_dir, e)

        try:
            entries = await sandbox.list_files(skill_path_str)
        except Exception:
            # Not a directory: accept a direct path to a SKILL.md file, as Skill.from_file does.
            if skill_path_str.lower().endswith("skill.md"):
                slash_index = skill_path_str.rfind("/")
                await load_skill("." if slash_index == -1 else skill_path_str[:slash_index], skill_path_str)
            else:
                logger.warning("path=<%s> | skill source does not exist or is not a valid path", skill_path_str)
            return skills

        md_name = _find_skill_md_name(entries)
        if md_name:
            await load_skill(skill_path_str, f"{skill_path_str}/{md_name}")
            return skills

        # Parent directory: load each subdirectory that contains a skill.
        for entry in sorted((e for e in entries if e.is_dir), key=lambda e: e.name):
            child_dir = f"{skill_path_str}/{entry.name}"
            try:
                child_entries = await sandbox.list_files(child_dir)
            except Exception as e:
                logger.warning("path=<%s> | failed to load skill from sandbox: %s", child_dir, e)
                continue
            child_md = _find_skill_md_name(child_entries)
            if child_md:
                await load_skill(child_dir, f"{child_dir}/{child_md}")

        return skills

    async def _restore_dynamic_paths(self, agent: Agent) -> None:
        """Re-load the dynamic skill paths recorded in agent state.

        Called after the agent's configured skills are loaded, so a session restored on a
        fresh agent regains the skills it loaded dynamically in earlier runs. Fail-soft: a
        recorded path that no longer exists (e.g. a new sandbox without the clone) just
        logs and contributes nothing until it is loaded again; it stays recorded so a later
        explicit ``load`` refreshes it.

        Args:
            agent: The agent whose dynamic paths to restore.
        """
        for dyn_path in self._dynamic_paths(agent):
            added, skipped, _ = await self._load_dynamic_path(agent, dyn_path, persist=False)
            if added or skipped:
                logger.debug(
                    "path=<%s>, added=<%d>, skipped=<%d> | restored dynamic skills from state",
                    dyn_path,
                    len(added),
                    len(skipped),
                )

    async def _reconcile_dynamic_paths(self, agent: Agent) -> None:
        """Load any dynamic path recorded in agent state that is not contributing skills yet.

        Complements :meth:`_restore_dynamic_paths` for the session-manager case: session
        managers replace ``agent.state`` wholesale after ``init_agent`` already ran, so
        paths recorded in a persisted session only become visible at hook time. Paths that
        already contributed at least one skill are left untouched (a live ``load`` refresh
        stays an explicit action). Fail-soft like restore: a recorded path that cannot be
        loaded (e.g. the clone does not exist in this sandbox yet) contributes nothing and
        is retried on the next hook, so it starts working the moment the path appears.

        Args:
            agent: The agent whose recorded paths to reconcile.
        """
        contributing = set(self._dynamic_origins.get(agent, {}).values())
        for dyn_path in self._dynamic_paths(agent):
            if dyn_path not in contributing:
                await self._load_dynamic_path(agent, dyn_path, persist=False)

    async def _load_dynamic_path(
        self, agent: Agent, path: str, *, persist: bool
    ) -> tuple[list[str], list[str], list[str]]:
        """Load (or re-load) skills from a dynamic path into an agent's skill set.

        Re-loading has refresh semantics: the skills this path contributed before are
        dropped first, then the current disk state is loaded (across an ``await``, so
        concurrent loads of the same path may interleave; last write wins), so edits are
        picked up and skills deleted on disk disappear. A dynamic skill may never shadow a skill
        configured on the plugin (skipped with a warning); a collision between two dynamic
        paths keeps the most recent load.

        Args:
            agent: The agent whose skill set to update.
            path: The normalized dynamic path to load.
            persist: When True, record the path in agent state while it contributes skills
                (and drop it when it no longer does). Restore passes False so a
                fail-soft re-load never prunes recorded paths.

        Returns:
            Tuple of (added names, skipped configured-collision names, names removed on refresh).
        """
        if agent not in self._agent_skills:
            self._agent_skills[agent] = dict(self._skills)
        skills = self._agent_skills[agent]
        origins = self._dynamic_origins.setdefault(agent, {})

        # Refresh semantics: drop what this path contributed before loading current disk state.
        previous = [skill_name for skill_name, origin in origins.items() if origin == path]
        for skill_name in previous:
            skills.pop(skill_name, None)
            origins.pop(skill_name, None)

        loaded = await self._load_skills_from_path(agent.sandbox, path)

        added: list[str] = []
        skipped: list[str] = []
        for skill_name, skill in loaded.items():
            if skill_name in skills and skill_name not in origins:
                skipped.append(skill_name)
                logger.warning(
                    "name=<%s>, path=<%s> | dynamic skill shadows a configured skill; skipped", skill_name, path
                )
                continue
            previous_origin = origins.get(skill_name)
            if previous_origin is not None and previous_origin != path:
                logger.warning(
                    "name=<%s>, previous=<%s>, path=<%s> | dynamic skill overrides one from another path "
                    "(most recent wins)",
                    skill_name,
                    previous_origin,
                    path,
                )
            skills[skill_name] = skill
            origins[skill_name] = path
            added.append(skill_name)

        removed = [skill_name for skill_name in previous if skill_name not in added]

        if persist:
            paths = self._dynamic_paths(agent)
            if added and path not in paths:
                self._set_state_field(agent, "dynamic_paths", [*paths, path])
            elif not added and path in paths:
                self._set_state_field(agent, "dynamic_paths", [p for p in paths if p != path])

        return added, skipped, removed

    def _dynamic_paths(self, agent: Agent) -> list[str]:
        """Return the dynamic skill paths recorded in agent state.

        Args:
            agent: The agent whose recorded paths to read.

        Returns:
            List of previously loaded dynamic paths (empty when none were recorded).
        """
        state_data = agent.state.get(self._state_key)
        paths = state_data.get("dynamic_paths", []) if isinstance(state_data, dict) else []
        if not isinstance(paths, list):
            # Fail-soft on corrupted state (it is externally persisted JSON).
            return []
        return [str(p) for p in paths]

    def _render_load_result(self, path: str, added: list[str], skipped: list[str], removed: list[str]) -> str:
        """Render the ``skills`` tool response for a ``load`` action.

        Args:
            path: The normalized path that was loaded.
            added: Names of skills added from the path.
            skipped: Names skipped because they collide with a configured skill.
            removed: Names previously contributed by the path that are now gone.

        Returns:
            Human-readable summary of the load.
        """
        parts: list[str] = []
        if added:
            parts.append(f"Loaded {len(added)} skill(s) from '{path}': {', '.join(sorted(added))}.")
        else:
            parts.append(
                f"No skills found at '{path}'. Expected a skill directory (containing SKILL.md), "
                "a parent directory of skill directories, or a path to a SKILL.md file."
            )
        if skipped:
            parts.append(f"Skipped (name collides with a configured skill): {', '.join(sorted(skipped))}.")
        if removed:
            parts.append(f"Removed on refresh: {', '.join(sorted(removed))}.")
        if added:
            parts.append('Activate one with the skills tool (action="activate").')
        return " ".join(parts)

    async def load_skills_for(self, agent: Agent, path: str | Path) -> list[str]:
        """Load skills from a sandbox path into an agent's skill set.

        Programmatic counterpart to the ``skills`` tool's ``load`` action, available
        regardless of the ``dynamic_loading`` flag (the flag only controls the tool surface
        exposed to the model). Loading the same path again refreshes it. The path is
        recorded in ``agent.state`` while it contributes skills, so it is restored on the
        next run over the same session.

        Args:
            agent: The agent to load the skills for.
            path: A skill directory (containing SKILL.md), a parent directory of skill
                directories, or a direct path to a SKILL.md file, resolved in the agent's
                sandbox.

        Returns:
            Names of the skills loaded from the path.
        """
        if agent not in self._agent_skills:
            await self._load_skill_paths(agent)
        added, _, _ = await self._load_dynamic_path(agent, _normalize_dynamic_path(path), persist=True)
        return added

    def unload_skills_for(self, agent: Agent, path: str | Path) -> list[str]:
        """Remove the skills previously loaded from a dynamic path.

        Programmatic counterpart to the ``skills`` tool's ``unload`` action, available
        regardless of the ``dynamic_loading`` flag. The path is also removed from the
        recorded state, so it is not restored on the next run. Unloading a path that
        contributed nothing is a no-op. Skills are removed outright: if one of them had
        overridden a same-named skill from another dynamic path, the earlier version is
        not resurrected automatically - re-load that path to restore it.

        Args:
            agent: The agent to unload the skills from.
            path: The path previously passed to ``load_skills_for`` or the tool's
                ``load`` action.

        Returns:
            Names of the skills that were removed.
        """
        normalized = _normalize_dynamic_path(path)
        skills = self._agent_skills.get(agent)
        origins = self._dynamic_origins.get(agent, {})

        removed = [skill_name for skill_name, origin in origins.items() if origin == normalized]
        for skill_name in removed:
            if skills is not None:
                skills.pop(skill_name, None)
            origins.pop(skill_name, None)

        paths = self._dynamic_paths(agent)
        if normalized in paths:
            self._set_state_field(agent, "dynamic_paths", [p for p in paths if p != normalized])

        if removed:
            logger.debug("path=<%s>, removed=<%d> | dynamic skills unloaded", normalized, len(removed))
        return removed

    def get_dynamic_skills(self, agent: Agent) -> dict[str, str]:
        """Return the dynamically loaded skills for an agent.

        Args:
            agent: The agent to query.

        Returns:
            Mapping of skill name to the sandbox path it was loaded from. Skills
            configured on the plugin are not included.
        """
        return dict(self._dynamic_origins.get(agent, {}))

    async def _format_skill_response(self, skill: Skill, sandbox: Sandbox) -> str:
        """Format the tool response when a skill is activated.

        Includes the full instructions along with relevant metadata fields
        and a listing of available resource files (scripts, references, assets)
        read through the sandbox for filesystem-based skills.

        Args:
            skill: The activated skill.
            sandbox: The agent's sandbox, used to list resource files.

        Returns:
            Formatted string with skill instructions and metadata.
        """
        if not skill.instructions:
            return f"Skill '{skill.name}' activated (no instructions available)."

        parts: list[str] = [skill.instructions]

        metadata_lines: list[str] = []
        if skill.allowed_tools:
            metadata_lines.append(f"Allowed tools: {', '.join(skill.allowed_tools)}")
        if skill.compatibility:
            metadata_lines.append(f"Compatibility: {skill.compatibility}")
        if skill.path is not None:
            metadata_lines.append(f"Location: {skill.path / 'SKILL.md'}")

        if metadata_lines:
            parts.append("\n---\n" + "\n".join(metadata_lines))

        if skill.path is not None:
            resources = await self._list_skill_resources(sandbox, str(skill.path))
            if resources:
                parts.append("\nAvailable resources:\n" + "\n".join(f"  {r}" for r in resources))

        return "\n".join(parts)

    async def _list_skill_resources(self, sandbox: Sandbox, skill_path: str) -> list[str]:
        """List resource files in a skill's optional directories through the sandbox.

        Scans the ``scripts/``, ``references/``, and ``assets/`` subdirectories
        for files, returning relative paths. Results are capped at
        ``max_resource_files`` to avoid context bloat.

        Args:
            sandbox: The agent's sandbox, used to list directory contents.
            skill_path: Path to the skill directory (a sandbox path).

        Returns:
            List of relative file paths (e.g. ``scripts/extract.py``).
        """
        files: list[str] = []

        # List a directory recursively through the sandbox, returning paths relative to its root.
        # Replaces Path.rglob, which has no sandbox equivalent.
        async def list_files_recursive(directory: str, depth: int = 0) -> list[str]:
            if depth >= _MAX_RESOURCE_DEPTH:
                return []
            result: list[str] = []
            for entry in await sandbox.list_files(directory):
                if entry.is_dir:
                    nested = await list_files_recursive(f"{directory}/{entry.name}", depth + 1)
                    result.extend(f"{entry.name}/{p}" for p in nested)
                else:
                    result.append(entry.name)
            return result

        for dir_name in _RESOURCE_DIRS:
            resource_dir = f"{skill_path}/{dir_name}"
            try:
                entries = await list_files_recursive(resource_dir)
            except Exception:
                # Missing directory (or unreadable): skip, as the optional dirs need not exist.
                continue

            for entry in sorted(entries):
                files.append(f"{dir_name}/{entry}")
                if len(files) >= self._max_resource_files:
                    files.append(f"... (truncated at {self._max_resource_files} files)")
                    return files

        return files

    def _generate_skills_xml(self, agent: Agent | None = None) -> str:
        """Generate the XML block listing available skills for the system prompt.

        When no skills are loaded, returns a block indicating no skills are available.
        Otherwise includes a ``<location>`` element for skills loaded from the filesystem,
        following the AgentSkills.io integration spec. With ``dynamic_loading`` enabled the
        block opens with a ``<usage>`` hint describing the load/unload mechanism; by default
        the output is byte-identical to previous releases.

        Args:
            agent: When provided, lists that agent's full skill set; otherwise lists
                only the base skills.

        Returns:
            XML-formatted string with skill metadata.
        """
        skills = self._skills_for(agent)
        if not skills:
            if self._dynamic_loading:
                return (
                    f"<available_skills>\n{_DYNAMIC_USAGE_HINT}\n"
                    "No skills are currently available.\n</available_skills>"
                )
            return "<available_skills>\nNo skills are currently available.\n</available_skills>"

        lines: list[str] = ["<available_skills>"]
        if self._dynamic_loading:
            lines.append(_DYNAMIC_USAGE_HINT)

        for skill in skills.values():
            lines.append("<skill>")
            lines.append(f"<name>{escape(skill.name)}</name>")
            lines.append(f"<description>{escape(skill.description)}</description>")
            if skill.path is not None:
                lines.append(f"<location>{escape(str(skill.path / 'SKILL.md'))}</location>")
            lines.append("</skill>")

        lines.append("</available_skills>")
        return "\n".join(lines)

    def _resolve_skills(self, sources: list[SkillSource]) -> tuple[dict[str, Skill], list[SkillSource]]:
        """Resolve sandbox-independent sources and collect deferred filesystem paths.

        Skill instances and ``https://`` URLs resolve immediately (both are
        synchronous and filesystem-independent). Filesystem paths (``str`` or
        ``Path``) are collected and returned unresolved, to be loaded per-agent
        through the sandbox in :meth:`_load_skill_paths`.

        Args:
            sources: List of skill sources to resolve.

        Returns:
            A tuple of (base skills mapping name to Skill, deferred filesystem paths).
        """
        resolved: dict[str, Skill] = {}
        skill_paths: list[SkillSource] = []

        for source in sources:
            if isinstance(source, Skill):
                if source.name in resolved:
                    logger.warning("name=<%s> | duplicate skill name, overwriting previous skill", source.name)
                resolved[source.name] = source
            elif isinstance(source, str) and source.startswith("https://"):
                try:
                    skill = Skill.from_url(source, strict=self._strict)
                    if skill.name in resolved:
                        logger.warning("name=<%s> | duplicate skill name, overwriting previous skill", skill.name)
                    resolved[skill.name] = skill
                except (RuntimeError, ValueError) as e:
                    logger.warning("url=<%s> | failed to load skill from URL: %s", source, e)
            else:
                # Filesystem path: defer to init_agent, where the agent's sandbox is available.
                skill_paths.append(source)

        logger.debug(
            "source_count=<%d>, resolved_count=<%d>, deferred_path_count=<%d> | skills resolved",
            len(sources),
            len(resolved),
            len(skill_paths),
        )
        return resolved, skill_paths

    def _set_state_field(self, agent: Agent, key: str, value: Any) -> None:
        """Set a single field in the plugin's agent state dict.

        Args:
            agent: The agent whose state to update.
            key: The state field key.
            value: The value to set.

        Raises:
            TypeError: If the existing state value is not a dict.
        """
        state_data = agent.state.get(self._state_key)
        if state_data is not None and not isinstance(state_data, dict):
            raise TypeError(f"expected dict for state key '{self._state_key}', got {type(state_data).__name__}")
        if state_data is None:
            state_data = {}
        state_data[key] = value
        agent.state.set(self._state_key, state_data)

    def _track_activated_skill(self, agent: Agent, skill_name: str) -> None:
        """Record a skill activation in agent state.

        Maintains an ordered list of activated skill names (most recent last),
        without duplicates.

        Args:
            agent: The agent whose state to update.
            skill_name: Name of the activated skill.
        """
        state_data = agent.state.get(self._state_key)
        activated: list[str] = state_data.get("activated_skills", []) if isinstance(state_data, dict) else []
        if skill_name in activated:
            activated.remove(skill_name)
        activated.append(skill_name)
        self._set_state_field(agent, "activated_skills", activated)

    def get_activated_skills(self, agent: Agent) -> list[str]:
        """Get the list of skills activated by this agent.

        Returns skill names in activation order (most recent last).

        Args:
            agent: The agent to query.

        Returns:
            List of activated skill names.
        """
        state_data = agent.state.get(self._state_key)
        if isinstance(state_data, dict):
            return list(state_data.get("activated_skills", []))
        return []
