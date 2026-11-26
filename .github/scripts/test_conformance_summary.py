"""Unit tests for conformance-summary.py (run with `python -m pytest .github/scripts -q`)."""

import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).with_name("conformance-summary.py")


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("conformance_summary", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def record(case: str, status: str, **extra) -> dict:
    return {"sdk": "python", "provider": "bedrock", "model": "nova", "case": case, "status": status, **extra}


def write(tmp_path: Path, records: list[dict]) -> str:
    path = tmp_path / "results.jsonl"
    path.write_text("".join(json.dumps(item) + "\n" for item in records), encoding="utf-8")
    return str(path)


def test_load_keeps_the_later_record_and_skips_missing_files(mod, tmp_path):
    path = write(tmp_path, [record("tool-use", "failed"), record("tool-use", "passed", attempts=2)])

    tru_records = mod.load([path, str(tmp_path / "missing.jsonl")])
    exp_records = [record("tool-use", "passed", attempts=2)]
    assert tru_records == exp_records


def test_summarize_without_records(mod):
    assert mod.summarize([], {}) == "No conformance results were recorded.\n"


def test_summarize_a_run_lists_counts_and_problems(mod):
    tru_summary = mod.summarize(
        [
            record("tool-use", "passed"),
            record("prompt-caching", "failed"),
            record("structured-output", "error", reason="ClientError (HTTP 404)"),
            record("temporary-messages", "failed"),
        ],
        {("bedrock", "nova", "temporary-messages"): 6227},
    )
    exp_summary = (
        "## Model conformance\n"
        "\n"
        "| SDK | Status | Cases |\n"
        "|---|---|---|\n"
        "| python | error | 1 |\n"
        "| python | failed | 2 |\n"
        "| python | passed | 1 |\n"
        "\n"
        "| SDK | Target | Case | Status | Note |\n"
        "|---|---|---|---|---|\n"
        "| python | bedrock `nova` | prompt-caching | failed |  |\n"
        "| python | bedrock `nova` | structured-output | error | ClientError (HTTP 404) |\n"
        "| python | bedrock `nova` | temporary-messages | failed | known failure #6227 |\n"
    )
    assert tru_summary == exp_summary


def test_known_failures_reads_the_shared_file(mod):
    assert all(isinstance(issue, int) for issue in mod.known_failures().values())


def test_summarize_a_probe_compares_results_with_what_is_declared(mod):
    tru_summary = mod.summarize(
        [
            record("tool-use", "passed", declared=True),
            record("prompt-caching", "passed", declared=False),
            record("forced-tool-choice", "failed", declared=True),
            record("server-side-summary", "failed", declared=False),
            record("max-output-tokens", "not-applicable", reason="limits.maxOutputTokens is unknown"),
        ],
        {},
    )
    exp_summary = (
        "## Probe of bedrock `nova`\n"
        "\n"
        "| Case | SDK | Declared | Result | Finding |\n"
        "|---|---|---|---|---|\n"
        "| tool-use | python | yes | passed | as declared |\n"
        "| prompt-caching | python | no | passed | **works, not declared** |\n"
        "| forced-tool-choice | python | yes | failed | **declared, but fails** |\n"
        "| server-side-summary | python | no | failed | not supported |\n"
        "| max-output-tokens | python |  | not-applicable | limits.maxOutputTokens is unknown |\n"
    )
    assert tru_summary == exp_summary
