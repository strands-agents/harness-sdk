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
from strands.vended_plugins.context_injector import ContextInjector
from tests_integ.conftest import retry_on_flaky
from tests_integ.models import conformance


class Profile(BaseModel):
    """Basic user profile model."""

    name: str
    age: int
    occupation: str


PROFILE_PROMPT = "Create a profile for John who is a 25 year old dentist."
EXPECTED_PROFILE = Profile(name="John", age=25, occupation="dentist")


@strands.tool
def echo(value: str) -> str:
    """Echo the given value back."""
    return value


@pytest.fixture(params=conformance.TARGETS)
def target(request):
    return request.param


@pytest.fixture
def model(request, target):
    model = target.create_model()
    case_id = request.function.conformance_case
    reason = conformance.not_applicable_reason(case_id, model)
    if reason:
        pytest.skip(f"{conformance.NOT_APPLICABLE}: {reason}")
    issue = conformance.KNOWN_FAILURES.get((target.provider, target.model_id, case_id))
    if issue:
        # Only a failed assertion is the known failure; a provider error still fails the run.
        request.applymarker(
            pytest.mark.xfail(strict=True, raises=AssertionError, reason=f"known failure, see #{issue}")
        )
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


@conformance.case("tool-use")
@retry_on_flaky("A model may occasionally answer without calling the tool")
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
@retry_on_flaky("A model may occasionally answer in text instead of producing the structured output")
def test_structured_output(model):
    result = _agent(model)(PROFILE_PROMPT, structured_output_model=Profile)

    tru_profile = _normalized(result.structured_output)
    assert tru_profile == EXPECTED_PROFILE


@conformance.case("max-output-tokens")
def test_max_output_tokens(model):
    result = _agent(model)("Reply with the single word OK.")

    assert result.stop_reason == "end_turn"


@conformance.case("forced-tool-choice")
@pytest.mark.asyncio
async def test_forced_tool_choice(model, alist):
    messages = [{"role": "user", "content": [{"text": "Hello there!"}]}]

    events = await alist(model.stream(messages, tool_specs=[echo.tool_spec], tool_choice={"any": {}}))

    tru_stop_reason = next(event["messageStop"]["stopReason"] for event in events if "messageStop" in event)
    exp_stop_reason = "tool_use"
    assert tru_stop_reason == exp_stop_reason


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
    # Salted so a rerun cannot read an entry an earlier run wrote, and sized to about twice the largest cache
    # minimum among the targets.
    system_prompt = f"Dossier {uuid.uuid4()}. " + ("The subject prefers concise written answers. " * 1200)
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
@retry_on_flaky("A model may occasionally answer without using the injected text")
def test_temporary_messages(model):
    order_number = uuid.uuid4().hex[:8]
    agent = _agent(model, plugins=[ContextInjector(lambda context: f"The user's order number is {order_number}.")])

    result = agent("What is my order number? Reply with only the number.")

    assert order_number in str(result)
