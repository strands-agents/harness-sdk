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
from pathlib import Path
from typing import Literal
from uuid import uuid4

import strands_harness
from strands import Agent, tool
from strands.hooks import HookOrder
from strands.hooks.events import BeforeToolCallEvent
from strands.session import SnapshotSessionManager
from strands.storage import LocalFileStorage
from strands.tools.mcp import MCPClient
from strands.types.tools import ToolContext
from strands.vended_plugins.skills import AgentSkills
from strands_harness import define_harness_agent_config, harness_agent_kwargs_from_config
from strands_harness.defaults import DEFAULT_MODEL

channel = os.fdopen(3, "w", buffering=1)
pending_permissions = {}


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


def overrides_from_config(partial):
    if not partial:
        return {}
    config = define_harness_agent_config(partial)
    options = harness_agent_kwargs_from_config(config)
    # These values are normally omitted by the config loader when equal to defaults.
    for key in ("builtinTools", "builtinPlugins", "caching", "description", "instructions", "sessionId"):
        if key in partial:
            options[re.sub(r"[A-Z]", lambda match: "_" + match[0].lower(), key)] = config[key]
    aliases = {
        "subagents": "tools",
        "modelModule": "model",
        "webFetchModelModule": "web_fetch_model",
        "memoryStores": "memory_store",
        "interventionModules": "interventions",
    }
    keys = {aliases.get(key, re.sub(r"[A-Z]", lambda match: "_" + match[0].lower(), key)) for key in partial}
    keys.update(partial.get("agentConfig", {}))
    keys.update(partial.get("agentConfigModules", {}))
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


def local_session_directory(storage):
    parts = []
    while hasattr(storage, "_storage") and hasattr(storage, "_prefix"):
        parts.append(storage._prefix)
        storage = storage._storage
    if not isinstance(storage, LocalFileStorage):
        return None
    return str(Path(storage._base_dir, *parts).resolve())


class Runtime:
    def __init__(self, module, command):
        self.module = module
        partial = command.get("overrides", {})
        for assignment in command.get("assignments", []):
            path, raw = assignment.split("=", 1)
            keys = path.split(".")
            try:
                value = json.loads(raw)
            except ValueError:
                value = raw
            if len(keys) == 1:
                partial[keys[0]] = value
            else:
                target = partial.setdefault(keys[0], {})
                if not isinstance(target, dict):
                    target = {}
                    partial[keys[0]] = target
                for key in keys[1:-1]:
                    if not isinstance(target.get(key), dict):
                        target[key] = {}
                    target = target[key]
                target[keys[-1]] = value
        self.options = overrides_from_config(partial)
        for source, target in (("sessionId", "session_id"), ("sessionDir", "session_dir")):
            if source in command:
                self.options[target] = command[source]
        self.explicit_option_keys = set(self.options)
        model = self.options.get("model")
        self.source_configuration = (
            {"model": model, "thinking": self.options.get("effort", "auto")} if isinstance(model, str) else None
        )
        selection = command.get("sourceSelection")
        if (
            self.source_configuration
            and selection
            and selection["source"] == module.__file__
            and selection["configured"] == self.source_configuration
        ):
            self.options.update(
                model=selection["selected"]["model"],
                effort=selection["selected"]["thinking"],
            )
        self.session_configuration = {
            "sessionId": self.options.get("session_id"),
            "sessionDir": str(self.options.get("session_dir", ".agent/sessions")),
        }
        session_directory = command.get("sessionStorageDirectory")
        self.options["session_dir"] = str(Path(self.options.get("session_dir", ".agent/sessions")).resolve())
        self.session_directory = (
            str(Path(session_directory).resolve())
            if session_directory is not None
            else str(Path(self.options["session_dir"]) / "session")
        )
        self.agent: Agent
        self.initial_agent = module.agent
        self.factory = getattr(module, "create_agent", None)
        self.interactive = command.get("interactive", False)
        self.mcp_servers = command.get("mcpServers", {})
        self.skill_paths = command.get("skillPaths", [])
        self.cancel_signal = threading.Event()
        self.reload_requested = False

    async def build(self, options, snapshot=None):
        previous = getattr(self, "agent", self.initial_agent)
        factory_options = {key: options[key] for key in self.explicit_option_keys if key in options}
        if self.initial_agent is not None and not factory_options:
            candidate = self.initial_agent
            self.initial_agent = None
        else:
            self.initial_agent = None
            if not callable(self.factory):
                raise ValueError(
                    "This source exports an agent instance but not create_agent(**overrides), "
                    "and is not a direct agent = create_harness(...) definition; recreation controls are unavailable."
                )
            candidate = self.factory(**factory_options)
        if inspect.isawaitable(candidate):
            candidate = await candidate
        if not isinstance(candidate, Agent):
            raise TypeError("create_harness() must return a Strands Agent")
        try:
            await self.augment(candidate)
            if snapshot:
                candidate.load_snapshot(snapshot)
            await self.save(candidate)
        except Exception:
            await self.cleanup(candidate)
            raise
        self.agent = candidate
        self.options = options
        if previous is not None and previous is not candidate:
            await self.cleanup(previous)

    async def augment(self, agent):
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
                skills.set_available_skills([*skills.get_available_skills(agent), *self.skill_paths])
                await skills.init_agent(agent)
            else:
                agent._plugin_registry.add_and_init(AgentSkills(skills=self.skill_paths))

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
            return "Source reload validated. It will be applied after this turn, preserving the conversation."

        return strands_config

    async def cleanup(self, agent):
        manager = getattr(agent, "memory_manager", None)
        if manager:
            with contextlib.suppress(Exception):
                await manager.flush()
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
        if not isinstance(model, str):
            model = str(self.agent.model.get_config().get("model_id", type(self.agent.model).__name__))
        manager = self.agent._session_manager
        session_id = (
            manager.session_id if isinstance(manager, SnapshotSessionManager) else self.options.get("session_id")
        )
        storage = manager._storage if isinstance(manager, SnapshotSessionManager) else None
        session_directory = local_session_directory(storage)
        managed_session = session_directory is not None
        skills = self.skills()
        active = skills.get_activated_skills(self.agent) if skills else []
        return {
            "name": self.agent.name or "Agent",
            "reconstructable": callable(self.factory),
            "description": self.agent.description or "",
            "model": model,
            **({"modelSpecifier": self.options["model"]} if isinstance(self.options.get("model"), str) else {}),
            "thinking": self.options.get("effort", "auto"),
            **(
                {
                    "sourceSelection": {
                        "source": self.module.__file__,
                        "configured": self.source_configuration,
                        "selected": {
                            "model": self.options.get("model") or DEFAULT_MODEL,
                            "thinking": self.options.get("effort", "auto"),
                        },
                    }
                }
                if self.source_configuration
                else {}
            ),
            **({"sessionId": session_id} if session_id else {}),
            "sessionDirectory": session_directory or self.options["session_dir"],
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
            "privatePaths": [
                *([session_directory] if session_directory else []),
                str(Path(self.options.get("memory_dir", ".agent/memory")).resolve()),
            ],
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

    async def turn(self, prompt):
        self.cancel_signal.clear()
        self.reload_requested = False
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
                    context = {
                        "currentTokens": result.context_size,
                        "projectedTokens": result.projected_context_size,
                        "contextWindow": self.agent.model.context_window_limit,
                    }
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
            from strands.types._snapshot import Snapshot

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
        elif kind == "seed":
            from strands.types._snapshot import Snapshot

            self.agent.load_snapshot(Snapshot.from_dict(json.loads(command["snapshot"], object_hook=decode)))
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
            if "sessionId" in command and options.get("session", True):
                options["session_id"] = command["sessionId"]
                self.explicit_option_keys.add("session_id")
            snapshot = None if command.get("clear") else self.agent.take_snapshot(preset="session")
            await self.build(options, snapshot)
            self.result({"stopReason": "reset"})
        elif kind == "compact":
            from strands.agent.conversation_manager import SummarizingConversationManager

            manager = SummarizingConversationManager(summary_ratio=0.8, preserve_recent_messages=2)
            before = len(self.agent.messages)
            await asyncio.to_thread(manager.reduce_context, self.agent)
            await self.save()
            self.result({"stopReason": "compacted" if len(self.agent.messages) < before else "unchanged"})
        elif kind == "skill":
            skills = self.skills()
            if not skills:
                raise ValueError("This agent has no skills")
            await skills.skills(
                skill_name=command["name"],
                tool_context=ToolContext(
                    tool_use={"toolUseId": str(uuid4()), "name": "skills", "input": {}},
                    agent=self.agent,
                    invocation_state={},
                ),
            )
            await self.save()
            self.result({"stopReason": "activated"})
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


def load_project(entrypoint, root):
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
        agent = original_create_harness(*args, **options)
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
    if not callable(getattr(module, "create_agent", None)) and direct_harness_assignment(entrypoint):
        construction = next(((args, options) for candidate, args, options in captured if candidate is agent), None)
        if construction is not None:
            args, options = construction

            def create_agent(**overrides):
                return original_create_harness(*args, **{**options, **overrides})

            module.create_agent = create_agent
    return module


async def main():
    module = load_project(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
    command = json.loads(await asyncio.to_thread(sys.stdin.readline))
    runtime = Runtime(module, command)
    await runtime.build(runtime.options)
    send({"type": "ready", "state": runtime.state()})
    running = None
    try:
        while line := await asyncio.to_thread(sys.stdin.readline):
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
