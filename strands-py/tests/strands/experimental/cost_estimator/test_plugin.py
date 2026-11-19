"""Tests for the GenAIPricesEstimator plugin."""

import logging
import math
import types
from decimal import Decimal

import pytest

genai_prices = pytest.importorskip("genai_prices")

from genai_prices.types import Tier, TieredPrices  # noqa: E402

from strands import Agent, tool  # noqa: E402
from strands.agent.invocation_context import _create_invocation_context  # noqa: E402
from strands.experimental.cost_estimator import (  # noqa: E402
    CostEstimate,
    CostEstimateEvent,
    GenAIPricesEstimator,
    ModelCostEstimate,
    ModelPrice,
)
from strands.experimental.cost_estimator import plugin as plugin_module  # noqa: E402
from strands.middleware import InvokeModelContext, InvokeModelStage, ModelStopReason  # noqa: E402
from strands.multiagent.base import MultiAgentResult  # noqa: E402
from strands.types.tools import ToolContext  # noqa: E402
from tests.fixtures.mocked_model_provider import MockedModelProvider  # noqa: E402

MAIN_PRICE = ModelPrice(3.0, 15.0, cache_read_per_million=0.3, cache_write_per_million=3.75, model_id="main")
SMALL_PRICE = ModelPrice(1.0, 5.0, model_id="small")


class NamedModel(MockedModelProvider):
    def __init__(self, model_id, agent_responses, usages):
        super().__init__(agent_responses, usages)
        self.model_id = model_id

    def get_config(self):
        return {"model_id": self.model_id}


def _usage(input_tokens, output_tokens, cache_read=0, cache_write=0, *, cache_in_input=False):
    cached = cache_read + cache_write
    usage = {
        "inputTokens": input_tokens + (cached if cache_in_input else 0),
        "outputTokens": output_tokens,
        "totalTokens": input_tokens + output_tokens + cached,
    }
    if cache_read:
        usage["cacheReadInputTokens"] = cache_read
    if cache_write:
        usage["cacheWriteInputTokens"] = cache_write
    return usage


def _request(*calls):
    """A request with one recorded model call per ``(usage, provider_name, model_id)``."""
    request = _create_invocation_context()
    for usage, provider_name, model_id in calls:
        request._record_usage(usage, provider_name, model_id)
    return request


def _text(text):
    return {"role": "assistant", "content": [{"text": text}]}


def _tool_use(name):
    return {"role": "assistant", "content": [{"toolUse": {"toolUseId": "tu-1", "name": name, "input": {}}}]}


@pytest.fixture
def genai_lookups(monkeypatch):
    """Replace the genai-prices lookup with one that lists ``priced-model`` at tiered rates, recording each call."""
    lookups = []

    def calc_price(usage, model_ref, *, provider_id):
        lookups.append((provider_id, model_ref))
        if not model_ref.endswith("priced-model"):
            raise LookupError(model_ref)
        model_price = genai_prices.types.ModelPrice(
            input_mtok=TieredPrices(base=Decimal("2"), tiers=[Tier(start=200_000, price=Decimal("4"))]),
            output_mtok=Decimal("10"),
            cache_read_mtok=TieredPrices(base=Decimal("0.2"), tiers=[Tier(start=200_000, price=Decimal("0.4"))]),
        )
        return types.SimpleNamespace(
            model_price=model_price,
            provider=types.SimpleNamespace(id=provider_id),
            model=types.SimpleNamespace(id="matched-model"),
        )

    monkeypatch.setattr(plugin_module, "calc_price", calc_price)
    return lookups


@pytest.mark.parametrize("cache_in_input", [True, False])
def test_estimate_charges_cached_tokens_once_under_either_input_tokens_convention(cache_in_input):
    usage = _usage(1_000, 100, cache_read=6_000, cache_write=2_000, cache_in_input=cache_in_input)

    tru_estimate = GenAIPricesEstimator(prices=[MAIN_PRICE]).estimate(_request((usage, "bedrock", "main")))

    exp_cost = (1_000 * 3.0 + 6_000 * 0.3 + 2_000 * 3.75 + 100 * 15.0) / 1_000_000
    assert tru_estimate == CostEstimate(
        total_usd=exp_cost,
        models=(ModelCostEstimate("bedrock", "main", usage, exp_cost, MAIN_PRICE, "user"),),
    )


def test_estimate_charges_cached_tokens_at_the_input_rate_when_the_price_has_no_cache_rate():
    usage = _usage(1_000, 100, cache_read=6_000, cache_write=2_000)

    tru_estimate = GenAIPricesEstimator(prices=[SMALL_PRICE]).estimate(_request((usage, None, "small")))

    assert tru_estimate.total_usd == (9_000 * 1.0 + 100 * 5.0) / 1_000_000


def test_estimate_adds_the_models_of_a_request_together():
    request = _request(
        (_usage(1_000, 100), None, "main"), (_usage(2_000, 200), None, "small"), (_usage(1_000, 100), None, "main")
    )

    tru_estimate = GenAIPricesEstimator(prices=[MAIN_PRICE, SMALL_PRICE]).estimate(request)

    exp_costs = [(2_000 * 3.0 + 200 * 15.0) / 1_000_000, (2_000 * 1.0 + 200 * 5.0) / 1_000_000]
    assert [model.cost_usd for model in tru_estimate.models] == exp_costs
    assert tru_estimate.total_usd == math.fsum(exp_costs)
    assert tru_estimate.unpriced == ()


@pytest.mark.parametrize(
    ("provider_name", "model_id", "exp_input_rate"),
    [
        ("bedrock", "priced-model", 7.0),
        ("openai", "priced-model", 5.0),
        (None, "priced-model", 5.0),
        ("litellm", "openai/priced-model", 9.0),
        ("bedrock", "arn:aws:bedrock:us-west-2:1:application-inference-profile/abc", 11.0),
    ],
    ids=["provider-entry-wins", "any-provider-entry", "model-without-provider", "id-with-slash", "arn"],
)
def test_estimate_prefers_your_price_and_compares_the_model_id_as_a_whole(
    provider_name, model_id, exp_input_rate, genai_lookups
):
    prices = [
        ModelPrice(5.0, 1.0, model_id="priced-model"),
        ModelPrice(7.0, 1.0, model_id="priced-model", provider_name="bedrock"),
        ModelPrice(9.0, 1.0, model_id="openai/priced-model"),
        ModelPrice(11.0, 1.0, model_id="arn:aws:bedrock:us-west-2:1:application-inference-profile/abc"),
    ]

    tru_estimate = GenAIPricesEstimator(prices=prices).estimate(_request((_usage(1, 1), provider_name, model_id)))

    tru_model = tru_estimate.models[0]
    assert (tru_model.price.input_per_million, tru_model.price_source) == (exp_input_rate, "user")
    assert genai_lookups == []


def test_estimate_skips_your_price_for_another_provider(genai_lookups):
    price = ModelPrice(7.0, 1.0, model_id="priced-model", provider_name="bedrock")

    tru_estimate = GenAIPricesEstimator(prices=[price]).estimate(_request((_usage(1, 1), "openai", "priced-model")))

    assert tru_estimate.models[0].price_source == "genai-prices:openai/matched-model"


@pytest.mark.parametrize(
    "prices",
    [
        [ModelPrice(1.0, 1.0)],
        [ModelPrice(1.0, 1.0, model_id="a"), ModelPrice(2.0, 2.0, model_id="a")],
        [ModelPrice(1.0, 1.0, model_id="a", provider_name="p"), ModelPrice(2.0, 2.0, model_id="a", provider_name="p")],
    ],
    ids=["no-model-id", "same-model-id", "same-provider-and-model-id"],
)
def test_init_rejects_prices_it_cannot_tell_apart(prices):
    with pytest.raises(ValueError, match="model_id"):
        GenAIPricesEstimator(prices=prices)


@pytest.mark.parametrize(
    "rates",
    [
        {"input_per_million": -1.0},
        {"output_per_million": math.nan},
        {"cache_read_per_million": math.inf},
        {"cache_write_per_million": "1"},
        {"input_per_million": True},
        {"output_per_million": None},
    ],
    ids=["negative", "nan", "infinite", "string", "bool", "missing-output"],
)
def test_model_price_rejects_a_rate_that_is_not_a_finite_non_negative_number(rates):
    with pytest.raises(ValueError, match="finite, non-negative number"):
        ModelPrice(**{"input_per_million": 1.0, "output_per_million": 1.0, **rates})


def test_estimate_leaves_the_total_empty_when_a_model_has_no_price(genai_lookups):
    request = _request(
        (_usage(1_000, 100), None, "main"),
        (_usage(1, 1), "bedrock", "unlisted"),
        (_usage(1, 1), None, "no-provider"),
        (_usage(1, 1), None, None),
    )

    tru_estimate = GenAIPricesEstimator(prices=[MAIN_PRICE]).estimate(request)

    assert tru_estimate.total_usd is None
    assert [(model.model_id, model.cost_usd, model.price, model.price_source) for model in tru_estimate.unpriced] == [
        ("unlisted", None, None, None),
        ("no-provider", None, None, None),
        (None, None, None, None),
    ]
    assert tru_estimate.models[0].cost_usd == (1_000 * 3.0 + 100 * 15.0) / 1_000_000


def test_estimate_uses_the_base_rate_of_a_tiered_genai_price(genai_lookups):
    usage = _usage(300_000, 1_000, cache_read=100_000, cache_write=50_000)

    tru_model = GenAIPricesEstimator().estimate(_request((usage, "openai", "priced-model"))).models[0]

    exp_price = ModelPrice(2.0, 10.0, cache_read_per_million=0.2, model_id="priced-model", provider_name="openai")
    exp_cost = (300_000 * 2.0 + 100_000 * 0.2 + 50_000 * 2.0 + 1_000 * 10.0) / 1_000_000
    assert (tru_model.price, tru_model.price_source) == (exp_price, "genai-prices:openai/matched-model")
    assert tru_model.cost_usd == pytest.approx(exp_cost)


@pytest.mark.parametrize(
    ("provider_name", "model_id", "exp_lookup"),
    [
        ("bedrock", "priced-model", ("aws", "priced-model")),
        ("bedrock-mantle", "openai.priced-model", ("aws", "openai.priced-model")),
        ("anthropic", "priced-model", ("anthropic", "priced-model")),
        ("openai", "priced-model", ("openai", "priced-model")),
        ("google", "priced-model", ("google", "priced-model")),
        ("mistral", "priced-model", ("mistral", "priced-model")),
        ("typesafe", "priced-model", ("typesafe", "priced-model")),
        ("litellm", "groq/meta/priced-model", ("groq", "meta/priced-model")),
    ],
)
def test_estimate_looks_a_model_up_under_the_genai_prices_provider(provider_name, model_id, exp_lookup, genai_lookups):
    tru_model = GenAIPricesEstimator().estimate(_request((_usage(1, 1), provider_name, model_id))).models[0]

    assert genai_lookups == [exp_lookup]
    assert tru_model.price_source == f"genai-prices:{exp_lookup[0]}/matched-model"
    assert (tru_model.provider_name, tru_model.model_id) == (provider_name, model_id)


@pytest.mark.parametrize(
    ("provider_name", "model_id"),
    [("ollama", "priced-model"), ("sagemaker", "priced-model"), ("litellm", "priced-model"), (None, "priced-model")],
)
def test_estimate_does_not_look_up_a_provider_genai_prices_does_not_list(provider_name, model_id, genai_lookups):
    tru_estimate = GenAIPricesEstimator().estimate(_request((_usage(1, 1), provider_name, model_id)))

    assert genai_lookups == []
    assert tru_estimate.total_usd is None


def test_estimate_leaves_a_genai_price_without_token_rates_unpriced(monkeypatch):
    matched = types.SimpleNamespace(model_price=genai_prices.types.ModelPrice(requests_kcount=Decimal("1")))
    monkeypatch.setattr(plugin_module, "calc_price", lambda *args, **kwargs: matched)

    tru_estimate = GenAIPricesEstimator().estimate(_request((_usage(1, 1), "openai", "per-request-model")))

    assert tru_estimate.unpriced == tru_estimate.models


def test_estimate_prices_a_well_known_bedrock_model_from_the_bundled_data():
    request = _request((_usage(1_000, 100), "bedrock", "us.anthropic.claude-sonnet-4-20250514-v1:0"))

    tru_estimate = GenAIPricesEstimator().estimate(request)

    assert tru_estimate.total_usd > 0
    assert tru_estimate.models[0].price_source.startswith("genai-prices:aws/")


@pytest.mark.asyncio
async def test_estimate_accepts_an_agent_result_a_multi_agent_result_and_an_invocation_context():
    cost = GenAIPricesEstimator(prices=[MAIN_PRICE])
    agent = Agent(model=NamedModel("main", [_text("done")], [_usage(1_000, 100)]), callback_handler=None)

    result = await agent.invoke_async("go")

    exp_cost = (1_000 * 3.0 + 100 * 15.0) / 1_000_000
    for request in (result, MultiAgentResult(invocation_context=result.invocation_context), result.invocation_context):
        assert cost.estimate(request).total_usd == exp_cost


def test_estimate_of_a_result_without_an_invocation_context_has_no_total():
    assert GenAIPricesEstimator().estimate(MultiAgentResult()) == CostEstimate(total_usd=None, models=())


def test_estimate_of_a_request_without_model_calls_is_zero():
    assert GenAIPricesEstimator().estimate(_create_invocation_context()) == CostEstimate(total_usd=0.0, models=())


def test_cost_estimate_event_is_a_dict_with_the_estimate_under_cost_estimate():
    estimate = CostEstimate(total_usd=0.0, models=())

    tru_event = CostEstimateEvent(estimate)

    assert tru_event.as_dict() == {"cost_estimate": estimate}
    assert tru_event.is_callback_event


def _research_agent(plugins, callback_handler=None):
    """An agent on ``main`` whose first turn calls a tool that runs a sub-agent on ``small`` in the same request."""

    @tool(context=True)
    async def research(tool_context: ToolContext) -> str:
        """Researches with a smaller model."""
        sub_agent = Agent(model=NamedModel("small", [_text("notes")], [_usage(40_000, 1_500)]), callback_handler=None)
        return str(await sub_agent.invoke_async("go", invocation_context=tool_context.invocation_context))

    model = NamedModel(
        "main",
        [_tool_use("research"), _text("done")],
        [_usage(2_000, 300, cache_write=18_000), _usage(2_500, 900, cache_read=18_000)],
    )
    return Agent(model=model, tools=[research], plugins=plugins, callback_handler=callback_handler)


MAIN_FIRST_CALL_COST = (2_000 * 3.0 + 18_000 * 3.75 + 300 * 15.0) / 1_000_000
MAIN_COST = (4_500 * 3.0 + 18_000 * 0.3 + 18_000 * 3.75 + 1_200 * 15.0) / 1_000_000
SMALL_COST = (40_000 * 1.0 + 1_500 * 5.0) / 1_000_000


@pytest.mark.asyncio
async def test_stream_emits_the_request_estimate_after_each_model_call(alist):
    cost = GenAIPricesEstimator(prices=[MAIN_PRICE, SMALL_PRICE])
    callback_estimates = []
    agent = _research_agent(
        [cost],
        lambda **kwargs: callback_estimates.append(kwargs["cost_estimate"]) if "cost_estimate" in kwargs else None,
    )

    events = await alist(agent.stream_async("go"))

    tru_estimates = [event["cost_estimate"] for event in events if "cost_estimate" in event]
    assert [estimate.total_usd for estimate in tru_estimates] == [
        pytest.approx(MAIN_FIRST_CALL_COST),
        pytest.approx(MAIN_COST + SMALL_COST),
    ]
    assert [[model.model_id for model in estimate.models] for estimate in tru_estimates] == [
        ["main"],
        ["main", "small"],
    ]
    assert callback_estimates == tru_estimates
    assert tru_estimates[-1] == cost.estimate(events[-1]["result"])


@pytest.mark.asyncio
async def test_stream_emits_the_estimate_right_after_the_model_stop_event(alist):
    agent = _research_agent([])
    stage_events = []

    async def record(context, next_fn):
        async for event in next_fn(context):
            stage_events.append(event)
            yield event

    # The first handler registered is the outermost, so it sees what the estimator adds.
    agent.add_middleware(InvokeModelStage, record)
    GenAIPricesEstimator(prices=[MAIN_PRICE, SMALL_PRICE]).init_agent(agent)

    await alist(agent.stream_async("go"))

    tru_types = [type(event) for event in stage_events]
    tru_preceding = [tru_types[index - 1] for index, kind in enumerate(tru_types) if kind is CostEstimateEvent]
    assert tru_preceding == [ModelStopReason, ModelStopReason]
    assert tru_types[-1] is CostEstimateEvent


@pytest.mark.asyncio
async def test_middleware_estimates_the_call_itself_without_an_invocation_context(alist):
    cost = GenAIPricesEstimator(prices=[MAIN_PRICE])
    model = NamedModel("main", [], [])
    context = InvokeModelContext(
        agent=Agent(model=model, callback_handler=None),
        messages=[],
        system_prompt=None,
        tool_specs=[],
        tool_choice=None,
        invocation_state={},
        model=model,
    )
    usage = _usage(1_000, 100)

    async def next_fn(context):
        yield ModelStopReason(stop_reason="end_turn", message=_text("done"), usage=usage, metrics={"latencyMs": 1})

    events = await alist(cost._emit_estimate(context, next_fn))

    exp_cost = (1_000 * 3.0 + 100 * 15.0) / 1_000_000
    assert events[1:] == [
        CostEstimateEvent(
            CostEstimate(exp_cost, (ModelCostEstimate(None, "main", usage, exp_cost, MAIN_PRICE, "user"),))
        )
    ]


@pytest.mark.asyncio
async def test_stream_finishes_without_an_estimate_when_pricing_raises(monkeypatch, caplog, alist):
    def failing_cost(usage, price):
        raise RuntimeError("pricing failed")

    monkeypatch.setattr(plugin_module, "_cost", failing_cost)
    agent = _research_agent([GenAIPricesEstimator(prices=[MAIN_PRICE, SMALL_PRICE])])

    with caplog.at_level(logging.WARNING, logger=plugin_module.__name__):
        events = await alist(agent.stream_async("go"))

    assert events[-1]["result"].stop_reason == "end_turn"
    assert [event for event in events if "cost_estimate" in event] == []
    assert (
        caplog.messages
        == ["error=<pricing failed> | cost estimate failed | no estimate emitted for this model call"] * 2
    )
