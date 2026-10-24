"""Unit tests for upload-integ-test-metrics.py (run with `python -m pytest .github/scripts -q`)."""

import importlib.util
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
