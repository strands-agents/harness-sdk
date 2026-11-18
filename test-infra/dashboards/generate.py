#!/usr/bin/env python3
"""Generate the CloudWatch dashboard bodies for the integ test metrics published by
.github/scripts/upload-integ-test-metrics.py (namespace Strands/Tests).

    python3 test-infra/dashboards/generate.py          # rewrite the *.json next to this file
    python3 test-infra/dashboards/generate.py --check  # exit 1 if a *.json is stale

Both dashboards share one layout, parametrised by SDK and shaped by the CloudWatch limits in README.md.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REGION = "us-east-1"
SCHEMA_PER_TEST = "{Strands/Tests,Repository,SDK,TestName}"
SCHEMA_PER_TEST_CONTEXT = "{Strands/Tests,Repository,SDK,TestName,Event,Branch,Leg}"
SCHEMA_SUITE = "{Strands/Tests,Repository,SDK,Event,Branch,Leg}"
INSIGHTS_SCHEMA = 'SCHEMA("Strands/Tests", Repository,SDK,TestName)'

HOUR = 3600
DAY = 86400
WEEK = 604800
MONTH = 30 * DAY

PUBLISHER_URL = "https://github.com/strands-agents/harness-sdk/blob/main/.github/scripts/upload-integ-test-metrics.py"
DASHBOARDS_URL = "https://github.com/strands-agents/harness-sdk/tree/main/test-infra/dashboards"

# Thresholds, repeated in widget titles so a reader never has to open the JSON.
FLAKY_LOW = 0.05
FLAKY_HIGH = 0.95
BROKEN_RATE = 0.95
MIN_RUNS = 5


@dataclass(frozen=True)
class DashboardSpec:
    sdk: str
    name: str
    # (label, SEARCH term): complete and < 450 series each, so the 500-series widget cap holds while renamed tests'
    # old names stay visible for 14 days. SEARCH tokenizes TestName on non-alphanumerics, so "models" matches
    # tests_integ.models.* and test/integ/models/*. A name carrying both project tokens appears in both partitions.
    partitions: tuple[tuple[str, str], ...]
    # (label, Leg, SEARCH term) for the nightly tables; every test the nightly run executes is in exactly one cell.
    nightly_partitions: tuple[tuple[str, str, str], ...]


TS_PARTITIONS = (
    ("browser, agent", "browser agent"),
    ("browser, interventions", "browser interventions NOT agent"),
    ("browser, other", "browser NOT agent NOT interventions"),
    ("node, agent", "node agent"),
    ("node, interventions", "node interventions NOT agent"),
    ("node, models", "node models NOT agent NOT interventions"),
    ("node, other", "node NOT agent NOT interventions NOT models"),
)

SPECS = (
    DashboardSpec(
        sdk="python",
        name="StrandsPythonIntegTests",
        partitions=(("models", "models"), ("other", "NOT models")),
        # The "all" leg (3.10) skips tests_integ/bidi and does not collect the mcp 1.x-only modules.
        nightly_partitions=(
            ("all leg, models", "all", "models"),
            ("all leg, other", "all", "NOT models"),
            ("bidi leg", "bidi", ""),
            ("mcp-1x leg", "mcp-1x", ""),
        ),
    ),
    DashboardSpec(
        sdk="typescript",
        name="StrandsTypescriptIntegTests",
        # TestName is `<vitest project>/<file>.<title>`, so `browser` / `node` are the project tokens (integ-browser,
        # integ-node). `node` also matches *.test.node.ts file names, which is why the node remainder is split once
        # more on `models` to keep its headroom.
        partitions=TS_PARTITIONS,
        # TypeScript has a single matrix leg, published as Leg="all".
        nightly_partitions=tuple((label, "all", term) for label, term in TS_PARTITIONS),
    ),
)


def search(schema: str, metric: str, sdk: str, stat: str, period: int, extra: str = "") -> str:
    terms = f'{schema} MetricName="{metric}" SDK="{sdk}"'
    if extra:
        terms = f"{terms} {extra}"
    return f"SEARCH('{terms}', '{stat}', {period})"


def insights(select: str, sdk: str) -> str:
    return f"SELECT {select} FROM {INSIGHTS_SCHEMA} WHERE SDK = '{sdk}'"


def expr(expression: str, id_: str, period: int, visible: bool = True, **extra: object) -> list[dict[str, object]]:
    row: dict[str, object] = {"expression": expression, "id": id_, "period": period}
    if not visible:
        row["visible"] = False
    row.update(extra)
    return [row]


def flaky_band(source_id: str, period: int, top_n: int) -> list[list[dict[str, object]]]:
    """Keep rates strictly inside (FLAKY_LOW, FLAKY_HIGH) and zero the rest; LOG10 of x <= 0 drops the series."""
    return [
        expr(f"10 ^ LOG10({source_id} - {FLAKY_LOW}) + {FLAKY_LOW}", "lo", period, visible=False),
        expr(f"{FLAKY_HIGH} - 10 ^ LOG10({FLAKY_HIGH} - lo)", "band", period, visible=False),
        expr(f"SORT(FILL(band, 0), MAX, DESC, {top_n})", "top", period),
    ]


class Layout:
    """Appends widgets top to bottom; `row` places several widgets side by side."""

    def __init__(self) -> None:
        self.widgets: list[dict[str, object]] = []
        self.y = 0

    def add(self, widget: dict[str, object], width: int, height: int, x: int = 0) -> None:
        self.widgets.append({**widget, "x": x, "y": self.y, "width": width, "height": height})

    def row(self, widgets: list[dict[str, object]], height: int) -> None:
        width = 24 // len(widgets)
        for index, widget in enumerate(widgets):
            self.add(widget, width, height, x=index * width)
        self.y += height

    def full(self, widget: dict[str, object], height: int) -> None:
        self.row([widget], height)


def text(markdown: str) -> dict[str, object]:
    return {"type": "text", "properties": {"markdown": markdown}}


def metric(
    title: str, metrics: list[list[dict[str, object]]], period: int, view: str, **props: object
) -> dict[str, object]:
    properties: dict[str, object] = {
        "title": title,
        "region": REGION,
        "view": view,
        "period": period,
        "metrics": metrics,
        **props,
    }
    return {"type": "metric", "properties": properties}


def table(
    title: str,
    metrics: list[list[dict[str, object]]],
    period: int,
    time_columns: bool = False,
    summary: str = "MAX",
) -> dict[str, object]:
    return metric(
        title,
        metrics,
        period,
        "table",
        table={"summaryColumns": [summary], "showTimeSeriesData": time_columns},
    )


def header(spec: DashboardSpec) -> str:
    return "\n".join(
        [
            f"## {spec.sdk.capitalize()} integration tests: health and flaky-test triage",
            "",
            "Every completed integration test run publishes one datapoint per test (TestPassed / TestFailed / "
            f"TestSkipped / TestDuration) from [upload-integ-test-metrics.py]({PUBLISHER_URL}). "
            f"This dashboard is generated from code in [test-infra/dashboards]({DASHBOARDS_URL}); edit it there.",
            "",
            "**How to read the per-test tables.** Each row is one test; the value is its failure rate over the window "
            "(failed / (passed + failed); a skipped execution publishes only TestSkipped and does not count). "
            "1.00 = failed every run (broken). "
            f"{FLAKY_LOW}-{FLAKY_HIGH} = flaky. A row showing 0 means no test in that group is inside the band. "
            "Tests are split into groups by name token because one widget can only show 500 series.",
            "",
            "**Caveats.** Most datapoints come from pull requests, so a PR breaking its own tests shows up here as "
            'flakiness; the "merge queue / main only" section at the bottom separates the two. Metric math cannot '
            'join a "minimum runs" filter onto a rate, so read the rate tables together with the '
            f'"fewer than {MIN_RUNS} runs" tables. Widgets built on Metrics Insights (SELECT ...) only see the last '
            "14 days whatever the time range says. A test that has not run for 14 days drops out of every table.",
        ]
    )


def last_publish_row(spec: DashboardSpec, layout: Layout) -> None:
    cards = [
        ("Failed, latest hour", "SUM(TestFailed)"),
        ("Passed, latest hour", "SUM(TestPassed)"),
        ("Skipped, latest hour", "SUM(TestSkipped)"),
        ("Datapoints published, latest hour (executed tests x runs; skips excluded)", "COUNT(TestFailed)"),
    ]
    layout.row(
        [
            metric(title, [expr(insights(select, spec.sdk), "q1", HOUR)], HOUR, "singleValue", sparkline=True)
            for title, select in cards
        ],
        4,
    )
    layout.full(
        metric(
            "Runs published per day, all legs and events (TestsRun)",
            [
                expr(search(SCHEMA_SUITE, "TestsRun", spec.sdk, "SampleCount", DAY), "runs", DAY, visible=False),
                expr("SUM(runs)", "total", DAY),
            ],
            DAY,
            "singleValue",
            sparkline=True,
        ),
        4,
    )


def suite_health(spec: DashboardSpec, layout: Layout) -> None:
    volume_note = "daily sums track PR volume, not health; read with the runs/day widget"
    failed = metric(
        f"Failed test executions per day, last 14 days (Metrics Insights cap); {volume_note}",
        [expr(insights("SUM(TestFailed)", spec.sdk), "q1", DAY, color="#d62728")],
        DAY,
        "timeSeries",
        stacked=False,
    )
    passing = metric(
        f"Share of executions passing per day, last 14 days; {volume_note}",
        [
            expr(insights("AVG(TestFailed)", spec.sdk), "fr", DAY, visible=False),
            expr("1 - fr", "passing", DAY, label="1 - failed/(passed + failed)"),
        ],
        DAY,
        "timeSeries",
        stacked=False,
        yAxis={"left": {"min": 0, "max": 1}},
        annotations={"horizontal": [{"value": 0.95, "label": "95% passing"}]},
    )
    layout.row([failed, passing], 6)

    suite_sums = [
        expr(search(SCHEMA_SUITE, "TestsPassed", spec.sdk, "Sum", DAY), "p", DAY, visible=False),
        expr(search(SCHEMA_SUITE, "TestsFailed", spec.sdk, "Sum", DAY), "f", DAY, visible=False),
    ]
    pass_rate = metric(
        "Pass rate per day, all events, 30 days",
        suite_sums + [expr("SUM(p) / (SUM(p) + SUM(f))", "rate", DAY, label="passed / (passed + failed)")],
        DAY,
        "timeSeries",
        stacked=False,
        yAxis={"left": {"min": 0, "max": 1}},
    )
    failed_tests = metric(
        "Failed tests per day, all events, 30 days",
        suite_sums + [expr("SUM(f)", "failed", DAY, label="failed tests", color="#d62728")],
        DAY,
        "timeSeries",
        stacked=False,
    )
    layout.row([pass_rate, failed_tests], 6)


def flaky_section(spec: DashboardSpec, layout: Layout) -> None:
    for label, term in spec.partitions:
        rate = expr(search(SCHEMA_PER_TEST, "TestFailed", spec.sdk, "Average", MONTH, term), "r", MONTH, visible=False)
        layout.full(
            table(
                f"Top 15 flaky tests, 30 days, {label}: failure rate strictly between {FLAKY_LOW} and {FLAKY_HIGH} "
                f"(0 = none in band; check the fewer-than-{MIN_RUNS}-runs table below)",
                [rate] + flaky_band("r", MONTH, 15),
                MONTH,
            ),
            9,
        )
    low_run_tables = [
        table(
            f"Tests with fewer than {MIN_RUNS} runs in 30 days, {label} (rates above are unreliable for these; "
            "value = runs, 0 = enough runs)",
            [
                expr(
                    search(SCHEMA_PER_TEST, "TestFailed", spec.sdk, "SampleCount", MONTH, term),
                    "n",
                    MONTH,
                    visible=False,
                ),
                expr(
                    f"SORT(FILL({MIN_RUNS - 0.5} - 10 ^ LOG10({MIN_RUNS - 0.5} - n), 0), MAX, DESC, 20)", "low", MONTH
                ),
            ],
            MONTH,
        )
        for label, term in spec.partitions
    ]
    for index in range(0, len(low_run_tables), 2):
        layout.row(low_run_tables[index : index + 2], 6)


def weekly_indicator(expression: str, id_: str) -> list[dict[str, object]]:
    """Per-week 0/1 flag sorted by flagged weeks; LOG10's NaNs would break SORT across several buckets."""
    return expr(f"SORT({expression}, SUM, DESC, 15)", id_, WEEK)


def weekly_section(spec: DashboardSpec, layout: Layout) -> None:
    for label, term in spec.partitions:
        rate = expr(search(SCHEMA_PER_TEST, "TestFailed", spec.sdk, "Average", WEEK, term), "r7", WEEK, visible=False)
        layout.full(
            table(
                f"Broken tests by week, {label}: 1 = failure rate at or above {BROKEN_RATE} that week "
                "(columns are weeks, rightmost = this week; summary = broken weeks; sample size: low-run table)",
                # FLOOR(r + 0.05) is 1 only when r >= 0.95.
                [rate, weekly_indicator(f"FLOOR(r7 + {round(1 - BROKEN_RATE, 4)})", "broken")],
                WEEK,
                time_columns=True,
                summary="SUM",
            ),
            8,
        )
    for label, term in spec.partitions:
        rate = expr(search(SCHEMA_PER_TEST, "TestFailed", spec.sdk, "Average", WEEK, term), "r7", WEEK, visible=False)
        half_width = round((FLAKY_HIGH - FLAKY_LOW) / 2, 4)
        centre = round((FLAKY_HIGH + FLAKY_LOW) / 2, 4)
        layout.full(
            table(
                f"Recently flaky by week, {label}: 1 = failure rate strictly between {FLAKY_LOW} and {FLAKY_HIGH} "
                "that week (columns are weeks, rightmost = this week; summary = flaky weeks)",
                # CEIL(0.45 - |r - 0.5|) is 1 only when 0.05 < r < 0.95; the outer ABS turns the -0 that CEIL
                # yields for r = 0 or r = 1 into a plain 0.
                [rate, weekly_indicator(f"ABS(CEIL({half_width} - ABS(r7 - {centre})))", "flaky")],
                WEEK,
                time_columns=True,
                summary="SUM",
            ),
            8,
        )


def duration_section(spec: DashboardSpec, layout: Layout) -> None:
    for label, term in spec.partitions:
        slowest = table(
            f"10 slowest tests, p90 duration in seconds over 30 days, {label}",
            [
                expr(
                    f"SORT({search(SCHEMA_PER_TEST, 'TestDuration', spec.sdk, 'p90', MONTH, term)}, MAX, DESC, 10)",
                    "slow",
                    MONTH,
                )
            ],
            MONTH,
        )
        trend = metric(
            f"Mean of per-test p90 duration per day, seconds, {label}",
            [
                expr(search(SCHEMA_PER_TEST, "TestDuration", spec.sdk, "p90", DAY, term), "d", DAY, visible=False),
                expr("AVG(d)", "mean_p90", DAY, label="mean of per-test p90"),
            ],
            DAY,
            "timeSeries",
            stacked=False,
        )
        layout.row([slowest, trend], 6)


def main_only_section(spec: DashboardSpec, layout: Layout) -> None:
    non_pr = 'Branch="main" NOT "pull_request_target"'
    # Pin every context dimension so each test is one series.
    nightly = 'Event="schedule" Branch="main"'
    layout.full(
        metric(
            "Pass rate per day, merge queue and nightly runs on main only",
            [
                expr(search(SCHEMA_SUITE, "TestsPassed", spec.sdk, "Sum", DAY, non_pr), "p", DAY, visible=False),
                expr(search(SCHEMA_SUITE, "TestsFailed", spec.sdk, "Sum", DAY, non_pr), "f", DAY, visible=False),
                expr("SUM(p) / (SUM(p) + SUM(f))", "rate", DAY, label="passed / (passed + failed)"),
            ],
            DAY,
            "timeSeries",
            stacked=False,
            yAxis={"left": {"min": 0, "max": 1}},
        ),
        6,
    )
    for label, leg, term in spec.nightly_partitions:
        pinned = f'{nightly} Leg="{leg}"'
        rate = expr(
            search(SCHEMA_PER_TEST_CONTEXT, "TestFailed", spec.sdk, "Average", MONTH, f"{pinned} {term}".rstrip()),
            "rb",
            MONTH,
            visible=False,
        )
        layout.full(
            table(
                f"Top 15 flaky tests, 30 days, nightly runs on main only, {label}: failure rate strictly between "
                f"{FLAKY_LOW} and {FLAKY_HIGH}",
                [rate] + flaky_band("rb", MONTH, 15),
                MONTH,
            ),
            9,
        )


def section(layout: Layout, title: str, blurb: str) -> None:
    layout.full(text(f"### {title}\n{blurb}"), 2)


def build(spec: DashboardSpec) -> dict[str, Any]:
    layout = Layout()
    layout.full(text(header(spec)), 7)
    section(layout, "Latest publish", "Sums over the most recent hour with data; the sparkline is the last 30 days.")
    last_publish_row(spec, layout)
    section(
        layout,
        "Suite health",
        "Left pair: last 14 days from Metrics Insights. Right pair: 30 days from suite counters.",
    )
    suite_health(spec, layout)
    section(
        layout,
        "Flaky tests, 30 days",
        f"Sorted by failure rate inside the ({FLAKY_LOW}, {FLAKY_HIGH}) band; the top row is the worst flake.",
    )
    flaky_section(spec, layout)
    section(
        layout, "Broken and recently flaky, by week", "Week columns show whether a problem is new, ongoing or fixed."
    )
    weekly_section(spec, layout)
    section(layout, "Duration", "p90 of each test's TestDuration; the trend is the mean of those p90s per day.")
    duration_section(spec, layout)
    section(
        layout,
        "Merge queue / main only",
        "Pass rate: every run that is not a pull request (merge queue, nightly and release runs). "
        "Flaky tables: the nightly run on main only, one table per matrix leg and name group.",
    )
    main_only_section(spec, layout)
    return {"start": "-P30D", "periodOverride": "inherit", "widgets": layout.widgets}


def render(body: dict[str, Any]) -> str:
    return json.dumps(body, indent=2) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="do not write; exit 1 if any dashboard file is stale")
    args = parser.parse_args(argv)

    out_dir = Path(__file__).resolve().parent
    stale = []
    for spec in SPECS:
        path = out_dir / f"{spec.name}.json"
        dashboard = build(spec)
        body = render(dashboard)
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != body:
                stale.append(path.name)
            continue
        path.write_text(body, encoding="utf-8")
        print(f"wrote {path.name}: {len(dashboard['widgets'])} widgets, {len(body.encode())} bytes")

    if stale:
        print(f"stale: {', '.join(stale)}; run python3 {Path(__file__).name} to regenerate", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
