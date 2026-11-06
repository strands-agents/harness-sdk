#!/usr/bin/env python3
"""Keep one GitHub issue per SDK in sync with the integ canary run on main.

Run by the `report` job of integ-canary.yml on main only. It reads this run's JUnit reports and the previous canary
run's, then opens the SDK's `integ-canary` issue when the run is red,
comments when the set of failing tests or broken legs changes, and closes the issue after two consecutive green runs.
The issue body always describes the latest run.
"""

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from types import ModuleType
from typing import Any, Protocol

LABEL = "integ-canary"
LABEL_COLOR = "d73a4a"
LABEL_DESCRIPTION = "Nightly integration run on main is failing"
SDK_TITLES = {"python": "Python", "typescript": "TypeScript"}
# Each list in the issue body is capped so a mass failure stays under GitHub's 65,536-character body limit.
MAX_LISTED = 30

Key = tuple[str, str]


def _load_publisher() -> ModuleType:
    """The publisher's parser and TestName rules, so issue entries match the dashboards' series names."""
    path = Path(__file__).with_name("upload-integ-test-metrics.py")
    spec = importlib.util.spec_from_file_location("upload_integ_test_metrics", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


publisher = _load_publisher()


@dataclass(frozen=True)
class Leg:
    name: str
    tests: int
    failed: frozenset[str]
    broken: str | None = None


@dataclass(frozen=True)
class Run:
    run_id: str
    sha: str
    legs: tuple[Leg, ...]

    def failures(self) -> frozenset[Key]:
        return frozenset((leg.name, test) for leg in self.legs for test in leg.failed)

    def broken(self) -> dict[str, str]:
        return {leg.name: leg.broken for leg in self.legs if leg.broken}

    @property
    def red(self) -> bool:
        return bool(self.failures() or self.broken())

    def signature(self) -> tuple[frozenset[Key], frozenset[str]]:
        return self.failures(), frozenset(self.broken())


def load_leg(name: str, path: Path) -> Leg:
    if not path.is_file():
        return Leg(name, 0, frozenset(), "no JUnit report (the leg did not run or stopped before reporting)")
    results = publisher.parse_junit_xml(str(path))
    if results is None:
        return Leg(name, 0, frozenset(), "unreadable JUnit report")
    if not results:
        return Leg(name, 0, frozenset(), "JUnit report has no test results")
    failed = frozenset(publisher.test_name(result) for result in results if result.outcome == "failed")
    return Leg(name, len(results), failed)


def load_run(run_id: str, sha: str, reports: list[tuple[str, Path]]) -> Run:
    return Run(run_id, sha, tuple(load_leg(leg, path) for leg, path in reports))


@dataclass(frozen=True)
class Changes:
    new: list[Key]
    still: list[Key]
    fixed: list[Key]
    changed: bool


def compare(current: Run, previous: Run | None) -> Changes:
    """A previous failure counts as fixed only if its leg reported this time; a broken leg ran nothing."""
    now = current.failures()
    before = previous.failures() if previous else frozenset()
    broken_now = current.broken()
    fixed = {key for key in before - now if key[0] not in broken_now}
    changed = previous is None or current.signature() != previous.signature()
    return Changes(sorted(now - before), sorted(now & before), sorted(fixed), changed)


class Action(Enum):
    NONE = "none"
    OPEN = "open"
    UPDATE = "update"
    COMMENT = "comment"
    CLOSE = "close"


def decide(current: Run, previous: Run | None, changed: bool, issue_open: bool) -> Action:
    """OPEN on a red run without an issue; COMMENT when a red run's failures changed or a first green run follows a
    red one; CLOSE on the second consecutive green run; UPDATE refreshes the body of an unchanged red run silently."""
    if current.red and not issue_open:
        return Action.OPEN
    if current.red:
        return Action.COMMENT if changed else Action.UPDATE
    if not issue_open:
        return Action.NONE
    if previous is not None and not previous.red:
        return Action.CLOSE
    return Action.COMMENT


@dataclass(frozen=True)
class Links:
    server: str
    repo: str

    def run(self, run_id: str) -> str:
        return f"[{run_id}]({self.server}/{self.repo}/actions/runs/{run_id})"

    def commit(self, sha: str) -> str:
        return f"[`{sha[:7]}`]({self.server}/{self.repo}/commit/{sha})" if sha else "unknown commit"

    def compare(self, base: str, head: str) -> str:
        return f"[commits since]({self.server}/{self.repo}/compare/{base}...{head})"


def code(text: str) -> str:
    """Markdown code span that survives backticks in the text; also keeps @mentions and #refs from linking."""
    longest = run = 0
    for char in text:
        run = run + 1 if char == "`" else 0
        longest = max(longest, run)
    fence = "`" * (longest + 1)
    pad = " " if text.startswith("`") or text.endswith("`") else ""
    return f"{fence}{pad}{text}{pad}{fence}"


def sdk_marker(sdk: str) -> str:
    return f"<!-- integ-canary sdk={sdk} -->"


def run_marker(run_id: str) -> str:
    return f"<!-- integ-canary run={run_id} -->"


def _plural(count: int, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def _test_list(title: str, keys: list[Key], multi_leg: bool) -> list[str]:
    if not keys:
        return []
    lines = ["", f"### {title} ({len(keys)})", ""]
    for leg, test in keys[:MAX_LISTED]:
        lines.append(f"- {code(leg)} {code(test)}" if multi_leg else f"- {code(test)}")
    if len(keys) > MAX_LISTED:
        lines.append(f"- ... and {len(keys) - MAX_LISTED} more (see the run's JUnit artifacts)")
    return lines


def _broken_list(run: Run) -> list[str]:
    broken = run.broken()
    if not broken:
        return []
    return ["", f"### Broken legs ({len(broken)})", "", *(f"- {code(leg)}: {why}" for leg, why in broken.items())]


def _leg_table(run: Run) -> list[str]:
    lines = ["| Leg | Tests | Failed |", "|---|---|---|"]
    for leg in run.legs:
        cells = ("-", leg.broken) if leg.broken else (str(leg.tests), str(len(leg.failed)))
        lines.append(f"| {code(leg.name)} | {cells[0]} | {cells[1]} |")
    return lines


def _run_line(run: Run, links: Links) -> str:
    counts = f"{_plural(len(run.failures()), 'failed test')}, {_plural(len(run.broken()), 'broken leg')}"
    return f"Run {links.run(run.run_id)} on {links.commit(run.sha)}: {counts}."


def _previous_line(current: Run, previous: Run | None, links: Links) -> str:
    if previous is None:
        return "No previous canary run to compare with."
    comparable = previous.sha and current.sha and previous.sha != current.sha
    since = f" ({links.compare(previous.sha, current.sha)})" if comparable else ""
    return f"Previous canary run: {_run_line(previous, links)}{since}"


def _new_title(previous: Run | None) -> str:
    return "Failing (no previous run to compare)" if previous is None else "Newly failing"


def render_body(sdk: str, workflow: str, current: Run, previous: Run | None, changes: Changes, links: Links) -> str:
    multi_leg = len(current.legs) > 1
    status = "failing" if current.red else "passing"
    lines = [
        sdk_marker(sdk),
        run_marker(current.run_id),
        f"**Status: {status}.** This issue tracks the {SDK_TITLES.get(sdk, sdk)} integration tests in the nightly "
        f"`{workflow}` run on `main`, which keeps it up to date: it comments when the set of failures changes and "
        "closes the issue after two consecutive green runs. Per-test history is on the integ test dashboards "
        "(`test-infra/dashboards/README.md`).",
        "",
        "## Latest canary run",
        "",
        _run_line(current, links),
        "",
        _previous_line(current, previous, links),
        "",
        *_leg_table(current),
        *_broken_list(current),
        *_test_list(_new_title(previous), changes.new, multi_leg),
        *_test_list("Still failing", changes.still, multi_leg),
        *_test_list("Fixed since the previous run", changes.fixed, multi_leg),
    ]
    return "\n".join(lines) + "\n"


def render_comment(action: Action, current: Run, previous: Run | None, changes: Changes, links: Links) -> str:
    multi_leg = len(current.legs) > 1
    run = links.run(current.run_id)
    if action is Action.CLOSE and previous is not None:
        return f"Canary runs {links.run(previous.run_id)} and {run} both passed. Closing."
    if not current.red:
        return f"Canary run {run} passed. This issue closes after the next green canary run."
    lines = [
        f"The failures changed in canary run {run}: {_plural(len(current.failures()), 'failed test')}, "
        f"{_plural(len(current.broken()), 'broken leg')}. The issue description shows the full state.",
        *_broken_list(current),
        *_test_list(_new_title(previous), changes.new, multi_leg),
        *_test_list("Fixed since the previous run", changes.fixed, multi_leg),
    ]
    return "\n".join(lines) + "\n"


class GitHub(Protocol):
    def find_issue(self, marker: str) -> dict[str, Any] | None: ...

    def create_issue(self, title: str, body: str) -> None: ...

    def comment(self, number: int, body: str) -> None: ...

    def update_issue(self, number: int, body: str, close: bool) -> None: ...


class GhCli:
    """GitHub REST calls through the `gh` CLI, authenticated by GH_TOKEN."""

    def __init__(self, repo: str):
        self.repo = repo

    def _api(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        cmd = ["gh", "api", "-X", method, path]
        if payload is not None:
            cmd += ["--input", "-"]
        stdin = json.dumps(payload) if payload is not None else None
        result = subprocess.run(cmd, input=stdin, capture_output=True, text=True, check=True)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def find_issue(self, marker: str) -> dict[str, Any] | None:
        issues = self._api("GET", f"repos/{self.repo}/issues?labels={LABEL}&state=open&per_page=100")
        matches = [i for i in issues if "pull_request" not in i and marker in (i.get("body") or "")]
        if len(matches) > 1:
            numbers = ", ".join(f"#{i['number']}" for i in matches)
            print(f"::warning::Several open {LABEL} issues carry {marker}: {numbers}; updating the oldest")
        return min(matches, key=lambda i: i["number"]) if matches else None

    def _ensure_label(self) -> None:
        try:
            self._api("GET", f"repos/{self.repo}/labels/{LABEL}")
        except subprocess.CalledProcessError:
            label = {"name": LABEL, "color": LABEL_COLOR, "description": LABEL_DESCRIPTION}
            self._api("POST", f"repos/{self.repo}/labels", label)

    def create_issue(self, title: str, body: str) -> None:
        self._ensure_label()
        issue = self._api("POST", f"repos/{self.repo}/issues", {"title": title, "body": body, "labels": [LABEL]})
        print(f"Opened {issue['html_url']}")

    def comment(self, number: int, body: str) -> None:
        self._api("POST", f"repos/{self.repo}/issues/{number}/comments", {"body": body})

    def update_issue(self, number: int, body: str, close: bool) -> None:
        payload: dict[str, Any] = {"body": body}
        if close:
            payload |= {"state": "closed", "state_reason": "completed"}
        self._api("PATCH", f"repos/{self.repo}/issues/{number}", payload)


class DryRunGitHub(GhCli):
    """Reads the repository's real issues; prints every write instead of making it."""

    def create_issue(self, title: str, body: str) -> None:
        print(f"[dry-run] create issue {title!r} labelled {LABEL}:\n{body}")

    def comment(self, number: int, body: str) -> None:
        print(f"[dry-run] comment on #{number}:\n{body}")

    def update_issue(self, number: int, body: str, close: bool) -> None:
        print(f"[dry-run] {'close' if close else 'update'} #{number} with body:\n{body}")


def issue_title(sdk: str) -> str:
    return f"Nightly {SDK_TITLES.get(sdk, sdk)} integration tests failing on main"


def sync_issue(
    github: GitHub, sdk: str, workflow: str, current: Run, previous: Run | None, links: Links
) -> tuple[Action, str]:
    """Apply one canary run to the SDK's canary issue. Returns the action taken and the rendered issue body."""
    changes = compare(current, previous)
    body = render_body(sdk, workflow, current, previous, changes, links)
    issue = github.find_issue(sdk_marker(sdk))
    if issue is not None and run_marker(current.run_id) in (issue.get("body") or ""):
        print(f"Run {current.run_id} is already reported on #{issue['number']}; nothing to do")
        return Action.NONE, body

    action = decide(current, previous, changes.changed, issue is not None)
    print(f"sdk={sdk}, red={current.red}, changed={changes.changed}, action={action.value} | canary issue sync")
    if action is Action.OPEN:
        github.create_issue(issue_title(sdk), body)
    if issue is None or action in (Action.NONE, Action.OPEN):
        return action, body
    if action in (Action.COMMENT, Action.CLOSE):
        github.comment(issue["number"], render_comment(action, current, previous, changes, links))
    github.update_issue(issue["number"], body, close=action is Action.CLOSE)
    return action, body


def _leg_report(value: str) -> tuple[str, Path]:
    leg, sep, path = value.partition("=")
    if not sep or not leg or not path:
        raise argparse.ArgumentTypeError(f"expected LEG=PATH, got {value!r}")
    return leg, Path(path)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=f"Sync the SDK's {LABEL} issue with an integ canary run.")
    parser.add_argument("--sdk", required=True, help="SDK whose issue to sync: python or typescript")
    parser.add_argument("--workflow", required=True, help="canary workflow file named in the issue body")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"), help="owner/name")
    parser.add_argument("--server-url", default=os.environ.get("GITHUB_SERVER_URL", "https://github.com"))
    parser.add_argument("--run-id", default=os.environ.get("GITHUB_RUN_ID"), help="this canary run's id")
    parser.add_argument("--sha", default=os.environ.get("GITHUB_SHA", ""), help="commit this run tested")
    parser.add_argument(
        "--report", type=_leg_report, action="append", required=True, metavar="LEG=PATH", help="one per matrix leg"
    )
    parser.add_argument("--previous-run-id", default="", help="previous canary run's id; omit when there is none")
    parser.add_argument("--previous-sha", default="")
    parser.add_argument("--previous-report", type=_leg_report, action="append", default=[], metavar="LEG=PATH")
    parser.add_argument("--dry-run", action="store_true", help="read the real issues but print every write")
    args = parser.parse_args(argv)
    if not args.repo or not args.run_id:
        parser.error("--repo and --run-id are required outside GitHub Actions")
    if bool(args.previous_run_id) != bool(args.previous_report):
        parser.error("--previous-run-id and --previous-report go together")
    return args


def _write_step_summary(body: str) -> None:
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(body)


def main(argv: list[str] | None = None, client: Callable[[str], GitHub] | None = None) -> int:
    args = parse_args(argv)
    current = load_run(args.run_id, args.sha, args.report)
    previous = load_run(args.previous_run_id, args.previous_sha, args.previous_report) if args.previous_run_id else None
    github = (client or (DryRunGitHub if args.dry_run else GhCli))(args.repo)
    try:
        _, body = sync_issue(github, args.sdk, args.workflow, current, previous, Links(args.server_url, args.repo))
    except subprocess.CalledProcessError as e:
        print(f"::error::GitHub API call failed: {' '.join(e.cmd)}: {(e.stderr or '').strip()}")
        return 1
    _write_step_summary(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
