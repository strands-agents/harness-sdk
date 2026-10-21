# Sample guide importer

The documentation build checks out `strands-agents/samples` and converts each entry in its root `samples.json` into
a Markdown guide under `.build/samples/pages`.

```bash
npm run samples:sync -- --source /path/to/samples
```

Set `SAMPLES_SOURCE_DIR` to provide the same path through the environment. CI also sets
`SAMPLES_REQUIRE_SOURCE=1`, so a missing checkout fails instead of using the one-guide local fallback.

The importer requires a clean Git checkout and records its exact commit in every generated page. It uses a root
`README.md` when present and otherwise renders the notebook named by the manifest. Notebook outputs and raw cells
are omitted. Safe HTML content and media are converted to Markdown, unsafe URL schemes are rejected, and relative
guide links and images are rewritten to the same pinned repository commit. Missing file links emit a build warning;
missing images fail the build because they would leave a visibly broken guide.

The samples repository owns catalog membership and metadata. This repository owns the publishing policy, generated
routes, navigation, and presentation. Production publishes static HTML and does not require a samples runtime.
