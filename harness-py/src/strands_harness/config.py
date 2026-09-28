"""Serializable harness configuration shared with TypeScript and exported projects."""

from __future__ import annotations

import importlib
import importlib.util
import json
import logging
import operator
import os
import re
import sys
from collections.abc import Callable
from copy import deepcopy
from functools import reduce
from pathlib import Path
from types import ModuleType
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    JsonValue,
    RootModel,
    SkipValidation,
    TypeAdapter,
    ValidationError,
    model_validator,
)
from pydantic.alias_generators import to_camel
from pydantic_core import PydanticCustomError

from strands_harness import defaults
from strands_harness.types.agent import BuiltinPluginName, BuiltinToolName, Effort, WebFetchTransport

__all__ = [
    "DEFAULT_HARNESS_AGENT_CONFIG",
    "define_harness_agent_config",
    "harness_agent_kwargs_from_config",
    "normalize_harness_agent_config",
]

logger = logging.getLogger(__name__)

DEFAULT_HARNESS_AGENT_CONFIG: dict[str, Any] = {
    "name": "Strands harness",
    "description": "",
    "instructions": "",
    "model": defaults.DEFAULT_MODEL,
    "modelModule": None,
    "effort": defaults.DEFAULT_EFFORT,
    "tools": [],
    "subagents": [],
    "mcpServers": {},
    "builtinTools": list(defaults.DEFAULT_BUILTIN_TOOLS),
    "caching": True,
    "contextManager": defaults.DEFAULT_CONTEXT_MANAGER,
    "session": True,
    "skills": True,
    "memory": True,
    "memoryStores": [],
    "plugins": [],
    "builtinPlugins": list(defaults.DEFAULT_BUILTIN_PLUGINS),
    "interventions": None,
    "interventionModules": [],
    "sandbox": None,
    "agentConfigModules": {},
    "dependencies": {"typescript": {}, "python": []},
    "agentConfig": {},
}


def define_harness_agent_config(config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Fill a partial portable config with the harness defaults."""
    return normalize_harness_agent_config({**deepcopy(DEFAULT_HARNESS_AGENT_CONFIG), **(config or {})})


def normalize_harness_agent_config(value: object) -> dict[str, Any]:
    """Validate and normalize a JSON-compatible harness definition.

    Normalizing also folds JSON-only spellings into their kwargs form: ``contextManager: "off"`` is ``False``.
    """
    if not isinstance(value, dict):
        raise ValueError("agent config must be an object.")
    unknown = sorted(set(value) - set(DEFAULT_HARNESS_AGENT_CONFIG))
    if unknown:
        logger.warning("Ignoring unknown agent config keys: %s.", ", ".join(unknown))
    config = {
        **DEFAULT_HARNESS_AGENT_CONFIG,
        **{key: item for key, item in value.items() if key in DEFAULT_HARNESS_AGENT_CONFIG},
    }
    try:
        parsed = _HarnessAgentConfig.model_validate(config)
    except ValidationError as error:
        raise ValueError(_describe(error, config)) from error
    # Every top-level key is set by the merge above; nested objects keep only the keys the config spelled out.
    return parsed.model_dump(by_alias=True, exclude_unset=True)


def _describe(error: ValidationError, config: dict[str, Any]) -> str:
    """One line per problem, located by its camelCase config path (``builtinTools.shell.description``).

    Each location is walked against ``config`` so only real keys and indexes survive: pydantic tags
    ``JsonValue`` union members into the path (``agentConfig.x.float``), and those tags are dropped. The
    one segment that is legitimately absent from the input is the name of a missing required key.
    """
    lines = []
    for item in error.errors(include_url=False):
        path: list[str] = []
        node: Any = config
        for part in item["loc"]:
            if (isinstance(node, dict) and part in node) or (
                isinstance(node, list) and isinstance(part, int) and 0 <= part < len(node)
            ):
                node = node[part]
            elif item["type"] != "missing":
                continue
            path.append(str(part))
        lines.append(f"{'.'.join(path)}: {item['msg']}" if path else item["msg"])
    return "\n".join(lines)


def harness_agent_kwargs_from_config(value: object, base_dir: str | Path = ".") -> dict[str, Any]:
    """Load executable references and convert portable config to ``create_harness`` kwargs.

    Local multi-file modules must use regular ``__init__.py`` packages and explicit relative imports.
    Bare imports use Python's normal import path; project directories are not added to ``sys.path``.
    """
    config = normalize_harness_agent_config(value)
    root = Path(base_dir).resolve()
    tools = _load_many(config["tools"], root)
    subagents = _load_many(config["subagents"], root, invoke=True)
    plugins = _load_many(config["plugins"], root)
    stores = _load_many(config["memoryStores"], root)
    sandbox = _load_optional(config["sandbox"], root)
    model = _load_optional(config["modelModule"], root)
    interventions = _load_many(config["interventionModules"], root)
    agent_config_modules = {
        key: _load_reference(reference, root) for key, reference in config["agentConfigModules"].items()
    }
    kwargs = deepcopy(config["agentConfig"])
    kwargs.update(agent_config_modules)
    kwargs.update(
        {
            "name": config["name"],
            "model": config["model"] if model is None else model,
            "effort": config["effort"],
            "context_manager": config["contextManager"],
            "session": _session_kwarg(config["session"], root),
            "skills": _skills_kwarg(config["skills"], root),
            "memory": _memory_kwarg(config["memory"], stores, root),
        }
    )
    builtin_tools = _builtin_tools_kwarg(config["builtinTools"], root)
    if builtin_tools is not None:
        kwargs["builtin_tools"] = builtin_tools
    if not config["caching"]:
        kwargs["caching"] = False
    if config["builtinPlugins"] != list(defaults.DEFAULT_BUILTIN_PLUGINS):
        kwargs["builtin_plugins"] = config["builtinPlugins"]
    if config["description"]:
        kwargs["description"] = config["description"]
    if config["instructions"]:
        kwargs["instructions"] = config["instructions"]
    # Specialist agents declared as ``subagents`` module refs are wired like any tool: each is exposed
    # via ``Agent.as_tool()`` and appended to ``tools`` (the harness has no separate subagents param).
    tools = [*tools, *(agent.as_tool() for agent in subagents)]
    if tools:
        kwargs["tools"] = tools
    if config["mcpServers"]:
        kwargs["mcp_servers"] = _python_mcp_servers(
            _expand_env(_resolve_mcp_working_directories(_mcp_server_map(config["mcpServers"], root), root))
        )
    if plugins:
        kwargs["plugins"] = plugins
    configured_interventions = (
        config["interventions"]
        if isinstance(config["interventions"], list)
        else [config["interventions"]]
        if config["interventions"]
        else []
    )
    intervention_values = [
        _resolve_path(value.strip(), root) if value.strip().endswith(".cedar") else value
        for value in configured_interventions
    ]
    intervention_values.extend(interventions)
    if intervention_values:
        kwargs["interventions"] = intervention_values[0] if len(intervention_values) == 1 else intervention_values
    if sandbox is not None:
        kwargs["sandbox"] = sandbox
    return kwargs


def _one_of(message: str, *branches: tuple[type | Callable[[object], bool], Any]) -> Any:
    """Union of ``branches``, picked by input shape (a type or a predicate); no match raises ``message``.

    Hand-rolled because pydantic's unions report a failed value once per member and tag error paths with the
    member's name (``session.SessionConfig.id``); a callable ``Discriminator`` still leaks its tag and warns on
    dump. ``SkipValidation`` on the union itself keeps the matched branch validated exactly once.
    """
    adapters = [(shape, TypeAdapter(annotation)) for shape, annotation in branches]

    def validate(value: object) -> object:
        for shape, adapter in adapters:
            if isinstance(value, shape) if isinstance(shape, type) else shape(value):
                return adapter.validate_python(value, strict=True)
        raise PydanticCustomError("shape", message)

    union = reduce(operator.or_, (annotation for _, annotation in branches))
    return Annotated[union, SkipValidation, BeforeValidator(validate)]


def _non_blank_str(message: str = "Input should be a non-empty string") -> Any:
    def validate(value: str) -> str:
        if not value.strip():
            raise PydanticCustomError("string_blank", message)
        return value

    return Annotated[str, AfterValidator(validate)]


def _record(value: Any) -> Any:
    """``dict[str, value]`` whose keys are non-blank, reported against the record rather than the key."""

    def check_keys(record: object) -> object:
        if isinstance(record, dict):
            for key in record:
                if not isinstance(key, str) or not key.strip():
                    raise PydanticCustomError(
                        "dict_key_blank", "Object keys should be non-empty strings, got {key}", {"key": repr(key)}
                    )
        return record

    return Annotated[dict[str, value], BeforeValidator(check_keys)]


def _single_line(value: str) -> str:
    if "\n" in value or "\r" in value:
        raise PydanticCustomError("string_multiline", "Input should not contain line breaks")
    return value


def _off_is_false(value: str) -> str | bool:
    return False if value == "off" else value


def _unique(items: list[Any]) -> list[Any]:
    if len(set(items)) != len(items):
        raise PydanticCustomError("unique_list", "List items should be unique")
    return items


def _positive_number(value: object) -> object:
    if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0):
        raise PydanticCustomError("positive_number", "Input should be a positive number or null")
    return value


NonBlankStr = _non_blank_str()
_UNIQUE = AfterValidator(_unique)
_UNSET: Any = None
"""Unset marker for optional keys that must not be explicit null; dumps use ``exclude_unset``."""


class _Model(BaseModel):
    """JSON object in ``config.json``: camelCase keys, no unknown keys, no type coercion.

    Optional keys default to ``_UNSET`` (dumps use ``exclude_unset``); only fields typed ``| None`` accept an
    explicit null.
    """

    model_config = ConfigDict(alias_generator=to_camel, extra="forbid", strict=True, allow_inf_nan=False)


class _JsonObject(RootModel[dict[str, JsonValue]]):
    model_config = ConfigDict(strict=True, allow_inf_nan=False)


class _ModuleRef(_Model):
    """``{kind, module, export?, language?, files?, dependency?}`` pointing at an importable value.

    ``kind`` is filled in by ``_reference`` from the field holding the reference; other keys pass through unchanged.
    """

    model_config = ConfigDict(alias_generator=to_camel, extra="allow", strict=True, allow_inf_nan=False)
    __pydantic_extra__: dict[str, JsonValue]

    kind: str | None = None
    module: NonBlankStr
    export: NonBlankStr = _UNSET
    language: Literal["python", "typescript"] = _UNSET
    files: list[NonBlankStr] = _UNSET
    dependency: NonBlankStr = _UNSET


def _reference(kind: str) -> Any:
    """A ``_ModuleRef`` object whose ``kind`` defaults to, and must be, ``kind``."""

    def expect_kind(reference: _ModuleRef) -> _ModuleRef:
        if "kind" not in reference.model_fields_set:
            reference.kind = kind
        elif reference.kind != kind:
            raise PydanticCustomError("kind", f"Input should be '{kind}'")
        return reference

    return _one_of(
        "Input should be a module reference object", (dict, Annotated[_ModuleRef, AfterValidator(expect_kind)])
    )


_ModelReference = _reference("model")


class _ReadConfig(_Model):
    media: bool = _UNSET


class _ShellConfig(_Model):
    description: NonBlankStr = _UNSET


class _WebFetchConfig(_Model):
    model: _one_of(
        "Input should be a non-empty string or a model module reference", (str, NonBlankStr), (dict, _ModelReference)
    ) = _UNSET
    transport: WebFetchTransport = _UNSET


class _ProgrammaticToolCallerConfig(_Model):
    allowed_tools: list[NonBlankStr] | None = None
    timeout: Annotated[int | float | None, BeforeValidator(_positive_number)] = None


class _SubagentConfig(_Model):
    max_depth: Annotated[int, Field(ge=0)] = _UNSET


_BUILTIN_TOOL_CONFIGS: dict[str, type[_Model]] = {
    "read": _ReadConfig,
    "shell": _ShellConfig,
    "web_fetch": _WebFetchConfig,
    "programmatic_tool_caller": _ProgrammaticToolCallerConfig,
    "subagent": _SubagentConfig,
}
"""Built-ins that take a config object as their ``builtinTools`` value; every other built-in is bool-only."""


def _bool_or(config: type[_Model]) -> Any:
    keys = ", ".join(field.alias or name for name, field in config.model_fields.items())
    return _one_of(f"Input should be a boolean or an object with optional {keys}", (bool, bool), (dict, config))


class _BuiltinToolsMap(BaseModel):
    """``builtinTools`` as edits to the default set: ``"*"`` picks the starting set, each tool a bool or config."""

    model_config = ConfigDict(extra="forbid", strict=True)

    all_tools: bool = Field(default=_UNSET, alias="*")
    shell: _bool_or(_ShellConfig) = _UNSET
    read: bool = _UNSET
    write: bool = _UNSET
    edit: bool = _UNSET
    web_fetch: _bool_or(_WebFetchConfig) = _UNSET
    web_search: _one_of(
        "Input should be a boolean or 'exa'", (bool, bool), (lambda value: value == "exa", Literal["exa"])
    ) = _UNSET
    programmatic_tool_caller: _bool_or(_ProgrammaticToolCallerConfig) = _UNSET
    subagent: _bool_or(_SubagentConfig) = _UNSET


class _SessionConfig(_Model):
    id: NonBlankStr = _UNSET
    dir: NonBlankStr = _UNSET


class _MemoryConfig(_Model):
    dir: NonBlankStr = _UNSET


class _Dependencies(BaseModel):
    """``{typescript: {package: version}, python: [requirement]}``; a missing half defaults to empty."""

    model_config = ConfigDict(strict=True)

    typescript: _record(NonBlankStr)
    python: Annotated[list[Annotated[NonBlankStr, AfterValidator(_single_line)]], _UNIQUE]

    @model_validator(mode="before")
    @classmethod
    def _fill_halves(cls, value: object) -> object:
        return {"typescript": {}, "python": [], **value} if isinstance(value, dict) else value


_MCP_SERVERS_SHAPE = "Input should be an object or a non-empty file path"


class _HarnessAgentConfig(_Model):
    """``DEFAULT_HARNESS_AGENT_CONFIG`` as a schema; every key is required because defaults are merged first."""

    name: NonBlankStr
    description: str
    instructions: str
    model: NonBlankStr
    model_module: _ModelReference | None
    effort: Effort
    tools: list[_reference("tool")]
    subagents: list[_reference("subagent")]
    mcp_servers: _one_of(_MCP_SERVERS_SHAPE, (dict, _JsonObject), (str, _non_blank_str(_MCP_SERVERS_SHAPE)))
    builtin_tools: _one_of(
        "Input should be an array of tool names or an object of per-tool settings",
        (list, Annotated[list[BuiltinToolName], _UNIQUE]),
        (dict, _BuiltinToolsMap),
    )
    caching: bool
    context_manager: _one_of(
        "Input should be one of 'auto', 'agentic', 'off'; false; or a config object",
        (str, Annotated[Literal["auto", "agentic", "off"], AfterValidator(_off_is_false)]),
        (lambda value: value is False, Literal[False]),
        (dict, _JsonObject),
    )
    session: _one_of(
        "Input should be a boolean or an object with optional id and dir", (bool, bool), (dict, _SessionConfig)
    )
    skills: _one_of(
        "Input should be a boolean, a path, or an array of paths",
        (bool, bool),
        (str, NonBlankStr),
        (list, Annotated[list[NonBlankStr], _UNIQUE]),
    )
    memory: _one_of("Input should be a boolean or an object with an optional dir", (bool, bool), (dict, _MemoryConfig))
    memory_stores: list[_reference("memory-store")]
    plugins: list[_reference("plugin")]
    builtin_plugins: Annotated[list[BuiltinPluginName], _UNIQUE]
    interventions: _one_of(
        "Input should be a string, an array of strings, or null",
        (str, NonBlankStr),
        (list, list[NonBlankStr]),
        (type(None), None),
    )
    intervention_modules: list[_reference("intervention")]
    sandbox: _reference("sandbox") | None
    agent_config_modules: _record(_reference("agent-config"))
    dependencies: _Dependencies
    agent_config: _JsonObject


def _builtin_tools_kwarg(value: list[str] | dict[str, Any], root: Path) -> list[str] | dict[str, Any] | None:
    if isinstance(value, list):
        # The portable default spells out today's set; leave it to the factory so the mapping stays "defaults".
        return None if value == list(defaults.DEFAULT_BUILTIN_TOOLS) else list(value)
    resolved: dict[str, Any] = {}
    for name, setting in value.items():
        if isinstance(setting, dict):
            fields = {field.alias or key: key for key, field in _BUILTIN_TOOL_CONFIGS[name].model_fields.items()}
            setting = {fields[key]: item for key, item in setting.items()}
            if isinstance(setting.get("model"), dict):
                setting["model"] = _load_reference(setting["model"], root)
        resolved[name] = setting
    return resolved


def _session_kwarg(value: bool | dict[str, Any], root: Path) -> bool | dict[str, Any]:
    if isinstance(value, bool):
        return value
    session = dict(value)
    if "dir" in session:
        session["dir"] = _resolve_path(session["dir"], root)
    return session


def _skills_kwarg(value: bool | str | list[str], root: Path) -> bool | str | list[str]:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return _resolve_skill_source(value, root)
    return [_resolve_skill_source(item, root) for item in value]


def _resolve_skill_source(value: str, root: Path) -> str:
    return value if value.startswith(("http://", "https://")) else _resolve_path(value, root)


def _memory_kwarg(value: bool | dict[str, Any], stores: list[Any], root: Path) -> bool | dict[str, Any]:
    if value is False:
        return False
    memory: dict[str, Any] = {} if value is True else dict(value)
    if "dir" in memory:
        memory["dir"] = _resolve_path(memory["dir"], root)
    if stores:
        memory["stores"] = stores
    return memory or True


def _load_many(references: list[dict[str, Any]], root: Path, *, invoke: bool = False) -> list[Any]:
    values: list[Any] = []
    for reference in references:
        value = _load_reference(reference, root)
        if invoke and callable(value):
            value = value()
        values.extend(value if isinstance(value, list) else [value])
    return values


def _load_optional(reference: dict[str, Any] | None, root: Path) -> Any:
    return None if reference is None else _load_reference(reference, root)


def _load_reference(reference: dict[str, Any], root: Path) -> Any:
    if reference.get("language") == "typescript" or Path(reference["module"]).suffix in {
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".ts",
        ".tsx",
    }:
        raise ValueError(f"Cannot load TypeScript module {reference['module']!r} in the Python runtime.")
    module_name = reference["module"]
    module = _load_module(module_name, root)
    export = reference.get("export", "default")
    if export == "default" and not hasattr(module, "default"):
        export = "agent" if reference.get("kind") == "subagent" and hasattr(module, "agent") else export
    if not hasattr(module, export):
        raise ValueError(f"Module {module_name!r} does not export {export!r}.")
    return getattr(module, export)


def _load_module(module: str, root: Path) -> ModuleType:
    if module.startswith(".") or os.path.isabs(module):
        path = Path(_resolve_path(module, root)).resolve()
        if path.is_dir():
            path /= "__init__.py"
        package = path.parent.parent if path.name == "__init__.py" else path.parent
        if (package / "__init__.py").is_file():
            parent = _load_module(str(package / "__init__.py"), root)
            name = path.parent.name if path.name == "__init__.py" else path.stem
            return importlib.import_module(f"{parent.__name__}.{name}")
        # Private package names isolate projects without shadowing installed packages.
        name = f"_strands_project_{abs(hash(path))}"
        if name in sys.modules:
            return sys.modules[name]
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ValueError(f"Cannot load Python module {module!r}.")
        loaded = importlib.util.module_from_spec(spec)
        sys.modules[name] = loaded
        try:
            spec.loader.exec_module(loaded)
        except BaseException:
            sys.modules.pop(name, None)
            raise
        return loaded
    return importlib.import_module(module)


def _resolve_path(value: str, root: Path) -> str:
    path = Path(value).expanduser()
    return str(path if path.is_absolute() else root / path)


def _expand_env(value: Any) -> Any:
    if isinstance(value, str):

        def replace(match: re.Match[str]) -> str:
            name = match.group(1)
            resolved = os.environ.get(name)
            if resolved is None:
                raise ValueError(f"Environment variable {json.dumps(name)} is not set.")
            return resolved

        return re.sub(
            r"\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}",
            replace,
            value,
        )
    if isinstance(value, list):
        return [_expand_env(item) for item in value]
    if isinstance(value, dict):
        return {key: _expand_env(item) for key, item in value.items()}
    return value


def _python_mcp_servers(servers: dict[str, Any]) -> dict[str, Any]:
    renamed = {
        "continueOnError": "continue_on_error",
        "toolFilters": "tool_filters",
        "clientId": "client_id",
        "clientSecret": "client_secret",
    }

    def convert(value: Any) -> Any:
        if isinstance(value, list):
            return [convert(item) for item in value]
        if isinstance(value, dict):
            if "tasksConfig" in value:
                raise ValueError("The Python harness does not support MCP tasksConfig.")
            return {renamed.get(key, key): convert(item) for key, item in value.items()}
        return value

    return convert(servers)


def _resolve_mcp_working_directories(servers: dict[str, Any], root: Path) -> dict[str, Any]:
    resolved: dict[str, Any] = {}
    for name, server in servers.items():
        if not isinstance(server, dict) or not isinstance(server.get("command"), str):
            resolved[name] = server
            continue
        configured = server.get("cwd")
        resolved[name] = {
            **server,
            "cwd": _resolve_path(configured, root) if isinstance(configured, str) else str(root),
        }
    return resolved


def _mcp_server_map(value: dict[str, Any] | str, root: Path) -> dict[str, Any]:
    if isinstance(value, str):
        path = Path(_resolve_path(value, root))
        try:
            loaded = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"MCP config {value!r} must be valid JSON.") from error
        if not isinstance(loaded, dict):
            raise ValueError(f"MCP config {value!r} must contain a server map.")
        value = loaded
    nested = value.get("mcpServers")
    if nested is None:
        return value
    if not isinstance(nested, dict):
        raise ValueError("mcpServers must contain a server map.")
    return nested
