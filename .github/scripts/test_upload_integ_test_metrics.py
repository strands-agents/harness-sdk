"""Unit tests for upload-integ-test-metrics.py (run with `python -m pytest .github/scripts -q`)."""

import importlib.util
import sys
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


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Agent > tool → result", "Agent > tool -> result"),
        ("Agent — with em dash", "Agent - with em dash"),
        ("café", "caf?"),
        ("plain.ascii[param-1]", "plain.ascii[param-1]"),
    ],
)
def test_sanitize_test_name_maps_to_printable_ascii(mod, raw, expected):
    assert mod.sanitize_test_name(raw) == expected


def test_sanitize_test_name_caps_at_255_chars(mod):
    sanitized = mod.sanitize_test_name("x" * 300)

    assert len(sanitized) == 255
    assert sanitized == "x" * 255


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


def results_named(mod, names):
    return [mod.TestResult(name=n, classname="suite", duration=0.1, outcome="passed") for n in names]


def test_publish_metrics_isolates_failed_batch_and_reports_its_tests(mod, capsys):
    # 750 tests x 4 datums = 3000 datums = 3 batches of 1000, i.e. 250 tests per batch.
    data = mod.build_metric_data(results_named(mod, [f"t{i:03d}" for i in range(750)]), "repo", "python")
    client = FakeCloudWatch(fail_on={1})

    failed = mod.publish_metrics(data, client)

    assert len(client.batches) == 3
    assert failed == [f"suite.t{i:03d}" for i in range(250, 500)]
    out = capsys.readouterr().out
    assert "::error::Metrics not published for test: suite.t250" in out
    assert "suite.t000" not in out


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


def test_build_metric_data_uses_sanitized_test_name(mod):
    result = mod.TestResult(name="tool → result", classname="test/integ/agent.test.ts", duration=1.0, outcome="passed")

    data = mod.build_metric_data([result], "harness-sdk", "typescript")

    dims = {d["Name"]: d["Value"] for d in data[0]["Dimensions"]}
    assert dims["TestName"] == "test/integ/agent.test.ts.tool -> result"
    assert all(0x20 <= ord(c) <= 0x7E for c in dims["TestName"])
