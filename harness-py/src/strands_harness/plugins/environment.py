"""EnvironmentContext: surface the working environment and project docs to the model.

Before each user turn an internal ``ContextInjector`` re-surfaces a small block: the platform and
current date (the date is why this is injected rather than baked into the system prompt — a value
that changes each turn would bust the cached system-prompt prefix, whereas an ephemeral injection
lands after it and leaves the cache warm), the working directory, the contents of the project's
``AGENTS.md``, and links to other ``AGENTS.md`` / ``README.md`` files found a couple of levels down
(links, not contents, so the block stays small — the agent reads them on demand).

Everything is read through the agent's ``sandbox`` seam (the same one the file tools use), so it works
against a local, Docker, or SSH sandbox. Discovery (the directory walk and cwd) is done once and
memoized per agent; only the date is recomputed each turn, so the per-turn cost is negligible.
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING, Any

from strands.plugins import Plugin
from strands.vended_plugins.context_injector import ContextInjector, InjectionContext

if TYPE_CHECKING:
    from strands import Agent

_DEFAULT_NAME = "strands:environment"

# How many directory levels below the working directory to scan for nearby AGENTS.md / README.md.
_DISCOVERY_DEPTH = 2

# AGENTS.md is injected in full up to this size; longer files are truncated with a marker so a large
# doc can't dominate every turn's context (the agent can still ``read`` the whole file).
_AGENTS_MD_CAP = 16_000

# Directories skipped during discovery: dependency/build/VCS trees that hold no project AGENTS.md and
# would make the walk slow and the link list noisy. Hidden directories (``.`` prefix) are skipped too.
_SKIP_DIRS = frozenset({"node_modules", "dist", "build", "target", "__pycache__", "venv", "site-packages", "vendor"})

# Filenames collected during discovery and surfaced as nearby links.
_DISCOVERED_FILES = ("AGENTS.md", "README.md")


class EnvironmentContext(Plugin):
    """Injects working-environment and project-doc context before each user turn.

    Reads through the agent's ``sandbox``, so it honors whatever sandbox the agent runs against.
    Sharing one instance across agents is safe: the captured agent and memoized discovery are scoped
    per ``init_agent`` call, not stored on the plugin.

    Args:
        name: Plugin name, for logging and duplicate detection. Defaults to ``"strands:environment"``.
    """

    def __init__(self, *, name: str = _DEFAULT_NAME) -> None:
        self._name = name
        super().__init__()

    @property
    def name(self) -> str:
        return self._name

    def init_agent(self, agent: Agent) -> None:
        """Register the environment-context injector, scoped to this agent."""
        memo: dict[str, Any] = {}

        async def render(_context: InjectionContext) -> str | None:
            return await _render(agent, memo)

        ContextInjector(render, name=f"{self._name}:injector", trigger="userTurn").init_agent(agent)


async def _render(agent: Agent, memo: dict[str, Any]) -> str | None:
    if "gathered" not in memo:
        memo["gathered"] = await _gather(agent)
    platform, cwd, agents_md, other_agents, readmes = memo["gathered"]

    env = []
    if platform:
        env.append(f"Platform: {platform}")
    env.append(f"Date: {date.today().isoformat()}")
    if cwd:
        env.append(f"Working directory: {cwd}")
    sections = ["<environment>\n" + "\n".join(env) + "\n</environment>"]
    if agents_md:
        sections.append(f"<AGENTS.md>\n{agents_md}\n</AGENTS.md>")
    if other_agents:
        sections.append("Other AGENTS.md files nearby (read as needed): " + ", ".join(other_agents))
    if readmes:
        sections.append("README files nearby (read as needed): " + ", ".join(readmes))

    return "<system-reminder>\n" + "\n\n".join(sections) + "\n</system-reminder>"


async def _gather(agent: Agent) -> tuple[str | None, str | None, str | None, list[str], list[str]]:
    """The one-time, memoized part: platform, working directory, cwd ``AGENTS.md``, and nearby links.

    Platform and cwd are read from the sandbox (via ``uname``/``pwd``), not the host process, so they
    describe where the agent actually runs — a Docker or SSH sandbox, not the machine hosting it.
    """
    try:
        sandbox = agent.sandbox
    except Exception:
        # Defensive: normally a default local sandbox is present, but if the getter has none to fall
        # back to, still surface the date block without probing the environment.
        return None, None, None, [], []
    platform = await _probe(sandbox, "uname -s")
    cwd = await _probe(sandbox, "pwd")
    agents_md = await _read_text(sandbox, "AGENTS.md")
    found = await _discover(sandbox)
    # The working-directory AGENTS.md is shown in full above; keep only the nested ones as links.
    other_agents = [p for p in found["AGENTS.md"] if p != "AGENTS.md"]
    return platform, cwd, agents_md, other_agents, found["README.md"]


async def _probe(sandbox: Any, command: str) -> str | None:
    """Run a one-line probe command in the sandbox; return its first stdout line, or ``None``."""
    try:
        result = await sandbox.execute(command)
    except Exception:
        return None
    if result.exit_code == 0 and result.stdout.strip():
        return result.stdout.strip().splitlines()[0]
    return None


async def _read_text(sandbox: Any, path: str) -> str | None:
    try:
        text = await sandbox.read_text(path)
    except Exception:
        return None
    if len(text) > _AGENTS_MD_CAP:
        return text[:_AGENTS_MD_CAP] + "\n… (truncated — read the full file if you need the rest)"
    return text


async def _discover(sandbox: Any) -> dict[str, list[str]]:
    """Walk up to ``_DISCOVERY_DEPTH`` levels from the working directory, collecting the paths of each
    ``_DISCOVERED_FILES`` name (skipping dependency/build/hidden directories)."""
    found: dict[str, list[str]] = {name: [] for name in _DISCOVERED_FILES}

    async def visit(rel: str, depth: int) -> None:
        try:
            entries = await sandbox.list_files(rel or ".")
        except Exception:
            return
        for entry in entries:
            path = f"{rel}/{entry.name}" if rel else entry.name
            if entry.is_dir:
                if depth < _DISCOVERY_DEPTH and entry.name not in _SKIP_DIRS and not entry.name.startswith("."):
                    await visit(path, depth + 1)
            elif entry.name in found:
                found[entry.name].append(path)

    await visit("", 0)
    return found
