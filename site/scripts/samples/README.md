# Sample guide importer

The importer converts the samples repository into generated Markdown under `.build/samples/pages`.

```bash
npm run samples:sync -- --source /path/to/samples
```

For local development or a full build, provide the source to the lifecycle script:

```bash
SAMPLES_SOURCE_DIR=/path/to/samples npm run dev
SAMPLES_SOURCE_DIR=/path/to/samples npm run build
```

Without a source, local builds show an unconfigured state. CI sets `SAMPLES_REQUIRE_SOURCE=1` so a missing checkout
fails. See [the site architecture](../../SITE-ARCHITECTURE.md) for ownership, safety, and rendering details.
