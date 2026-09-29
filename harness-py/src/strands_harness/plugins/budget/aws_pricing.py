"""Fetch optional Amazon Bedrock rates from the AWS Price List API.

The returned table contains per-token input and output rates. A fetch failure
returns an empty table, so callers can continue with explicitly supplied rates.
"""

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

_PRICING_ENDPOINT_REGION = "us-east-1"
_EXCLUDED_USAGETYPE_MARKERS = ("-batch", "-custom-model", "cross-region", "-flex", "-priority")


def find_rates(products: list[dict[str, Any]], suffix: str) -> dict[str, float]:
    """Extract per-token rates for one token direction from pricing products.

    Args:
        products: Parsed AWS Price List product records.
        suffix: Usage-type suffix, such as ``"-input-tokens"``.

    Returns:
        Rates keyed by normalized model names and usage-type model names.
    """
    rates: dict[str, float] = {}

    for product in products:
        attributes = product.get("product", {}).get("attributes", {})
        usage_type = attributes.get("usagetype", "")
        normalized_usage_type = usage_type.lower()

        if not normalized_usage_type.endswith(suffix):
            continue
        if any(marker in normalized_usage_type for marker in _EXCLUDED_USAGETYPE_MARKERS):
            continue

        for term in product.get("terms", {}).get("OnDemand", {}).values():
            for dimension in term.get("priceDimensions", {}).values():
                if dimension.get("unit") != "1K tokens":
                    continue

                price_per_1k = float(dimension.get("pricePerUnit", {}).get("USD", 0))
                if price_per_1k <= 0:
                    continue
                rate = price_per_1k / 1000

                core = normalized_usage_type[: -len(suffix)].partition("-")[2]
                if core:
                    rates[core] = rate

                model = attributes.get("model", "").lower().strip().replace(" ", "-")
                if model:
                    rates[model] = rate

    return rates


def build_rates_from_products(
    input_products: list[dict[str, Any]], output_products: list[dict[str, Any]]
) -> dict[str, tuple[float, float]]:
    """Combine products that contain both input and output token prices."""
    input_rates = find_rates(input_products, "-input-tokens")
    output_rates = find_rates(output_products, "-output-tokens")

    models = input_rates.keys() & output_rates.keys()
    return {model: (input_rates[model], output_rates[model]) for model in models}


def fetch_aws_rates(region_name: str = "us-east-1", boto_session: Any = None) -> dict[str, tuple[float, float]]:
    """Fetch Amazon Bedrock on-demand token rates.

    Args:
        region_name: Amazon Bedrock region used to filter pricing products.
        boto_session: Optional boto3 session or module used to create the
            pricing client.

    Returns:
        Per-token rates, or an empty dictionary when the request fails.
    """
    try:
        import boto3

        session = boto_session or boto3
        pricing_client = session.client("pricing", region_name=_PRICING_ENDPOINT_REGION)
        paginator = pricing_client.get_paginator("get_products")

        def query(inference_type: str) -> list[dict[str, Any]]:
            filters = [
                {"Type": "TERM_MATCH", "Field": "regionCode", "Value": region_name},
                {"Type": "TERM_MATCH", "Field": "inferenceType", "Value": inference_type},
            ]
            products: list[dict[str, Any]] = []
            for page in paginator.paginate(ServiceCode="AmazonBedrock", Filters=filters):
                products.extend(json.loads(price) for price in page["PriceList"])
            return products

        rates = build_rates_from_products(query("Input tokens"), query("Output tokens"))
        logger.info("region=<%s>, models=<%d> | Amazon Bedrock pricing fetched", region_name, len(rates))
        return rates
    except Exception as error:
        logger.warning("region=<%s>, error=<%s> | Amazon Bedrock pricing fetch failed", region_name, error)
        return {}


def format_rates(rates: dict[str, tuple[float, float]]) -> str:
    """Format a per-token rate table for display."""
    if not rates:
        return "(no rates)"

    width = max(len(key) for key in rates)
    header = f"{'model':<{width}}  {'input $/token':>15}  {'output $/token':>15}"
    lines = [header, "-" * len(header)]
    for key in sorted(rates):
        input_rate, output_rate = rates[key]
        lines.append(f"{key:<{width}}  {input_rate:>15.10f}  {output_rate:>15.10f}")
    return "\n".join(lines)
