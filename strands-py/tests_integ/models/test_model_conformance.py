"""Model conformance: every case in shared/conformance.json, run on every target it applies to.

A target the case does not apply to skips as not applicable. Each target carries its provider's skip mark, so a
missing key skips only that provider's rows.
"""

import uuid

import pytest
from pydantic import BaseModel

import strands
from strands import Agent
from strands.models import CacheConfig
from strands.models._model_info import lookup_model_info
from strands.models._native_output import _is_unsupported_mechanism_message
from strands.vended_plugins.context_injector import ContextInjector
from tests_integ.models import conformance


class Profile(BaseModel):
    """Basic user profile model."""

    name: str
    age: int
    occupation: str


# Covers three attempts of up to three minutes each, half a minute apart.
pytestmark = pytest.mark.timeout(630)

PROFILE_PROMPT = "Create a profile for John who is a 25 year old dentist."
EXPECTED_PROFILE = Profile(name="John", age=25, occupation="dentist")


@strands.tool
def echo(value: str) -> str:
    """Echo the given value back."""
    return value


@pytest.fixture(params=conformance.TARGETS)
def target(request):
    return request.param


@pytest.fixture(autouse=True)
def running_item(request):
    conformance.running_item = request.node
    yield
    conformance.running_item = None


@pytest.fixture
def model(request, target):
    model = target.create_model()
    case_id = request.function.conformance_case
    reason = conformance.not_applicable_reason(case_id, model)
    if conformance.PROBE_TARGET:
        return conformance.prepare_probe(request.node, case_id, model, reason)
    known = conformance.KNOWN_FAILURES.get((target.provider, target.model_id, case_id))
    if reason and known:
        pytest.fail(
            f"known failure #{known['issue']} no longer applies ({reason}); "
            "remove it from knownFailures in shared/conformance.json"
        )
    if reason:
        pytest.skip(f"{conformance.NOT_APPLICABLE}: {reason}")
    return model


def _normalized(profile):
    return profile.model_copy(update={"occupation": profile.occupation.lower()})


def _agent(model, **kwargs):
    return Agent(model=model, load_tools_from_directory=False, callback_handler=None, **kwargs)


def test_shared_cases_and_providers_are_all_accounted_for():
    tru_cases = conformance.IMPLEMENTED | set(conformance.OMITTED_CASES)
    exp_cases = set(conformance.CASES)
    assert tru_cases == exp_cases

    unmapped_providers = conformance.TARGET_PROVIDERS - set(conformance.PROVIDERS) - set(conformance.OMITTED_PROVIDERS)
    assert unmapped_providers == set()


def test_known_failures_name_a_live_target_and_a_case():
    stale = [
        key
        for key in conformance.KNOWN_FAILURES
        if key[:2] not in conformance.LIVE_TARGETS or key[2] not in conformance.CASES
    ]
    assert stale == []


@conformance.case("tool-use")
def test_tool_use(model):
    agent = _agent(model, tools=[echo])

    result = agent("Use the echo tool to echo the value 'pineapple'.")

    assert result.stop_reason == "end_turn"
    assert any(block.get("toolUse") for message in agent.messages for block in message["content"])


@conformance.case("context-window")
def test_context_window(model, target):
    tru_window = model.get_config().get("context_window_limit")
    exp_window = lookup_model_info(target.model_id).limits.context_window

    assert exp_window is not None, "the model id resolves to no entry in shared/model-info.json"
    assert tru_window == exp_window


@conformance.case("structured-output")
def test_structured_output(model):
    result = _agent(model)(PROFILE_PROMPT, structured_output_model=Profile)

    tru_profile = _normalized(result.structured_output)
    assert tru_profile == EXPECTED_PROFILE


@conformance.case("max-output-tokens")
def test_max_output_tokens(model):
    result = _agent(model)("Reply with the single word OK.")

    assert result.stop_reason == "end_turn"


async def _forced_tool_choice_outcome(model, alist):
    messages = [{"role": "user", "content": [{"text": "Hello there!"}]}]
    try:
        events = await alist(model.stream(messages, tool_specs=[echo.tool_spec], tool_choice={"any": {}}))
    except Exception as error:
        if not _is_unsupported_mechanism_message(str(error), "forced"):
            raise
        return "refused"
    used_tool = any("toolUse" in event.get("contentBlockStart", {}).get("start", {}) for event in events)
    return "accepted" if used_tool else "no tool use"


@conformance.case("forced-tool-choice")
@pytest.mark.asyncio
async def test_forced_tool_choice(model, alist):
    tru_outcome = await _forced_tool_choice_outcome(model, alist)
    exp_outcome = "accepted"
    assert tru_outcome == exp_outcome


@conformance.case("forced-tool-choice-refused")
@pytest.mark.asyncio
async def test_forced_tool_choice_refused(model, alist):
    tru_outcome = await _forced_tool_choice_outcome(model, alist)
    exp_outcome = "refused"
    assert tru_outcome == exp_outcome


@conformance.case("native-structured-output")
@pytest.mark.asyncio
async def test_native_structured_output(model, alist):
    messages = [{"role": "user", "content": [{"text": PROFILE_PROMPT}]}]

    events = await alist(model.stream(messages, structured_output_model=Profile))

    text = "".join(
        event["contentBlockDelta"]["delta"].get("text", "") for event in events if "contentBlockDelta" in event
    )
    tru_profile = _normalized(Profile.model_validate_json(text))
    assert tru_profile == EXPECTED_PROFILE


@conformance.case("prompt-caching")
def test_prompt_caching(model):
    model.update_config(cache_config=CacheConfig(strategy="auto"))
    # Salted so a rerun cannot read an entry an earlier run wrote.
    system_prompt = f"Session {uuid.uuid4()}.\n{conformance.CACHE_PROMPT}"
    agent = _agent(model, system_prompt=system_prompt)

    agent("Reply ALPHA.")
    # An entry can take a moment to become readable, so the read may land a turn late.
    tru_read_tokens = 0
    for reply in ("BETA", "GAMMA", "DELTA"):
        tru_read_tokens = agent(f"Reply {reply}.").metrics.latest_agent_invocation.usage.get("cacheReadInputTokens", 0)
        if tru_read_tokens:
            break

    assert tru_read_tokens > 0


@conformance.case("server-side-summary")
@pytest.mark.asyncio
async def test_server_side_summary(model):
    messages = [
        {"role": "user", "content": [{"text": "My name is Ada and I live in Lisbon. Remember that."}]},
        {"role": "assistant", "content": [{"text": "Got it, Ada from Lisbon."}]},
        {"role": "user", "content": [{"text": "My favourite colour is teal."}]},
        {"role": "assistant", "content": [{"text": "Noted: teal."}]},
    ]

    summary = await model.summarize(messages, system_prompt="You are helpful.")
    block = summary.content[0]

    assert block["summary"]["provider"] is not None

    # Mirrors how the summarize strategy splices the summary into history.
    agent = _agent(
        model,
        system_prompt="You are helpful.",
        messages=[messages[0], {"role": "assistant", "content": [block]}],
    )
    result = await agent.invoke_async("What is my name and which city do I live in?")

    assert all(word in str(result).lower() for word in ("ada", "lisbon"))


@conformance.case("temporary-messages")
def test_temporary_messages(model):
    order_number = uuid.uuid4().hex[:8]
    agent = _agent(model, plugins=[ContextInjector(lambda context: f"The user's order number is {order_number}.")])

    result = agent("What is my order number? Reply with only the number.")

    assert order_number in str(result)
