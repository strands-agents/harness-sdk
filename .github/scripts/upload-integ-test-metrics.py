#!/usr/bin/env python3
import argparse
import os
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, TypedDict

import boto3

STRANDS_METRIC_NAMESPACE = "Strands/Tests"

# One non-printable-ASCII dimension value rejects the whole put_metric_data batch. Applied after NFKC, which
# already maps "…" and NBSP; anything left outside 0x20-0x7E becomes "?".
TRANSLITERATIONS = {
    "→": "->",
    "←": "<-",
    "—": "-",
    "–": "-",
    "‘": "'",
    "’": "'",
    "“": '"',
    "”": '"',
}
MAX_DIMENSION_LENGTH = 255
MAX_TIMESTAMP_AGE_DAYS = 13

# The only event the dashboards read the per-test context schema for (see build_metric_data).
CONTEXT_SCHEMA_EVENT = "schedule"


class Dimension(TypedDict):
    Name: str
    Value: str


class MetricDatum(TypedDict):
    MetricName: str
    Dimensions: list[Dimension]
    Value: float
    Unit: str
    Timestamp: datetime


@dataclass
class TestResult:
    name: str
    classname: str
    duration: float
    outcome: Literal["failed", "skipped", "passed"]
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


def suite_timestamp(attr: str | None, now: datetime) -> datetime:
    """Parse a <testsuite timestamp> (naive = UTC, as on GitHub runners), falling back to `now` when it is missing,
    unparsable, in the future, or outside CloudWatch's two-week put_metric_data window."""
    if not attr:
        return now
    try:
        parsed = datetime.fromisoformat(attr)
    except ValueError:
        return now
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if parsed > now or now - parsed > timedelta(days=MAX_TIMESTAMP_AGE_DAYS):
        return now
    return parsed


def _parse_testcase(testcase: ET.Element, timestamp: datetime) -> TestResult | None:
    name = testcase.get("name")
    classname = testcase.get("classname")
    if not name or not classname:
        return None
    duration = float(testcase.get("time", 0.0))

    if testcase.find("failure") is not None or testcase.find("error") is not None:
        outcome = "failed"
    elif testcase.find("skipped") is not None:
        outcome = "skipped"
    else:
        outcome = "passed"

    return TestResult(name, classname, duration, outcome, timestamp)


def sanitize_test_name(name: str) -> str:
    normalized = unicodedata.normalize("NFKC", name)
    for char, replacement in TRANSLITERATIONS.items():
        normalized = normalized.replace(char, replacement)
    ascii_only = "".join(c if 0x20 <= ord(c) <= 0x7E else "?" for c in normalized)
    return ascii_only[:MAX_DIMENSION_LENGTH]


def parse_junit_xml(xml_file_path: str) -> list[TestResult] | None:
    try:
        tree = ET.parse(xml_file_path)
    except FileNotFoundError:
        print(f"Warning: XML file not found: {xml_file_path}")
        return None
    except ET.ParseError as e:
        print(f"Warning: Failed to parse XML: {e}")
        return None

    now = datetime.now(timezone.utc)
    root = tree.getroot()
    # pytest writes one <testsuite>; vitest writes one per file. Each suite's timestamp applies to its direct
    # <testcase> children. A report with no <testsuite> at all is stamped with the upload time.
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    if not suites:
        parsed = (_parse_testcase(tc, now) for tc in root.iter("testcase"))
        return [result for result in parsed if result is not None]

    results = []
    for suite in suites:
        timestamp = suite_timestamp(suite.get("timestamp"), now)
        parsed = (_parse_testcase(tc, timestamp) for tc in suite.findall("testcase"))
        results.extend(result for result in parsed if result is not None)
    return results


@dataclass(frozen=True)
class RunContext:
    """Where a publish came from. Bounded cardinality: event names, base branches and matrix legs only."""

    event: str
    branch: str
    leg: str


def resolve_branch(env: Mapping[str, str]) -> str:
    """Base branch of the run: PR base, merge-queue base, or the pushed/scheduled ref. Never a PR head branch."""
    base_ref = env.get("GITHUB_BASE_REF", "")
    if base_ref:
        return base_ref
    ref_name = env.get("GITHUB_REF_NAME", "")
    if not ref_name:
        return "unknown"
    ref_name = ref_name.removeprefix("refs/heads/")
    queue = re.fullmatch(r"gh-readonly-queue/(.+)/pr-\d+-[0-9a-f]+", ref_name)
    return queue.group(1) if queue else ref_name


def _test_datums(test: TestResult, dimensions: list[Dimension], timestamp: datetime) -> list[MetricDatum]:
    values = [
        ("TestPassed", 1.0 if test.outcome == "passed" else 0.0, "Count"),
        ("TestFailed", 1.0 if test.outcome == "failed" else 0.0, "Count"),
        ("TestSkipped", 1.0 if test.outcome == "skipped" else 0.0, "Count"),
        ("TestDuration", test.duration, "Seconds"),
    ]
    return [
        MetricDatum(MetricName=name, Dimensions=dimensions, Value=value, Unit=unit, Timestamp=timestamp)
        for name, value, unit in values
    ]


def _suite_datums(
    test_results: list[TestResult], dimensions: list[Dimension], timestamp: datetime
) -> list[MetricDatum]:
    counts = Counter(test.outcome for test in test_results)
    values = [
        ("TestsRun", float(len(test_results))),
        ("TestsPassed", float(counts["passed"])),
        ("TestsFailed", float(counts["failed"])),
        ("TestsSkipped", float(counts["skipped"])),
    ]
    return [
        MetricDatum(MetricName=name, Dimensions=dimensions, Value=value, Unit="Count", Timestamp=timestamp)
        for name, value in values
    ]


def build_metric_data(test_results: list[TestResult], repository: str, sdk: str, ctx: RunContext) -> list[MetricDatum]:
    """Per-test datums on (Repository, SDK, TestName) for every run, the same with (Event, Branch, Leg) for
    nightly runs only, and one set of suite-level Tests* counters per publish.

    Context dimensions stay off the first schema because they would multiply series per test past the 500-series
    SEARCH cap.
    """
    metrics: list[MetricDatum] = []
    context_dimensions = [
        Dimension(Name="Event", Value=ctx.event),
        Dimension(Name="Branch", Value=ctx.branch),
        Dimension(Name="Leg", Value=ctx.leg),
    ]
    emit_context_schema = ctx.event == CONTEXT_SCHEMA_EVENT

    for test in test_results:
        test_name = sanitize_test_name(f"{test.classname}.{test.name}")
        dimensions: list[Dimension] = [
            Dimension(Name="TestName", Value=test_name),
            Dimension(Name="Repository", Value=repository),
            Dimension(Name="SDK", Value=sdk),
        ]
        metrics.extend(_test_datums(test, dimensions, test.timestamp))
        if emit_context_schema:
            metrics.extend(_test_datums(test, dimensions + context_dimensions, test.timestamp))

    suite_dimensions = [Dimension(Name="Repository", Value=repository), Dimension(Name="SDK", Value=sdk)]
    earliest = min(test.timestamp for test in test_results)
    metrics.extend(_suite_datums(test_results, suite_dimensions + context_dimensions, earliest))
    return metrics


def _test_names(batch: list[dict[str, Any]]) -> list[str]:
    names = {dim["Value"] for datum in batch for dim in datum["Dimensions"] if dim["Name"] == "TestName"}
    return sorted(names)


def publish_metrics(metric_data: list[dict[str, Any]], cloudwatch: Any) -> int:
    """Publish in batches of 1000; a failed batch never blocks the others. Returns the number of failed batches."""
    failed_batches = 0

    batch_size = 1000
    for i in range(0, len(metric_data), batch_size):
        batch = metric_data[i : i + batch_size]
        try:
            cloudwatch.put_metric_data(Namespace=STRANDS_METRIC_NAMESPACE, MetricData=batch)
            print(f"Published {len(batch)} metrics to CloudWatch")
        except Exception as e:
            failed_batches += 1
            names = _test_names(batch)
            print(f"::error::Failed to publish a batch of {len(batch)} metrics ({len(names)} tests): {e}")
            for name in names:
                print(f"::error::Metrics not published for test: {name}")
    return failed_batches


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish JUnit results to CloudWatch (namespace Strands/Tests).")
    parser.add_argument("xml_file", help="JUnit XML report")
    parser.add_argument("repository", help="Repository dimension value, e.g. harness-sdk")
    parser.add_argument("sdk", nargs="?", default="python", help="SDK dimension value (default: python)")
    parser.add_argument(
        "--event",
        default=os.environ.get("GITHUB_EVENT_NAME", "unknown"),
        help="Event dimension; defaults to GITHUB_EVENT_NAME",
    )
    parser.add_argument(
        "--branch",
        default=resolve_branch(os.environ),
        help="Branch dimension; defaults to the PR/merge-queue base or GITHUB_REF_NAME",
    )
    parser.add_argument("--leg", default="all", help="Leg dimension: the matrix leg that produced the report")
    parser.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    return parser.parse_args(argv)


def main():
    args = parse_args()
    ctx = RunContext(event=args.event, branch=args.branch, leg=args.leg)

    test_results = parse_junit_xml(args.xml_file)
    if test_results is None:
        sys.exit(1)
    if not test_results:
        print("No test results to publish")
        return

    print(f"Found {len(test_results)} test results (event={ctx.event}, branch={ctx.branch}, leg={ctx.leg})")
    metric_data = build_metric_data(test_results, args.repository, args.sdk, ctx)
    cloudwatch = boto3.client("cloudwatch", region_name=args.region)
    failed_batches = publish_metrics(metric_data, cloudwatch)
    if failed_batches:
        print(f"::error::{failed_batches} metric batches were rejected")
        sys.exit(1)


if __name__ == "__main__":
    main()
