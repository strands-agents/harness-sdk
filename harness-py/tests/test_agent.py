import logging
import re
import tempfile
import textwrap
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from strands import Agent, BackgroundTasksConfig, tool
from strands.agent.conversation_manager import NullConversationManager
from strands.experimental.context_manager import ContextManager
from strands.hooks import BeforeModelCallEvent
from strands.memory import MemoryManager
from strands.models import BedrockModel, CacheConfig, ModelRouter
from strands.sandbox.docker import DockerSandbox
from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage
from strands.vended_memory_stores.file_memory_store import FileMemoryStore
from strands.vended_plugins.context_offloader import ContextOffloader, FileStorage
from strands.vended_plugins.skills import AgentSkills
from strands.vended_tools.file_editor import make_file_editor
from strands.vended_tools.shell import make_shell

from strands_harness import BUILTIN_TOOL_NAMES, HARNESS_CONTRACT, create_harness
from strands_harness import agent as agent_module
from strands_harness.defaults import DEFAULT_BUILTIN_TOOLS, DEFAULT_SUBAGENT_MAX_DEPTH
from strands_harness.models import resolve_web_fetch_model
from strands_harness.options import _memory_config, _normalize_builtin_tools
from strands_harness.tools.subagent import build_default_subagent


def _context_managed(agent: Agent) -> bool:
    """Whether the SDK installed context management: a ``ContextManager`` plugin (strands-agents
    >= 1.56) or a real conversation manager (earlier releases). How it is wired is the SDK's business."""
    plugins = agent._plugin_registry._plugins.values()
    return any(isinstance(p, ContextManager) for p in plugins) or not isinstance(
        agent.conversation_manager, NullConversationManager
    )


def _offloaders(agent: Agent) -> list[ContextOffloader]:
    return [p for p in agent._plugin_registry._plugins.values() if isinstance(p, ContextOffloader)]


def _offload_dir(offloader: ContextOffloader) -> str:
    return str(offloader._storage._artifact_dir)


def _skills(agent: Agent) -> list[AgentSkills]:
    return [p for p in agent._plugin_registry._plugins.values() if isinstance(p, AgentSkills)]


def _write_skill(skills_dir: Path, name: str) -> None:
    skill = skills_dir / name
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        textwrap.dedent(
            f"""\
            ---
            name: {name}
            description: A {name} skill.
            ---
            Do the {name} thing.
            """
        )
    )


@tool
def sample_tool(x: str) -> str:
    """A sample tool."""
    return x


def test_defaults():
    agent = create_harness()
    assert isinstance(agent, Agent)
    assert {"shell", "read", "write", "edit", "web_fetch"} <= set(agent.tool_names)
    assert agent.system_prompt == HARNESS_CONTRACT
    assert _context_managed(agent)
    assert agent._background_tasks is not None
    assert agent._background_tasks._policy == {"*": "agentic", "subagent": "always"}


def test_background_tasks_true_matches_the_default():
    agent = create_harness(background_tasks=True)
    assert agent._background_tasks is not None
    assert agent._background_tasks._policy == {"*": "agentic", "subagent": "always"}


def test_subagent_stays_backgrounded_under_a_custom_policy():
    policy: BackgroundTasksConfig = {
        "agentic": ["subagent"],
        "always": [sample_tool, "subagent"],
        "never": ["*", "subagent"],
        "wait_for_completion": False,
        "max_concurrency": 2,
        "timeout": 5.0,
    }
    agent = create_harness(tools=[sample_tool], background_tasks=policy)
    assert agent._background_tasks is not None
    assert agent._background_tasks._policy == {"sample_tool": "always", "subagent": "always", "*": "never"}
    assert agent._background_tasks._config.get("wait_for_completion") is False
    assert agent._background_tasks._config.get("max_concurrency") == 2
    assert agent._background_tasks._config.get("timeout") == 5.0
    assert policy.get("agentic") == ["subagent"]
    assert policy.get("always") == [sample_tool, "subagent"]
    assert policy.get("never") == ["*", "subagent"]


def test_background_tasks_can_be_disabled():
    agent = create_harness(background_tasks=False)
    assert agent._background_tasks is None


def test_model_router_is_attached_through_the_model_parameter():
    default = BedrockModel(model_id="fast")
    router = ModelRouter([default, BedrockModel(model_id="deep")])

    agent = create_harness(model=router)

    assert agent._model_router is router
    assert agent.model is default


def test_instructions_appended():
    agent = create_harness(instructions="You are a migration assistant.")
    assert agent.system_prompt.startswith(HARNESS_CONTRACT)
    assert agent.system_prompt.endswith("You are a migration assistant.")


def test_explicit_system_prompt_wins_over_instructions():
    agent = create_harness(instructions="ignored", system_prompt="my own prompt")
    assert agent.system_prompt == "my own prompt"


def test_consumer_tools_added_alongside_builtins():
    agent = create_harness(tools=[sample_tool])
    assert {"shell", "read", "sample_tool"} <= set(agent.tool_names)


def test_subagent_enabled_by_default():
    agent = create_harness()
    assert "subagent" in agent.tool_names


def test_subagent_disabled_via_builtin_tools():
    # Drop it like any other built-in — no bespoke flag.
    agent = create_harness(builtin_tools=["shell", "read", "write", "edit", "web_fetch"])
    assert "subagent" not in agent.tool_names


def test_subagent_offers_the_generalist_preset():
    agent = create_harness()
    schema = agent.tool_registry.registry["subagent"].tool_spec["inputSchema"]["json"]
    assert schema["properties"]["agent_type"]["enum"] == ["generalist"]
    assert "generalist" in agent.tool_registry.registry["subagent"].tool_spec["description"]


def test_subagent_selectable_set_keeps_subagent_and_drops_web_search():
    # web_search is resolved per model rather than selected; subagent stays in, so a delegate can
    # sub-delegate (bounded by the depth guard). The default wiring includes both names.
    agent = create_harness()
    enum = set(
        agent.tool_registry.registry["subagent"].tool_spec["inputSchema"]["json"]["properties"]["tools"]["items"][
            "enum"
        ]
    )
    assert "subagent" in enum
    assert "web_search" not in enum


def test_subagent_tools_include_consumer_tools():
    # A consumer tool is delegable too: it joins the selectable set alongside the built-ins.
    agent = create_harness(builtin_tools=["read", "shell", "subagent"], tools=[sample_tool])
    schema = agent.tool_registry.registry["subagent"].tool_spec["inputSchema"]["json"]
    assert set(schema["properties"]["tools"]["items"]["enum"]) == {"read", "shell", "subagent", "sample_tool"}


async def test_subagent_refuses_once_the_parents_depth_budget_is_exhausted():
    # Depth lives on agent.state, tracked by the tool itself, not by omitting the tool from a
    # child's tool list — so a real agent always has subagent, but a spent budget refuses the call.
    from types import SimpleNamespace

    from strands.agent.state import AgentState

    agent = create_harness()
    tool = agent.tool_registry.registry["subagent"]
    exhausted_parent = SimpleNamespace(state=AgentState({"subagent_depth": 0}), messages=[])
    tool_use = {"toolUseId": "t1", "name": "subagent", "input": {"task": "do it"}}
    events = [e async for e in tool.stream(tool_use, {"agent": exhausted_parent})]
    result = events[-1].tool_result
    assert result["status"] == "error"
    assert "depth" in result["content"][0]["text"].lower()


def test_builtin_tools_subset():
    agent = create_harness(builtin_tools=["read"])
    assert "read" in agent.tool_names
    assert "shell" not in agent.tool_names


def test_builtin_tools_disabled():
    agent = create_harness(builtin_tools=[], tools=[sample_tool])
    assert "shell" not in agent.tool_names
    assert "read" not in agent.tool_names
    assert "sample_tool" in agent.tool_names


class _BashSandbox(DockerSandbox):
    def get_tools(self):
        return [
            make_shell(sandbox=self, name="sandbox_bash"),
            make_file_editor(sandbox=self, name="sandbox_file_editor"),
        ]


def test_sandbox_vended_tools_are_dropped():
    agent = create_harness(sandbox=DockerSandbox(container="c1"))
    assert {"shell", "read", "write", "edit"} <= set(agent.tool_names)
    assert {"sandbox_shell", "sandbox_file_editor"}.isdisjoint(agent.tool_names)

    agent = create_harness(sandbox=_BashSandbox(container="c1"))
    assert {"sandbox_bash", "sandbox_file_editor"}.isdisjoint(agent.tool_names)


def test_unknown_builtin_tool_raises():
    with pytest.raises(ValueError, match="Unknown built-in tool"):
        create_harness(builtin_tools=["grep"])


class TestBuiltinToolsUnion:
    """§2 row 7: a list pins, a mapping edits the defaults, ``"*"`` picks the base, bad input raises."""

    def test_none_is_every_default_on(self):
        normalized = _normalize_builtin_tools(None)
        assert {name for name, on in normalized.items() if on} == set(DEFAULT_BUILTIN_TOOLS)
        assert all(on is True for on in normalized.values() if on)

    def test_list_pins_exactly_the_names_given(self):
        normalized = _normalize_builtin_tools(["read", "web_fetch"])
        assert {name for name, on in normalized.items() if on} == {"read", "web_fetch"}
        assert set(normalized) == set(BUILTIN_TOOL_NAMES)

    def test_mapping_edits_the_default_set(self):
        normalized = _normalize_builtin_tools({"subagent": False, "web_fetch": {"model": "openai/gpt-5-mini"}})
        assert normalized["subagent"] is False
        assert normalized["web_fetch"] == {"model": "openai/gpt-5-mini"}
        assert normalized["shell"] is True
        assert "*" not in normalized

    def test_star_false_starts_from_nothing(self):
        normalized = _normalize_builtin_tools({"*": False, "read": True, "web_fetch": {}})
        assert {name for name, on in normalized.items() if on is not False} == {"read", "web_fetch"}
        agent = create_harness(builtin_tools={"*": False, "read": True})
        assert set(agent.tool_names) & set(BUILTIN_TOOL_NAMES) == {"read"}

    def test_empty_config_mapping_enables_the_tool(self):
        agent = create_harness(builtin_tools={"*": False, "web_fetch": {}})
        assert set(agent.tool_names) & set(BUILTIN_TOOL_NAMES) == {"web_fetch"}

    def test_mapping_removes_a_default_tool(self):
        agent = create_harness(builtin_tools={"shell": False})
        assert "shell" not in agent.tool_names
        assert {"read", "write", "edit", "web_fetch", "subagent"} <= set(agent.tool_names)

    def test_web_fetch_model_config_reaches_the_summarizer(self, monkeypatch):
        seen: list = []

        def spy(main_model, web_fetch_model):
            seen.append(web_fetch_model)
            return resolve_web_fetch_model(main_model, web_fetch_model)

        monkeypatch.setattr(agent_module, "resolve_web_fetch_model", spy)
        create_harness(builtin_tools={"web_fetch": {"model": "openai/gpt-5-mini"}})
        assert seen == ["openai/gpt-5-mini"]
        seen.clear()
        create_harness(builtin_tools=["web_fetch"])
        assert seen == [None]

    @pytest.mark.parametrize(
        ("name", "factory", "config"),
        [
            ("shell", "make_shell", {"description": "Run a command."}),
            ("programmatic_tool_caller", "make_programmatic_tool_caller", {"allowed_tools": ["read"], "timeout": 5}),
            ("subagent", "build_default_subagent", {"max_depth": 1}),
        ],
    )
    def test_tool_config_reaches_its_factory(self, monkeypatch, name, factory, config):
        seen: list[dict] = []
        real = getattr(agent_module, factory)

        def spy(*args, **kwargs):
            seen.append(kwargs)
            return real(*args, **kwargs)

        monkeypatch.setattr(agent_module, factory, spy)
        create_harness(builtin_tools={name: config})
        assert seen == [config]
        seen.clear()
        create_harness(builtin_tools={name: True})
        assert seen == [{}]

    def test_tool_config_shapes_the_built_tool(self):
        agent = create_harness(builtin_tools={"shell": {"description": "Run a command."}, "subagent": {"max_depth": 1}})
        assert agent.tool_registry.registry["shell"].tool_spec["description"] == "Run a command."
        assert agent.tool_registry.registry["subagent"]._max_depth == 1
        assert create_harness().tool_registry.registry["subagent"]._max_depth == DEFAULT_SUBAGENT_MAX_DEPTH

    @pytest.mark.parametrize("name", ["write", "edit"])
    def test_bool_only_tools_reject_a_config_mapping(self, name):
        with pytest.raises(ValueError, match=f"Built-in tool '{name}' takes no config; pass True or False"):
            create_harness(builtin_tools={name: {}})

    @pytest.mark.parametrize(
        ("name", "allowed"),
        [
            ("read", "media"),
            ("shell", "description"),
            ("web_fetch", "model"),
            ("programmatic_tool_caller", "allowed_tools, timeout"),
            ("subagent", "max_depth"),
        ],
    )
    def test_unknown_tool_config_keys_raise(self, name, allowed):
        with pytest.raises(ValueError, match=f"Unknown {name} config keys: bogus. Allowed: {allowed}."):
            create_harness(builtin_tools={name: {"bogus": 1}})

    def test_normalized_mapping_is_what_subagents_receive(self, monkeypatch):
        captured: list[dict] = []

        def capturing(build_agent, parent_config, **kwargs):
            captured.append(parent_config)
            return build_default_subagent(build_agent, parent_config, **kwargs)

        monkeypatch.setattr(agent_module, "build_default_subagent", capturing)
        create_harness(builtin_tools={"*": False, "subagent": True, "read": True})
        forwarded = captured[0]["builtin_tools"]
        assert "*" not in forwarded
        assert forwarded["read"] is True and forwarded["shell"] is False

    @pytest.mark.parametrize(
        ("name", "config"),
        [
            ("shell", {"description": "Run things"}),
            ("web_fetch", {"model": "openai/gpt-5-mini"}),
            ("web_fetch", {"model": ModelRouter([BedrockModel(model_id="mini")])}),
            ("programmatic_tool_caller", {"allowed_tools": ["read", "shell"]}),
            ("programmatic_tool_caller", {"allowed_tools": [], "timeout": None}),
            ("programmatic_tool_caller", {"timeout": 2.5}),
            ("programmatic_tool_caller", {"timeout": 1}),
            ("subagent", {"max_depth": 0}),
        ],
    )
    def test_well_formed_tool_config_values_pass_through(self, name, config):
        assert _normalize_builtin_tools({name: config})[name] == config

    def test_none_config_values_are_unset_unless_none_is_a_documented_value(self):
        normalized = _normalize_builtin_tools(
            {
                "shell": {"description": None},
                "web_fetch": {"model": None},
                "programmatic_tool_caller": {"allowed_tools": None, "timeout": None},
                "subagent": {"max_depth": None},
            }
        )
        assert normalized == {
            **{name: name in DEFAULT_BUILTIN_TOOLS for name in BUILTIN_TOOL_NAMES},
            "shell": {},
            "web_fetch": {},
            "programmatic_tool_caller": {"allowed_tools": None, "timeout": None},
            "subagent": {},
        }

    @pytest.mark.parametrize(
        ("name", "config", "message"),
        [
            ("shell", {"description": ""}, r"\['shell'\]\['description'\] must be a non-empty string, got ''"),
            (
                "web_fetch",
                {"model": {"module": "x"}},
                r"\['web_fetch'\]\['model'\] must be a Model, ModelRouter or 'provider/name' string",
            ),
            (
                "programmatic_tool_caller",
                {"allowed_tools": "read"},
                r"\['programmatic_tool_caller'\]\['allowed_tools'\] must be a list of tool names, got 'read'",
            ),
            (
                "programmatic_tool_caller",
                {"timeout": 0},
                r"\['programmatic_tool_caller'\]\['timeout'\] must be a positive number of seconds, got 0",
            ),
            ("subagent", {"max_depth": -1}, r"\['subagent'\]\['max_depth'\] must be a non-negative int, got -1"),
        ],
    )
    def test_malformed_tool_config_values_raise(self, name, config, message):
        with pytest.raises(ValueError, match=f"builtin_tools{message}"):
            create_harness(builtin_tools={name: config})

    @pytest.mark.parametrize(
        ("value", "message"),
        [
            ("read", r"must be a list of names or a mapping of name to bool/config, got 'read'"),
            (True, r"must be a list of names or a mapping of name to bool/config, got True"),
            (False, r"must be a list of names or a mapping of name to bool/config, got False"),
            (["grep"], "Unknown built-in tool"),
            ({"grep": True}, "Unknown built-in tool"),
            ({"*": "yes"}, r"builtin_tools\['\*'\] must be a bool"),
            ({"web_fetch": {"speed": 1}}, "Unknown web_fetch config keys: speed"),
            ({"web_fetch": {"model": {"module": "x"}}}, r"builtin_tools\['web_fetch'\]\['model'\] must be a Model"),
            ({"web_fetch": {"model": ""}}, r"builtin_tools\['web_fetch'\]\['model'\] must be a Model"),
            ({"read": "on"}, r"builtin_tools\['read'\] must be a bool or a config mapping"),
        ],
    )
    def test_malformed_values_raise(self, value, message):
        with pytest.raises(ValueError, match=message):
            create_harness(builtin_tools=value)


def test_root_exports_match_the_spec_table():
    """§1: the root module exposes exactly the documented surface."""
    import strands_harness

    expected = {
        "create_harness",
        "HARNESS_CONTRACT",
        "build_system_prompt",
        "DEFAULT_HARNESS_AGENT_CONFIG",
        "define_harness_agent_config",
        "harness_agent_kwargs_from_config",
        "normalize_harness_agent_config",
        "BUILTIN_TOOL_NAMES",
        "ReadConfig",
        "BUILTIN_PLUGIN_NAMES",
        "supports_thinking",
        "supports_web_search",
        "resolve_interventions",
        "resolve_memory",
        "InterventionsOption",
        "InterventionAsk",
        "InterventionValue",
        "Effort",
        "BuiltinToolName",
        "BuiltinPluginName",
        "BuiltinToolsConfig",
        "WebFetchConfig",
        "WebFetchTransport",
        "ShellConfig",
        "ProgrammaticToolCallerConfig",
        "SubagentConfig",
        "SessionConfig",
        "MemoryConfig",
        "ContextManagerConfig",
        "ContextManagerOption",
    }
    assert set(strands_harness.__all__) == expected
    for name in expected:
        assert getattr(strands_harness, name) is not None
    assert strands_harness.supports_web_search("openai/gpt-5.6-sol") is True
    assert strands_harness.supports_web_search(BedrockModel(model_id="x")) is False


def test_web_search_is_not_a_tool():
    agent = create_harness(model="openai/gpt-5.6-sol")
    assert "web_search" not in agent.tool_names


def test_web_search_enabled_on_supported_provider_from_default():
    agent = create_harness(model="openai/gpt-5.6-sol")
    assert agent.model.config["params"]["tools"] == [{"type": "web_search"}]


def test_web_search_default_on_bedrock_warns_with_the_opt_in_and_builds(caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="strands_harness.agent"):
        agent = create_harness()
    assert "web_search" not in agent.tool_names
    assert any("has no native web search" in r.message and "'web_search': 'exa'" in r.message for r in caplog.records)


def test_web_search_explicit_on_unsupported_provider_raises():
    with pytest.raises(ValueError, match="has no native web search"):
        create_harness(builtin_tools=["read", "web_search"])
    with pytest.raises(ValueError, match="has no native web search"):
        create_harness(builtin_tools={"web_search": True})


def test_web_search_exa_fallback_builds_the_tool_and_warns_about_the_third_party(caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="strands_harness.agent"):
        agent = create_harness(builtin_tools={"web_search": "exa"})
    assert "web_search" in agent.tool_names
    assert any("Exa (exa.ai), a third-party service" in r.message for r in caplog.records)
    assert not any("has no native web search" in r.message for r in caplog.records)


def test_web_search_exa_wins_over_native_search():
    # https://github.com/strands-agents/harness-sdk/issues/4480
    agent = create_harness(model="openai/gpt-5.6-sol", builtin_tools={"web_search": "exa"})
    assert "web_search" in agent.tool_names
    assert "tools" not in agent.model.config["params"]


def test_web_search_exa_fallback_works_on_a_model_instance():
    agent = create_harness(model=BedrockModel(model_id="x"), builtin_tools={"web_search": "exa"})
    assert "web_search" in agent.tool_names


def test_web_search_setting_is_a_bool_or_exa():
    with pytest.raises(ValueError, match="must be a bool or 'exa'"):
        create_harness(builtin_tools={"web_search": "bing"})
    with pytest.raises(ValueError, match="must be a bool or 'exa'"):
        create_harness(builtin_tools={"web_search": {"fallback": "exa"}})


def test_web_search_native_on_anthropic_and_mantle_gpt():
    agent = create_harness(model="anthropic/claude-opus-4-8")
    assert "web_search" not in agent.tool_names
    assert agent.model.config["anthropic_tools"][0]["type"] == "web_search_20260318"
    agent = create_harness(model="bedrock-mantle/openai.gpt-5.6-luna")
    assert "web_search" not in agent.tool_names
    assert agent.model.config["params"]["tools"] == [{"type": "web_search", "external_web_access": True}]
    # Other Mantle families have no native search: the default warns and drops it.
    agent = create_harness(model="bedrock-mantle/openai.gpt-oss-120b-1:0")
    assert "web_search" not in agent.tool_names
    assert "tools" not in agent.model.config["params"]


def test_web_search_explicit_on_supported_provider_enabled():
    agent = create_harness(model="google/gemini-3.5-flash", builtin_tools=["read", "web_search"])
    assert "gemini_tools" in agent.model.config
    assert "web_search" not in agent.tool_names


def test_caching_enabled_by_default_on_bedrock():
    agent = create_harness()
    assert agent.model.config["cache_config"] == CacheConfig(strategy="auto", tools_ttl=True)


def test_caching_enabled_by_default_on_anthropic_direct():
    agent = create_harness(model="anthropic/claude-opus-4-8")
    assert agent.model.config["cache_config"] == CacheConfig(strategy="auto", tools_ttl=True)


def test_caching_default_on_model_instance_warns_and_builds(caplog):
    import logging

    from strands.models import BedrockModel

    instance = BedrockModel(model_id="anything")
    with caplog.at_level(logging.WARNING, logger="strands_harness.models"):
        agent = create_harness(model=instance)
    assert isinstance(agent, Agent)
    assert any("pre-built Model instance" in r.message for r in caplog.records)


def test_caching_explicit_on_model_instance_warns_and_builds(caplog):
    from strands.models import BedrockModel

    instance = BedrockModel(model_id="anything")
    with caplog.at_level(logging.WARNING, logger="strands_harness.models"):
        agent = create_harness(model=instance, caching="auto")
    assert agent.model is instance
    assert any("pre-built Model instance" in r.message for r in caplog.records)


def test_caching_disabled_leaves_no_cache_config():
    agent = create_harness(caching=False)
    assert "cache_config" not in agent.model.config


@pytest.mark.parametrize("value", [False, None])
def test_context_manager_disabled(value):
    agent = create_harness(context_manager=value)
    assert not _context_managed(agent)


def test_context_manager_default_uses_default_strategy():
    agent = create_harness()
    assert _context_managed(agent)


def test_context_manager_true_is_rejected_by_the_sdk():
    with pytest.raises(ValueError, match="Unsupported context_manager value: True"):
        create_harness(context_manager=True)


def test_context_manager_config_builds_an_sdk_context_manager():
    agent = create_harness(context_manager={"stash": False})
    assert isinstance(agent.conversation_manager, NullConversationManager)
    assert any(isinstance(plugin, ContextManager) for plugin in agent._plugin_registry._plugins.values())


def test_effort_auto_uses_recommended_level():
    agent = create_harness(effort="auto")
    assert agent.model.config["additional_request_fields"]["output_config"]["effort"] == "high"


def test_effort_off_drops_reasoning():
    agent = create_harness(effort="off")
    assert "additional_request_fields" not in agent.model.config


def test_effort_level_is_validated_against_the_model():
    with pytest.raises(ValueError, match="not supported by Bedrock model"):
        create_harness(effort="minimal")


def test_explicit_context_manager_wins():
    manager = ContextManager()
    agent = create_harness(context_manager=manager)
    assert isinstance(agent.conversation_manager, NullConversationManager)
    assert any(plugin is manager for plugin in agent._plugin_registry._plugins.values())


def test_session_manager_on_by_default(tmp_path):
    agent = create_harness(session={"dir": str(tmp_path)})
    assert isinstance(agent._session_manager, SnapshotSessionManager)
    assert re.fullmatch(r"[0-9a-f]{8}", agent._session_manager.session_id)


def test_session_true_and_empty_config_use_the_default_dir(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    for session in (True, {}):
        agent = create_harness(session=session)
        assert isinstance(agent._session_manager, SnapshotSessionManager)
        base_dir = agent._session_manager._storage._storage._base_dir
        assert Path(base_dir).resolve() == (tmp_path / ".agent" / "sessions").resolve()


def test_default_agents_mint_distinct_ids(tmp_path):
    first = create_harness(session={"dir": str(tmp_path)})
    second = create_harness(session={"dir": str(tmp_path)})
    assert first.session_id != second.session_id
    assert first.session_id == first._session_manager.session_id


@pytest.mark.parametrize("session", [False, None])
def test_session_disabled_builds_no_manager(session):
    agent = create_harness(session=session)
    assert agent._session_manager is None


def test_session_manager_instance_is_used_verbatim(tmp_path):
    supplied = SnapshotSessionManager("mine", storage=LocalFileStorage(str(tmp_path)))
    agent = create_harness(session=supplied)
    assert agent._session_manager is supplied


def test_session_manager_kwarg_passthrough_wins(tmp_path):
    supplied = SnapshotSessionManager("mine", storage=LocalFileStorage(str(tmp_path)))
    agent = create_harness(session={"id": "ignored"}, session_manager=supplied)
    assert agent._session_manager is supplied


class TestSessionAndMemoryUnions:
    """§2 rows 11/12: out-of-union ``session``/``memory`` values raise a clear ``ValueError`` before any
    wiring happens, instead of an ``AttributeError`` deep in the factory or a silently ignored key."""

    @pytest.mark.parametrize(
        ("value", "message"),
        [
            ("abc", r'session must be .* not a string \(\'abc\'\); "auto" is no longer a value'),
            (3, r"session must be a bool, a SessionConfig mapping, a SessionManager instance, or None, got 3"),
            ({"id": 5}, r"session\['id'\] must be a str, got 5"),
            ({"dir": 5}, r"session\['dir'\] must be a str, got 5"),
            ({"idd": "x"}, r"session contains unknown keys: idd\. Allowed: dir, id\."),
            ({1: "x"}, r"session contains unknown keys: 1\. Allowed: dir, id\."),
            ({"id": ""}, r"session\.id must be a non-empty string\."),
            ({"dir": ""}, r"session\.dir must be a non-empty string\."),
        ],
        ids=["string", "int", "id-not-str", "dir-not-str", "unknown-key", "non-str-key", "id-empty", "dir-empty"],
    )
    def test_malformed_session_raises(self, value, message):
        with pytest.raises(ValueError, match=message):
            create_harness(session=value, memory=False)

    @pytest.mark.parametrize(
        ("value", "message"),
        [
            ("x", r'memory must be .* not a string \(\'x\'\); "auto" is no longer a value'),
            (["x"], r"memory must be a bool, a MemoryConfig mapping, a MemoryManager instance, or None, got \['x'\]"),
            ({"dir": 3}, r"memory\['dir'\] must be a str, got 3"),
            ({"foo": 1}, r"memory contains unknown keys: foo\. Allowed: dir, stores\."),
            ({1: "x"}, r"memory contains unknown keys: 1\. Allowed: dir, stores\."),
            ({"dir": ""}, r"memory\.dir must be a non-empty string\."),
            ({"stores": "x"}, r"memory\.stores must be a sequence of MemoryStore instances, got 'x'\."),
            ({"stores": [1]}, r"memory\.stores must be a sequence of MemoryStore instances, got \[1\]\."),
        ],
        ids=[
            "string",
            "list",
            "dir-not-str",
            "unknown-key",
            "non-str-key",
            "dir-empty",
            "stores-str",
            "stores-not-store",
        ],
    )
    def test_malformed_memory_raises(self, value, message):
        with pytest.raises(ValueError, match=message):
            create_harness(memory=value, session=False)

    def test_memory_stores_accepts_memory_store_instances(self, tmp_path):
        store = FileMemoryStore(name="mine", storage=LocalFileStorage(str(tmp_path)).namespace(""), writable=False)
        agent = create_harness(memory={"stores": [store]}, session=False)
        assert isinstance(agent.memory_manager, MemoryManager)
        assert _memory_config({"stores": (store,)}) == {"stores": [store]}

    @pytest.mark.parametrize("value", [True, False, None, {}], ids=["true", "false", "none", "empty"])
    def test_in_union_scalars_are_accepted(self, value):
        create_harness(session=value, memory=value)


def test_session_manager_wired(tmp_path):
    agent = create_harness(session={"id": "user-42", "dir": str(tmp_path)})
    assert isinstance(agent._session_manager, SnapshotSessionManager)
    assert agent._session_manager.session_id == "user-42"


def test_subagent_delegate_has_session_forced_off(monkeypatch):
    captured: list[dict] = []

    def capturing(build_agent, parent_config, **kwargs):
        captured.append(parent_config)
        return build_default_subagent(build_agent, parent_config, **kwargs)

    monkeypatch.setattr(agent_module, "build_default_subagent", capturing)
    create_harness()
    assert captured[0]["session"] is False


def test_session_persists_messages_before_invocation_finishes(tmp_path):
    def create_agent():
        return create_harness(
            session={"id": "checkpoint", "dir": str(tmp_path)},
            builtin_tools=[],
            builtin_plugins=[],
            context_manager=False,
            memory=False,
        )

    def check_checkpoint(event):
        restored = create_agent()
        assert restored.messages[0]["content"][0].get("text") == "Remember the checkpoint"
        raise RuntimeError("Stop before calling the model")

    agent = create_agent()
    agent.add_hook(check_checkpoint, BeforeModelCallEvent)
    with pytest.raises(RuntimeError, match="Stop before calling the model"):
        agent("Remember the checkpoint")


def test_session_id_sanitized(tmp_path):
    agent = create_harness(session={"id": "azrn:studio:us-west-2:session/abc", "dir": str(tmp_path)})
    assert agent._session_manager.session_id == "azrn-studio-us-west-2-session-abc"


def test_session_id_lowercased(tmp_path):
    agent = create_harness(session={"id": "MyProj.v2", "dir": str(tmp_path)})
    assert agent._session_manager.session_id == "myproj-v2"


def test_offloader_uses_temp_dir_when_session_disabled():
    agent = create_harness(session=False)
    offloaders = _offloaders(agent)
    assert len(offloaders) == 1
    assert _offload_dir(offloaders[0]).startswith(tempfile.gettempdir())


def test_offloader_uses_session_dir_by_default(tmp_path):
    agent = create_harness(session={"dir": str(tmp_path)})
    offloaders = _offloaders(agent)
    assert len(offloaders) == 1
    assert _offload_dir(offloaders[0]) == str(tmp_path / "offloaded")


def test_offloader_disabled_when_context_manager_off():
    agent = create_harness(context_manager=False)
    assert _offloaders(agent) == []


def test_offloader_uses_session_dir_when_session_active(tmp_path):
    agent = create_harness(session={"id": "user-42", "dir": str(tmp_path)})
    offloaders = _offloaders(agent)
    assert len(offloaders) == 1
    assert _offload_dir(offloaders[0]) == str(tmp_path / "offloaded")


def test_offloader_not_double_added_when_supplied(tmp_path):
    existing = ContextOffloader(storage=FileStorage(str(tmp_path / "custom")))
    agent = create_harness(plugins=[existing])
    offloaders = _offloaders(agent)
    assert offloaders == [existing]


def test_skills_loaded_from_dir(tmp_path):
    _write_skill(tmp_path, "hello")
    agent = create_harness(skills=[str(tmp_path)])
    assert len(_skills(agent)) == 1
    assert "skills" in agent.tool_names


def test_skills_default_loads_the_default_dir_when_present(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    _write_skill(tmp_path / ".agent" / "skills", "hello")
    agent = create_harness(skills=True, session=False)
    plugins = _skills(agent)
    assert len(plugins) == 1
    assert plugins[0]._skill_paths == ["./.agent/skills"]


def test_skills_default_is_noop_without_the_default_dir(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    agent = create_harness(session=False)
    assert _skills(agent) == []


def test_skills_explicit_missing_dir_is_reported_by_the_sdk(tmp_path, caplog):
    with caplog.at_level(logging.WARNING, logger="strands.vended_plugins.skills"):
        agent = create_harness(skills=[str(tmp_path / "absent")])
    assert len(_skills(agent)) == 1
    assert any("skill source does not exist" in r.message for r in caplog.records)


@pytest.mark.parametrize("skills", [None, False])
def test_skills_disabled(skills):
    agent = create_harness(skills=skills)
    assert _skills(agent) == []


def test_skills_instance_is_used_verbatim(tmp_path):
    _write_skill(tmp_path, "hello")
    supplied = AgentSkills(skills=[str(tmp_path)])
    agent = create_harness(skills=supplied)
    assert _skills(agent) == [supplied]


def test_skills_loaded_from_multiple_dirs(tmp_path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    _write_skill(a, "hello")
    _write_skill(b, "world")
    agent = create_harness(skills=[str(a), str(b)])
    plugins = _skills(agent)
    assert len(plugins) == 1
    assert plugins[0]._skill_paths == [str(a), str(b)]


def test_skills_multiple_dirs_skips_missing(tmp_path):
    present = tmp_path / "present"
    _write_skill(present, "hello")
    agent = create_harness(skills=[str(present), str(tmp_path / "absent")])
    assert len(_skills(agent)) == 1


def test_skills_disabled_with_empty_list():
    agent = create_harness(skills=[])
    assert _skills(agent) == []


def test_skills_not_double_added_when_supplied(tmp_path):
    _write_skill(tmp_path, "hello")
    existing = AgentSkills(skills=[str(tmp_path)])
    agent = create_harness(skills=[str(tmp_path)], plugins=[existing])
    assert _skills(agent) == [existing]


@tool
def read(path: str) -> str:
    """A consumer tool that collides with the built-in read."""
    return path


@tool
def subagent(task: str) -> str:
    """A consumer tool that collides with the built-in subagent tool."""
    return task


def test_builtin_tool_collides_with_consumer_tool_raises():
    with pytest.raises(ValueError) as exc:
        create_harness(tools=[read])
    msg = str(exc.value)
    assert "Tool name 'read' is registered more than once (from a built-in tool and tools)." in msg
    assert "drop the built-in via builtin_tools / builtin_plugins" in msg


@tool(name="todo_write")
def todo_write(todos: list) -> str:
    """A consumer tool that collides with the todos plugin's built-in tool."""
    return "ok"


def test_builtin_plugin_tool_collides_with_consumer_tool_raises():
    with pytest.raises(ValueError) as exc:
        create_harness(builtin_plugins=["todos"], tools=[todo_write])
    msg = str(exc.value)
    assert "Tool name 'todo_write' is registered more than once (from tools and a built-in plugin)." in msg
    assert "drop the built-in via builtin_tools / builtin_plugins" in msg


def test_dropping_builtin_plugin_frees_the_name_for_consumer():
    agent = create_harness(builtin_plugins=[], tools=[todo_write])
    assert "todo_write" in agent.tool_names


def test_subagent_collides_with_consumer_tool_raises():
    with pytest.raises(ValueError, match=r"Tool name 'subagent' is registered more than once"):
        create_harness(tools=[subagent])


def test_same_consumer_tool_listed_twice_raises():
    with pytest.raises(ValueError, match=r"Tool name 'sample_tool' is registered more than once \(from tools\)"):
        create_harness(tools=[sample_tool, sample_tool])


def test_consumer_collision_remedy_does_not_mention_builtins():
    with pytest.raises(ValueError, match=r"unique name") as exc:
        create_harness(tools=[sample_tool, sample_tool])
    assert "built-in" not in str(exc.value)


def test_dash_underscore_near_collision_raises():
    @tool(name="web-fetch")
    def web_fetch_dash(url: str) -> str:
        """Collides with web_fetch by '-' vs '_'."""
        return url

    with pytest.raises(ValueError, match=r"registered more than once"):
        create_harness(tools=[web_fetch_dash])


def test_dropping_builtin_frees_the_name_for_consumer():
    agent = create_harness(builtin_tools=["shell", "write", "edit"], tools=[read])
    assert "read" in agent.tool_names
    spec = agent.tool_registry.registry["read"].tool_spec
    assert "consumer tool that collides" in spec["description"]


def test_non_tool_forms_in_tools_are_not_name_checked():
    # The SDK also accepts nested lists (and strings/dicts/modules) in ``tools`` and resolves them
    # later; the collision pre-flight must skip them rather than choke on the missing ``tool_name``.
    agent = create_harness(tools=[[sample_tool]])
    assert "sample_tool" in agent.tool_names


def _interventions(agent: Agent) -> list:
    return agent._intervention_registry.handlers


def test_interventions_off_by_default():
    agent = create_harness()
    assert _interventions(agent) == []


def test_interventions_preset_is_wired():
    from strands.vended_interventions.hitl import HumanInTheLoop

    agent = create_harness(interventions="ask")
    handlers = _interventions(agent)
    assert len(handlers) == 1
    assert isinstance(handlers[0], HumanInTheLoop)


def test_interventions_handler_instance_passes_through():
    from strands.vended_interventions.hitl import HumanInTheLoop

    handler = HumanInTheLoop(ask="stdio")
    agent = create_harness(interventions=handler)
    assert _interventions(agent) == [handler]


async def test_subagent_child_inherits_interventions_and_background_tasks():
    # A delegate must inherit interventions or it's an approval bypass; capture what the builder forwards.
    from types import SimpleNamespace

    from strands_harness.tools.subagent import build_default_subagent

    captured: dict = {}

    class _StubResult:
        stop_reason = "end_turn"
        interrupts: list = []

        def __str__(self) -> str:
            return "done"

    from strands.agent.state import AgentState

    class _StubAgent:
        messages: list = []
        state = AgentState()
        _interrupt_state = SimpleNamespace(activated=False, interrupts={})

        async def stream_async(self, prompt, cancel_signal=None):
            yield {"result": _StubResult()}

    def fake_factory(**kwargs):
        captured.update(kwargs)
        return _StubAgent()

    tool = build_default_subagent(
        fake_factory,
        {
            "interventions": "smart",
            "background_tasks": False,
            "builtin_tools": _normalize_builtin_tools(None),
        },
    )
    tool_use = {"toolUseId": "t1", "name": "subagent", "input": {"task": "do it"}}
    async for _ in tool.stream(tool_use, {"agent": None}):
        pass
    assert captured["interventions"] == "smart"
    assert captured["background_tasks"] is False
    assert "_subagent_remaining_depth" not in captured  # depth lives on agent.state, not a kwarg


async def test_subagent_narrowed_builtin_tools_keep_every_builtin_name():
    # A narrowed child mapping keeps the shape of ``_normalize_builtin_tools``: every built-in name
    # present, only the selected ones on.
    from types import SimpleNamespace

    from strands.agent.state import AgentState

    captured: dict = {}

    class _StubResult:
        stop_reason = "end_turn"
        interrupts: list = []

        def __str__(self) -> str:
            return "done"

    class _StubAgent:
        messages: list = []
        state = AgentState()
        _interrupt_state = SimpleNamespace(activated=False, interrupts={})

        async def stream_async(self, prompt, cancel_signal=None):
            yield {"result": _StubResult()}

    def fake_factory(**kwargs):
        captured.update(kwargs)
        return _StubAgent()

    tool = build_default_subagent(
        fake_factory, {"background_tasks": False, "builtin_tools": _normalize_builtin_tools(None)}
    )
    tool_use = {"toolUseId": "t1", "name": "subagent", "input": {"task": "do it", "tools": ["read"]}}
    async for _ in tool.stream(tool_use, {"agent": None}):
        pass
    child = captured["builtin_tools"]
    assert set(child) == set(BUILTIN_TOOL_NAMES) == set(_normalize_builtin_tools(None))
    assert child["read"] is True
    assert all(child[name] is False for name in BUILTIN_TOOL_NAMES if name not in ("read", "web_search"))


def _build_subagent_child(**parent_kwargs):
    from strands_harness.tools import AgentSpec
    from strands_harness.tools.subagent import GENERALIST

    parent = create_harness(**parent_kwargs)
    spec = AgentSpec(task="x", agent_type="generalist", instructions=GENERALIST.instructions)
    return parent.tool_registry.registry["subagent"]._builder(spec)


def test_subagent_child_does_not_share_a_live_context_manager():
    # A ContextManager instance carries per-agent state; a delegate gets its own (default strategy).
    shared = ContextManager()
    parent_kwargs = {"context_manager": shared}
    child = _build_subagent_child(**parent_kwargs)
    parent = create_harness(**parent_kwargs)
    assert parent._context_manager is shared
    assert isinstance(child._context_manager, ContextManager)
    assert child._context_manager is not shared


def test_subagent_child_inherits_consumer_plugins():
    class MarkerPlugin:
        name = "marker"
        hooks: list = []
        tools: list = []

        def init_agent(self, agent):
            pass

    child = _build_subagent_child(plugins=[MarkerPlugin()])
    assert any(isinstance(p, MarkerPlugin) for p in child._plugin_registry._plugins.values())


def test_subagent_child_inherits_consumer_hooks():
    from strands.hooks import BeforeToolCallEvent

    def marker_hook(event):
        pass

    class MarkerHooks:
        def register_hooks(self, registry, **kwargs):
            registry.add_callback(BeforeToolCallEvent, marker_hook)

    child = _build_subagent_child(hooks=[MarkerHooks()])
    entries = child.hooks._registered_callbacks.get(BeforeToolCallEvent, [])
    assert any(getattr(e, "callback", None) is marker_hook for e in entries)


def test_subagent_child_inherits_sandbox():
    from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment

    sandbox = NotASandboxLocalEnvironment()
    child = _build_subagent_child(sandbox=sandbox)
    assert child.sandbox is sandbox


def test_subagent_child_without_sandbox_gets_the_sdk_default():
    from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment

    child = _build_subagent_child()
    assert isinstance(child.sandbox, NotASandboxLocalEnvironment)


def test_subagent_child_inherits_interventions_and_background_tasks_end_to_end():
    child = _build_subagent_child(interventions="ask", background_tasks=False)
    assert [type(h).__name__ for h in child._intervention_registry._handlers] == ["HumanInTheLoop"]
    assert child._background_tasks is None


def test_subagent_child_inherits_consumer_tools_when_not_narrowed():
    # A bare delegation (spec.tools is None) hands the child every consumer tool the parent holds.
    child = _build_subagent_child(tools=[sample_tool])
    assert "sample_tool" in child.tool_names


def test_subagent_child_narrowed_to_a_consumer_tool_gets_only_that_tool():
    from strands_harness.tools import AgentSpec

    parent = create_harness(builtin_tools=["read", "shell", "subagent"], tools=[sample_tool])
    # Model narrows to one built-in and the consumer tool, dropping shell.
    spec = AgentSpec(task="x", tools=["read", "sample_tool"])
    child = parent.tool_registry.registry["subagent"]._builder(spec)
    assert "sample_tool" in child.tool_names
    assert "read" in child.tool_names
    assert "shell" not in child.tool_names


def test_subagent_child_inherits_explicit_web_search():
    from strands_harness.tools import AgentSpec

    # web_search is never in the tools enum; a narrowed selection populates spec.tools without it,
    # but the builder still carries it onto a delegate of a web_search parent.
    parent = create_harness(model="openai/gpt-5.6-sol", builtin_tools=["read", "web_search", "subagent"])
    spec = AgentSpec(task="x", tools=["read"])
    child = parent.tool_registry.registry["subagent"]._builder(spec)
    assert child.model.config["params"]["tools"] == [{"type": "web_search"}]


def test_subagent_child_can_sub_delegate():
    # A default delegate keeps its own subagent tool, so multi-level delegation is possible (bounded
    # at call time by the depth guard).
    child = _build_subagent_child()
    assert "subagent" in child.tool_names


def test_mcp_servers_load_via_sdk_defaults(monkeypatch):
    # The SDK owns file reading, `mcpServers` unwrapping, and the per-server defaults: every server
    # is resilient and its tools are namespaced by its config key unless it sets its own `prefix`.
    mock = MagicMock(return_value=[])
    monkeypatch.setattr(agent_module.MCPClient, "load_servers", mock)
    create_harness(mcp_servers="~/mcp.json")
    mock.assert_called_once_with("~/mcp.json", continue_on_error=True, prefix_with_server_name=True)


def test_no_mcp_servers_is_a_noop(monkeypatch):
    mock = MagicMock(return_value=[])
    monkeypatch.setattr(agent_module.MCPClient, "load_servers", mock)
    create_harness()
    mock.assert_not_called()


_MCP_SERVER = str(Path(__file__).parent / "tools" / "echo_mcp_server.py")


def test_subagent_delegate_inherits_parent_mcp_tools():
    # A delegate shares the parent's connected MCP clients, so it keeps the parent's MCP tools; the
    # mcp_servers axis is keyed by server name, and an omitted selection grants every server.
    from strands_harness.tools import AgentSpec
    from strands_harness.tools.subagent import GENERALIST

    parent = create_harness(mcp_servers={"srv": {"command": "python", "args": [_MCP_SERVER]}})
    try:
        assert "srv_echo" in parent.tool_names
        builder = parent.tool_registry.registry["subagent"]._builder
        inherit_all = AgentSpec(task="x", agent_type="generalist", instructions=GENERALIST.instructions)
        assert "srv_echo" in builder(inherit_all).tool_names
        # Narrowing to no servers drops the parent's MCP tools from the delegate.
        none = AgentSpec(task="x", agent_type="generalist", instructions=GENERALIST.instructions, mcp_servers=[])
        assert "srv_echo" not in builder(none).tool_names
        # Selecting the server by name grants exactly its tools.
        # A repeated name (the axis is an array-of-enum) must not forward a client twice.
        one = AgentSpec(
            task="x", agent_type="generalist", instructions=GENERALIST.instructions, mcp_servers=["srv", "srv"]
        )
        assert "srv_echo" in builder(one).tool_names
    finally:
        for provider in parent.tool_registry._tool_providers:
            provider.stop(None, None, None)


def test_subagent_exposes_mcp_servers_axis_from_parent():
    # The parent's connected servers become the mcp_servers enum on the delegation tool's schema.
    parent = create_harness(mcp_servers={"srv": {"command": "python", "args": [_MCP_SERVER]}})
    try:
        schema = parent.tool_registry.registry["subagent"].tool_spec["inputSchema"]["json"]["properties"]
        assert schema["mcp_servers"]["items"]["enum"] == ["srv"]
    finally:
        for provider in parent.tool_registry._tool_providers:
            provider.stop(None, None, None)


def _generalist_spec(**kwargs):
    from strands_harness.tools import AgentSpec
    from strands_harness.tools.subagent import GENERALIST

    return AgentSpec(task="x", agent_type="generalist", instructions=GENERALIST.instructions, **kwargs)


def test_mcp_clients_passed_in_tools_join_the_subagent_axis():
    # Connected clients handed in via `tools` (how the CLI passes servers) are offered to delegates too,
    # each under its own client_name.
    servers = {
        "alpha": {"command": "python", "args": [_MCP_SERVER]},
        "beta": {"command": "python", "args": [_MCP_SERVER]},
    }
    alpha, beta = agent_module.MCPClient.load_servers(servers, prefix_with_server_name=True)
    parent = create_harness(tools=[alpha, beta])
    try:
        assert {"alpha_echo", "beta_echo"} <= set(parent.tool_names)
        schema = parent.tool_registry.registry["subagent"].tool_spec["inputSchema"]["json"]["properties"]
        assert schema["mcp_servers"]["items"]["enum"] == ["alpha", "beta"]
        assert not {"alpha", "beta"} & set(schema["tools"]["items"]["enum"])  # servers never pose as tools
        # Narrowing both axes at once: the tools split must not drop the selected servers.
        spec = _generalist_spec(tools=["read"], mcp_servers=["beta"])
        child = parent.tool_registry.registry["subagent"]._builder(spec)
        assert {"read", "beta_echo"} <= set(child.tool_names)
        assert "alpha_echo" not in child.tool_names
    finally:
        for provider in parent.tool_registry._tool_providers:
            provider.stop(None, None, None)


def test_mcp_clients_sharing_a_name_warn_and_first_wins(caplog):
    # Two clients answering to the same client_name can't both sit behind one enum value: the first is
    # offered, the second is dropped from delegation, and the collapse is warned about.
    servers = {
        "alpha": {"command": "python", "args": [_MCP_SERVER], "application_name": "shared"},
        "beta": {"command": "python", "args": [_MCP_SERVER], "application_name": "shared"},
    }
    alpha, beta = agent_module.MCPClient.load_servers(servers, prefix_with_server_name=True)
    with caplog.at_level(logging.WARNING, logger="strands_harness.tools.subagent"):
        parent = create_harness(tools=[alpha, beta])
    try:
        assert any("share the name 'shared'" in r.message for r in caplog.records)
        assert {"alpha_echo", "beta_echo"} <= set(parent.tool_names)  # the parent itself keeps both
        schema = parent.tool_registry.registry["subagent"].tool_spec["inputSchema"]["json"]["properties"]
        assert schema["mcp_servers"]["items"]["enum"] == ["shared"]
        child = parent.tool_registry.registry["subagent"]._builder(_generalist_spec(mcp_servers=["shared"]))
        assert "alpha_echo" in child.tool_names
        assert "beta_echo" not in child.tool_names
    finally:
        for provider in parent.tool_registry._tool_providers:
            provider.stop(None, None, None)


def test_unnamed_mcp_client_warns_and_is_not_offered_to_subagents(caplog):
    # A hand-built client without application_name has no name the model could pick, so it stays
    # out of the mcp_servers axis (and out of delegates) with a warning telling the caller how to fix it.
    from mcp import StdioServerParameters, stdio_client

    bare = agent_module.MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=[_MCP_SERVER])), prefix="bare"
    )
    with caplog.at_level(logging.WARNING, logger="strands_harness.tools.subagent"):
        parent = create_harness(tools=[bare])
    try:
        assert any("has no application_name" in r.message for r in caplog.records)
        assert "bare_echo" in parent.tool_names
        schema = parent.tool_registry.registry["subagent"].tool_spec["inputSchema"]["json"]["properties"]
        assert "mcp_servers" not in schema  # no offerable server, so no axis at all
        child = parent.tool_registry.registry["subagent"]._builder(_generalist_spec())
        assert "bare_echo" not in child.tool_names
    finally:
        for provider in parent.tool_registry._tool_providers:
            provider.stop(None, None, None)


def test_subagent_grandchild_inherits_parent_mcp_tools():
    # A delegate of a delegate keeps the parent's MCP tools: the child forwards its shared clients on.
    parent = create_harness(mcp_servers={"srv": {"command": "python", "args": [_MCP_SERVER]}})
    try:
        child = parent.tool_registry.registry["subagent"]._builder(_generalist_spec())
        assert "srv_echo" in child.tool_names
        grandchild = child.tool_registry.registry["subagent"]._builder(_generalist_spec())
        assert "srv_echo" in grandchild.tool_names
    finally:
        for provider in parent.tool_registry._tool_providers:
            provider.stop(None, None, None)


def test_subagent_grandchild_narrowing_propagates():
    # A child restricted to no MCP servers can't pass any to a grandchild; a granted server carries on.
    parent = create_harness(mcp_servers={"srv": {"command": "python", "args": [_MCP_SERVER]}})
    try:
        starved = parent.tool_registry.registry["subagent"]._builder(_generalist_spec(mcp_servers=[]))
        assert "srv_echo" not in starved.tool_names
        starved_grandchild = starved.tool_registry.registry["subagent"]._builder(_generalist_spec())
        assert "srv_echo" not in starved_grandchild.tool_names

        granted = parent.tool_registry.registry["subagent"]._builder(_generalist_spec(mcp_servers=["srv"]))
        granted_grandchild = granted.tool_registry.registry["subagent"]._builder(_generalist_spec())
        assert "srv_echo" in granted_grandchild.tool_names
    finally:
        for provider in parent.tool_registry._tool_providers:
            provider.stop(None, None, None)


def test_subagent_child_inherits_exa_fallback():
    from strands_harness.tools import AgentSpec

    parent = create_harness(builtin_tools={"web_search": "exa"})
    child = parent.tool_registry.registry["subagent"]._builder(AgentSpec(task="x", tools=["read"]))
    assert "web_search" in child.tool_names
