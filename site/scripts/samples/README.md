# Samples importer

The samples importer turns a local `strands-agents/samples` checkout into the pinned, static data used by the
documentation-style examples reader and its generated sample routes.

```bash
npm run samples:sync -- --source /path/to/samples
```

`SAMPLES_SOURCE_DIR` is the environment-variable equivalent of `--source`. CI also sets
`SAMPLES_REQUIRE_SOURCE=1`, which makes a missing checkout an error. Without that guard, local builds retain an
existing generated snapshot or use the small committed fallback.

The source checkout must be clean, including ignored and untracked files. This keeps every published byte tied to
the commit recorded in the snapshot.

## Inputs and output

The importer:

1. Verifies the checkout is clean and resolves its exact Git commit before and after the import.
2. Uses `<checkout>/samples.json` when present, otherwise `site/src/data/samples.json`.
3. Applies explicit `example.yaml` markers.
4. Writes schema version 2 to the ignored `.build/samples/sample-details.json`.

There are no timestamps or branch names in the output. Samples, files, and tags use stable sorting, and published
text uses normalized line endings.

## `example.yaml` markers

A version 1 marker in a directory already listed by the manifest can overlay display metadata such as `title`,
`summary`, `tags`, `notebook`, `prerequisites`, and `run`. It cannot change an existing `id` or `slug`.

A marker can add a directory that is not yet in the migration manifest, but it must provide immutable `id` and
`slug` values:

```yaml
schemaVersion: 1
id: python/01-learn/20-example
slug: python/example
title: Example
summary: Explain what the sample demonstrates.
tags:
  - Agent
content:
  guide: README.md
  featured:
    - src/agent.py
```

The source `path` always comes from the marker's directory. This keeps discovery explicit and avoids inferring
samples from arbitrary repository folders.

`content.guide` explicitly selects a Markdown file or notebook. Safe files listed in `content.featured` are selected
before the per-sample file cap, but remain subject to every content safety rule.

## Published content policy

- `content.guide` is used when configured; otherwise a root README is preferred.
- Without either, the configured notebook or first root notebook becomes the guide. Only Markdown and code cells
  are rendered; outputs and raw cells are omitted.
- Source panels accept an explicit text extension/name allowlist.
- Symlinks, secret-like paths, lockfiles, generated/data directories, invalid UTF-8, notebooks, and files over
  256 KiB are omitted.
- At most 40 source files are included per sample. The snapshot records omitted source entries; skipped directory
  trees are not traversed and count once.
- Traversal fails closed above 2,000 entries per sample, 50,000 entries overall, or 16 directory levels.

README links and images that are not embedded in the snapshot still resolve against the same pinned Git commit.
