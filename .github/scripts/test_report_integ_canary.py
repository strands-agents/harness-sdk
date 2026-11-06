"""Unit tests for report-integ-canary.py (run with `python -m pytest .github/scripts -q`)."""

import importlib.util
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).with_name("report-integ-canary.py")
SERVER = "https://github.com"
REPO = "strands-agents/harness-sdk"


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("report_integ_canary", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def links(mod):
    return mod.Links(SERVER, REPO)


def junit(tmp_path: Path, name: str, passed=(), failed=(), skipped=()) -> Path:
    cases = [f'<testcase classname="tests_integ.m" name="{n}" time="1"/>' for n in passed]
    cases += [f'<testcase classname="tests_integ.m" name="{n}" time="1"><failure/></testcase>' for n in failed]
    cases += [f'<testcase classname="tests_integ.m" name="{n}" time="0"><skipped/></testcase>' for n in skipped]
    path = tmp_path / name
    path.write_text(f'<testsuites><testsuite name="pytest">{"".join(cases)}</testsuite></testsuites>')
    return path


def run(mod, run_id="2", sha="b" * 40, legs=None):
    legs = legs if legs is not None else {"all": ()}
    built = tuple(
        mod.Leg(name, 10, frozenset(failed)) if failed is not None else mod.Leg(name, 0, frozenset(), "no report")
        for name, failed in legs.items()
    )
    return mod.Run(run_id, sha, built)


class FakeGitHub:
    def __init__(self, issue=None):
        self.issue = issue
        self.calls = []

    def find_issue(self, marker):
        return self.issue if self.issue and marker in self.issue["body"] else None

    def create_issue(self, title, body):
        self.calls.append(("create", title, body))

    def comment(self, number, body):
        self.calls.append(("comment", number, body))

    def update_issue(self, number, body, close):
        self.calls.append(("close" if close else "update", number, body))


def open_issue(mod, sdk="python", run_id="1"):
    return {"number": 42, "body": f"{mod.sdk_marker(sdk)}\n{mod.run_marker(run_id)}\nold body"}


# Loading reports


def test_load_leg_collects_failed_test_names_like_the_metrics_publisher(mod, tmp_path):
    path = junit(tmp_path, "r.xml", passed=["test_ok"], failed=["test_bad"], skipped=["test_skip"])

    leg = mod.load_leg("all", path)

    assert leg == mod.Leg("all", 3, frozenset({"tests_integ.m.test_bad"}))


@pytest.mark.parametrize(
    ("content", "reason"),
    [
        (None, "no JUnit report"),
        ("<testsuites", "unreadable JUnit report"),
        ("<testsuites><testsuite/></testsuites>", "JUnit report has no test results"),
    ],
)
def test_load_leg_marks_a_missing_unreadable_or_empty_report_as_broken(mod, tmp_path, content, reason):
    path = tmp_path / "r.xml"
    if content is not None:
        path.write_text(content)

    leg = mod.load_leg("bidi", path)

    assert leg.tests == 0
    assert leg.failed == frozenset()
    assert leg.broken.startswith(reason)


def test_run_is_red_on_a_failed_test_or_a_broken_leg(mod):
    assert not run(mod, legs={"all": (), "bidi": ()}).red
    assert run(mod, legs={"all": ("t",), "bidi": ()}).red
    assert run(mod, legs={"all": (), "bidi": None}).red


# Comparing with the previous run


def test_compare_splits_failures_into_new_still_and_fixed(mod):
    previous = run(mod, "1", legs={"all": ("a", "b")})
    current = run(mod, "2", legs={"all": ("b", "c")})

    changes = mod.compare(current, previous)

    assert changes.new == [("all", "c")]
    assert changes.still == [("all", "b")]
    assert changes.fixed == [("all", "a")]
    assert changes.changed


def test_compare_keys_failures_by_leg(mod):
    previous = run(mod, "1", legs={"all": ("t",), "bidi": ()})
    current = run(mod, "2", legs={"all": (), "bidi": ("t",)})

    changes = mod.compare(current, previous)

    assert changes.new == [("bidi", "t")]
    assert changes.fixed == [("all", "t")]


def test_compare_does_not_call_failures_in_a_now_broken_leg_fixed(mod):
    previous = run(mod, "1", legs={"all": ("a",), "bidi": ("b",)})
    current = run(mod, "2", legs={"all": (), "bidi": None})

    assert mod.compare(current, previous).fixed == [("all", "a")]


def test_compare_reports_no_change_for_the_same_failures_and_broken_legs(mod):
    previous = run(mod, "1", legs={"all": ("t",), "bidi": None})
    current = run(mod, "2", legs={"all": ("t",), "bidi": None})

    assert not mod.compare(current, previous).changed


def test_compare_counts_a_newly_broken_leg_as_a_change(mod):
    previous = run(mod, "1", legs={"all": ("t",), "bidi": ()})
    current = run(mod, "2", legs={"all": ("t",), "bidi": None})

    assert mod.compare(current, previous).changed


def test_compare_without_a_previous_run_treats_every_failure_as_new(mod):
    changes = mod.compare(run(mod, legs={"all": ("t",)}), None)

    assert changes.new == [("all", "t")]
    assert changes.changed


# Deciding what to do with the issue


@pytest.mark.parametrize(
    ("current_red", "previous_red", "changed", "issue_open", "expected"),
    [
        (True, None, True, False, "open"),
        (True, True, False, False, "open"),
        (True, True, True, True, "comment"),
        (True, True, False, True, "update"),
        (False, True, True, True, "comment"),
        (False, None, True, True, "comment"),
        (False, False, False, True, "close"),
        (False, False, False, False, "none"),
        (False, True, True, False, "none"),
    ],
)
def test_decide(mod, current_red, previous_red, changed, issue_open, expected):
    current = run(mod, "2", legs={"all": ("t",) if current_red else ()})
    previous = None if previous_red is None else run(mod, "1", legs={"all": ("t",) if previous_red else ()})

    assert mod.decide(current, previous, changed, issue_open).value == expected


# Syncing the issue


def test_sync_opens_an_issue_for_a_red_run_without_one(mod, links):
    github = FakeGitHub()

    action, _ = mod.sync_issue(github, "python", "wf.yml", run(mod, legs={"all": ("t",)}), None, links)

    assert action is mod.Action.OPEN
    [(kind, title, body)] = github.calls
    assert kind == "create"
    assert title == "Nightly Python integration tests failing on main"
    assert mod.sdk_marker("python") in body
    assert mod.run_marker("2") in body


def test_sync_comments_and_refreshes_the_body_when_failures_change(mod, links):
    github = FakeGitHub(open_issue(mod))
    previous = run(mod, "1", legs={"all": ("a",)})

    mod.sync_issue(github, "python", "wf.yml", run(mod, "2", legs={"all": ("a", "b")}), previous, links)

    assert [call[0] for call in github.calls] == ["comment", "update"]
    assert "### Newly failing (1)\n\n- `b`" in github.calls[0][2]
    assert mod.run_marker("2") in github.calls[1][2]


def test_sync_only_refreshes_the_body_when_failures_are_unchanged(mod, links):
    github = FakeGitHub(open_issue(mod))
    previous = run(mod, "1", legs={"all": ("a",)})

    mod.sync_issue(github, "python", "wf.yml", run(mod, "2", legs={"all": ("a",)}), previous, links)

    assert [call[0] for call in github.calls] == ["update"]


def test_sync_closes_after_two_green_runs(mod, links):
    github = FakeGitHub(open_issue(mod))

    action, _ = mod.sync_issue(github, "python", "wf.yml", run(mod, "2"), run(mod, "1"), links)

    assert action is mod.Action.CLOSE
    assert [call[0] for call in github.calls] == ["comment", "close"]
    assert "both passed" in github.calls[0][2]


def test_sync_is_a_no_op_when_the_run_is_already_reported(mod, links):
    github = FakeGitHub(open_issue(mod, run_id="2"))

    action, _ = mod.sync_issue(github, "python", "wf.yml", run(mod, "2", legs={"all": ("t",)}), None, links)

    assert action is mod.Action.NONE
    assert github.calls == []


def test_sync_ignores_the_other_sdks_issue(mod, links):
    github = FakeGitHub(open_issue(mod, sdk="typescript"))

    mod.sync_issue(github, "python", "wf.yml", run(mod, legs={"all": ("t",)}), None, links)

    assert [call[0] for call in github.calls] == ["create"]


# Rendering


def test_code_span_survives_backticks_and_keeps_mentions_inert(mod):
    assert mod.code("plain @user #1") == "`plain @user #1`"
    assert mod.code("a `b` c") == "``a `b` c``"
    assert mod.code("`edge`") == "`` `edge` ``"


def test_body_lists_tests_with_their_leg_only_for_multi_leg_sdks(mod, links):
    multi = run(mod, legs={"all": ("t",), "bidi": ()})
    single = run(mod, legs={"all": ("t",)})

    multi_body = mod.render_body("python", "wf.yml", multi, None, mod.compare(multi, None), links)
    single_body = mod.render_body("typescript", "wf.yml", single, None, mod.compare(single, None), links)

    assert "- `all` `t`" in multi_body
    assert "- `t`" in single_body
    assert "- `all` `t`" not in single_body


def test_body_caps_long_lists(mod, links):
    current = run(mod, legs={"all": tuple(f"t{i:03d}" for i in range(mod.MAX_LISTED + 5))})

    body = mod.render_body("typescript", "wf.yml", current, None, mod.compare(current, None), links)

    assert f"- `t{mod.MAX_LISTED - 1:03d}`" in body
    assert f"- `t{mod.MAX_LISTED:03d}`" not in body
    assert "... and 5 more" in body


def test_body_links_the_runs_and_the_commit_range(mod, links):
    previous = run(mod, "1", sha="a" * 40, legs={"all": ("t",)})
    current = run(mod, "2", sha="b" * 40, legs={"all": ("t",), "bidi": None})

    body = mod.render_body("python", "wf.yml", current, previous, mod.compare(current, previous), links)

    assert f"[2]({SERVER}/{REPO}/actions/runs/2)" in body
    assert f"[1]({SERVER}/{REPO}/actions/runs/1)" in body
    assert f"{SERVER}/{REPO}/compare/{'a' * 40}...{'b' * 40}" in body
    assert "### Broken legs (1)" in body
    assert "| `bidi` | - | no report |" in body


def test_body_omits_the_commit_range_when_both_runs_tested_the_same_commit(mod, links):
    previous = run(mod, "1", sha="a" * 40)
    current = run(mod, "2", sha="a" * 40, legs={"all": ("t",)})

    body = mod.render_body("python", "wf.yml", current, previous, mod.compare(current, previous), links)

    assert "/compare/" not in body


# CLI


def test_parse_args_requires_previous_run_and_reports_together(mod, capsys):
    base = ["--sdk", "python", "--workflow", "wf.yml", "--repo", REPO, "--run-id", "2", "--report", "all=r.xml"]

    with pytest.raises(SystemExit):
        mod.parse_args([*base, "--previous-run-id", "1"])

    assert "go together" in capsys.readouterr().err


def test_parse_args_rejects_a_report_without_a_leg(mod):
    with pytest.raises(SystemExit):
        mod.parse_args(["--sdk", "python", "--workflow", "w", "--repo", REPO, "--run-id", "2", "--report", "r.xml"])


def test_main_syncs_from_reports_on_disk(mod, tmp_path, monkeypatch):
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(tmp_path / "summary.md"))
    github = FakeGitHub()
    current = junit(tmp_path, "now.xml", passed=["a"], failed=["b"])
    previous = junit(tmp_path, "before.xml", passed=["a", "b"])
    argv = ["--sdk", "python", "--workflow", "wf.yml", "--repo", REPO, "--run-id", "2", "--sha", "b" * 40]
    argv += ["--report", f"all={current}", "--report", f"bidi={tmp_path / 'missing.xml'}"]
    argv += ["--previous-run-id", "1", "--previous-sha", "a" * 40, "--previous-report", f"all={previous}"]
    argv += ["--previous-report", f"bidi={previous}"]

    assert mod.main(argv, client=lambda repo: github) == 0

    [(kind, _, body)] = github.calls
    assert kind == "create"
    assert "### Newly failing (1)" in body
    assert "- `all` `tests_integ.m.b`" in body
    assert "### Broken legs (1)" in body
    assert (tmp_path / "summary.md").read_text() == body


def test_main_returns_1_when_the_github_api_fails(mod, tmp_path, capsys):
    class Failing(FakeGitHub):
        def find_issue(self, marker):
            raise subprocess.CalledProcessError(1, ["gh", "api"], stderr="HTTP 403")

    argv = ["--sdk", "python", "--workflow", "w", "--repo", REPO, "--run-id", "2"]
    argv += ["--report", f"all={junit(tmp_path, 'r.xml', failed=['t'])}"]

    assert mod.main(argv, client=lambda repo: Failing()) == 1
    assert "::error::GitHub API call failed: gh api: HTTP 403" in capsys.readouterr().out
