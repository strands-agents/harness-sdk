"""Cost estimate plugin for Strands Agents.

Estimates what a request cost in USD from its token usage per model and the list prices bundled in the
third-party ``genai-prices`` package. The estimate is not a bill.

Requires the optional ``cost-estimator`` extra (``pip install 'strands-agents[cost-estimator]'``) and
Python 3.11+; importing this module without it raises :class:`ImportError`.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_plugins.cost_estimator import GenAIPricesEstimator

    cost = GenAIPricesEstimator()
    agent = Agent(plugins=[cost])

    async for event in agent.stream_async("Compare the three proposals."):
        if event.get("type") == "cost_estimate":
            print("so far:", event["cost_estimate"].total_usd)
        if "result" in event:
            print("request:", cost.estimate(event["result"]).total_usd)
    ```
"""

from .plugin import CostEstimate, CostEstimateEvent, GenAIPricesEstimator, ModelCostEstimate, ModelPrice

__all__ = [
    "CostEstimate",
    "CostEstimateEvent",
    "GenAIPricesEstimator",
    "ModelCostEstimate",
    "ModelPrice",
]
