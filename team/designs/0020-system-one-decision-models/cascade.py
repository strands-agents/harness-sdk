"""Simulate the design's front-door cascade from recorded per-item results (no new API calls).

Policy: take Jev's answer when its confidence >= threshold, otherwise escalate to the LLM arm.
Cost = every item pays Jev; escalated items also pay the LLM. Latency = Jev, plus the LLM on escalation.
Choice confidence is Jev's own; YesNo confidence is |p - 0.5| * 2.

Usage: cascade.py [--fast jev] [--slow us.anthropic.claude-haiku-4-5-20251001-v1:0]. Both take arm ids as passed
to bench.py --arms, and each must have a PRICES entry. The output keys keep the published names (``haiku_only``,
``vs_haiku``) for the slow arm, whichever arm it is.
"""

import argparse
import json
import pathlib
import statistics

from analyze import boot, load

PRICES = {
    "jev": (0.042, 0.0),
    "us.anthropic.claude-haiku-4-5-20251001-v1:0": (1.10, 5.50),
    "us.amazon.nova-micro-v1:0": (0.035, 0.14),
}
TASKS = ["banking77", "clinc_oos", "prompt_injection"]


def cost(row, arm):
    pin, pout = PRICES[arm]
    return (row["in"] * pin + row["out"] * pout) / 1e6


def p(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]


parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("--fast", default="jev", help="arm answered first (must report confidence)")
parser.add_argument("--slow", default="us.anthropic.claude-haiku-4-5-20251001-v1:0", help="escalation arm")
args = parser.parse_args()
FAST, SLOW = args.fast, args.slow

out = {}
for task in TASKS:
    jev = sorted(load(task, FAST), key=lambda r: r["i"])
    llm = sorted(load(task, SLOW), key=lambda r: r["i"])
    print(f"== {task} ({FAST} -> {SLOW})")
    base_acc = sum(r["correct"] for r in llm) / len(llm)
    base_cost = sum(cost(r, SLOW) for r in llm) / len(llm) * 1000
    base_p50 = statistics.median(r["lat"] for r in llm)
    print(f"  {SLOW}-only  acc={base_acc:.3f}  $/1k={base_cost:.3f}  p50={base_p50:.3f}s")
    rows = []
    for th in (0.5, 0.7, 0.8, 0.9):
        correct, costs, lats, esc = [], [], [], 0
        for j, h in zip(jev, llm, strict=True):
            take = j["conf"] is not None and j["conf"] >= th
            esc += not take
            correct.append(float(j["correct"] if take else h["correct"]))
            costs.append(cost(j, FAST) + (0 if take else cost(h, SLOW)))
            lats.append(j["lat"] + (0 if take else h["lat"]))
        acc = sum(correct) / len(correct)
        lo, hi = boot(correct)
        diff = [c - float(h["correct"]) for c, h in zip(correct, llm, strict=True)]
        dlo, dhi = boot(diff)
        row = {
            "min_conf": th,
            "escalated": round(esc / len(jev), 3),
            "accuracy": round(acc, 3),
            "ci": [round(lo, 3), round(hi, 3)],
            "vs_haiku": round(sum(diff) / len(diff), 3),
            "vs_haiku_ci": [round(dlo, 3), round(dhi, 3)],
            "usd_per_1k": round(sum(costs) / len(costs) * 1000, 3),
            "p50_s": round(statistics.median(lats), 3),
            "p95_s": round(p(lats, 0.95), 3),
        }
        rows.append(row)
        print(
            f"  cascade conf>={th}  escalated={row['escalated']:.0%}  acc={acc:.3f} [{lo:.3f},{hi:.3f}]  "
            f"vs-slow={row['vs_haiku']:+.3f} [{dlo:+.3f},{dhi:+.3f}]  $/1k={row['usd_per_1k']}  "
            f"p50={row['p50_s']}s p95={row['p95_s']}s"
        )
    out[task] = {"haiku_only": {"accuracy": round(base_acc, 3), "usd_per_1k": round(base_cost, 3)}, "cascade": rows}

(pathlib.Path(__file__).parent / "results" / "cascade.json").write_text(json.dumps(out, indent=2))
