#!/usr/bin/env python3
import os
import sys
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, TypedDict

import boto3

STRANDS_METRIC_NAMESPACE = "Strands/Tests"

# CloudWatch dimension values must be printable ASCII and at most 255 characters; a single offending
# value rejects the whole put_metric_data batch. Characters seen in real test names get a readable ASCII
# form so the name stays searchable; anything else outside 0x20-0x7E becomes "?".
TRANSLITERATIONS = {
    "→": "->",
    "←": "<-",
    "—": "-",
    "–": "-",
    "‘": "'",
    "’": "'",
    "“": '"',
    "”": '"',
    "…": "...",
    "\u00a0": " ",
}
MAX_DIMENSION_LENGTH = 255


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

    results = []
    root = tree.getroot()

    for testcase in root.iter("testcase"):
        name = testcase.get("name")
        classname = testcase.get("classname")
        duration = float(testcase.get("time", 0.0))

        if not name or not classname:
            continue

        if testcase.find("failure") is not None or testcase.find("error") is not None:
            outcome = "failed"
        elif testcase.find("skipped") is not None:
            outcome = "skipped"
        else:
            outcome = "passed"

        results.append(TestResult(name, classname, duration, outcome))

    return results


def build_metric_data(test_results: list[TestResult], repository: str, sdk: str) -> list[MetricDatum]:
    metrics: list[MetricDatum] = []
    timestamp = datetime.now(timezone.utc)

    for test in test_results:
        test_name = sanitize_test_name(f"{test.classname}.{test.name}")
        dimensions: list[Dimension] = [
            Dimension(Name="TestName", Value=test_name),
            Dimension(Name="Repository", Value=repository),
            Dimension(Name="SDK", Value=sdk),
        ]

        metrics.append(
            MetricDatum(
                MetricName="TestPassed",
                Dimensions=dimensions,
                Value=1.0 if test.outcome == "passed" else 0.0,
                Unit="Count",
                Timestamp=timestamp,
            )
        )

        metrics.append(
            MetricDatum(
                MetricName="TestFailed",
                Dimensions=dimensions,
                Value=1.0 if test.outcome == "failed" else 0.0,
                Unit="Count",
                Timestamp=timestamp,
            )
        )

        metrics.append(
            MetricDatum(
                MetricName="TestSkipped",
                Dimensions=dimensions,
                Value=1.0 if test.outcome == "skipped" else 0.0,
                Unit="Count",
                Timestamp=timestamp,
            )
        )

        metrics.append(
            MetricDatum(
                MetricName="TestDuration",
                Dimensions=dimensions,
                Value=test.duration,
                Unit="Seconds",
                Timestamp=timestamp,
            )
        )

    return metrics


def publish_metrics(metric_data: list[dict[str, Any]], region: str):
    cloudwatch = boto3.client("cloudwatch", region_name=region)

    batch_size = 1000
    for i in range(0, len(metric_data), batch_size):
        batch = metric_data[i : i + batch_size]
        try:
            cloudwatch.put_metric_data(Namespace=STRANDS_METRIC_NAMESPACE, MetricData=batch)
            print(f"Published {len(batch)} metrics to CloudWatch")
        except Exception as e:
            print(f"Warning: Failed to publish metrics batch: {e}")


def main():
    if len(sys.argv) not in (3, 4):
        print("Usage: python upload-integ-test-metrics.py <xml_file> <repository_name> [sdk]")
        sys.exit(1)

    xml_file = sys.argv[1]
    repository = sys.argv[2]
    sdk = sys.argv[3] if len(sys.argv) > 3 else "python"
    region = os.environ.get("AWS_REGION", "us-east-1")

    test_results = parse_junit_xml(xml_file)
    if test_results is None:
        sys.exit(1)
    if not test_results:
        print("No test results to publish")
        return

    print(f"Found {len(test_results)} test results")
    metric_data = build_metric_data(test_results, repository, sdk)
    publish_metrics(metric_data, region)


if __name__ == "__main__":
    main()
