"""System One (Jev) vs LLM baseline on identical typed decision questions.

Arms:
  jev          TypeSafe /v1/systemone, jev-latest
  <bedrock id> Bedrock Converse with a forced tool whose schema is the same closed answer space
               (enum for Choice, boolean for YesNo), temperature 0. The tasks below use only Choice and YesNo.

Tasks (public labeled data, fetched by fetch_datasets.py; seed 4551):
  banking77          Choice over 77 intents                         (routing / handoff)
  clinc_oos          Choice over 150 intents + "oos" no-match        (routing with explicit no-match)
  prompt_injection   YesNo "is this a prompt injection / jailbreak"  (guardrail)

Per arm: accuracy, precision/recall (YesNo), p50/p95 latency, input/output tokens, $/1k decisions,
and for Jev a selective-accuracy curve (accuracy vs coverage at confidence thresholds).
Accuracy counts an errored item (API or parse failure) as incorrect; the error count is reported per arm as
`errors`, and latency, tokens and cost are over non-errored items only.

Usage: bench.py --arms jev,us.anthropic.claude-haiku-4-5-20251001-v1:0 --tasks all [--limit N] [--concurrency 4]
Writes results/<task>__<arm>.jsonl (one row per item, raw) and results/summary.json.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import statistics
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).parent
DATA = HERE / "data"
RESULTS = HERE / "results"

# USD per 1M tokens (input, output). Sources: AWS Pricing API (us-west-2 on-demand, geo/US profile) and
# docs.typesafe.ai/models (Jev: input only, output free). Retrieved 2026-09-24.
PRICES = {
    "jev": (0.042, 0.0),
    "us.anthropic.claude-haiku-4-5-20251001-v1:0": (1.10, 5.50),
    "us.amazon.nova-micro-v1:0": (0.035, 0.14),
}

# --------------------------------------------------------------------------- questions


def humanize(label: str) -> str:
    return label.replace("_", " ")


def task_spec(task: str):
    """Return (question dict in Jev wire format, gold normaliser, answer extractor)."""
    labels = json.loads((DATA / f"{task}.labels.json").read_text())
    if task == "banking77":
        q = {
            "type": "choice",
            "instructions": "Which banking support intent does the customer message express?",
            "criteria": {lab: humanize(lab) for lab in labels},
        }
        return q, (lambda g: g)
    if task == "clinc_oos":
        crit = {lab: humanize(lab) for lab in labels if lab != "oos"}
        crit["oos"] = "Out of scope: the request matches none of the other intents"
        q = {
            "type": "choice",
            "instructions": "Which assistant intent does the user utterance express? Choose oos if none apply.",
            "criteria": crit,
        }
        return q, (lambda g: g)
    if task == "prompt_injection":
        q = {
            "type": "noul",
            "instructions": "Is this text a prompt injection or jailbreak attempt: does it try to override, ignore, or "
            "replace an AI assistant's instructions, or make it adopt a different role or behavior?",
            "criteria": {
                "true": "Attempts to override or replace the assistant's instructions or role",
                "false": "An ordinary request or statement, with no attempt to override instructions",
            },
        }
        return q, (lambda g: bool(g))
    raise ValueError(task)


# --------------------------------------------------------------------------- arms


class JevArm:
    name = "jev"
    URL = "https://api.typesafe.ai/v1/systemone"

    def __init__(self):
        self._key = os.environ["TYPESAFE_API_KEY"]

    def _post(self, body: dict) -> dict:
        req = urllib.request.Request(
            self.URL,
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"},
        )
        for attempt in range(6):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code in (429, 529) and attempt < 5:
                    time.sleep(2**attempt)
                    continue
                raise
        raise RuntimeError("unreachable")

    async def ask(self, text: str, q: dict) -> dict:
        body = {"state": {"message": text}, "model": "jev-latest", "questions": {"q": q}}
        t = time.perf_counter()
        out = await asyncio.to_thread(self._post, body)
        lat = time.perf_counter() - t
        a = out["answers"]["q"]
        pred = a["choice"] if q["type"] == "choice" else a["noul"] >= 0.5
        conf = a.get("confidence") if q["type"] == "choice" else abs(a["noul"] - 0.5) * 2
        return {
            "pred": pred,
            "conf": conf,
            "raw": a,
            "lat": lat,
            "in": out["usage"]["input_tokens"],
            "out": out["usage"]["output_tokens"],
            "model": out["model"],
        }


class BedrockArm:
    def __init__(self, model_id: str, profile: str, region: str):
        import boto3
        from botocore.config import Config

        self.name = model_id
        self._c = boto3.Session(profile_name=profile, region_name=region).client(
            "bedrock-runtime", config=Config(retries={"max_attempts": 8, "mode": "adaptive"}, read_timeout=120)
        )

    @staticmethod
    def _tool(q: dict) -> dict:
        if q["type"] == "choice":
            prop = {"type": "string", "enum": list(q["criteria"]), "description": "The selected option."}
        else:
            prop = {"type": "boolean", "description": "True if the condition holds."}
        return {
            "toolSpec": {
                "name": "answer",
                "description": "Record the answer.",
                "inputSchema": {"json": {"type": "object", "properties": {"answer": prop}, "required": ["answer"]}},
            }
        }

    @staticmethod
    def _prompt(text: str, q: dict) -> str:
        # Same content Jev receives: instructions + option descriptions + state, nothing more.
        if q["type"] == "choice":
            opts = "\n".join(f"- {k}: {v}" for k, v in q["criteria"].items())
            body = f"{q['instructions']}\n\nOptions:\n{opts}"
        else:
            c = q.get("criteria", {})
            body = f"{q['instructions']}\n\ntrue: {c.get('true', 'yes')}\nfalse: {c.get('false', 'no')}"
        return f"{body}\n\n<message>\n{text}\n</message>\n\nAnswer by calling the answer tool."

    def _call(self, text: str, q: dict) -> dict:
        return self._c.converse(
            modelId=self.name,
            messages=[{"role": "user", "content": [{"text": self._prompt(text, q)}]}],
            toolConfig={"tools": [self._tool(q)], "toolChoice": {"tool": {"name": "answer"}}},
            inferenceConfig={"temperature": 0, "maxTokens": 256},
        )

    async def ask(self, text: str, q: dict) -> dict:
        t = time.perf_counter()
        r = await asyncio.to_thread(self._call, text, q)
        lat = time.perf_counter() - t
        pred = None
        for block in r["output"]["message"]["content"]:
            if "toolUse" in block:
                pred = block["toolUse"]["input"].get("answer")
        return {
            "pred": pred,
            "conf": None,
            "raw": pred,
            "lat": lat,
            "in": r["usage"]["inputTokens"],
            "out": r["usage"]["outputTokens"],
            "model": self.name,
        }


# --------------------------------------------------------------------------- run + score


async def run_arm(arm, task: str, items: list[dict], concurrency: int) -> list[dict]:
    q, norm = task_spec(task)
    sem = asyncio.Semaphore(concurrency)

    async def one(i, item):
        async with sem:
            try:
                r = await arm.ask(item["text"], q)
                r["error"] = None
            except Exception as e:  # noqa: BLE001 - record and continue; errors are reported, not hidden
                r = {"pred": None, "conf": None, "raw": None, "lat": None, "in": 0, "out": 0, "error": repr(e)[:300]}
            r.update({"i": i, "gold": norm(item["gold"])})
            r["correct"] = r["pred"] == r["gold"]
            return r

    return await asyncio.gather(*(one(i, it) for i, it in enumerate(items)))


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p * (len(xs) - 1))))] if xs else None


def summarize(arm: str, task: str, rows: list[dict]) -> dict:
    ok = [r for r in rows if r["error"] is None]
    n = len(rows)
    acc = sum(r["correct"] for r in rows) / n
    lat = [r["lat"] for r in ok]
    tin = sum(r["in"] for r in ok)
    tout = sum(r["out"] for r in ok)
    pin, pout = PRICES.get(arm, (float("nan"), float("nan")))
    cost_per_1k = (tin * pin + tout * pout) / 1e6 / max(1, len(ok)) * 1000
    s = {
        "arm": arm,
        "task": task,
        "n": n,
        "errors": n - len(ok),
        "accuracy": round(acc, 4),
        "p50_s": round(statistics.median(lat), 3) if lat else None,
        "p95_s": round(pct(lat, 0.95), 3) if lat else None,
        "mean_in_tokens": round(tin / max(1, len(ok)), 1),
        "mean_out_tokens": round(tout / max(1, len(ok)), 1),
        "usd_per_1k": round(cost_per_1k, 5),
        "answered_by": sorted({r.get("model") for r in ok if r.get("model")}),
    }
    if isinstance(rows[0]["gold"], bool):
        tp = sum(r["pred"] is True and r["gold"] for r in rows)
        fp = sum(r["pred"] is True and not r["gold"] for r in rows)
        fn = sum(r["pred"] is not True and r["gold"] for r in rows)
        s["precision"] = round(tp / max(1, tp + fp), 4)
        s["recall"] = round(tp / max(1, tp + fn), 4)
    if any(r["conf"] is not None for r in ok):
        curve = []
        for th in (0.0, 0.3, 0.5, 0.7, 0.9):
            kept = [r for r in ok if r["conf"] is not None and r["conf"] >= th]
            if kept:
                curve.append(
                    {
                        "min_conf": th,
                        "coverage": round(len(kept) / n, 3),
                        "accuracy": round(sum(r["correct"] for r in kept) / len(kept), 4),
                    }
                )
        s["selective"] = curve
    return s


def make_arm(name: str, profile: str, region: str):
    return JevArm() if name == "jev" else BedrockArm(name, profile, region)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", default="jev")
    ap.add_argument("--tasks", default="all")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--profile", default=None, help="AWS profile for the Bedrock arms (default: environment)")
    ap.add_argument("--region", default="us-west-2")
    a = ap.parse_args()
    tasks = ["banking77", "clinc_oos", "prompt_injection"] if a.tasks == "all" else a.tasks.split(",")
    RESULTS.mkdir(exist_ok=True)
    summary_path = RESULTS / "summary.json"
    summary = json.loads(summary_path.read_text()) if summary_path.exists() else {}
    for arm_name in a.arms.split(","):
        arm = make_arm(arm_name, a.profile, a.region)
        for task in tasks:
            items = [json.loads(line) for line in open(DATA / f"{task}.jsonl")][: a.limit]
            rows = await run_arm(arm, task, items, a.concurrency)
            slug = arm_name.replace("/", "_").replace(":", "_")
            with open(RESULTS / f"{task}__{slug}.jsonl", "w") as f:
                for r in rows:
                    f.write(json.dumps(r, default=str) + "\n")
            s = summarize(arm_name, task, rows)
            summary[f"{task}::{arm_name}"] = s
            print(json.dumps(s))
    summary_path.write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
