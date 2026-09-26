"""End-to-end tests: a real agent runs a turn against a live model.

Prompts tell the agent plainly it's being tested and which tools to use, then we assert from the
conversation that each tool actually ran and succeeded (``tool_succeeded``) — or, for features that
aren't tools (environment injection, sessions), that the answer reflects them. The built-in tools
are exercised in a single turn rather than one live invocation per tool; only features that need a
differently-configured agent (interventions, sessions, environment) get their own test.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

from strands import Agent
from strands.vended_interventions.hitl import HumanInTheLoop

Build = Callable[..., Agent]
Check = Callable[[Agent, str], bool]

_TESTING = "You are an automated integration test. Do exactly what is asked and nothing else."

# For the multi-step tool test: the agent tends to batch parallel tool calls and quietly drop the
# ones that feel trivial (reading a file, say). This is a test whose whole point is that every tool
# fires, so the system prompt spells out that no step may be skipped, merged, or substituted.
_TEST_INSTRUCTIONS = (
    "You are running inside an automated integration test whose only purpose is to confirm that every "
    "tool works. You MUST complete every numbered step, one at a time and in order. You may NOT skip a "
    "step, combine or batch steps into parallel tool calls, or substitute one tool for another (do not "
    "use one tool to do another step's job). For each step, call the exact tool it names, wait for the "
    "result, then move on. Do nothing that isn't asked."
)


async def test_shell_tool(build_agent: Build, tool_succeeded: Check) -> None:
    # Shell is tested on its own so it isn't in the combined agent below: with shell available the
    # model substitutes it (`cat`/redirect) for the read/write/edit tools, which we want to force.
    agent = build_agent()
    result = await agent.invoke_async(f"{_TESTING} Use the shell tool to run `echo hi` and report its output.")
    assert tool_succeeded(agent, "shell")
    assert "hi" in str(result)


async def test_builtin_tools_all_work(
    work_dir: Path,
    build_agent: Build,
    tool_succeeded: Check,
    tool_result_contains: Callable[[Agent, str, str], bool],
) -> None:
    """One turn on a fully-loaded agent that exercises the file/web tools, the todos plugin, the
    ``subagent`` delegation tool, and an MCP server — instead of a separate live invocation per
    tool. Shell is left out so the file tools are the only way to satisfy the read/write/edit
    steps (see above)."""
    data, out, edit = work_dir / "data.txt", work_dir / "out.txt", work_dir / "edit.txt"
    data.write_text("The secret code is 4271.\n")
    edit.write_text("alpha\n")
    agent = build_agent(
        builtin_tools=["read", "write", "edit", "web_fetch", "subagent"],
        builtin_plugins=["todos", "environment"],
        mcp_servers={"docs": {"command": "strands-agents-mcp-server"}},
        instructions=_TEST_INSTRUCTIONS,
    )
    result = await agent.invoke_async(
        "This is an automated integration test. There are 7 steps below. You MUST perform every single "
        "one, in order, each with its own separate tool call — do not skip any, do not do them in "
        "parallel, do not use a different tool than the one named. After all 7, stop.\n"
        f"Step 1 — call the `read` tool on {data}, then tell me the secret code it contains.\n"
        f"Step 2 — call the `write` tool to create {out} whose entire contents are that secret code.\n"
        f"Step 3 — call the `edit` tool to replace alpha with omega in {edit}.\n"
        "Step 4 — call the `web_fetch` tool on https://example.com and report its title.\n"
        "Step 5 — call the `todo_write` tool to record a two-item todo list.\n"
        "Step 6 — call the `subagent` tool, asking it to compute 111 + 222, and report the result.\n"
        'Step 7 — call the `docs_search_docs` tool to search the Strands docs for "agents" and report one result.\n'
        "That is all 7 steps. Each of the 7 tools must be called exactly once."
    )
    # The MCP tool is namespaced by its server key ("docs"), so search_docs is exposed as docs_search_docs.
    for name in ("read", "write", "edit", "web_fetch", "todo_write", "subagent", "docs_search_docs"):
        assert tool_succeeded(agent, name), f"{name} was not used successfully"
    # Beyond "the tool ran", assert each tool's effect: read returned the file's contents and the
    # subagent's delivered answer reached the parent (it runs in the background, so the value
    # lands in the final result, not the immediate tool result), and write/edit landed on disk.
    assert tool_result_contains(agent, "read", "4271")
    assert "333" in str(result)
    assert "4271" in out.read_text()
    assert "omega" in edit.read_text()


async def test_subagent_result_is_delivered(
    build_agent: Build,
    tool_succeeded: Check,
) -> None:
    agent = build_agent(builtin_plugins=["todos"])
    # Ensure everyTurn injection and subagent delegation are exercised together.
    agent.state.set(
        "todos",
        [
            {
                "content": "Track the delegated calculation",
                "activeForm": "Tracking the delegated calculation",
                "status": "in_progress",
            }
        ],
    )
    result = await agent.invoke_async(
        f"{_TESTING} Call the subagent tool exactly once to compute 111 + 222, then stop."
    )
    assert tool_succeeded(agent, "subagent")
    assert "333" in str(result)


async def test_environment_context_is_injected(work_dir: Path, build_agent: Build) -> None:
    # With no tools, the only way the agent can know this marker is the environment plugin injecting
    # the working directory's AGENTS.md into the turn.
    (work_dir / "AGENTS.md").write_text("Project note: the integration codeword is ZEBRAFISH.\n")
    agent = build_agent(builtin_tools=[], builtin_plugins=["environment"])
    result = await agent.invoke_async(f"{_TESTING} What is the integration codeword mentioned in this project?")
    assert "ZEBRAFISH" in str(result)


async def test_interventions_deny_blocks_the_tool(
    work_dir: Path, build_agent: Build, tool_succeeded: Check, tool_attempted: Check
) -> None:
    # A HumanInTheLoop that answers "no" to every approval; the write must be attempted (so we know
    # the gate ran, not that the model just skipped it) but must never take effect.
    deny = HumanInTheLoop(ask=lambda _prompt, **_kw: False)
    agent = build_agent(interventions=[deny])
    blocked = work_dir / "blocked.txt"
    await agent.invoke_async(f"{_TESTING} Use the write tool to create the file {blocked} containing: nope.")
    assert tool_attempted(agent, "write")
    assert not tool_succeeded(agent, "write")
    assert not blocked.exists()


async def test_interventions_approve_allows_the_tool(work_dir: Path, build_agent: Build, tool_succeeded: Check) -> None:
    # The mirror of the deny test: a HumanInTheLoop that answers "yes" must let the tool through.
    allow = HumanInTheLoop(ask=lambda _prompt, **_kw: True)
    agent = build_agent(interventions=[allow])
    allowed = work_dir / "allowed.txt"
    await agent.invoke_async(f"{_TESTING} Use the write tool to create the file {allowed} containing: yes.")
    assert tool_succeeded(agent, "write")
    assert allowed.exists()


async def test_sessions_persist_across_agents(work_dir: Path, build_agent: Build) -> None:
    # Two separate agents sharing a session id: the second must recall what the first was told,
    # proving the conversation is persisted and rehydrated.
    first = build_agent(session={"id": "integ-session"})
    await first.invoke_async(f"{_TESTING} Remember this codeword for later: MARMALADE. Just acknowledge.")
    second = build_agent(session={"id": "integ-session"})
    result = await second.invoke_async(f"{_TESTING} What codeword did I ask you to remember?")
    assert "MARMALADE" in str(result)


async def test_session_persists_with_minted_id(work_dir: Path, build_agent: Build) -> None:
    # The default-on behavior: a session with no id mints an 8-hex one and writes its snapshot under
    # session_dir after a single turn. The snapshot on disk is the deterministic side effect.
    session_dir = work_dir / "sessions"
    agent = build_agent(session={"dir": str(session_dir)})
    await agent.invoke_async(f"{_TESTING} Say hi in one word.")
    assert list(session_dir.rglob("snapshot_latest.json"))
    minted = [path.name for path in session_dir.rglob("*") if path.is_dir() and re.fullmatch(r"[0-9a-f]{8}", path.name)]
    assert len(minted) == 1


async def test_memory_persists_across_agents(work_dir: Path, build_agent: Build) -> None:
    # Memory is independent of sessions: a fresh agent with no shared session, only the same memory
    # dir, recalls a durable fact. Extraction runs on a 5-turn interval, so flush() forces the write
    # rather than driving five turns; the .md file on disk is the deterministic side effect.
    memory_dir = work_dir / "memory"
    first = build_agent(memory={"dir": str(memory_dir)})
    await first.invoke_async(f"{_TESTING} Remember this durable fact about me: my favorite fruit is TANGERINE.")
    await first.memory_manager.flush()
    distilled = "\n".join(path.read_text() for path in memory_dir.glob("*.md"))
    assert "TANGERINE" in distilled

    second = build_agent(memory={"dir": str(memory_dir)})
    result = await second.invoke_async(f"{_TESTING} What is my favorite fruit?")
    assert "TANGERINE" in str(result)
