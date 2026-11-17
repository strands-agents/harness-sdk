"""Execute an authored Python agent; only terminal commands cross the process boundary."""

import ast
import asyncio
import base64
import contextlib
import importlib
import importlib.abc
import importlib.machinery
import importlib.util
import inspect
import json
import os
import re
import sys
import threading
import tokenize
import weakref
from pathlib import Path
from typing import Literal
from uuid import uuid4

import strands_harness
from strands import Agent, tool
from strands.hooks import HookOrder
from strands.hooks.events import BeforeModelCallEvent, BeforeToolCallEvent
from strands.models import Model
from strands.middleware import InvokeModelStage
from strands.session import FileSessionManager, S3SessionManager, SnapshotSessionManager
from strands.storage import InMemoryStorage, LocalFileStorage, S3Storage
from strands.storage import storage as storage_types
from strands.tools.mcp import MCPClient
from strands.types.tools import ToolContext
from strands.vended_memory_stores.file_memory_store import FileMemoryStore
from strands.vended_plugins.context_offloader import ContextOffloader
from strands.vended_plugins.context_offloader import storage as offloader_storage
from strands.vended_plugins.skills import AgentSkills
from strands_harness import define_harness_agent_config, harness_agent_kwargs_from_config
from strands_harness.defaults import DEFAULT_MODEL

channel = os.fdopen(3, "w", buffering=1)
commands = os.fdopen(4, encoding="utf-8")
pending_permissions = {}
COMPACT_PRESERVE_RECENT_MESSAGES = 2
MAX_SAFE_INTEGER = 9_007_199_254_740_991


def encode(value):
    if isinstance(value, bytes):
        return {"$bytes": base64.b64encode(value).decode("ascii")}
    raise TypeError(f"Cannot send {type(value).__name__} to the terminal")


def decode(value):
    if set(value) == {"$bytes"}:
        return base64.b64decode(value["$bytes"])
    return value


def send(message):
    channel.write(json.dumps(message, default=encode) + "\n")


def emit(event):
    send({"type": "event", "event": event})


def compacted_tokens(reported, estimated_before, estimated_after):
    """Offline token estimates can overcount the system prompt and tool specs by a wide margin, so a
    model-reported size minus the estimated reduction tracks the next reported size more closely."""
    if reported is None or estimated_before is None or estimated_after is None:
        return estimated_after
    return max(0, reported - max(0, estimated_before - estimated_after))


async def estimate_context_categories(context):
    system = context.system_prompt
    estimates = {
        "systemPrompt": await Model.count_tokens(
            context.model,
            [],
            system_prompt=system if isinstance(system, str) else None,
            system_prompt_content=system if isinstance(system, list) else None,
        ),
        "tools": await Model.count_tokens(context.model, [], tool_specs=context.tool_specs),
    }
    grouped = {kind: [] for kind in ("userMessages", "assistantMessages", "toolResults", "injectedContext")}
    last_user = next(
        (index for index in range(len(context.messages) - 1, -1, -1) if context.messages[index]["role"] == "user"),
        -1,
    )
    trailing = max(0, getattr(context, "dynamic_trailing_blocks", 0))
    for index, message in enumerate(context.messages):
        content = message["content"]
        for block_index, block in enumerate(content):
            if index == last_user and block_index >= len(content) - trailing:
                kind = "injectedContext"
            elif "toolResult" in block:
                kind = "toolResults"
            else:
                kind = "assistantMessages" if message["role"] == "assistant" else "userMessages"
            grouped[kind].append({"role": message["role"], "content": [block]})
    for kind, messages in grouped.items():
        estimates[kind] = await Model.count_tokens(context.model, messages)
    return estimates


def context_breakdown(estimates, current_tokens, projected_tokens):
    if estimates is None or any(
        type(value) is not int or value < 0 or value > MAX_SAFE_INTEGER
        for value in (current_tokens, projected_tokens, *estimates.values())
    ):
        return None
    if projected_tokens < current_tokens:
        return None
    total = sum(estimates.values())
    tokens = {
        kind: value * current_tokens // total if total > current_tokens else value
        for kind, value in estimates.items()
    }
    tokens["other"] = current_tokens - sum(tokens.values())
    tokens["assistantMessages"] += projected_tokens - current_tokens
    return {"categories": [{"kind": kind, "tokens": value} for kind, value in tokens.items() if value > 0]}


def context_model_usage(usage):
    if not isinstance(usage, dict) or any(key not in usage for key in ("inputTokens", "outputTokens", "totalTokens")):
        return None
    numeric = {
        key: usage.get(key, 0)
        for key in ("inputTokens", "outputTokens", "totalTokens", "cacheReadInputTokens", "cacheWriteInputTokens")
    }
    if any(type(value) is not int or value < 0 or value > MAX_SAFE_INTEGER for value in numeric.values()):
        return None
    return numeric if any(numeric.values()) else None


async def authorize_tool(event):
    tool_use = event.tool_use
    if tool_use["name"] == "strands_config":
        return
    request = {
        "type": "authorize",
        "name": tool_use["name"],
        "input": tool_use.get("input", {}),
        "pathInWorkspace": False,
    }
    path = tool_use.get("input", {}).get("path")
    if isinstance(path, str):
        try:
            resolved = Path(path).resolve()
            request["pathInWorkspace"] = resolved.is_relative_to(Path.cwd().resolve())
            if tool_use["name"] in ("write", "edit"):
                request["before"] = await event.agent.sandbox.read_text(path)
        except FileNotFoundError:
            if tool_use["name"] == "write":
                request["before"] = ""
        except Exception:
            pass
    approved = await permission(request)
    if not approved:
        event.cancel_tool = "DENIED: Tool call denied by the user"


async def permission(request):
    request_id = request.get("id", str(uuid4()))
    future = asyncio.get_running_loop().create_future()
    pending_permissions[request_id] = future
    try:
        send({**request, "id": request_id})
        return await future
    finally:
        pending_permissions.pop(request_id, None)


def merge_assigned_option(authored, converted, paths, path):
    if any(path == assigned or path.startswith(assigned + ".") for assigned in paths) or not isinstance(converted, dict):
        return converted
    if path == "builtinTools" and isinstance(authored, list):
        authored = {"*": False, **dict.fromkeys(authored, True)}
    merged: dict[str, object] = dict(authored) if isinstance(authored, dict) else {}
    for name in {assigned[len(path) + 1:].split(".")[0] for assigned in paths if assigned.startswith(path + ".")}:
        key = name if name in converted else re.sub(r"[A-Z]", lambda match: "_" + match[0].lower(), name)
        merged[key] = merge_assigned_option(merged.get(key), converted.get(key), paths, f"{path}.{name}")
    return merged


def overrides_from_config(partial, authored, assignments):
    if not partial:
        return {}
    config = define_harness_agent_config(partial)
    options = harness_agent_kwargs_from_config(config)
    # These values are normally omitted by the config loader when equal to defaults.
    for key in ("builtinTools", "builtinPlugins", "caching", "description", "instructions"):
        if key in partial:
            options.setdefault(re.sub(r"[A-Z]", lambda match: "_" + match[0].lower(), key), config[key])
    aliases = {
        "subagents": "tools",
        "modelModule": "model",
        "memoryStores": "memory",
        "interventionModules": "interventions",
    }
    keys = {aliases.get(key, re.sub(r"[A-Z]", lambda match: "_" + match[0].lower(), key)) for key in partial}
    keys.update(partial.get("agentConfig", {}))
    keys.update(partial.get("agentConfigModules", {}))
    for key, empty in {"tools": [], "plugins": [], "mcp_servers": {}, "interventions": None, "sandbox": None}.items():
        if key in keys:
            options.setdefault(key, empty)
    paths = [assignment.split("=", 1)[0] for assignment in assignments]
    for field in partial:
        if field in aliases or field == "agentConfigModules":
            continue
        fields = partial[field] if field == "agentConfig" else [field]
        for name in fields:
            path = f"agentConfig.{name}" if field == "agentConfig" else name
            key = name if field == "agentConfig" else re.sub(r"[A-Z]", lambda match: "_" + match[0].lower(), name)
            if key in partial.get("agentConfigModules", {}) or any(
                alias in partial and option == key for alias, option in aliases.items()
            ):
                continue
            if not any(assigned.startswith(path + ".") for assigned in paths):
                continue
            value = authored.get(key)
            if key == "mcp_servers" and isinstance(value, str):
                with open(value) as source:
                    document = json.load(source)
                value = document.get("mcpServers", document)
            options[key] = merge_assigned_option(value, options.get(key), paths, path)
    return {
        key: options[key]
        for key in keys
        if key in options and key not in ("agent_config", "agent_config_modules", "dependencies")
    }


def display_content(block):
    if "text" in block:
        return {"type": "text", "text": block["text"]}
    if "json" in block:
        return {"type": "json", "value": block["json"]}
    for kind in ("image", "document"):
        if kind in block:
            media = block[kind]
            source = media["source"]
            source_type = next(iter(source))
            return {
                "type": kind,
                **{key: value for key, value in media.items() if key != "source"},
                "source": {"type": source_type, source_type: source[source_type]},
            }
    return {"type": "text", "text": str(block)}


def display_messages(agent):
    messages = []
    for message in agent.messages:
        blocks = []
        for block in message["content"]:
            if "text" in block or "toolUse" in block:
                blocks.append(block)
            elif "toolResult" in block:
                result = block["toolResult"]
                blocks.append(
                    {
                        "toolResult": {
                            **result,
                            "content": [
                                value if "text" in value or "json" in value else {"text": "[media]"}
                                for value in result.get("content", [])
                            ],
                        }
                    }
                )
        if blocks:
            messages.append({"role": message["role"], "content": blocks})
    return messages


def local_storage_paths(storage):
    parts = []
    while isinstance(storage, getattr(storage_types, "_NamespacedStorage", ())):
        prefix = getattr(storage, "_prefix", None)
        if not isinstance(prefix, str):
            return None
        parts.insert(0, prefix)
        storage = getattr(storage, "_storage", None)
    if isinstance(storage, LocalFileStorage):
        directory = getattr(storage, "base_dir", None)
    elif isinstance(storage, offloader_storage.FileStorage):
        directory = getattr(storage, "_artifact_dir", None)
    elif isinstance(storage, (InMemoryStorage, S3Storage, offloader_storage.InMemoryStorage, offloader_storage.S3Storage)):
        return []
    else:
        return None
    if not isinstance(directory, (str, os.PathLike)):
        return None
    return [str(Path(os.fsdecode(directory), *parts).resolve())]


def agent_stash(agent):
    return getattr(getattr(agent, "context_manager", None), "stash", None)


def agent_private_paths(agent):
    """None disables export and watching when private storage cannot be identified."""
    paths = []
    storages = []
    manager = getattr(agent, "_session_manager", None)
    if isinstance(manager, SnapshotSessionManager):
        storages.append(getattr(manager, "_storage", None))
    elif isinstance(manager, FileSessionManager):
        directory = getattr(manager, "storage_dir", None)
        if not isinstance(directory, (str, os.PathLike)):
            return None
        paths.append(str(Path(os.fsdecode(directory)).resolve()))
    elif manager is not None and not isinstance(manager, S3SessionManager):
        return None

    stash = agent_stash(agent)
    if stash is not None:
        base_storage = getattr(stash, "_base_storage", None)
        storage = getattr(stash, "_storage", None)
        base_paths = local_storage_paths(base_storage)
        if base_paths is None or local_storage_paths(storage) is None:
            return None
        if storage is base_storage:
            paths.extend(base_paths)
        elif isinstance(storage, getattr(storage_types, "_NamespacedStorage", ())):
            namespace = getattr(storage, "_prefix", None)
            if not isinstance(namespace, str) or not namespace:
                return None
            # Exclude every session's stash, not just this agent's.
            paths.extend(str(Path(path, namespace.split("/")[0])) for path in base_paths)
        else:
            return None

    plugins = getattr(getattr(agent, "_plugin_registry", None), "_plugins", None)
    if not isinstance(plugins, dict):
        return None
    storages.extend(getattr(plugin, "_storage", None) for plugin in plugins.values() if isinstance(plugin, ContextOffloader))
    memory = getattr(agent, "memory_manager", None)
    if memory is not None:
        stores = getattr(memory, "_stores", None)
        if not isinstance(stores, (list, tuple)):
            return None
        for store in stores:
            if isinstance(store, FileMemoryStore):
                storages.append(getattr(store, "_storage", None))
            else:
                try:
                    from strands.vended_memory_stores.bedrock_knowledge_base import BedrockKnowledgeBaseStore
                except ImportError:
                    return None
                if not isinstance(store, BedrockKnowledgeBaseStore):
                    return None
    for storage in storages:
        local = local_storage_paths(storage)
        if local is None:
            return None
        paths.extend(local)
    return list(dict.fromkeys(paths))


def runtime_options(authored, command):
    partial = command.get("overrides", {})
    options = overrides_from_config(partial, authored, command.get("assignments", []))
    flags = command.get("configFlags", {})
    for key in ("session", "memory"):
        if flags.get(key) == "off":
            options[key] = False
        elif flags.get(key) == "on":
            value = options.get(key, authored.get(key))
            options[key] = True if value is None or value is False else value
        elif flags.get(key) is not None:
            raise ValueError(f"--{key} must be 'on' or 'off'.")
    directory = command.get("stateDirectory")
    if directory:
        for key in ("session", "memory"):
            value = options.get(key, authored.get(key, True))
            manager = options.get(f"{key}_manager", authored.get(f"{key}_manager"))
            custom = (
                manager is not None
                or (value is not None and not isinstance(value, (bool, dict)))
                or (key == "memory" and isinstance(value, dict) and bool(value.get("stores")))
            )
            if custom:
                if command.get("relocateState"):
                    raise ValueError(f"--state-dir cannot relocate a custom {key} store.")
                continue
            if value is False or value is None:
                continue
            if key == "session" and command.get("relocateState") and options.get("storage", authored.get("storage")) is not None:
                raise ValueError("--state-dir cannot relocate custom agent storage.")
            configured = value if isinstance(value, dict) else {}
            if command.get("relocateState") or "dir" not in configured:
                options[key] = {
                    **configured, "dir": str(Path(directory) / ("sessions" if key == "session" else "memory"))
                }
    return options


class Runtime:
    def __init__(self, module, command):
        self.module = module
        authored = getattr(module, "_strands_options", {})
        self.options = runtime_options(authored, command)
        self.append_instructions = command.get("appendInstructions")
        self.instruction_agents = weakref.WeakSet()
        flags = command.get("configFlags", {})
        session = self.options.get("session", authored.get("session", True))
        if flags.get("sessionId") is not None and (session is True or isinstance(session, dict)):
            self.options["session"] = {**(session if isinstance(session, dict) else {}), "id": flags["sessionId"]}
        self.explicit_option_keys = set(self.options)
        model = self.options.get("model", authored.get("model"))
        if model is None and hasattr(module, "_strands_options"):
            model = DEFAULT_MODEL
        self.source_configuration = (
            {"model": model, "thinking": self.options.get("effort", authored.get("effort", "auto"))}
            if isinstance(model, str)
            else None
        )
        selection = command.get("sourceSelection")
        if (
            self.source_configuration
            and selection
            and selection["source"] == module.__file__
            and selection["configured"] == self.source_configuration
        ):
            for field, option in (("model", "model"), ("thinking", "effort")):
                if selection["selected"][field] != self.source_configuration[field]:
                    self.options[option] = selection["selected"][field]
                    self.explicit_option_keys.add(option)
        session = self.options.get("session", authored.get("session", True))
        session_options = session if isinstance(session, dict) else {}
        self.session_configuration = {
            "sessionId": session_options.get("id"),
            "sessionDir": str(session_options.get("dir", ".agent/sessions")),
        }
        restoration = command.get("restoreSession")
        if restoration and (session is True or isinstance(session, dict)):
            identity = restoration["identity"]
            if restoration["preserve"] or identity["configured"] == self.session_configuration:
                session_options = {
                    "id": identity["sessionId"],
                    "dir": str(Path(identity["sessionDirectory"]).parent),
                }
                self.options["session"] = session_options
                self.explicit_option_keys.add("session")
        if "sessionId" in command and (session is True or isinstance(session, dict)):
            self.options["session"] = {
                **session_options,
                "id": command["sessionId"],
                **(
                    {"dir": str(Path(command["sessionStorageDirectory"]).parent)}
                    if "sessionStorageDirectory" in command
                    else {}
                ),
                **({"dir": str(Path(command["sessionDir"]).parent)} if "sessionDir" in command else {}),
            }
            self.explicit_option_keys.add("session")
        if command.get("relocateState") and isinstance(self.options.get("session"), dict):
            expected = Path(command["stateDirectory"]) / "sessions"
            if Path(self.options["session"]["dir"]).resolve() != expected.resolve():
                raise ValueError("This session is outside --state-dir. Resume a session stored in the selected directory.")
        self.agent: Agent
        self.initial_agent = module.agent
        self.factory = getattr(module, "create_agent", None)
        self.interactive = command.get("interactive", False)
        self.mcp_servers = command.get("mcpServers", {})
        self.skill_paths = command.get("skillPaths", []) if self.options.get("skills", authored.get("skills", True)) else []
        self.cancel_signal = threading.Event()
        self.reload_requested = False
        self.context_estimates = None
        self.context_usage = None

    async def build(self, options, snapshot=None, *, resume=False):
        previous = getattr(self, "agent", self.initial_agent)
        factory_options = {key: options[key] for key in self.explicit_option_keys if key in options}
        if self.initial_agent is not None and not factory_options:
            candidate = self.initial_agent
            self.initial_agent = None
        else:
            if not callable(self.factory):
                raise ValueError(
                    "This source exports an agent instance but not create_agent(**overrides), "
                    "and is not a direct agent = create_harness(...) definition; recreation controls are unavailable."
                )
            manager = getattr(previous, "memory_manager", None)
            if manager:
                await manager.flush()
            self.initial_agent = None
            candidate = self.factory(**factory_options)
        if inspect.isawaitable(candidate):
            candidate = await candidate
        if not isinstance(candidate, Agent):
            raise TypeError("create_harness() must return a Strands Agent")
        try:
            if resume:
                manager = candidate._session_manager
                if not isinstance(manager, SnapshotSessionManager) or not await manager.restore_snapshot(candidate):
                    raise ValueError("No saved Python session was found for this agent.")
            await self.augment(candidate)
            if snapshot:
                candidate.load_snapshot(snapshot)
            await self.save(candidate)
        except Exception:
            await self.cleanup(candidate)
            raise
        self.agent = candidate
        self.options = options
        self.reported_context_tokens = None
        if previous is not None and previous is not candidate:
            await self.cleanup(previous)

    async def augment(self, agent):
        if self.append_instructions and agent not in self.instruction_agents:
            self.instruction_agents.add(agent)
            async def append_instructions(context):
                prompt = context.system_prompt
                text = self.append_instructions
                return context.replace(system_prompt=(
                    [*prompt, {"text": text}] if isinstance(prompt, list)
                    else "\n\n".join(part for part in (prompt, text) if part)
                ))
            agent.add_middleware(InvokeModelStage.Input, append_instructions)
        if self.interactive:
            agent.hooks.add_callback(BeforeToolCallEvent, authorize_tool, order=HookOrder.INTERVENTION_INPUT)
            if not any(spec["name"] == "strands_config" for spec in agent.tool_registry.get_all_tool_specs()):
                agent.tool_registry.process_tools([self.configuration_tool()])
        if self.mcp_servers:
            existing = {getattr(provider, "client_name", None) for provider in agent.tool_registry._tool_providers}
            servers = {name: value for name, value in self.mcp_servers.items() if name not in existing}
            if servers:
                agent.tool_registry.process_tools(
                    MCPClient.load_servers(
                        servers,
                        continue_on_error=True,
                        prefix_with_server_name=True,
                    )
                )
        if self.skill_paths:
            skills = next(
                (plugin for plugin in agent._plugin_registry._plugins.values() if isinstance(plugin, AgentSkills)),
                None,
            )
            if skills:
                authored_skills = {skill.name: skill for skill in skills.get_available_skills(agent)}
                skills.set_available_skills([*authored_skills.values(), *self.skill_paths])
                await skills.init_agent(agent)
                # Merge resolved skills: the SDK loads filesystem paths after Skill instances.
                skills.set_available_skills(
                    [authored_skills.get(skill.name, skill) for skill in skills.get_available_skills(agent)]
                )
            else:
                agent._plugin_registry.add_and_init(AgentSkills(skills=self.skill_paths))
        self.attach_context_capture(agent)

    def attach_context_capture(self, agent):
        # Python exposes effective model requests only through the optional middleware registry.
        try:
            from strands.middleware import InvokeModelStage
        except ImportError:
            try:
                from strands._middleware import InvokeModelStage
            except ImportError:
                return
        registry = getattr(agent, "_middleware_registry", None)
        add_middleware = getattr(agent, "add_middleware", None) or getattr(registry, "add_middleware", None)
        handlers_by_stage = getattr(registry, "_handlers", None)
        if not callable(add_middleware) or not isinstance(handlers_by_stage, dict):
            return
        capture_ready = False

        def prepare(event):
            nonlocal capture_ready
            if event.agent is not agent:
                return
            self.context_estimates = None
            self.context_usage = None
            capture_ready = False
            handlers = handlers_by_stage.get(InvokeModelStage)
            if not isinstance(handlers, list):
                return
            # Hooks can register request transforms, so observe after every other Wrap handler.
            for index, handler in enumerate(handlers):
                if getattr(handler, "handler", None) is capture:
                    handlers.append(handlers.pop(index))
                    capture_ready = True
                    break

        async def capture(context, next_handler):
            estimates = None
            if context.agent is agent:
                self.context_estimates = None
                self.context_usage = None
                if capture_ready:
                    with contextlib.suppress(Exception):
                        handlers = handlers_by_stage.get(InvokeModelStage)
                        if isinstance(handlers, list) and getattr(handlers[-1], "handler", None) is capture:
                            estimates = await estimate_context_categories(context)
            async for event in next_handler(context):
                if context.agent is agent and "stop" in event:
                    self.context_usage = context_model_usage(event["stop"][2])
                    self.context_estimates = estimates if self.context_usage is not None else None
                yield event

        add_middleware(InvokeModelStage, capture)
        agent.hooks.add_callback(BeforeModelCallEvent, prepare, order=HookOrder.SDK_LAST)

    def configuration_tool(self):
        runtime = self

        @tool(name="strands_config")
        def strands_config(action: Literal["inspect", "apply"], revision: int | None = None) -> str:
            """Inspect this source-backed agent or apply source edits by reloading it after the current turn.

            Args:
                action: Inspect the active source or apply edits made to it.
                revision: The revision returned by inspect; required when applying.
            """
            if action == "inspect":
                return json.dumps(
                    {
                        "revision": 0,
                        "target": {"source": runtime.module.__file__},
                        "runtime": {
                            "name": runtime.agent.name,
                            "model": runtime.agent.model.get_config().get("model_id"),
                            "tools": [spec["name"] for spec in runtime.agent.tool_registry.get_all_tool_specs()],
                        },
                    }
                )
            if revision != 0:
                raise ValueError("Inspect the source before applying it, then pass revision 0.")
            runtime.reload_requested = True
            return (
                "Source reload requested. Reload pending until this turn finishes; the conversation will be preserved."
            )

        return strands_config

    async def cleanup(self, agent):
        with contextlib.suppress(Exception):
            await agent.shutdown_async()
        with contextlib.suppress(Exception):
            agent.cleanup()

    async def save(self, agent=None):
        agent = self.agent if agent is None else agent
        manager = agent._session_manager
        if isinstance(manager, SnapshotSessionManager):
            await manager.save_snapshot(agent, is_latest=True)

    def skills(self):
        return next(
            (plugin for plugin in self.agent._plugin_registry._plugins.values() if isinstance(plugin, AgentSkills)),
            None,
        )

    def state(self):
        model = self.options.get("model")
        model_specifier = self.options.get(
            "model", self.source_configuration["model"] if self.source_configuration else None
        )
        thinking = self.options.get(
            "effort", self.source_configuration["thinking"] if self.source_configuration else "auto"
        )
        if not isinstance(model, str):
            model = str(self.agent.model.get_config().get("model_id", type(self.agent.model).__name__))
        manager = self.agent._session_manager
        session_id = manager.session_id if isinstance(manager, SnapshotSessionManager) else None
        storage = getattr(manager, "_storage", None) if isinstance(manager, SnapshotSessionManager) else None
        session_paths = local_storage_paths(storage)
        session_directory = session_paths[0] if session_paths else None
        managed_session = session_directory is not None
        skills = self.skills()
        active = skills.get_activated_skills(self.agent) if skills else []
        return {
            "name": self.agent.name or "Agent",
            "reconstructable": callable(self.factory),
            "description": self.agent.description or "",
            "model": model,
            **({"modelSpecifier": model_specifier} if isinstance(model_specifier, str) else {}),
            "thinking": thinking,
            **(
                {
                    "sourceSelection": {
                        "source": self.module.__file__,
                        "configured": self.source_configuration,
                        "selected": {
                            "model": model_specifier,
                            "thinking": thinking,
                        },
                    }
                }
                if self.source_configuration
                else {}
            ),
            **({"sessionId": session_id} if session_id else {}),
            "sessionDirectory": session_directory or str(Path(self.session_configuration["sessionDir"]).resolve()),
            **(
                {
                    "session": {
                        "sessionId": session_id,
                        "sessionDirectory": session_directory,
                        "workspace": str(Path.cwd()),
                        "configured": self.session_configuration,
                    }
                }
                if managed_session
                else {}
            ),
            "messages": display_messages(self.agent),
            "privatePaths": agent_private_paths(self.agent),
            "tools": [
                {"name": spec["name"], "description": spec.get("description", "")}
                for spec in self.agent.tool_registry.get_all_tool_specs()
            ],
            "skills": [
                {
                    "name": skill.name,
                    "description": skill.description,
                    "instructions": skill.instructions,
                    "active": skill.name in active,
                }
                for skill in skills.get_available_skills(self.agent)
            ]
            if skills
            else [],
        }

    def result(self, result, *, reload=False):
        send({"type": "result", "result": result, "state": self.state(), "reload": reload})

    async def estimate_context_tokens(self):
        try:
            return await self.agent.model.count_tokens(
                self.agent.messages,
                tool_specs=self.agent.tool_registry.get_all_tool_specs(),
                system_prompt=self.agent.system_prompt,
                system_prompt_content=self.agent.system_prompt_content,
            )
        except Exception:
            # The meter stays empty until the next model response reports usage.
            return None

    async def compact(self):
        from strands.agent.conversation_manager import SummarizingConversationManager

        if len(self.agent.messages) <= COMPACT_PRESERVE_RECENT_MESSAGES:
            return None
        before = [id(message) for message in self.agent.messages]
        estimated_before = await self.estimate_context_tokens()
        manager = SummarizingConversationManager(
            summary_ratio=0.8, preserve_recent_messages=COMPACT_PRESERVE_RECENT_MESSAGES
        )
        await asyncio.to_thread(manager.reduce_context, self.agent)
        # A proactive reduce_context logs summarization failures instead of raising.
        if [id(message) for message in self.agent.messages] == before:
            raise RuntimeError("The model did not return a usable summary. Try /compact again.")
        await self.save()
        self.reported_context_tokens = compacted_tokens(
            self.reported_context_tokens, estimated_before, await self.estimate_context_tokens()
        )
        context = {
            "currentTokens": self.reported_context_tokens,
            "contextWindow": self.agent.model.context_window_limit,
        }
        return {key: value for key, value in context.items() if value is not None}

    async def turn(self, prompt):
        self.cancel_signal.clear()
        self.reload_requested = False
        self.context_estimates = None
        self.context_usage = None
        snapshot = self.agent.take_snapshot(preset="session")
        emitted_tool_results = set()
        try:
            while True:
                result = None
                async for event in self.agent.stream_async(prompt, cancel_signal=self.cancel_signal):
                    if isinstance(event.get("data"), str):
                        emit({"type": "textDelta", "text": event["data"]})
                    if event.get("reasoningText"):
                        emit({"type": "reasoningDelta", "text": event["reasoningText"]})
                    tool_results = [event["tool_result"]] if event.get("tool_result") else []
                    for block in event.get("message", {}).get("content", []):
                        if "toolUse" in block:
                            emit({"type": "toolStart", **block["toolUse"]})
                        elif "toolResult" in block:
                            tool_results.append(block["toolResult"])
                        elif "image" in block or "document" in block:
                            emit({"type": "media", "content": display_content(block)})
                    for tool_result in tool_results:
                        if tool_result["toolUseId"] in emitted_tool_results:
                            continue
                        emitted_tool_results.add(tool_result["toolUseId"])
                        emit(
                            {
                                "type": "toolResult",
                                "toolUseId": tool_result["toolUseId"],
                                "status": tool_result["status"],
                                "content": [display_content(block) for block in tool_result.get("content", [])],
                            }
                        )
                    if "result" in event:
                        result = event["result"]
                if result is None:
                    raise RuntimeError("The Python agent finished without a result")
                if result.stop_reason != "interrupt" or not result.interrupts:
                    self.reported_context_tokens = (
                        result.projected_context_size
                        if result.projected_context_size is not None
                        else result.context_size
                    )
                    context = {
                        "currentTokens": result.context_size,
                        "projectedTokens": result.projected_context_size,
                        "contextWindow": self.agent.model.context_window_limit,
                    }
                    invocations = getattr(result.metrics, "agent_invocations", [])
                    cycles = getattr(invocations[-1], "cycles", []) if invocations else []
                    latest_usage = context_model_usage(getattr(cycles[-1], "usage", None)) if cycles else None
                    breakdown = context_breakdown(
                        self.context_estimates if self.context_usage == latest_usage else None,
                        result.context_size,
                        result.projected_context_size,
                    )
                    if breakdown is not None:
                        context["breakdown"] = breakdown
                    self.result(
                        {
                            "stopReason": result.stop_reason,
                            "finalText": str(result),
                            "context": {key: value for key, value in context.items() if value is not None},
                            "usage": {
                                "cacheReadInputTokens": 0,
                                "cacheWriteInputTokens": 0,
                                **result.metrics.accumulated_usage,
                            },
                        },
                        reload=self.reload_requested and not self.cancel_signal.is_set(),
                    )
                    return
                prompt = []
                for interrupt in result.interrupts:
                    future = asyncio.get_running_loop().create_future()
                    pending_permissions[interrupt.id] = future
                    try:
                        emit(
                            {
                                "type": "permission",
                                "request": {
                                    "id": interrupt.id,
                                    "toolName": interrupt.name,
                                    "input": interrupt.reason,
                                    "options": [
                                        {"id": "allow", "label": "Allow", "kind": "allow_once"},
                                        {"id": "deny", "label": "Deny", "kind": "reject_once"},
                                    ],
                                },
                            }
                        )
                        approved = await future
                        prompt.append({"interruptResponse": {"interruptId": interrupt.id, "response": approved}})
                    finally:
                        pending_permissions.pop(interrupt.id, None)
        except asyncio.CancelledError:
            self.result({"stopReason": "cancelled"})
        except Exception as error:
            try:
                self.agent.load_snapshot(snapshot)
                await self.save()
            except Exception as rollback_error:
                send({"type": "error", "message": f"{error}; could not restore session: {rollback_error}"})
                return
            send({"type": "error", "message": str(error)})
        finally:
            self.reload_requested = False

    async def command(self, command):
        kind = command["type"]
        if kind == "conversation":
            from strands.types import Snapshot

            snapshot = command.get("snapshot")
            if snapshot:
                data = snapshot["data"]
                if not command.get("preserveReasoning"):
                    for message in data["messages"]:
                        message["content"] = [block for block in message["content"] if "reasoningContent" not in block]
                    data["messages"] = [message for message in data["messages"] if message["content"]]
                self.agent.load_snapshot(
                    Snapshot(scope="agent", schema_version=snapshot["schemaVersion"], data=data, app_data={})
                )
                await self.save()
                self.result({"stopReason": "restored"})
            else:
                manager = getattr(self.agent, "memory_manager", None)
                if manager:
                    await manager.flush()
                snapshot = self.agent.take_snapshot(include=["messages", "state", "conversation_manager_state"])
                self.result(
                    {
                        "stopReason": "snapshot",
                        "finalText": json.dumps(
                            {
                                "scope": snapshot.scope,
                                "schemaVersion": snapshot.schema_version,
                                "createdAt": snapshot.created_at,
                                "data": snapshot.data,
                                "appData": {},
                            },
                            default=encode,
                        ),
                    }
                )
        elif kind == "reload-failed":
            self.agent.messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "text": (
                                "The harness setup result: source reload failed. "
                                "The previous agent remains active.\n"
                                f"Reason: {command['message']}\n"
                                "Correct the source and use strands_config apply to retry."
                            )
                        }
                    ],
                }
            )
            await self.save()
            self.result({"stopReason": "recorded"})
        elif kind == "snapshot":
            snapshot = self.agent.take_snapshot(preset="session").to_dict()
            self.result({"stopReason": "snapshot", "finalText": json.dumps(snapshot, default=encode)})
        elif kind == "stash":
            stash = agent_stash(self.agent)
            entries = await stash.take_snapshot() if stash is not None else {}
            self.result({"stopReason": "stash", "finalText": json.dumps(entries, default=encode)})
        elif kind == "seed":
            from strands.types import Snapshot

            self.agent.load_snapshot(Snapshot.from_dict(json.loads(command["snapshot"], object_hook=decode)))
            stash = agent_stash(self.agent)
            if stash is not None and command.get("stash"):
                # A fork has its own session id, so the refs in its copied messages resolve only against a
                # copy of the source's stash.
                await stash.load_snapshot(json.loads(command["stash"], object_hook=decode))
            await self.save()
            self.result({"stopReason": "seeded"})
        elif kind == "reset":
            options = dict(self.options)
            if "model" in command:
                options["model"] = command["model"]
                self.explicit_option_keys.add("model")
            if "thinking" in command:
                options["effort"] = command["thinking"]
                self.explicit_option_keys.add("effort")
            session = options.get("session", getattr(self.module, "_strands_options", {}).get("session", True))
            if "sessionId" in command and (session is True or isinstance(session, dict)):
                options["session"] = {**(session if isinstance(session, dict) else {}), "id": command["sessionId"]}
                self.explicit_option_keys.add("session")
            snapshot = None if command.get("clear") else self.agent.take_snapshot(preset="session")
            await self.build(options, snapshot)
            self.result({"stopReason": "reset"})
        elif kind == "compact":
            context = await self.compact()
            if context is None:
                self.result({"stopReason": "unchanged"})
            else:
                self.result({"stopReason": "compacted", "context": context})
        elif kind == "skill":
            skills = self.skills()
            if not skills:
                raise ValueError("This agent has no skills")
            content = await skills.skills(
                skill_name=command["name"],
                tool_context=ToolContext(
                    tool_use={"toolUseId": str(uuid4()), "name": "skills", "input": {}},
                    agent=self.agent,
                    invocation_state={},
                ),
            )
            await self.save()
            self.result({"stopReason": "activated", "finalText": content})
        else:
            raise ValueError(f"Unknown terminal command: {kind}")


class ProjectSourceLoader(importlib.machinery.SourceFileLoader):
    def get_code(self, fullname):
        # Same-size edits within one second can leave timestamp-based bytecode valid.
        return self.source_to_code(self.get_data(self.path), self.path)


class ProjectImports(importlib.abc.MetaPathFinder):
    def __init__(self, root):
        self.root = root

    def find_spec(self, fullname, path=None, target=None):
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec is not None and isinstance(spec.loader, importlib.machinery.SourceFileLoader):
            source = Path(spec.loader.path).resolve()
            if source.is_relative_to(self.root) and ".venv" not in source.relative_to(self.root).parts:
                spec.loader = ProjectSourceLoader(fullname, str(source))
                return spec


def direct_harness_assignment(entrypoint):
    with tokenize.open(entrypoint) as source:
        tree = ast.parse(source.read(), filename=str(entrypoint))
    return any(
        isinstance(node, (ast.Assign, ast.AnnAssign))
        and (
            any(isinstance(target, ast.Name) and target.id == "agent" for target in node.targets)
            if isinstance(node, ast.Assign)
            else isinstance(node.target, ast.Name) and node.target.id == "agent"
        )
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Name)
        and node.value.func.id == "create_harness"
        for node in tree.body
    )


def load_project(entrypoint, root, command):
    sys.meta_path.insert(0, ProjectImports(root))
    sys.path[:0] = [str(root), str(entrypoint.parent)]
    relative = entrypoint.relative_to(root)
    module_parts = list(relative.with_suffix("").parts)
    if module_parts[-1] == "__init__":
        module_parts.pop()
    packaged = bool(module_parts) and all(
        (root.joinpath(*module_parts[:index], "__init__.py")).is_file() for index in range(1, len(module_parts))
    )
    captured = []
    original_create_harness = strands_harness.create_harness

    def capture_create_harness(*args, **options):
        state = {key: command[key] for key in ("stateDirectory", "relocateState") if key in command}
        configured = {**options, **runtime_options(options, state)} if captured is not None else options
        agent = original_create_harness(*args, **configured)
        if captured is not None:
            captured.append((agent, args, options))
        return agent

    strands_harness.create_harness = capture_create_harness
    try:
        if packaged:
            module = importlib.import_module(".".join(module_parts))
        else:
            spec = importlib.util.spec_from_file_location(f"harness_project_agent_{uuid4().hex}", entrypoint)
            if spec is None or spec.loader is None:
                raise RuntimeError(f"Cannot load Python agent from {entrypoint}")
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
    finally:
        strands_harness.create_harness = original_create_harness
    agent = getattr(module, "agent", None)
    if not isinstance(agent, Agent):
        raise TypeError('Export a Strands Agent as "agent".')
    construction = next(((args, options) for candidate, args, options in captured if candidate is agent), None)
    captured = None
    if construction is not None:
        module._strands_options = construction[1]
    if not callable(getattr(module, "create_agent", None)) and direct_harness_assignment(entrypoint):
        if construction is not None:
            args, options = construction

            def create_agent(**overrides):
                return original_create_harness(*args, **{**options, **overrides})

            module.create_agent = create_agent
    return module


async def main():
    command = json.loads(await asyncio.to_thread(commands.readline))
    module = load_project(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), command)
    runtime = Runtime(module, command)
    await runtime.build(runtime.options, resume=command.get("resume", False))
    send({"type": "ready", "state": runtime.state()})
    running = None
    try:
        while line := await asyncio.to_thread(commands.readline):
            command = json.loads(line, object_hook=decode)
            kind = command["type"]
            if kind == "permission":
                future = pending_permissions.get(command["requestId"])
                if future and not future.done():
                    future.set_result(command["approved"])
            elif kind in ("cancel", "close"):
                runtime.cancel_signal.set()
                if running:
                    running.cancel()
                if kind == "close":
                    break
            elif running and not running.done():
                send({"type": "error", "message": "The Python agent is busy"})
            elif kind == "prompt":
                running = asyncio.create_task(runtime.turn(command["prompt"]))
            else:
                try:
                    await runtime.command(command)
                except Exception as error:
                    send({"type": "error", "message": str(error)})
            del command, line
    finally:
        if running and not running.done():
            running.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await running
        await runtime.cleanup(runtime.agent)


try:
    asyncio.run(main())
except Exception as error:
    send({"type": "error", "message": str(error)})
    sys.exit(1)
