"""Paired analysis of bench results: accuracy 95% CIs, paired bootstrap of differences, per-language split.

Usage: analyze.py [--arms jev=jev,haiku=<bedrock id>,...]. Each entry is short-name=arm id as passed to
bench.py --arms; the first arm is the reference that every other arm is diffed against. The default matches the
published baseline.
"""

import argparse
import json
import pathlib
import random
import re

HERE = pathlib.Path(__file__).parent
R = HERE / "results"  # written by bench.py (not committed; rerun to regenerate)
DATA = HERE / "data"  # written by fetch_datasets.py
DEFAULT_ARMS = "jev=jev,haiku=us.anthropic.claude-haiku-4-5-20251001-v1:0,nova=us.amazon.nova-micro-v1:0"
ARMS: dict[str, str] = {}
TASKS = ["banking77", "clinc_oos", "prompt_injection"]
GERMAN = re.compile(r"\b(und|nicht|ich|der|die|das|ist|mit|sie|wie|für|auf|eine?)\b", re.I)


def parse_arms(spec: str) -> dict[str, str]:
    """Parse 'short=arm id,...' into {short: arm id}."""
    return dict(item.split("=", 1) for item in spec.split(",") if item)


def result_file(task: str, arm_id: str) -> pathlib.Path:
    """The per-item results file bench.py writes for ``arm_id`` (':' becomes '_' in file names)."""
    return R / f"{task}__{arm_id.replace(':', '_')}.jsonl"


def load(task, arm):
    arm_id = (ARMS or parse_arms(DEFAULT_ARMS)).get(arm, arm)
    return [json.loads(line) for line in open(result_file(task, arm_id))]


def boot(values, n=5000, seed=4551):
    rng = random.Random(seed)
    k = len(values)
    means = sorted(sum(values[rng.randrange(k)] for _ in range(k)) / k for _ in range(n))
    return means[int(0.025 * n)], means[int(0.975 * n)]


def accuracy_report():
    for task in TASKS:
        rows = {arm: sorted(load(task, arm), key=lambda r: r["i"]) for arm in ARMS}
        ref, *others = ARMS
        print(f"== {task} (n={len(rows[ref])})")
        for arm, rs in rows.items():
            acc = [float(r["correct"]) for r in rs]
            lo, hi = boot(acc)
            errors = sum(r.get("error") is not None for r in rs)
            print(f"  {arm:6} acc={sum(acc) / len(acc):.3f}  95%CI=[{lo:.3f},{hi:.3f}]  errors={errors}")
        for other in others:
            diff = [float(a["correct"]) - float(b["correct"]) for a, b in zip(rows[ref], rows[other], strict=True)]
            lo, hi = boot(diff)
            print(f"  {ref}-{other:5} diff={sum(diff) / len(diff):+.3f}  95%CI=[{lo:+.3f},{hi:+.3f}]")


def language_report():
    texts = [json.loads(line)["text"] for line in open(DATA / "prompt_injection.jsonl")]
    is_de = [len(GERMAN.findall(t)) >= 2 for t in texts]
    print(
        f"== prompt_injection by language (heuristic German detector): de={sum(is_de)} other={len(is_de) - sum(is_de)}"
    )
    for arm in ARMS:
        rs = sorted(load("prompt_injection", arm), key=lambda r: r["i"])
        for label, flag in (("de", True), ("en", False)):
            sub = [r for r, de in zip(rs, is_de, strict=True) if de == flag]
            pos = [r for r in sub if r["gold"]]
            print(
                f"  {arm:6} {label}: n={len(sub):3} acc={sum(r['correct'] for r in sub) / max(1, len(sub)):.3f} "
                f"recall={sum(r['correct'] for r in pos) / max(1, len(pos)):.3f} (pos={len(pos)})"
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--arms", default=DEFAULT_ARMS)
    ARMS.update(parse_arms(parser.parse_args().arms))
    accuracy_report()
    language_report()
