#!/usr/bin/env python3
"""Count the series each per-test SEARCH partition of the integ dashboards returns and fail near the cap.

    python3 test-infra/dashboards/check_series.py                 # every partition of every dashboard
    python3 test-infra/dashboards/check_series.py --sdk typescript --threshold 400

Needs read-only CloudWatch credentials (cloudwatch:GetMetricData) for the test account; one GetMetricData call per
partition. A widget shows at most 500 series and drops the rest silently, so run this after adding tests or changing
the partitions in generate.py and split a partition before it reaches the threshold.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import boto3

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate  # noqa: E402

SERIES_CAP = 500
DEFAULT_THRESHOLD = 400
# SEARCH only sees metrics that received data in the last two weeks, so a longer window adds nothing.
LOOKBACK = timedelta(days=14)
MAX_METRICS_EXCEEDED = "MaxMetricsExceeded"


def count_series(cloudwatch: Any, spec: generate.DashboardSpec, term: str) -> tuple[int, bool]:
    """Series returned by the partition's TestFailed SEARCH and whether CloudWatch reported the cap was exceeded."""
    expression = generate.search(generate.SCHEMA_PER_TEST, "TestFailed", spec.sdk, "SampleCount", generate.MONTH, term)
    end = datetime.now(timezone.utc)
    request: dict[str, Any] = {
        "MetricDataQueries": [{"Id": "q", "Expression": expression, "Period": generate.MONTH, "ReturnData": True}],
        "StartTime": end - LOOKBACK,
        "EndTime": end,
    }
    series = 0
    exceeded = False
    while True:
        response = cloudwatch.get_metric_data(**request)
        series += len(response["MetricDataResults"])
        exceeded |= any(message["Code"] == MAX_METRICS_EXCEEDED for message in response.get("Messages", []))
        token = response.get("NextToken")
        if not token:
            return series, exceeded
        request["NextToken"] = token


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sdk", action="append", help="only check this SDK's dashboard (repeatable)")
    parser.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD, help="fail above this many series")
    parser.add_argument("--region", default=generate.REGION)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cloudwatch = boto3.client("cloudwatch", region_name=args.region)
    specs = [spec for spec in generate.SPECS if not args.sdk or spec.sdk in args.sdk]
    status = 0
    for spec in specs:
        for label, term in spec.partitions:
            series, exceeded = count_series(cloudwatch, spec, term)
            note = f" ({MAX_METRICS_EXCEEDED})" if exceeded else ""
            print(f"{spec.sdk} {label}: {series} series{note}")
            if series > args.threshold or exceeded:
                print(f"::error::{spec.sdk} '{label}' is above {args.threshold} of the {SERIES_CAP}-series cap")
                status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
