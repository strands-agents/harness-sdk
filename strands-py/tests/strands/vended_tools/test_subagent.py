"""Tests for the subagent tool: schema derivation, context modes, interrupts, and safety."""

from types import SimpleNamespace

import pytest

from strands.agent.state import AgentState
from strands.multiagent.spec import Choice, Fixed, Inherit, Option, Preset
from strands.vended_tools.subagent import make_subagent
from strands.vended_tools.subagent.subagent import _CONTEXT_PREAMBLE, _DEPTH_STATE_KEY
from strands.vended_tools.subagent.types import GENERALIST


class _FakeResult:
    def __init__(self, text="done", stop_reason="end_turn", interrupts=None):
        self.text = text
        self.stop_reason = stop_reason
        self.interrupts = interrupts or []

    def __str__(self):
        return self.text


class _FakeChild:
    def __init__(self, *results, activated=False):
        self._results = list(results)
        self.messages: list = []
        self.prompts: list = []
        self.invocation_states: list = []
        self.cancel_signals: list = []
        self.state = AgentState()
        self._interrupt_state = SimpleNamespace(activated=activated, interrupts={})

    async def stream_async(self, prompt, invocation_state=None, cancel_signal=None):
        self.prompts.append(prompt)
        self.invocation_states.append(invocation_state)
        self.cancel_signals.append(cancel_signal)
        yield {"result": self._results.pop(0)}


async def _events(tool, raw_input, parent=None, **kwargs):
    tool_use = {"toolUseId": "t1", "name": "subagent", "input": raw_input}
    return [event async for event in tool.stream(tool_use, {"agent": parent}, **kwargs)]


def _result(events):
    return events[-1].tool_result


# -- Schema derivation -------------------------------------------------------


def test_axes_derive_expected_parameters():
    tool = make_subagent(
        builder=lambda spec: None,
        presets={},
        instructions=Choice(["concise", "verbose"]),
        model=Choice(["fast", "deep"]),
        context=Choice(["none", "all"]),
        tools=Choice(["read", "shell"], multiple=True),
        mcp_servers=Choice(["fs", "api"], multiple=True),
    )
    props = tool.tool_spec["inputSchema"]["json"]["properties"]
    assert set(props) == {
        "task",
        "instructions",
        "tools",
        "model",
        "context",
        "last_messages",
        "mcp_servers",
    }
    assert props["tools"]["items"]["enum"] == ["read", "shell"]
    assert props["model"]["enum"] == ["fast", "deep"]
    assert props["instructions"]["enum"] == ["concise", "verbose"]
    assert props["mcp_servers"]["items"]["enum"] == ["fs", "api"]
    assert props["last_messages"]["type"] == "integer"


def test_fixed_and_inherit_hide_parameters():
    tool = make_subagent(
        builder=lambda spec: None,
        presets={},
        instructions=Fixed("x"),
        tools=Inherit(),
        model=Inherit(),
        context=Fixed("none"),
    )
    assert set(tool.tool_spec["inputSchema"]["json"]["properties"]) == {"task"}


def test_presets_add_agent_type_parameter():
    tool = make_subagent(
        builder=lambda spec: None,
        presets={
            "generalist": GENERALIST,
            "reviewer": Preset(instructions="review", description="reviews diffs"),
        },
        default_preset="generalist",
        instructions=Fixed(None),
        tools=Fixed(None),
    )
    props = tool.tool_spec["inputSchema"]["json"]["properties"]
    assert props["agent_type"]["enum"] == ["generalist", "reviewer"]
    assert "reviews diffs" in tool.tool_spec["description"]
    # Description names the default preset.
    assert "generalist" in props["agent_type"]["description"]


@pytest.mark.parametrize(
    "axis,match",
    [
        ({"tools": Choice([])}, "offers no options"),
        ({"tools": Choice(["read", "shell"])}, "must be multiple"),
        ({"mcp_servers": Choice([])}, "offers no options"),
        ({"mcp_servers": Choice(["fs"])}, "must be multiple"),
    ],
)
def test_invalid_choice_raises(axis, match):
    with pytest.raises(ValueError, match=match):
        make_subagent(builder=lambda spec: None, **axis)


@pytest.mark.parametrize("kwargs", [{"name": ""}, {"description": ""}, {"max_depth": 0}, {"max_depth": -1}])
def test_make_subagent_rejects_invalid_args(kwargs):
    with pytest.raises(ValueError):
        make_subagent(builder=lambda spec: None, **kwargs)


# -- Run & resolution --------------------------------------------------------


@pytest.mark.asyncio
async def test_run_builds_child_and_returns_output():
    captured = {}

    def builder(spec):
        captured["spec"] = spec
        return _FakeChild(_FakeResult("the answer"))

    tool = make_subagent(builder=builder, presets={"generalist": GENERALIST})
    result = _result(await _events(tool, {"task": "do it"}))
    assert result["status"] == "success"
    assert result["content"][0]["text"] == "the answer"
    assert captured["spec"].instructions == GENERALIST.instructions


@pytest.mark.asyncio
async def test_tools_choice_maps_option_values():
    captured = {}

    def builder(spec):
        captured["spec"] = spec
        return _FakeChild(_FakeResult())

    tool = make_subagent(
        builder=builder,
        tools=Choice([Option("readonly", "read"), Option("sh", "shell")], multiple=True),
    )
    await _events(tool, {"task": "x", "tools": ["readonly"]})
    assert captured["spec"].tools == ["read"]


@pytest.mark.asyncio
async def test_tools_clamped_and_coerced():
    """Off-enum tools are dropped; scalar and non-list types are coerced."""
    captured = {}

    def builder(spec):
        captured["spec"] = spec
        return _FakeChild(_FakeResult())

    tool = make_subagent(builder=builder, tools=Choice(["read", "shell"], multiple=True))
    await _events(tool, {"task": "x", "tools": ["read", "write"]})
    assert captured["spec"].tools == ["read"]
    await _events(tool, {"task": "x", "tools": "read"})
    assert captured["spec"].tools == ["read"]
    await _events(tool, {"task": "x", "tools": 123})
    assert captured["spec"].tools == []


@pytest.mark.asyncio
async def test_fixed_axis_ignores_model_value():
    captured = {}

    def builder(spec):
        captured["spec"] = spec
        return _FakeChild(_FakeResult())

    tool = make_subagent(builder=builder, presets={}, instructions=Fixed("pinned"), context=Fixed("none"))
    await _events(tool, {"task": "x", "instructions": "override", "context": "all"})
    assert captured["spec"].instructions == "pinned"
    assert tool._resolve_context({"context": "all"})[0] == "none"


@pytest.mark.asyncio
async def test_off_schema_agent_type_rejected():
    tool = make_subagent(
        builder=lambda spec: _FakeChild(_FakeResult()),
        presets={"generalist": GENERALIST},
    )
    result = _result(await _events(tool, {"task": "x", "agent_type": "nope"}))
    assert result["status"] == "error"


# -- Context modes ------------------------------------------------------------

_PREAMBLE = (
    "The conversation so far is the parent agent's. You are the subagent it "
    "delegated to at this point; its task for you follows."
)


def _framed(task):
    return {"text": f"{_PREAMBLE}\n\n{task}"}


@pytest.mark.asyncio
async def test_context_all_forks_messages():
    """Covers forking, in-flight dropping, reasoning filtering, and trailing-user merge."""
    child = _FakeChild(_FakeResult())
    reasoning = {"reasoningContent": {"reasoningText": {"text": "think", "signature": "sig"}}}
    tr = {"toolResult": {"toolUseId": "r1", "status": "success", "content": [{"text": "A"}]}}
    messages = [
        {"role": "user", "content": [{"text": "go"}]},
        {
            "role": "assistant",
            "content": [
                reasoning,
                {"toolUse": {"toolUseId": "r1", "name": "read", "input": {}}},
            ],
        },
        {"role": "user", "content": [tr]},
        # In-flight (no result yet) — should be dropped.
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "t1", "name": "subagent", "input": {}}},
            ],
        },
    ]
    parent = SimpleNamespace(state=AgentState(), messages=messages)
    tool = make_subagent(builder=lambda spec: child, context=Choice(["none", "all"]))

    await _events(tool, {"task": "do X", "context": "all"}, parent=parent)
    prompt = child.prompts[0]
    assert "reasoningContent" not in str(prompt)
    assert prompt[0] == messages[0]
    assert prompt[1] == {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "r1", "name": "read", "input": {}}}],
    }
    assert prompt[-1] == {"role": "user", "content": [tr, _framed("do X")]}

    # When the last surviving message is user, the task merges into it.
    child2 = _FakeChild(_FakeResult())
    tool2 = make_subagent(builder=lambda spec: child2, context=Choice(["none", "all"]))
    parent2 = SimpleNamespace(state=AgentState(), messages=list(messages))
    await _events(tool2, {"task": "do X", "context": "all"}, parent=parent2)
    assert [m["role"] for m in child2.prompts[0]] == ["user", "assistant", "user"]


@pytest.mark.asyncio
async def test_context_all_merges_consecutive_same_role():
    """Dropping an assistant whose only block is unanswered toolUse must not leave two user turns."""
    child = _FakeChild(_FakeResult())
    messages = [
        {"role": "user", "content": [{"text": "one"}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "x1", "name": "sub", "input": {}}},
            ],
        },
        {"role": "user", "content": [{"text": "two"}]},
    ]
    parent = SimpleNamespace(state=AgentState(), messages=messages)
    tool = make_subagent(builder=lambda spec: child, context=Choice(["none", "all"]))
    await _events(tool, {"task": "t", "context": "all"}, parent=parent)
    roles = [m["role"] for m in child.prompts[0]]
    for i in range(len(roles) - 1):
        assert roles[i] != roles[i + 1], f"consecutive {roles[i]} at index {i}"


@pytest.mark.asyncio
async def test_context_all_last_messages_never_splits_tool_pair():
    child = _FakeChild(_FakeResult())
    tr = {"toolResult": {"toolUseId": "r1", "status": "success", "content": [{"text": "A"}]}}
    messages = [
        {"role": "user", "content": [{"text": "old"}]},
        {"role": "assistant", "content": [{"text": "ok"}]},
        {"role": "user", "content": [{"text": "recent"}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "r1", "name": "read", "input": {}}},
            ],
        },
        {"role": "user", "content": [tr]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "t1", "name": "subagent", "input": {}}},
            ],
        },
    ]
    parent = SimpleNamespace(state=AgentState(), messages=messages)
    tool = make_subagent(builder=lambda spec: child, context=Choice(["none", "all"]))
    await _events(tool, {"task": "x", "context": "all", "last_messages": 2}, parent=parent)
    assert child.prompts[0][0] == messages[2]  # widened to include "recent"


@pytest.mark.asyncio
async def test_context_no_tools_renders_text_block():
    child = _FakeChild(_FakeResult())
    messages = [
        {"role": "user", "content": [{"text": "hello"}]},
        {"role": "assistant", "content": [{"text": "hi"}]},
    ]
    parent = SimpleNamespace(state=AgentState(), messages=messages)
    tool = make_subagent(builder=lambda spec: child, context=Choice(["none", "no_tools"]))
    await _events(tool, {"task": "do X", "context": "no_tools"}, parent=parent)
    prompt = child.prompts[0]
    assert prompt.startswith("<parent_context>")
    assert "user: hello" in prompt and "assistant: hi" in prompt
    assert _CONTEXT_PREAMBLE in prompt
    assert prompt.endswith("do X")


@pytest.mark.asyncio
async def test_context_no_tools_strips_nested_framing():
    child = _FakeChild(_FakeResult())
    nested = f"<parent_context>\nold\n</parent_context>\n\n{_CONTEXT_PREAMBLE}\n\nreal task"
    messages = [{"role": "user", "content": [{"text": nested}]}]
    parent = SimpleNamespace(state=AgentState(), messages=messages)
    tool = make_subagent(builder=lambda spec: child, context=Choice(["none", "no_tools"]))
    await _events(tool, {"task": "x", "context": "no_tools"}, parent=parent)
    assert "real task" in child.prompts[0]
    assert "old" not in child.prompts[0]


def test_resolve_context_edge_cases():
    tool = make_subagent(builder=lambda spec: None, context=Choice(["none", "all"]))
    # Valid
    assert tool._resolve_context({"context": "all", "last_messages": 5}) == ("all", 5)
    # Non-numeric → ignored
    assert tool._resolve_context({"context": "all", "last_messages": "bogus"}) == ("all", None)
    # Off-enum context → "none"
    assert tool._resolve_context({"context": "no_tools"})[0] == "none"
    # Zero / negative last_messages → None
    assert tool._resolve_context({"context": "all", "last_messages": 0})[1] is None
    assert tool._resolve_context({"context": "all", "last_messages": -5})[1] is None


# -- Interrupts, errors, depth ------------------------------------------------


@pytest.mark.asyncio
async def test_interrupt_propagates_and_resumes():
    interrupt = SimpleNamespace(id="i1", response=None)
    first_result = _FakeResult(stop_reason="interrupt", interrupts=[interrupt])
    child = _FakeChild(first_result, _FakeResult("resumed"), activated=True)

    parent = SimpleNamespace(state=AgentState(), messages=[])
    tool = make_subagent(builder=lambda spec: child, presets={"generalist": GENERALIST})

    tool_use = {"toolUseId": "t1", "name": "subagent", "input": {"task": "x"}}
    events = [event async for event in tool.stream(tool_use, {"agent": parent})]
    assert events[-1].interrupts == [interrupt]

    interrupt.response = "go ahead"
    child._interrupt_state.interrupts = {"i1": interrupt}
    events = [event async for event in tool.stream(tool_use, {"agent": parent})]
    assert _result(events)["content"][0]["text"] == "resumed"


@pytest.mark.asyncio
async def test_child_exception_becomes_error_result():
    tool = make_subagent(
        builder=lambda spec: (_ for _ in ()).throw(RuntimeError("boom")), presets={"generalist": GENERALIST}
    )
    result = _result(await _events(tool, {"task": "x"}))
    assert result["status"] == "error" and "boom" in result["content"][0]["text"]


@pytest.mark.asyncio
async def test_cancelled_child_becomes_error_result():
    child = _FakeChild(_FakeResult(stop_reason="cancelled"))
    tool = make_subagent(builder=lambda spec: child, presets={"generalist": GENERALIST})
    result = _result(await _events(tool, {"task": "x"}))
    assert result["status"] == "error" and "cancelled" in result["content"][0]["text"].lower()


@pytest.mark.asyncio
async def test_depth_tracking():
    built = []

    def builder(spec):
        child = _FakeChild(_FakeResult())
        built.append(child)
        return child

    tool = make_subagent(
        builder=builder,
        presets={"generalist": GENERALIST},
        max_depth=3,
        name="delegate",
    )

    # Exhausted depth refuses, message names the tool.
    parent = SimpleNamespace(state=AgentState({_DEPTH_STATE_KEY: 0}), messages=[])
    result = _result(await _events(tool, {"task": "x"}, parent=parent))
    assert result["status"] == "error" and not built
    assert "delegate" in result["content"][0]["text"]

    # First delegation starts at max_depth, decrements.
    parent = SimpleNamespace(state=AgentState(), messages=[])
    await _events(tool, {"task": "x"}, parent=parent)
    assert len(built) == 1
    assert built[-1].state.get(_DEPTH_STATE_KEY) == 2


@pytest.mark.asyncio
async def test_invocation_state_is_copied():
    child = _FakeChild(_FakeResult())
    parent = SimpleNamespace(state=AgentState(), messages=[], cancel_signal=None)
    invocation_state = {"agent": parent, "scratch": 1}
    tool = make_subagent(builder=lambda spec: child, presets={"generalist": GENERALIST})
    tool_use = {"toolUseId": "t1", "name": "subagent", "input": {"task": "x"}}
    [event async for event in tool.stream(tool_use, invocation_state)]
    assert child.invocation_states[0] is not invocation_state
    assert child.invocation_states[0]["scratch"] == 1


@pytest.mark.asyncio
async def test_cancel_signal_prefers_tool_context():
    """_tool_context.cancel_signal wins; without it, falls back to the parent's."""
    child = _FakeChild(_FakeResult(), _FakeResult())
    parent = SimpleNamespace(state=AgentState(), messages=[], cancel_signal="parent-sig")
    tool = make_subagent(builder=lambda spec: child, presets={"generalist": GENERALIST})
    tool_use = {"toolUseId": "t1", "name": "subagent", "input": {"task": "x"}}

    # With _tool_context → uses its signal.
    ctx = SimpleNamespace(cancel_signal="ctx-sig")
    [e async for e in tool.stream(tool_use, {"agent": parent}, _tool_context=ctx)]
    assert child.cancel_signals[0] == "ctx-sig"

    # Without _tool_context → falls back to parent.
    [e async for e in tool.stream(tool_use, {"agent": parent})]
    assert child.cancel_signals[1] == "parent-sig"


@pytest.mark.asyncio
async def test_no_result_from_child_yields_error():
    class _EmptyChild:
        messages: list = []
        state = AgentState()
        _interrupt_state = SimpleNamespace(activated=False, interrupts={})

        async def stream_async(self, prompt, invocation_state=None, cancel_signal=None):
            yield {"data": "not a result"}

    tool = make_subagent(builder=lambda spec: _EmptyChild(), presets={"generalist": GENERALIST})
    result = _result(await _events(tool, {"task": "x"}))
    assert result["status"] == "error" and "no result" in result["content"][0]["text"].lower()


@pytest.mark.asyncio
async def test_missing_task_returns_error():
    """Empty or missing task should produce an error result."""
    tool = make_subagent(builder=lambda spec: _FakeChild(_FakeResult()), presets={"generalist": GENERALIST})
    result = _result(await _events(tool, {}))
    assert result["status"] == "error"
    assert "task" in result["content"][0]["text"].lower()
    result2 = _result(await _events(tool, {"task": "   "}))
    assert result2["status"] == "error"


@pytest.mark.asyncio
async def test_no_parent_falls_back_to_plain_task():
    """Both context='all' and 'no_tools' with no parent should return just the task string."""
    for ctx in ("all", "no_tools"):
        child = _FakeChild(_FakeResult())
        tool = make_subagent(builder=lambda spec, c=child: c, presets={}, context=Fixed(ctx))
        await _events(tool, {"task": "do X"}, parent=None)
        assert child.prompts[0] == "do X", f"context={ctx!r} with no parent should yield plain task"


@pytest.mark.asyncio
async def test_context_all_last_message_is_assistant():
    """context='all' where last surviving message is assistant should append a new user turn."""
    child = _FakeChild(_FakeResult())
    messages = [
        {"role": "user", "content": [{"text": "hello"}]},
        {"role": "assistant", "content": [{"text": "hi back"}]},
    ]
    parent = SimpleNamespace(state=AgentState(), messages=messages)
    tool = make_subagent(builder=lambda spec: child, presets={}, context=Fixed("all"))
    await _events(tool, {"task": "do X"}, parent=parent)
    prompt = child.prompts[0]
    assert prompt[-1]["role"] == "user"
    assert prompt[-1]["content"] == [_framed("do X")]
    assert len(prompt) == 3


@pytest.mark.asyncio
async def test_render_context_last_n():
    """_render_context should respect last_n to trim to the last N text turns."""
    child = _FakeChild(_FakeResult())
    messages = [
        {"role": "user", "content": [{"text": "first"}]},
        {"role": "assistant", "content": [{"text": "second"}]},
        {"role": "user", "content": [{"text": "third"}]},
    ]
    parent = SimpleNamespace(state=AgentState(), messages=messages)
    tool = make_subagent(builder=lambda spec: child, presets={}, context=Choice(["none", "no_tools"]))
    await _events(tool, {"task": "do X", "context": "no_tools", "last_messages": 1}, parent=parent)
    prompt = child.prompts[0]
    assert "first" not in prompt
    assert "second" not in prompt
    assert "third" in prompt
