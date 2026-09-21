"""The harness factory: a preconfigured ``strands.Agent`` in one call."""

from __future__ import annotations

import logging
import os
import tempfile
import uuid
from collections.abc import Mapping, Sequence
from typing import Any, Literal

from strands import Agent, BackgroundTasksConfig
from strands.experimental.context_manager import ContextManager
from strands.memory import MemoryManager
from strands.models import Model, ModelRouter
from strands.plugins import Plugin
from strands.session import SessionManager, SnapshotSessionManager
from strands.storage import LocalFileStorage
from strands.tools.mcp import MCPClient, MCPServerConfig
from strands.types.tools import AgentTool
from strands.vended_plugins.context_offloader import ContextOffloader, FileStorage
from strands.vended_plugins.skills import AgentSkills, SkillSources
from strands.vended_tools import make_shell

from strands_harness import defaults
from strands_harness.interventions import InterventionsOption, resolve_interventions
from strands_harness.memory import resolve_memory
from strands_harness.models import (
    _supports_media,
    resolve_model,
    resolve_web_fetch_model,
    supports_web_search,
)
from strands_harness.options import (
    _builtin_tool_config,
    _memory_config,
    _normalize_builtin_tools,
    _sanitize_session_id,
    _session_config,
)
from strands_harness.plugins import EnvironmentContext, Todos
from strands_harness.prompt import build_system_prompt
from strands_harness.telemetry import setup_telemetry
from strands_harness.tools import (
    edit,
    exa_web_search,
    make_programmatic_tool_caller,
    make_read,
    make_web_fetch,
    write,
)
from strands_harness.tools.subagent import build_default_subagent
from strands_harness.types.agent import (
    BuiltinPluginName,
    BuiltinToolName,
    BuiltinToolsConfig,
    ContextManagerOption,
    Effort,
    MemoryConfig,
    SessionConfig,
)

logger = logging.getLogger(__name__)

# Built-in plugins, each toggled by name via ``builtin_plugins``. Unlike the offloader and skills
# plugins (wired from their own options), these are opt-out feature plugins that only bundle a tool
# and a loop-level behavior; the map is the seam to grow the set (e.g. memories) later.
_BUILTIN_PLUGINS = {"todos": Todos, "environment": EnvironmentContext}

# The delegation tool always runs in the background: its calls are long-running subtasks whose
# intermediate work should stay out of the parent's turn.
_ALWAYS_BACKGROUND_TOOL_NAMES = frozenset({"subagent"})

_AUTO_MAX_RESULT_TOKENS = 1_500
_AUTO_PREVIEW_TOKENS = 750

# Sentinel for ``caching``: distinguishes "not passed" (the default, which warns on an unsupported
# provider) from an explicit value like ``caching=None`` (off) or ``caching=True`` (which raises on
# an unsupported provider string, and only warns when the model is a ``Model`` instance).
_UNSET: Any = object()


def _builtin_tools(parent_config: dict[str, Any]) -> dict[str, Any]:
    """The built-in tools by name. Each configurable one is built from its factory with the config it
    was enabled with (``{}`` for ``True``, see ``_BUILTIN_TOOL_CONFIG_KEYS``); ``web_fetch`` also
    derives its summarizer from the agent's model, ``subagent`` takes the whole parent config so it
    can rebuild a child the way this agent was built. ``subagent``'s own delegation-depth budget
    lives on ``agent.state``, tracked by the tool itself. ``web_search`` here is the Exa fallback;
    ``create_harness`` selects it only for a model without native search."""
    enabled = parent_config["builtin_tools"]
    web_fetch_config = _builtin_tool_config(enabled, "web_fetch")
    web_fetch_model = resolve_web_fetch_model(parent_config["model"], web_fetch_config.pop("model", None))
    tools = (
        make_shell(**_builtin_tool_config(enabled, "shell")),
        make_read(**{"media": _supports_media(parent_config["model"]), **_builtin_tool_config(enabled, "read")}),
        write,
        edit,
        make_web_fetch(model=web_fetch_model, **web_fetch_config),
        exa_web_search,
        make_programmatic_tool_caller(**_builtin_tool_config(enabled, "programmatic_tool_caller")),
        build_default_subagent(create_harness, parent_config, **_builtin_tool_config(enabled, "subagent")),
    )
    return {t.tool_name: t for t in tools}


def _select_builtin_tools(enabled: Mapping[str, Any], tools: dict[str, Any]) -> list[Any]:
    # A config mapping enables the tool even when empty (``{"web_fetch": {}}`` is "on with
    # defaults"), so only ``False`` means off.
    return [tools[name] for name, setting in enabled.items() if setting is not False]


def _web_search_mode(
    setting: Any, explicit: bool, model: Model | ModelRouter | str | None
) -> Literal["native", "exa"] | None:
    """How ``web_search`` is served for ``model``: ``"native"`` (a model flag), ``"exa"`` (the
    third-party tool, opted into with ``"exa"``), or ``None`` (off)."""
    if setting is False:
        return None
    if supports_web_search(model):
        return "native"
    if setting == "exa":
        logger.warning(
            "web_search is opted into Exa (exa.ai), a third-party service: every search query leaves your "
            "environment and is subject to Exa's privacy policy (https://exa.ai/privacy-policy)."
        )
        return "exa"
    target = (
        "A pre-built Model instance"
        if isinstance(model, (Model, ModelRouter))
        else f"Model {model or defaults.DEFAULT_MODEL}"
    )
    message = (
        f"{target} has no native web search. Pass builtin_tools={{'web_search': 'exa'}} to search "
        "through Exa (a third party), or drop 'web_search'."
    )
    if explicit:
        raise ValueError(message)
    logger.warning(message)
    return None


def _durable_offloader(offload_dir: str) -> Any:
    return ContextOffloader(
        storage=FileStorage(offload_dir),
        max_result_tokens=_AUTO_MAX_RESULT_TOKENS,
        preview_tokens=_AUTO_PREVIEW_TOKENS,
    )


def _has_offloader(plugins: list[Any]) -> bool:
    return any(isinstance(p, ContextOffloader) for p in plugins)


def _skills_plugin(skills: bool | SkillSources | AgentSkills | None) -> AgentSkills | None:
    """The skills plugin for ``skills``: the default dir when present (``True``), the sources named
    (passed through untouched; the SDK reports a missing path), or the instance verbatim."""
    if skills is None or skills is False:
        return None
    if isinstance(skills, AgentSkills):
        return skills
    if skills is True:
        return AgentSkills(skills=[defaults.DEFAULT_SKILLS_DIR]) if os.path.isdir(defaults.DEFAULT_SKILLS_DIR) else None
    if isinstance(skills, list) and not skills:
        return None
    return AgentSkills(skills=skills)


def _has_skills(plugins: list[Any]) -> bool:
    return any(isinstance(p, AgentSkills) for p in plugins)


def _select_builtin_plugins(names: Sequence[str] | None, existing: list[Any]) -> list[Any]:
    if names is None:
        names = defaults.DEFAULT_BUILTIN_PLUGINS
    selected = []
    for name in names:
        if name not in _BUILTIN_PLUGINS:
            available = ", ".join(sorted(_BUILTIN_PLUGINS))
            raise ValueError(f"Unknown built-in plugin {name!r}. Available: {available}.")
        plugin_cls = _BUILTIN_PLUGINS[name]
        if not any(isinstance(p, plugin_cls) for p in existing):
            selected.append(plugin_cls())
    return selected


def _check_name_collisions(*sources: tuple[str, bool, list[Any]]) -> None:
    """Raise if two tools would register under the same name, so a collision fails at construction
    with the losing source named rather than one tool silently disappearing. Names differing only by
    ``-``/``_`` collide, matching the SDK tool registry. Each source is ``(label, is_builtin, tools)``;
    the remedy only mentions dropping a built-in when a built-in is actually one of the two sources."""
    seen: dict[str, tuple[str, bool]] = {}
    for label, is_builtin, tools in sources:
        for tool in tools:
            # Only resolved tool objects have a fixed name here; the SDK also accepts strings, dicts,
            # modules, and nested lists in ``tools`` and resolves them later, so skip those.
            if not isinstance(tool, AgentTool):
                continue
            key = tool.tool_name.replace("-", "_")
            if key in seen:
                prior_label, prior_builtin = seen[key]
                where = label if prior_label == label else f"{prior_label} and {label}"
                if is_builtin or prior_builtin:
                    remedy = "Rename the tool you passed, or drop the built-in via builtin_tools / builtin_plugins."
                else:
                    remedy = "Rename one so each tool has a unique name."
                raise ValueError(f"Tool name {tool.tool_name!r} is registered more than once (from {where}). {remedy}")
            seen[key] = (label, is_builtin)


def _drop_sandbox_tools(agent: Agent) -> None:
    """Drop the tools the sandbox vends (e.g. ``sandbox_bash``); the harness's built-ins already route through it."""
    for tool in agent.sandbox.get_tools():
        agent.tool_registry.registry.pop(tool.tool_name, None)


def _plugin_tools(plugins: list[Any]) -> list[Any]:
    """The tools each plugin vends (e.g. the todos plugin's ``todo_write``), via the SDK's ``.tools``."""
    return [tool for plugin in plugins for tool in (getattr(plugin, "tools", None) or [])]


def _resolve_background_tasks(
    configured: bool | BackgroundTasksConfig | None,
    forced: Sequence[AgentTool],
) -> Literal[False] | BackgroundTasksConfig:
    if configured is False:
        return False

    policy: BackgroundTasksConfig = {"agentic": ["*"]} if configured is None or configured is True else configured
    forced_names = {tool.tool_name for tool in forced}

    def omit_forced(selectors: Sequence[AgentTool | str]) -> list[AgentTool | str]:
        return [
            selector
            for selector in selectors
            if selector == "*" or (selector if isinstance(selector, str) else selector.tool_name) not in forced_names
        ]

    always = [*omit_forced(policy.get("always", [])), *forced]
    resolved: BackgroundTasksConfig = {**policy}
    if "agentic" in policy:
        resolved["agentic"] = omit_forced(policy["agentic"])
    if always or "always" in policy:
        resolved["always"] = always
    if "never" in policy:
        resolved["never"] = omit_forced(policy["never"])
    return resolved


def create_harness(
    *,
    model: Model | ModelRouter | str | None = None,
    effort: Effort = defaults.DEFAULT_EFFORT,
    instructions: str | None = None,
    tools: list[Any] | None = None,
    plugins: list[Plugin] | None = None,
    mcp_servers: str | dict[str, MCPServerConfig] | None = None,
    builtin_tools: Sequence[BuiltinToolName] | BuiltinToolsConfig | None = None,
    background_tasks: bool | BackgroundTasksConfig | None = None,
    caching: str | bool | None = _UNSET,
    context_manager: ContextManagerOption = defaults.DEFAULT_CONTEXT_MANAGER,
    session: bool | SessionConfig | SessionManager | None = True,
    skills: bool | SkillSources | AgentSkills | None = True,
    memory: bool | MemoryConfig | MemoryManager | None = True,
    builtin_plugins: list[BuiltinPluginName] | None = None,
    interventions: InterventionsOption = None,
    **agent_kwargs: Any,
) -> Agent:
    """Build a preconfigured Strands agent with the harness's defaults enabled.

    Every default is overridable, and the return value is a plain ``strands.Agent`` that can
    be modified further after construction. Any keyword accepted by ``Agent`` may be passed
    through ``agent_kwargs``; an explicit SDK value there (``session_manager``, ``memory_manager``,
    ``system_prompt``, ...) always beats the harness sugar it corresponds to.

    Args:
        model: A ``Model`` or ``ModelRouter`` instance, a ``"provider/name"`` string (e.g.
            ``"anthropic/claude-fable-5"``), a bare Bedrock model id, or ``None`` for the
            harness default (Bedrock Opus 4.8).
        effort: Reasoning effort applied to the resolved model, mapped to each provider's request
            fields. ``"auto"`` (the default) uses the provider's recommended level, ``"off"`` turns
            reasoning off, and ``"minimal"``/``"low"``/``"medium"``/``"high"``/``"xhigh"``/``"max"``
            set it explicitly; a level the provider does not offer raises. When ``model`` is a
            ``Model`` or ``ModelRouter`` instance a non-``"auto"`` effort is ignored with a warning
            (configure reasoning on the instance).
        instructions: A domain block appended after the harness contract. Ignored when a full
            ``system_prompt`` is passed via ``agent_kwargs``.
        tools: Consumer tools, added alongside the built-in tools. To expose a specialist ``Agent``
            as a tool, wrap it with ``Agent.as_tool()`` and pass it here. A tool name must be unique
            across all sources (built-in tools, ``tools``, plugins); a collision raises at
            construction. To replace a built-in, drop it first via ``builtin_tools`` so the name is
            free. A connected ``MCPClient`` passed here is offered to delegates on the ``subagent``
            tool's ``mcp_servers`` axis under its ``client_name`` (set ``application_name``), like the
            servers loaded from ``mcp_servers``; an unnamed or same-named client is warned about and
            left off that axis.
        plugins: Consumer SDK plugins, added alongside the built-in plugins (consumer plugins run
            first). Tools a plugin vends take part in the name-collision check, and the plugins reach
            ``subagent`` children too. A ``ContextOffloader`` or ``AgentSkills`` passed here replaces
            the one the harness would add. Plugin *instances* are shared with children, so one that keeps
            per-agent state must keep it in ``agent.state`` (the SDK convention), not on ``self``.
        mcp_servers: MCP servers to connect, given as the standard ``mcpServers`` config: either a
            path to a JSON file or the mapping itself (a flat ``{name: {...}}`` map, or that map under
            an ``mcpServers`` key). Each server's tools are discovered and added to the tool list, and
            the SDK manages connection and lifecycle. A server that fails to start yields no tools
            rather than failing construction; set ``"continue_on_error": false`` on a server to make
            its failure fatal. Each server's tools are prefixed with its name by default
            (``<server>_<tool>``) so servers don't clash; set a server's ``"prefix"`` to override, or
            ``"prefix": ""`` to opt out.
        builtin_tools: Which built-in tools to enable, as a list or a mapping. A **list pins** exactly
            the names given (``[]`` disables them all). A **mapping edits** the harness's default set:
            ``False`` removes a tool, ``True`` adds one, and a config dict adds *and* configures it;
            the ``"*"`` key (default ``True``) is the starting set, written ``False`` to start from
            nothing: ``{"subagent": False}`` is the defaults minus one, ``{"*": False, "read": True}``
            a pin. The default set is ``["shell", "read", "write", "edit", "web_fetch", "web_search",
            "programmatic_tool_caller", "subagent"]``.
            ``web_fetch`` fetches a URL and answers a prompt about it via a small summarizer model,
            keeping the raw page out of the main context; ``{"web_fetch": {"model": ...}}`` picks that
            model (a ``Model``/``ModelRouter`` instance or ``"provider/name"`` string; the default is the
            small fast model of the main agent's provider so credentials align), and ``{"web_fetch":
            {"transport": "direct"}}`` fetches from the harness process instead of running ``curl`` in the
            agent's sandbox (the default, ``"curl"``).
            ``web_search`` turns on the model provider's native web search (OpenAI, Anthropic, Google,
            GPT-5/GPT-6 models on bedrock-mantle). Elsewhere (Bedrock Converse, other Mantle models,
            ``Model`` instances) it is off unless ``{"web_search": "exa"}`` opts into a ``web_search``
            tool backed by Exa's hosted search, a third party that receives the queries (keyless;
            ``EXA_API_KEY`` lifts its rate limit); naming ``web_search`` without the fallback on such a
            model raises.
            ``programmatic_tool_caller`` lets the model orchestrate its other tools by writing Python
            that runs in a Monty sandbox (no filesystem, network, or process access; only the other
            tools are reachable), returning only what the code prints.
            ``subagent`` delegates a self-contained subtask to a child agent built through this same
            factory, so the child is a full harness member: it inherits the model, built-in tools,
            built-in plugins, skills, interventions, and the consumer ``plugins`` and ``hooks`` passed
            here (the gate and any policy plugins/hooks reach the delegate too), plus the consumer
            ``tools`` (narrowable — the delegate may be granted a subset). By default the model picks
            the ``generalist`` role, may write an ad-hoc role prompt, and may narrow the tool set
            (never widen it). Delegation depth is bounded, so a child eventually cannot delegate
            further. For a fully configured delegation tool (custom roles, model tiers, fixed
            prompts), build one with ``make_subagent`` and pass it via ``tools`` with ``subagent``
            dropped from ``builtin_tools``.
        background_tasks: SDK Background Tasks policy. The ``subagent`` tool always runs in the
            background; by default, the model may choose background execution for any other
            compatible tool. The invocation waits for completion and continues with the result.
            Pass ``False`` to disable Background Tasks, or provide a policy to control other tools,
            concurrency, completion, and timeouts.
        caching: Enables prompt caching to save cost and latency where the provider supports it
            (Bedrock and Anthropic direct set cache points and cached tools; OpenAI, Gemini, and
            bedrock-mantle cache automatically server-side). Defaults to on. ``False``/``None`` turns
            off what the harness configures, and has no effect where caching is automatic. Explicitly
            enabling caching on a provider without it raises; on a pre-built ``Model`` instance it is
            ignored with a warning (configure it on the instance).
        context_manager: The SDK's ``Agent(context_manager=)`` option: ``"auto"`` (the default) or
            ``"agentic"`` for an SDK preset, a ``ContextManagerConfig`` dict or a ``ContextManager``
            instance for a custom pipeline, or ``False``/``None`` to disable it. When enabled, large
            tool results are also offloaded to disk (a preview and reference are kept in context) so
            the agent can run longer before compacting; disabling turns this off too.
        session: File-backed conversation persistence, on by default. ``True`` (or ``{}``) snapshots
            the run under a fresh random id in ``./.agent/sessions`` via a ``SnapshotSessionManager``;
            ``{"id": ..., "dir": ...}`` picks the id and/or root directory; a ``SessionManager``
            instance is used verbatim; ``False``/``None`` disables it (the conversation is in-memory
            and offloaded artifacts go to a temporary directory that does not outlive the process).
            This does not auto-resume across runs: with no ``id`` a new run starts a new session. To
            continue a previous conversation, read the minted id off the returned agent
            (``agent.session_id``) and pass it back as ``session={"id": ...}`` on the next run. An
            explicit ``session_manager`` in ``agent_kwargs`` takes precedence.
        skills: Agent Skills loaded via the SDK's ``AgentSkills`` plugin for progressive disclosure.
            ``True`` (the default) loads ``./.agent/skills`` when that directory exists and is
            otherwise a no-op; the SDK's ``SkillSources`` (a skill dir, a parent dir of skills, a
            ``SKILL.md``, an ``https://`` URL, or a parsed ``Skill``, single or in a list) is passed
            through untouched, so the SDK warns about a missing path; an ``AgentSkills`` instance is
            used verbatim; ``False``/``None`` disables skills. Filesystem sources are read through the
            agent's sandbox when there is one. An ``AgentSkills`` in ``plugins`` wins.
        memory: File-backed long-term memory, on by default. When enabled, the agent distills durable
            facts into markdown files, searches them before each turn, and folds the top matches into
            context; persistence is independent of any session, so memory survives across sessions.
            ``True`` (or ``{}``) uses a file store under ``./.agent/memory``; ``{"dir": ...}`` moves it;
            ``{"stores": [...]}`` swaps in your own store(s) under the harness's memory policy (injection on,
            ``search_memory`` on, no ``add_memory`` tool), which a ``subagent`` delegate shares
            read-only; a ``MemoryManager`` instance is used verbatim and not forwarded to delegates;
            ``False``/``None`` disables it. An explicit ``memory_manager`` in ``agent_kwargs`` takes
            precedence. Extraction runs asynchronously every few turns on a small model, so a short run
            may end before the first extraction fires; run
            ``if agent.memory_manager: await agent.memory_manager.flush()`` at your shutdown boundary to
            persist what's pending.
        builtin_plugins: Names of the built-in feature plugins to enable. Defaults to
            ``["todos", "environment"]``: ``todos`` adds a ``todo_write`` tool that tracks
            multi-step work and re-surfaces the list before each step; ``environment`` injects the
            platform, date, working directory, and the project's ``AGENTS.md`` (plus links to nearby
            ``AGENTS.md``/``README.md`` files) before each user turn. Pass ``[]`` to disable them.
        interventions: Gate tool calls behind approval or a policy; defaults to ``None`` (off —
            every call runs). Accepts a preset (``"ask"`` approves every call, ``"smart"`` lets the
            SDK's LLM risk classifier flag risky ones), a natural-language policy used as that
            classifier's prompt, a ``.cedar`` policy file (needs ``strands-agents[cedar]``), a
            ``HumanInTheLoop``/``CedarAuthorization`` instance for full control, or a list layering a
            Cedar policy with one human gate. Sugar over the SDK's handlers; a ``subagent`` child
            inherits the policy so a delegate cannot bypass it.
    """
    setup_telemetry()

    enabled_tools = _normalize_builtin_tools(builtin_tools)
    session_option = _session_config(session)
    memory_option = _memory_config(memory)
    # Explicit when the caller named web_search themselves (a list containing it, or a mapping key).
    web_search_explicit = (
        "web_search" in builtin_tools if isinstance(builtin_tools, Mapping) else builtin_tools is not None
    )
    web_search = _web_search_mode(enabled_tools["web_search"], web_search_explicit, model)
    if web_search is None:
        # Off, or default-on but unavailable here: forward it off so a child with the same model stays quiet.
        enabled_tools["web_search"] = False
    elif not web_search_explicit:
        # Forward the default as a default, so a child on a model without native search warns, not raises.
        del enabled_tools["web_search"]

    caching_explicit = caching is not _UNSET
    caching_on = bool(defaults.DEFAULT_CACHING) if not caching_explicit else bool(caching)
    resolved_model = resolve_model(
        model,
        defaults.DEFAULT_MODEL,
        effort,
        web_search=web_search == "native",
        caching=caching_on,
        caching_explicit=caching_explicit,
    )

    if "system_prompt" not in agent_kwargs:
        agent_kwargs["system_prompt"] = build_system_prompt(instructions)

    consumer_plugins = list(plugins or [])
    # Hooks and the sandbox stay in agent_kwargs (the harness adds none) but are forwarded so subagent children
    # run under them too.
    consumer_hooks = list(agent_kwargs.get("hooks") or [])
    consumer = list(tools or [])
    # MCP clients are tool providers the SDK connects at load time; loaded ones join `tools` as consumer tools.
    if mcp_servers:
        consumer += MCPClient.load_servers(mcp_servers, continue_on_error=True, prefix_with_server_name=True)

    # An explicit ``memory_manager`` (or a ``MemoryManager`` passed as ``memory``) wins over the harness's memory
    # wiring and is not forwarded: a delegate shares harness-built stores read-only or gets none.
    memory_manager = agent_kwargs.pop("memory_manager", None)
    if memory_manager is None and isinstance(memory_option, MemoryManager):
        memory_manager = memory_option
    # ``{}`` is on (the harness's defaults) even though it is falsy; ``_memory_config`` maps off to ``None``.
    child_memory: Literal[False] | MemoryConfig = (
        False if memory_option is None or memory_manager is not None else memory_option
    )

    # What build_default_subagent rebuilds a child from: this call's keyword arguments, with ``builtin_tools``
    # normalized and ``session`` forced off so a throwaway delegate never persists session state.
    parent_config: dict[str, Any] = {
        "model": model,
        "effort": effort,
        "caching": caching,
        "context_manager": context_manager,
        "builtin_tools": enabled_tools,
        "background_tasks": background_tasks,
        "builtin_plugins": builtin_plugins,
        "skills": skills,
        "memory": child_memory,
        "session": False,
        "interventions": interventions,
        "plugins": consumer_plugins,
        "hooks": consumer_hooks,
        "tools": consumer,
        "sandbox": agent_kwargs.get("sandbox"),
    }

    builtin = _select_builtin_tools({**enabled_tools, "web_search": web_search == "exa"}, _builtin_tools(parent_config))
    context_enabled = context_manager is not None and context_manager is not False
    # The SDK's Agent rejects a bare config dict; build the instance from it here.
    if isinstance(context_manager, Mapping):
        agent_kwargs["context_manager"] = ContextManager(**context_manager)
    else:
        agent_kwargs["context_manager"] = context_manager if context_enabled else False

    session_manager = agent_kwargs.pop("session_manager", None)
    session_dir: str | None = None
    if session_manager is None:
        if isinstance(session_option, SessionManager):
            session_manager = session_option
        elif session_option is not None:
            session_id = session_option.get("id")
            session_dir = session_option.get("dir") or defaults.DEFAULT_SESSION_DIR
            resolved_id = _sanitize_session_id(session_id) if session_id else uuid.uuid4().hex[:8]
            session_manager = SnapshotSessionManager(
                resolved_id,
                storage=LocalFileStorage(session_dir),
                save_latest_on="message",
            )

    # Assemble plugins before the collision check so plugin-vended tools are checked too; consumer
    # plugins stay first so the tail is the harness's own.
    all_plugins: list[Any] = list(consumer_plugins)

    if context_enabled and not _has_offloader(all_plugins):
        offload_dir = (
            os.path.join(session_dir, "offloaded")
            if session_dir is not None
            else tempfile.mkdtemp(prefix="strands-offload-")
        )
        all_plugins.append(_durable_offloader(offload_dir))

    if not _has_skills(all_plugins):
        skills_plugin = _skills_plugin(skills)
        if skills_plugin is not None:
            all_plugins.append(skills_plugin)

    all_plugins.extend(_select_builtin_plugins(builtin_plugins, all_plugins))
    harness_plugins = all_plugins[len(consumer_plugins) :]

    # Memory is built from ``memory`` when on and nothing explicit was given. A ``MemoryManager``
    # instance already carries its resolved tools (``search_memory`` by default); a bare config does
    # not, so only an instance can be pre-flighted for name collisions here.
    if memory_manager is None and child_memory is not False:
        memory_manager = resolve_memory(
            stores=child_memory.get("stores"),
            model=model,
            memory_dir=child_memory.get("dir") or defaults.DEFAULT_MEMORY_DIR,
            web_fetch_model=_builtin_tool_config(enabled_tools, "web_fetch").get("model"),
        )
    memory_tools = memory_manager.tools if isinstance(memory_manager, MemoryManager) else []

    _check_name_collisions(
        ("a built-in tool", True, builtin),
        ("tools", False, consumer),
        ("a built-in plugin", True, _plugin_tools(harness_plugins)),
        ("plugins", False, _plugin_tools(consumer_plugins)),
        ("memory", True, memory_tools),
    )
    # MCP tool names are only known once a client connects, so the pre-flight above skips them. They are
    # namespaced by server (prefix_with_server_name) so cross-server names don't clash, but a server keyed
    # to a built-in name (e.g. ``web`` exposing ``fetch`` -> ``web_fetch``) still can.
    agent_tools = [*builtin, *consumer]
    resolved_background_tasks = _resolve_background_tasks(
        background_tasks,
        [
            candidate
            for candidate in agent_tools
            if isinstance(candidate, AgentTool) and candidate.tool_name in _ALWAYS_BACKGROUND_TOOL_NAMES
        ],
    )

    agent = Agent(
        model=resolved_model,
        tools=agent_tools,
        plugins=all_plugins,
        background_tasks=resolved_background_tasks,
        session_manager=session_manager,
        memory_manager=memory_manager,
        interventions=resolve_interventions(interventions),
        **agent_kwargs,
    )
    _drop_sandbox_tools(agent)
    return agent
