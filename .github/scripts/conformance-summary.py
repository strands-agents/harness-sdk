"""Summarize model conformance result records as markdown, for a workflow run summary.

Usage: conformance-summary.py RESULTS.jsonl [RESULTS.jsonl ...]

The record format is described in shared/README.md.
"""

import json
import sys
from collections import Counter
from pathlib import Path

PROBE_FINDINGS = {
    ("passed", True): "as declared",
    ("passed", False): "**works, not declared**",
    ("failed", True): "**declared, but fails**",
    ("failed", False): "not supported",
}


def load(paths: list[str]) -> list[dict]:
    """Read the records of every file that exists; a later record for the same SDK, target and case wins."""
    latest: dict[tuple, dict] = {}
    for path in paths:
        if not Path(path).is_file():
            continue
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            if line.strip():
                record = json.loads(line)
                latest[(record["sdk"], record["provider"], record["model"], record["case"])] = record
    return list(latest.values())


def _target(record: dict) -> str:
    return f"{record['provider']} `{record['model']}`"


def probe_report(records: list[dict]) -> str:
    """What a probed model supports, against what the model info declares."""
    lines = [
        f"## Probe of {_target(records[0])}",
        "",
        "| Case | SDK | Declared | Result | Finding |",
        "|---|---|---|---|---|",
    ]
    for record in records:
        declared = record.get("declared")
        finding = PROBE_FINDINGS.get((record["status"], declared), record.get("reason", ""))
        shown = {True: "yes", False: "no"}.get(declared, "")
        lines.append(f"| {record['case']} | {record['sdk']} | {shown} | {record['status']} | {finding} |")
    return "\n".join(lines) + "\n"


def known_failures() -> dict[tuple, int]:
    """The issue that tracks each known failure in shared/conformance.json, by provider, model and case."""
    shared = json.loads((Path(__file__).parents[2] / "shared" / "conformance.json").read_text(encoding="utf-8"))
    return {(known["provider"], known["model"], known["case"]): known["issue"] for known in shared["knownFailures"]}


def run_report(records: list[dict], known: dict[tuple, int]) -> str:
    """Counts per SDK and status, then every case that failed or could not be validated."""
    lines = ["## Model conformance", "", "| SDK | Status | Cases |", "|---|---|---|"]
    counts = Counter((record["sdk"], record["status"]) for record in records)
    lines += [f"| {sdk} | {status} | {count} |" for (sdk, status), count in sorted(counts.items())]
    problems = [record for record in records if record["status"] in ("failed", "error")]
    if problems:
        lines += ["", "| SDK | Target | Case | Status | Note |", "|---|---|---|---|---|"]
    for record in problems:
        issue = known.get((record["provider"], record["model"], record["case"]))
        note = f"known failure #{issue}" if issue else record.get("reason", "")
        lines.append(f"| {record['sdk']} | {_target(record)} | {record['case']} | {record['status']} | {note} |")
    return "\n".join(lines) + "\n"


def summarize(records: list[dict], known: dict[tuple, int]) -> str:
    if not records:
        return "No conformance results were recorded.\n"
    if any("declared" in record for record in records):
        return probe_report(records)
    return run_report(records, known)


if __name__ == "__main__":
    print(summarize(load(sys.argv[1:]), known_failures()), end="")
