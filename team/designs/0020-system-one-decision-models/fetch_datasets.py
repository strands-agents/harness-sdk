"""Fetch small, public, labeled evaluation slices via the HuggingFace datasets-server (no auth).

Writes JSONL under data/. Deterministic: seeded sample over a fixed split.
Usage: python fetch_datasets.py            # fetch all task slices
       python fetch_datasets.py --info DS   # print splits/features for discovery
"""

import json
import pathlib
import random
import sys
import urllib.parse
import urllib.request

OUT = pathlib.Path(__file__).parent / "data"
API = "https://datasets-server.huggingface.co"
SEED = 4551

# task -> (dataset, config, split, label_field, sample_size or None for all)
SLICES = {
    "banking77": ("legacy-datasets/banking77", "default", "test", "label", 200),
    "clinc_oos": ("clinc/clinc_oos", "plus", "test", "intent", 200),
    "prompt_injection": ("deepset/prompt-injections", "default", "test", "label", None),
}


def get(path, **params):
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def label_names(dataset, config, field):
    feats = get("info", dataset=dataset)["dataset_info"][config]["features"]
    spec = feats[field]
    return spec.get("names") if isinstance(spec, dict) else None


def fetch_split(dataset, config, split):
    """Download the split's parquet export once (avoids per-row rate limits)."""
    import io

    import pyarrow.parquet as pq

    files = [
        f for f in get("parquet", dataset=dataset)["parquet_files"] if f["config"] == config and f["split"] == split
    ]
    rows = []
    for f in files:
        with urllib.request.urlopen(f["url"], timeout=120) as r:
            rows += pq.read_table(io.BytesIO(r.read())).to_pylist()
    return rows


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rng = random.Random(SEED)
    for task, (ds, cfg, split, field, n) in SLICES.items():
        meta = get("info", dataset=ds)["dataset_info"][cfg]
        total = meta["splits"][split]["num_examples"]
        names = label_names(ds, cfg, field)
        all_rows = fetch_split(ds, cfg, split)
        assert len(all_rows) == total, (task, len(all_rows), total)
        rows = all_rows if n is None else [all_rows[i] for i in sorted(rng.sample(range(total), n))]
        with open(OUT / f"{task}.jsonl", "w") as f:
            for r in rows:
                gold = names[r[field]] if names else r[field]
                f.write(json.dumps({"text": r["text"], "gold": gold}) + "\n")
        (OUT / f"{task}.labels.json").write_text(json.dumps(names if names else sorted({0, 1})))
        print(task, len(rows), "rows;", len(names) if names else 2, "labels;", f"{ds}/{cfg}/{split}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--info"]:
        for ds in sys.argv[2:]:
            for cfg, c in get("info", dataset=ds)["dataset_info"].items():
                print(
                    ds, cfg, {s: v["num_examples"] for s, v in c.get("splits", {}).items()}, list(c.get("features", {}))
                )
    else:
        main()
