"""Tests for the GenAIPricesEstimator plugin."""

import logging
import math
import re
import types
import unittest.mock
from decimal import Decimal

import pytest

genai_prices = pytest.importorskip("genai_prices")

from genai_prices.types import Tier, TieredPrices  # noqa: E402

from strands import Agent, tool  # noqa: E402
from strands.agent.invocation_context import ModelUsage, _create_invocation_context  # noqa: E402
from strands.middleware import InvokeModelStage, ModelStopReason  # noqa: E402
from strands.models._provider_name import _model_key  # noqa: E402
from strands.models.bedrock import BedrockModel  # noqa: E402
from strands.models.sagemaker import SageMakerAIModel  # noqa: E402
from strands.multiagent.base import MultiAgentResult  # noqa: E402
from strands.types.tools import ToolContext  # noqa: E402
from strands.vended_plugins.cost_estimator import (  # noqa: E402
    CostEstimate,
    CostEstimateEvent,
    GenAIPricesEstimator,
    ModelCostEstimate,
    ModelPrice,
)
from strands.vended_plugins.cost_estimator import plugin as plugin_module  # noqa: E402
from tests.fixtures.mocked_model_provider import MockedModelProvider  # noqa: E402

MAIN_PRICE = ModelPrice(
    model_id="main",
    input_per_million=3.0,
    output_per_million=15.0,
    cache_read_per_million=0.3,
    cache_write_per_million=3.75,
)
SMALL_PRICE = ModelPrice(model_id="small", input_per_million=1.0, output_per_million=5.0)


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


def _price(model_id, input_per_million, provider_name=None):
    return ModelPrice(
        model_id=model_id, provider_name=provider_name, input_per_million=input_per_million, output_per_million=1.0
    )


def _model_estimate(provider_name, model_id, usage, cost_usd, price):
    return ModelCostEstimate(
        provider_name=provider_name,
        model_id=model_id,
        usage=usage,
        cost_usd=cost_usd,
        price=price,
        price_source=None if price is None else "user",
    )


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
        models=(_model_estimate("bedrock", "main", usage, exp_cost, MAIN_PRICE),),
    )


def test_estimate_charges_no_uncached_input_when_the_cached_tokens_exceed_input_tokens():
    usage = {"inputTokens": 100, "outputTokens": 10, "totalTokens": 110, "cacheReadInputTokens": 500}

    tru_estimate = GenAIPricesEstimator(prices=[MAIN_PRICE]).estimate(_request((usage, "bedrock", "main")))

    assert tru_estimate.total_usd == (500 * 0.3 + 10 * 15.0) / 1_000_000


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
        _price("priced-model", 5.0),
        _price("priced-model", 7.0, provider_name="bedrock"),
        _price("openai/priced-model", 9.0),
        _price("arn:aws:bedrock:us-west-2:1:application-inference-profile/abc", 11.0),
    ]
    cost = GenAIPricesEstimator(prices=prices)
    genai_lookups.clear()

    tru_estimate = cost.estimate(_request((_usage(1, 1), provider_name, model_id)))

    tru_model = tru_estimate.models[0]
    assert (tru_model.price.input_per_million, tru_model.price_source) == (exp_input_rate, "user")
    assert genai_lookups == []


def test_estimate_prices_a_sagemaker_model_with_your_price_for_its_endpoint_name():
    model = SageMakerAIModel(
        endpoint_config={"endpoint_name": "endpoint-a"},
        payload_config={"max_tokens": 1},
        boto_session=unittest.mock.Mock(),
    )
    request = _request((_usage(1_000, 100), *_model_key(model)))

    tru_estimate = GenAIPricesEstimator(prices=[_price("endpoint-a", 2.0)]).estimate(request)

    assert tru_estimate.total_usd == (1_000 * 2.0 + 100 * 1.0) / 1_000_000


def test_estimate_skips_your_price_for_another_provider(genai_lookups):
    price = _price("priced-model", 7.0, provider_name="bedrock")

    tru_estimate = GenAIPricesEstimator(prices=[price]).estimate(_request((_usage(1, 1), "openai", "priced-model")))

    assert tru_estimate.models[0].price_source == "genai-prices:openai/matched-model"


@pytest.mark.parametrize(
    "prices",
    [
        [_price("a", 1.0), _price("a", 2.0)],
        [_price("a", 1.0, provider_name="p"), _price("a", 2.0, provider_name="p")],
    ],
    ids=["same-model-id", "same-provider-and-model-id"],
)
def test_init_rejects_two_prices_for_one_model(prices):
    with pytest.raises(ValueError, match="two entries for one model"):
        GenAIPricesEstimator(prices=prices)


def test_init_loads_the_price_data_and_never_raises(monkeypatch):
    lookups = []

    def failing_lookup(*args, **kwargs):
        lookups.append(args)
        raise RuntimeError("no price data")

    monkeypatch.setattr(plugin_module, "calc_price", failing_lookup)

    GenAIPricesEstimator()

    assert len(lookups) == 1


@pytest.mark.parametrize("model_id", ["", None])
def test_model_price_rejects_an_empty_model_id(model_id):
    with pytest.raises(ValueError, match="a price needs the id of the model"):
        ModelPrice(model_id=model_id, input_per_million=1.0, output_per_million=1.0)


@pytest.mark.parametrize(
    "rates",
    [
        {"input_per_million": -1.0},
        {"output_per_million": math.nan},
        {"cache_read_per_million": math.inf},
        {"cache_write_per_million": "1"},
        {"input_per_million": True},
        {"output_per_million": None},
        {"input_per_million": 10**400},
    ],
    ids=["negative", "nan", "infinite", "string", "bool", "missing-output", "larger-than-a-float"],
)
def test_model_price_rejects_a_rate_that_is_not_a_finite_non_negative_number(rates):
    with pytest.raises(ValueError, match="finite, non-negative number"):
        ModelPrice(**{"model_id": "main", "input_per_million": 1.0, "output_per_million": 1.0, **rates})


@pytest.mark.parametrize(
    ("record_type", "args"),
    [
        (ModelUsage, (None, "main", {})),
        (ModelPrice, ("main", 3.0, 15.0)),
        (ModelCostEstimate, (None, "main", {}, None, None, None)),
        (CostEstimate, (0.0, ())),
    ],
)
def test_types_take_keyword_arguments_only(record_type, args):
    with pytest.raises(TypeError, match="positional"):
        record_type(*args)


def test_estimates_that_are_equal_hash_equal():
    cost = GenAIPricesEstimator(prices=[MAIN_PRICE])

    tru_estimates = {
        cost.estimate(_request((_usage(1_000, 100), None, "main"))),
        cost.estimate(_request((_usage(1_000, 100), None, "main"))),
        cost.estimate(_request((_usage(2_000, 100), None, "main"))),
    }

    assert len(tru_estimates) == 2


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

    exp_price = ModelPrice(
        model_id="priced-model",
        provider_name="openai",
        input_per_million=2.0,
        output_per_million=10.0,
        cache_read_per_million=0.2,
    )
    exp_cost = (300_000 * 2.0 + 100_000 * 0.2 + 50_000 * 2.0 + 1_000 * 10.0) / 1_000_000
    assert (tru_model.price, tru_model.price_source) == (exp_price, "genai-prices:openai/matched-model")
    assert tru_model.cost_usd == pytest.approx(exp_cost)


@pytest.mark.parametrize(
    ("provider_name", "model_id", "exp_lookup"),
    [
        ("bedrock", "priced-model", ("aws", "priced-model")),
        ("anthropic", "priced-model", ("anthropic", "priced-model")),
        ("openai", "priced-model", ("openai", "priced-model")),
        ("google", "priced-model", ("google", "priced-model")),
        ("mistral", "priced-model", ("mistral", "priced-model")),
        ("litellm", "groq/meta/priced-model", ("groq", "meta/priced-model")),
    ],
)
def test_estimate_looks_a_model_up_under_the_genai_prices_provider(provider_name, model_id, exp_lookup, genai_lookups):
    cost = GenAIPricesEstimator()
    genai_lookups.clear()

    tru_model = cost.estimate(_request((_usage(1, 1), provider_name, model_id))).models[0]

    assert genai_lookups == [exp_lookup]
    assert tru_model.price_source == f"genai-prices:{exp_lookup[0]}/matched-model"
    assert (tru_model.provider_name, tru_model.model_id) == (provider_name, model_id)


@pytest.mark.parametrize(
    ("provider_name", "model_id"),
    [("ollama", "priced-model"), ("sagemaker", "priced-model"), (None, "priced-model")],
)
def test_estimate_does_not_look_up_a_provider_genai_prices_does_not_list(provider_name, model_id, genai_lookups):
    cost = GenAIPricesEstimator()
    genai_lookups.clear()

    tru_estimate = cost.estimate(_request((_usage(1, 1), provider_name, model_id)))

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


def test_estimate_prices_a_litellm_model_id_without_a_provider_prefix_from_the_bundled_data():
    tru_estimate = GenAIPricesEstimator().estimate(_request((_usage(1_000, 100), "litellm", "gpt-4o")))

    assert tru_estimate.models[0].price_source == "genai-prices:openai/gpt-4o"


def test_estimate_leaves_a_bundled_price_with_a_fee_per_request_unpriced():
    usage = genai_prices.Usage(input_tokens=1_000, output_tokens=100)
    bundled = genai_prices.calc_price(usage, "sonar", provider_id="perplexity").model_price
    assert None not in (bundled.input_mtok, bundled.output_mtok, bundled.requests_kcount)

    tru_estimate = GenAIPricesEstimator().estimate(_request((_usage(1_000, 100), "litellm", "perplexity/sonar")))

    assert tru_estimate.total_usd is None
    assert tru_estimate.unpriced == tru_estimate.models


@pytest.mark.parametrize(("provider_name", "provider_id"), [("bedrock", "aws"), ("litellm", None)])
def test_estimate_leaves_a_model_id_the_bundled_data_does_not_match_unpriced(provider_name, provider_id):
    usage = genai_prices.Usage(input_tokens=1, output_tokens=1)
    with pytest.raises(LookupError):
        genai_prices.calc_price(usage, "no-such-model", provider_id=provider_id)

    tru_estimate = GenAIPricesEstimator().estimate(_request((_usage(1, 1), provider_name, "no-such-model")))

    assert tru_estimate.unpriced == tru_estimate.models


@pytest.mark.asyncio
async def test_estimate_accepts_an_agent_result_a_multi_agent_result_and_an_invocation_context():
    cost = GenAIPricesEstimator(prices=[MAIN_PRICE])
    agent = Agent(model=NamedModel("main", [_text("done")], [_usage(1_000, 100)]), callback_handler=None)

    result = await agent.invoke_async("go")

    exp_cost = (1_000 * 3.0 + 100 * 15.0) / 1_000_000
    for request in (result, MultiAgentResult(invocation_context=result.invocation_context), result.invocation_context):
        assert cost.estimate(request).total_usd == exp_cost


def test_estimate_accepts_usage_records():
    cost = GenAIPricesEstimator(prices=[MAIN_PRICE, SMALL_PRICE])
    usage_by_model = (
        ModelUsage(provider_name=None, model_id=model_id, usage=_usage(1_000, 100)) for model_id in ("main", "small")
    )

    tru_estimate = cost.estimate(usage_by_model)

    exp_costs = [(1_000 * 3.0 + 100 * 15.0) / 1_000_000, (1_000 * 1.0 + 100 * 5.0) / 1_000_000]
    assert [model.cost_usd for model in tru_estimate.models] == exp_costs
    assert tru_estimate.total_usd == math.fsum(exp_costs)


@pytest.mark.parametrize(
    "make_request",
    [
        lambda: None,
        lambda: Agent(model=NamedModel("main", [], []), callback_handler=None),
        lambda: object(),
        lambda: [_usage(1, 1)],
        lambda: "",
        lambda: {},
    ],
    ids=["none", "agent", "object", "usage-dicts", "string", "mapping"],
)
def test_estimate_rejects_what_is_not_a_request_or_usage_records(make_request):
    request = make_request()
    exp_message = f"request=<{type(request).__name__}> | expected an agent or multi-agent result"

    with pytest.raises(TypeError, match=re.escape(exp_message)):
        GenAIPricesEstimator().estimate(request)


def test_estimate_of_a_result_without_an_invocation_context_has_no_total():
    assert GenAIPricesEstimator().estimate(MultiAgentResult()) == CostEstimate(total_usd=None, models=())


def test_estimate_of_a_request_without_model_calls_is_zero():
    assert GenAIPricesEstimator().estimate(_create_invocation_context()) == CostEstimate(total_usd=0.0, models=())


def test_cost_estimate_event_is_a_typed_dict_with_the_request_and_the_model_call_estimates():
    usage = _usage(1_000, 100)
    model_call = _model_estimate(None, "main", usage, 0.0045, MAIN_PRICE)
    estimate = CostEstimate(total_usd=0.0045, models=(model_call,))

    tru_event = CostEstimateEvent(estimate, model_call)

    assert tru_event.as_dict() == {"type": "cost_estimate", "cost_estimate": estimate, "model_call": model_call}
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
MAIN_SECOND_CALL_COST = (2_500 * 3.0 + 18_000 * 0.3 + 900 * 15.0) / 1_000_000
MAIN_COST = (4_500 * 3.0 + 18_000 * 0.3 + 18_000 * 3.75 + 1_200 * 15.0) / 1_000_000
SMALL_COST = (40_000 * 1.0 + 1_500 * 5.0) / 1_000_000


@pytest.mark.asyncio
async def test_stream_emits_the_model_call_and_the_request_estimate_after_each_model_call(alist):
    cost = GenAIPricesEstimator(prices=[MAIN_PRICE, SMALL_PRICE])
    callback_events = []
    agent = _research_agent(
        [cost], lambda **kwargs: callback_events.append(kwargs) if kwargs.get("type") == "cost_estimate" else None
    )

    events = await alist(agent.stream_async("go"))

    tru_events = [event for event in events if event.get("type") == "cost_estimate"]
    assert [event["model_call"] for event in tru_events] == [
        _model_estimate(None, "main", _usage(2_000, 300, cache_write=18_000), MAIN_FIRST_CALL_COST, MAIN_PRICE),
        _model_estimate(None, "main", _usage(2_500, 900, cache_read=18_000), MAIN_SECOND_CALL_COST, MAIN_PRICE),
    ]
    assert [event["cost_estimate"].total_usd for event in tru_events] == [
        pytest.approx(MAIN_FIRST_CALL_COST),
        pytest.approx(MAIN_COST + SMALL_COST),
    ]
    assert [[model.model_id for model in event["cost_estimate"].models] for event in tru_events] == [
        ["main"],
        ["main", "small"],
    ]
    assert callback_events == tru_events
    assert tru_events[-1]["cost_estimate"] == cost.estimate(events[-1]["result"])


@pytest.mark.asyncio
async def test_stream_names_the_model_an_input_middleware_routed_the_call_to(alist):
    routed = NamedModel("small", [_text("done")], [_usage(1_000, 100)])
    agent = Agent(
        model=NamedModel("main", [], []),
        plugins=[GenAIPricesEstimator(prices=[MAIN_PRICE, SMALL_PRICE])],
        callback_handler=None,
    )
    agent.add_middleware(InvokeModelStage.Input, lambda context: context.replace(model=routed))

    events = await alist(agent.stream_async("go"))

    tru_model_ids = [event["model_call"].model_id for event in events if "model_call" in event]
    assert tru_model_ids == ["small"]


@pytest.mark.asyncio
async def test_stream_reports_a_model_call_without_a_price_as_unpriced(alist):
    agent = Agent(
        model=NamedModel("unlisted", [_text("done")], [_usage(1_000, 100)]),
        plugins=[GenAIPricesEstimator()],
        callback_handler=None,
    )

    events = await alist(agent.stream_async("go"))

    tru_model_calls = [event["model_call"] for event in events if "model_call" in event]
    assert tru_model_calls == [_model_estimate(None, "unlisted", _usage(1_000, 100), None, None)]


@pytest.mark.asyncio
async def test_stream_prices_a_vended_model_class_from_the_bundled_data(alist):
    class BedrockNamedModel(NamedModel, BedrockModel):
        """A Bedrock model that replays canned responses."""

        config = {}

    model = BedrockNamedModel("us.anthropic.claude-sonnet-4-20250514-v1:0", [_text("done")], [_usage(1_000, 100)])
    agent = Agent(model=model, plugins=[GenAIPricesEstimator()], callback_handler=None)

    events = await alist(agent.stream_async("go"))

    tru_model_call = next(event["model_call"] for event in events if "model_call" in event)
    assert tru_model_call.provider_name == "bedrock"
    assert tru_model_call.price_source.startswith("genai-prices:aws/")
    assert tru_model_call.cost_usd > 0


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
async def test_stream_finishes_without_an_estimate_when_pricing_raises(monkeypatch, caplog, alist):
    def failing_cost(usage, price):
        raise RuntimeError("pricing failed")

    monkeypatch.setattr(plugin_module, "_cost", failing_cost)
    agent = _research_agent([GenAIPricesEstimator(prices=[MAIN_PRICE, SMALL_PRICE])])

    with caplog.at_level(logging.WARNING, logger=plugin_module.__name__):
        events = await alist(agent.stream_async("go"))

    assert events[-1]["result"].stop_reason == "end_turn"
    assert [event for event in events if "cost_estimate" in event] == []
    tru_messages = [record.getMessage() for record in caplog.records if record.name == plugin_module.__name__]
    assert (
        tru_messages == ["error=<pricing failed> | cost estimate failed | no estimate emitted for this model call"] * 2
    )
