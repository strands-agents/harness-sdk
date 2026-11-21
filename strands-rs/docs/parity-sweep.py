#!/usr/bin/env python3
"""Check that every strands-ts spec file at the pin has a row in PARITY.md.

Usage:
    python3 strands-rs/docs/parity-sweep.py [--ts-root DIR] [--write]

`--ts-root` is a strands-ts checkout at the pinned baseline (default `/tmp/ts-spec/strands-ts`,
or `$STRANDS_TS_ROOT`). The script reads files only. It prints the summary and every problem,
and exits 1 when a spec has no row, a spec has more than one row, a row names a path that is
not a spec, or an out-of-scope row gives no reason. `--write` replaces the block
between the `parity-sweep` markers at the top of PARITY.md with the summary.

Row conventions:
- The first cell lists spec paths in backticks. `{a,b}` expands; a bare file name is relative to
  the directory of the previous path in the same cell; `dir/**` covers every spec under `dir/`.
- `P / T` in the third cell counts ported and total TS cases for the specs in the row.
- `out of scope` in the third cell marks specs outside v0.1; the gaps cell gives the reason, either
  a link to the RFC decision (`0022-rust-sdk.md#decision-v01-scope`) or a plain reason such as
  `browser-only`.
- Rows naming no spec file (fixtures, conformance files, Rust-only suites) are skipped.
"""

import argparse
import os
import re
import sys
from pathlib import Path

BEGIN = "<!-- parity-sweep:begin -->"
END = "<!-- parity-sweep:end -->"
SPEC_RE = re.compile(r"\.(test|test\.node|test\.browser|test-d)\.ts$")
CASE_RE = re.compile(r"^\s*(it|test)(\.(each|skip|only|concurrent|todo|fails|skipIf|runIf)(\([^)]*\))?)*\s*[(`]")
COUNT_RE = re.compile(r"^(\d+) / (\d+)")
TOKEN_RE = re.compile(r"`([^`]+)`")


def list_specs(ts_root):
    specs = []
    for base in ("src", "test/integ"):
        for path in sorted((ts_root / base).rglob("*.ts")):
            rel = path.relative_to(ts_root).as_posix()
            if not SPEC_RE.search(rel):
                continue
            if base == "src" and "/__tests__/" not in rel:
                continue
            specs.append(rel)
    return sorted(specs)


def count_cases(ts_root, spec):
    text = (ts_root / spec).read_text(encoding="utf-8")
    return sum(1 for line in text.splitlines() if CASE_RE.match(line))


def expand_braces(token):
    match = re.search(r"\{([^{}]*)\}", token)
    if not match:
        return [token]
    head, tail = token[: match.start()], token[match.end() :]
    return [out for part in match.group(1).split(",") for out in expand_braces(head + part + tail)]


def cell_paths(cell):
    paths = []
    previous_dir = None
    for token in TOKEN_RE.findall(cell):
        for path in expand_braces(token.strip()):
            if "/" not in path and previous_dir is not None:
                path = f"{previous_dir}/{path}"
            if not path.startswith(("src/", "test/")):
                continue
            if not (SPEC_RE.search(path) or path.endswith("/**")):
                continue
            paths.append(path)
            previous_dir = path.rsplit("/", 1)[0]
    return paths


def table_rows(parity_text):
    rows = []
    for number, line in enumerate(parity_text.splitlines(), start=1):
        if line.startswith("## "):
            if rows:
                break
            continue
        if not line.startswith("|") or line.startswith("|---"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 4 or cells[0] == "TS spec":
            continue
        rows.append((number, cells))
    return rows


def resolve(paths, specs):
    resolved = []
    unknown = []
    for path in paths:
        if path.endswith("/**"):
            prefix = path[:-2]
            matched = [spec for spec in specs if spec.startswith(prefix)]
        else:
            matched = [path] if path in specs else []
        if matched:
            resolved.extend(matched)
        else:
            unknown.append(path)
    return resolved, unknown


def out_of_scope_reason(gaps):
    return bool(gaps.strip())


def sweep(ts_root, parity_text):
    specs = list_specs(ts_root)
    spec_set = set(specs)
    owners = {}
    problems = []
    in_scope_specs = set()
    out_of_scope_specs = set()
    declared = {"unit": [0, 0], "integ": [0, 0]}
    source_total = 0
    for number, cells in table_rows(parity_text):
        paths = cell_paths(cells[0])
        if not paths:
            continue
        resolved, unknown = resolve(paths, spec_set)
        for path in unknown:
            problems.append(f"line {number}: `{path}` is not a spec file at the pin")
        for spec in resolved:
            owners.setdefault(spec, []).append(number)
        status = cells[2]
        count = COUNT_RE.match(status)
        if count:
            kind = "integ" if all(spec.startswith("test/") for spec in resolved) else "unit"
            declared[kind][0] += int(count.group(1))
            declared[kind][1] += int(count.group(2))
            in_scope_specs.update(resolved)
            source_total += sum(count_cases(ts_root, spec) for spec in resolved)
            continue
        if status.startswith("out of scope"):
            if not out_of_scope_reason(cells[3]):
                problems.append(f"line {number}: out-of-scope row gives no reason")
            out_of_scope_specs.update(resolved)
            continue
        problems.append(f"line {number}: third cell is neither `P / T` nor `out of scope`: {status}")
    for spec in specs:
        lines = owners.get(spec)
        if not lines:
            problems.append(f"`{spec}` has no row")
        elif len(lines) > 1:
            problems.append(f"`{spec}` has {len(lines)} rows (lines {', '.join(map(str, lines))})")
    unit = [spec for spec in specs if spec.startswith("src/")]
    integ = [spec for spec in specs if spec.startswith("test/")]
    summary = [
        BEGIN,
        "Sweep (`python3 strands-rs/docs/parity-sweep.py --write`, strands-ts at the pin):",
        "",
        "| | Count |",
        "|---|---|",
        f"| TS spec files | {len(specs)} ({len(unit)} unit, {len(integ)} integ) |",
        f"| In-scope spec files | {len(in_scope_specs)} |",
        f"| Out-of-scope spec files | {len(out_of_scope_specs)} |",
        f"| TS cases in in-scope rows | {declared['unit'][1] + declared['integ'][1]} "
        f"({declared['unit'][1]} unit, {declared['integ'][1]} integ) |",
        f"| Ported cases | {declared['unit'][0] + declared['integ'][0]} "
        f"({declared['unit'][0]} unit, {declared['integ'][0]} integ) |",
        f"| `it(...)`/`test(...)` call sites in in-scope specs | {source_total} |",
        "",
        "The last row counts call sites in the TS source; `it.each` tables and `describe.each` blocks "
        "count once there, while row totals count the cases they generate where the porter expanded them.",
        END,
    ]
    return "\n".join(summary), problems


def write_summary(parity_path, parity_text, summary):
    if BEGIN in parity_text and END in parity_text:
        head, rest = parity_text.split(BEGIN, 1)
        _, tail = rest.split(END, 1)
        updated = head + summary + tail
    else:
        lines = parity_text.split("\n", 2)
        updated = "\n".join([lines[0], "", summary, lines[2] if len(lines) > 2 else ""])
    parity_path.write_text(updated, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--ts-root", default=os.environ.get("STRANDS_TS_ROOT", "/tmp/ts-spec/strands-ts"))
    parser.add_argument("--parity", default=str(Path(__file__).resolve().parent / "PARITY.md"))
    parser.add_argument("--write", action="store_true", help="update the summary block in PARITY.md")
    args = parser.parse_args()
    ts_root = Path(args.ts_root)
    parity_path = Path(args.parity)
    parity_text = parity_path.read_text(encoding="utf-8")
    summary, problems = sweep(ts_root, parity_text)
    print(summary)
    for problem in problems:
        print(f"problem: {problem}")
    if args.write:
        write_summary(parity_path, parity_text, summary)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
