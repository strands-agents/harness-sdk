"""Unit tests for upload-integ-test-metrics.py (run with `python -m pytest .github/scripts -q`)."""

import importlib.util
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

SCRIPT = Path(__file__).with_name("upload-integ-test-metrics.py")


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("upload_integ_test_metrics", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_junit(tmp_path: Path, body: str, suite_attrs: str = "") -> str:
    xml = (
        '<?xml version="1.0" encoding="utf-8"?>'
        f'<testsuites><testsuite name="pytest" {suite_attrs}>{body}</testsuite></testsuites>'
    )
    path = tmp_path / "test-results.xml"
    path.write_text(xml, encoding="utf-8")
    return str(path)


THREE_CASES = (
    '<testcase classname="tests_integ.test_a" name="test_passed" time="1.5"/>'
    '<testcase classname="tests_integ.test_a" name="test_failed" time="2.0"><failure message="boom"/></testcase>'
    '<testcase classname="tests_integ.test_a" name="test_skipped" time="0.0"><skipped message="no key"/></testcase>'
)


def test_parse_junit_xml_returns_one_result_per_testcase(mod, tmp_path):
    results = mod.parse_junit_xml(write_junit(tmp_path, THREE_CASES))

    assert [(r.name, r.outcome, r.duration) for r in results] == [
        ("test_passed", "passed", 1.5),
        ("test_failed", "failed", 2.0),
        ("test_skipped", "skipped", 0.0),
    ]


@pytest.mark.parametrize("time_attr", ['time=""', 'time="NaN"', 'time="inf"', 'time="-Infinity"', 'time="abc"', ""])
def test_parse_junit_xml_defaults_malformed_time_to_zero_and_keeps_the_leg(mod, tmp_path, time_attr):
    body = f'<testcase classname="tests_integ.test_a" name="test_odd" {time_attr}><failure/></testcase>' + THREE_CASES

    results = mod.parse_junit_xml(write_junit(tmp_path, body))

    assert [(r.name, r.outcome, r.duration) for r in results] == [
        ("test_odd", "failed", 0.0),
        ("test_passed", "passed", 1.5),
        ("test_failed", "failed", 2.0),
        ("test_skipped", "skipped", 0.0),
    ]


HASH_SUFFIX = r"#[0-9a-f]{6}$"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Agent > tool → result", "Agent > tool -> result"),
        ("Agent — with em dash", "Agent - with em dash"),
        ("wait… for it", "wait... for it"),
        ("café", "caf?"),
    ],
)
def test_sanitize_test_name_maps_to_printable_ascii_with_a_hash_suffix(mod, raw, expected):
    assert re.fullmatch(re.escape(expected) + HASH_SUFFIX, mod.sanitize_test_name(raw))


def test_sanitize_test_name_leaves_printable_ascii_unchanged(mod):
    assert mod.sanitize_test_name("plain.ascii[param-1]") == "plain.ascii[param-1]"


def test_sanitize_test_name_keeps_names_that_sanitise_alike_distinct(mod):
    sanitized = {mod.sanitize_test_name(name) for name in ["café", "cafe", "caf\u00e8"]}

    assert len(sanitized) == 3
    assert mod.sanitize_test_name("café") == mod.sanitize_test_name("café")


def test_sanitize_test_name_caps_at_255_chars(mod):
    sanitized = mod.sanitize_test_name("x" * 300)

    assert len(sanitized) == 255
    assert re.fullmatch("x" * 248 + HASH_SUFFIX, sanitized)
    assert sanitized != mod.sanitize_test_name("x" * 301)


class FakeCloudWatch:
    """put_metric_data stub that raises on the batch indices listed in `fail_on`."""

    def __init__(self, fail_on=()):
        self.fail_on = set(fail_on)
        self.batches = []

    def put_metric_data(self, Namespace, MetricData):
        index = len(self.batches)
        self.batches.append(MetricData)
        if index in self.fail_on:
            raise RuntimeError(f"batch {index} rejected")


@pytest.fixture
def pr_ctx(mod):
    return mod.RunContext(event="pull_request_target", branch="main", leg="all")


def results_named(mod, names):
    return [mod.TestResult(name=n, classname="suite", duration=0.1, outcome="passed") for n in names]


def test_publish_metrics_isolates_failed_batch_and_reports_its_tests(mod, capsys):
    # 749 tests x 4 datums + 4 suite datums = 3000 datums = 3 batches, 250 tests per batch.
    ctx = mod.RunContext(event="pull_request_target", branch="main", leg="all")
    data = mod.build_metric_data(results_named(mod, [f"t{i:03d}" for i in range(749)]), "repo", "python", ctx)
    client = FakeCloudWatch(fail_on={1})

    failed = mod.publish_metrics(data, client)

    assert len(client.batches) == 3
    assert failed == 1
    out = capsys.readouterr().out
    assert "::error::Metrics not published for test: suite.t250" in out
    assert "::error::Metrics not published for test: suite.t499" in out
    assert "suite.t000" not in out
    assert "suite.t500" not in out


def test_publish_metrics_counts_a_failed_suite_only_batch(mod):
    # 250 tests x 4 datums fill exactly one batch, so the 4 suite datums form a batch without any TestName.
    ctx = mod.RunContext(event="pull_request_target", branch="main", leg="all")
    data = mod.build_metric_data(results_named(mod, [f"t{i:03d}" for i in range(250)]), "repo", "python", ctx)
    client = FakeCloudWatch(fail_on={1})

    assert mod.publish_metrics(data, client) == 1
    assert [len(batch) for batch in client.batches] == [1000, 4]


def test_main_exits_non_zero_when_a_batch_fails(mod, tmp_path, monkeypatch):
    client = FakeCloudWatch(fail_on={0})
    monkeypatch.setattr(mod.boto3, "client", lambda *args, **kwargs: client)
    monkeypatch.setattr(sys, "argv", ["upload", write_junit(tmp_path, THREE_CASES), "harness-sdk", "python"])

    with pytest.raises(SystemExit) as exc:
        mod.main()

    assert exc.value.code == 1
    assert len(client.batches) == 1


def test_main_succeeds_when_all_batches_publish(mod, tmp_path, monkeypatch):
    client = FakeCloudWatch()
    monkeypatch.setattr(mod.boto3, "client", lambda *args, **kwargs: client)
    monkeypatch.setattr(sys, "argv", ["upload", write_junit(tmp_path, THREE_CASES), "harness-sdk", "python"])

    mod.main()

    assert len(client.batches) == 1


def test_main_fails_without_publishing_above_the_test_name_ceiling(mod, tmp_path, monkeypatch, capsys):
    client = FakeCloudWatch()
    monkeypatch.setattr(mod.boto3, "client", lambda *args, **kwargs: client)
    argv = ["upload", write_junit(tmp_path, THREE_CASES), "harness-sdk", "python", "--max-test-names", "2"]
    monkeypatch.setattr(sys, "argv", argv)

    with pytest.raises(SystemExit) as exc:
        mod.main()

    assert exc.value.code == 1
    assert client.batches == []
    assert "::error::3 distinct TestName values for (harness-sdk, python) exceed --max-test-names 2" in (
        capsys.readouterr().out
    )


def test_test_name_keeps_the_vitest_project_prefix_from_the_classname(mod):
    results = [
        mod.TestResult(
            name="Agent > invoke", classname=f"{project}/test/integ/foo.test.ts", duration=1.0, outcome="passed"
        )
        for project in ("integ-node", "integ-browser")
    ]

    assert [mod.test_name(result) for result in results] == [
        "integ-node/test/integ/foo.test.ts.Agent > invoke",
        "integ-browser/test/integ/foo.test.ts.Agent > invoke",
    ]


def dims_of(datum):
    return {d["Name"]: d["Value"] for d in datum["Dimensions"]}


@pytest.mark.parametrize("event", ["pull_request_target", "merge_group"])
def test_non_nightly_event_emits_context_free_per_test_schema_and_suite_counters(mod, event):
    ctx = mod.RunContext(event=event, branch="main", leg="all")

    data = mod.build_metric_data(results_named(mod, ["a", "b", "c"]), "repo", "python", ctx)

    per_test = [d for d in data if d["MetricName"].startswith("Test") and not d["MetricName"].startswith("Tests")]
    suite = [d for d in data if d["MetricName"].startswith("Tests")]
    assert len(per_test) == 3 * 4
    assert all(set(dims_of(d)) == {"TestName", "Repository", "SDK"} for d in per_test)
    assert {d["MetricName"]: d["Value"] for d in suite} == {
        "TestsRun": 3.0,
        "TestsPassed": 3.0,
        "TestsFailed": 0.0,
        "TestsSkipped": 0.0,
    }
    assert all(
        dims_of(d) == {"Repository": "repo", "SDK": "python", "Event": event, "Branch": "main", "Leg": "all"}
        for d in suite
    )


def test_nightly_event_emits_both_per_test_schemas(mod):
    ctx = mod.RunContext(event="schedule", branch="main", leg="bidi")
    results = results_named(mod, ["a", "b"])
    results[1].outcome = "failed"

    data = mod.build_metric_data(results, "repo", "python", ctx)

    assert len(data) == 2 * 4 * 2 + 4
    context_schema = [d for d in data if "TestName" in dims_of(d) and "Event" in dims_of(d)]
    assert len(context_schema) == 2 * 4
    assert all(dims_of(d)["Leg"] == "bidi" and dims_of(d)["Event"] == "schedule" for d in context_schema)
    suite = {d["MetricName"]: d["Value"] for d in data if d["MetricName"].startswith("Tests")}
    assert suite == {"TestsRun": 2.0, "TestsPassed": 1.0, "TestsFailed": 1.0, "TestsSkipped": 0.0}


def test_skipped_test_emits_only_test_skipped(mod, pr_ctx):
    results = results_named(mod, ["skipped", "passed"])
    results[0].outcome = "skipped"

    data = mod.build_metric_data(results, "repo", "python", pr_ctx)

    skipped = [d for d in data if dims_of(d).get("TestName") == "suite.skipped"]
    assert [(d["MetricName"], d["Value"]) for d in skipped] == [("TestSkipped", 1.0)]
    executed = [d["MetricName"] for d in data if dims_of(d).get("TestName") == "suite.passed"]
    assert executed == ["TestPassed", "TestFailed", "TestSkipped", "TestDuration"]
    suite = {d["MetricName"]: d["Value"] for d in data if d["MetricName"].startswith("Tests")}
    assert suite == {"TestsRun": 2.0, "TestsPassed": 1.0, "TestsFailed": 0.0, "TestsSkipped": 1.0}


def test_skipped_test_emits_one_test_skipped_per_schema_on_nightly(mod):
    ctx = mod.RunContext(event="schedule", branch="main", leg="all")
    results = results_named(mod, ["skipped"])
    results[0].outcome = "skipped"

    data = mod.build_metric_data(results, "repo", "python", ctx)

    per_test = [d for d in data if "TestName" in dims_of(d)]
    assert [d["MetricName"] for d in per_test] == ["TestSkipped", "TestSkipped"]
    assert [set(dims_of(d)) for d in per_test] == [
        {"TestName", "Repository", "SDK"},
        {"TestName", "Repository", "SDK", "Event", "Branch", "Leg"},
    ]


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({"GITHUB_BASE_REF": "main", "GITHUB_REF_NAME": "feature/x"}, "main"),
        ({"GITHUB_REF_NAME": "gh-readonly-queue/main/pr-12-0123abcd"}, "main"),
        ({"GITHUB_REF_NAME": "gh-readonly-queue/release/v2/pr-7-00ff"}, "release/v2"),
        ({"GITHUB_REF_NAME": "refs/heads/main"}, "main"),
        ({"GITHUB_REF_NAME": "main"}, "main"),
        ({}, "unknown"),
    ],
)
def test_resolve_branch(mod, env, expected):
    assert mod.resolve_branch(env) == expected


def test_parse_args_defaults_and_legacy_positionals(mod, monkeypatch):
    monkeypatch.setenv("GITHUB_EVENT_NAME", "merge_group")
    monkeypatch.setenv("GITHUB_REF_NAME", "gh-readonly-queue/main/pr-3-abc")
    monkeypatch.delenv("GITHUB_BASE_REF", raising=False)
    monkeypatch.delenv("AWS_REGION", raising=False)

    legacy = mod.parse_args(["results.xml", "harness-sdk"])
    assert (legacy.xml_file, legacy.repository, legacy.sdk) == ("results.xml", "harness-sdk", "python")
    assert (legacy.event, legacy.branch, legacy.leg, legacy.region) == ("merge_group", "main", "all", "us-east-1")
    assert legacy.max_test_names == 1000

    explicit = mod.parse_args(
        ["r.xml", "harness-sdk", "typescript", "--leg", "mcp-1x", "--branch", "dev", "--event", "push"]
        + ["--max-test-names", "1500"]
    )
    assert (explicit.sdk, explicit.leg, explicit.branch, explicit.event) == ("typescript", "mcp-1x", "dev", "push")
    assert explicit.max_test_names == 1500


NOW = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    ("attr", "expected"),
    [
        ("2026-10-24T10:30:00.123456", datetime(2026, 10, 24, 10, 30, 0, 123456, tzinfo=timezone.utc)),
        ("2026-10-24T10:30:00.000Z", datetime(2026, 10, 24, 10, 30, tzinfo=timezone.utc)),
        ("2026-10-24T06:30:00-04:00", datetime(2026, 10, 24, 10, 30, tzinfo=timezone.utc)),
        (None, NOW),
        ("", NOW),
        ("not-a-date", NOW),
        ("2026-10-04T12:00:00", NOW),
        ("2026-10-23T11:00:00", NOW),
        ("2026-10-23T13:00:00", datetime(2026, 10, 23, 13, 0, tzinfo=timezone.utc)),
        ("2026-10-25T12:00:00", NOW),
    ],
)
def test_suite_timestamp(mod, attr, expected):
    assert mod.suite_timestamp(attr, NOW) == expected


def recent(hours_ago: int) -> datetime:
    """A whole-second UTC stamp inside the 24-hour window suite_timestamp accepts."""
    return datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=hours_ago)


def test_parse_junit_xml_stamps_tests_with_their_suite_time(mod, tmp_path):
    stamp = recent(2)
    path = write_junit(tmp_path, THREE_CASES, suite_attrs=f'timestamp="{stamp.strftime("%Y-%m-%dT%H:%M:%S.000000")}"')

    results = mod.parse_junit_xml(path)

    assert {r.timestamp for r in results} == {stamp}


def test_parse_junit_xml_stamps_each_vitest_suite_separately(mod, tmp_path):
    first, second = recent(3), recent(2)
    xml = (
        f'<testsuites><testsuite name="a.test.ts" timestamp="{first.strftime("%Y-%m-%dT%H:%M:%S.000Z")}">'
        '<testcase classname="a.test.ts" name="one" time="1"/></testsuite>'
        f'<testsuite name="b.test.ts" timestamp="{second.strftime("%Y-%m-%dT%H:%M:%S.000Z")}">'
        '<testcase classname="b.test.ts" name="two" time="1"/></testsuite></testsuites>'
    )
    path = tmp_path / "report.xml"
    path.write_text(xml, encoding="utf-8")

    results = mod.parse_junit_xml(str(path))

    assert [(r.name, r.timestamp) for r in results] == [("one", first), ("two", second)]


def test_parse_junit_xml_accepts_a_bare_testsuite_root(mod, tmp_path):
    stamp = recent(2)
    xml = f'<testsuite name="pytest" timestamp="{stamp.strftime("%Y-%m-%dT%H:%M:%S")}">{THREE_CASES}</testsuite>'
    path = tmp_path / "report.xml"
    path.write_text(xml, encoding="utf-8")

    results = mod.parse_junit_xml(str(path))

    assert [r.outcome for r in results] == ["passed", "failed", "skipped"]
    assert {r.timestamp for r in results} == {stamp}


def test_parse_junit_xml_without_any_testsuite_stamps_upload_time(mod, tmp_path):
    before = datetime.now(timezone.utc)
    path = tmp_path / "report.xml"
    path.write_text(f"<testsuites>{THREE_CASES}</testsuites>", encoding="utf-8")

    results = mod.parse_junit_xml(str(path))

    assert [r.name for r in results] == ["test_passed", "test_failed", "test_skipped"]
    assert all(before <= r.timestamp <= datetime.now(timezone.utc) for r in results)


def test_parse_junit_xml_without_suite_timestamp_uses_upload_time(mod, tmp_path):
    before = datetime.now(timezone.utc)

    results = mod.parse_junit_xml(write_junit(tmp_path, THREE_CASES))

    assert all(before <= r.timestamp <= datetime.now(timezone.utc) for r in results)


def test_build_metric_data_uses_test_timestamps_and_earliest_for_suite(mod, pr_ctx):
    early, late = NOW - timedelta(hours=2), NOW - timedelta(hours=1)
    results = results_named(mod, ["a", "b"])
    results[0].timestamp, results[1].timestamp = late, early

    data = mod.build_metric_data(results, "repo", "python", pr_ctx)

    assert {d["Timestamp"] for d in data if dims_of(d).get("TestName", "").endswith(".a")} == {late}
    assert {d["Timestamp"] for d in data if d["MetricName"].startswith("Tests")} == {early}


def test_build_metric_data_uses_sanitized_test_name(mod, pr_ctx):
    result = mod.TestResult(name="tool → result", classname="test/integ/agent.test.ts", duration=1.0, outcome="passed")

    data = mod.build_metric_data([result], "harness-sdk", "typescript", pr_ctx)

    dims = {d["Name"]: d["Value"] for d in data[0]["Dimensions"]}
    assert re.fullmatch(re.escape("test/integ/agent.test.ts.tool -> result") + HASH_SUFFIX, dims["TestName"])
    assert all(0x20 <= ord(c) <= 0x7E for c in dims["TestName"])
