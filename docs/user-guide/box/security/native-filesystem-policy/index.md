This experiment adds Dogwood checks to selected native file operations on macOS. It requires macOS 27 or later and a binary built with the macOS 27 SDK or later. The binary must carry Apple’s Endpoint Security entitlement and a valid signature. Endpoint Security is the macOS interface that lets a client decide selected operating system requests.

## Enable the experiment

Signed macOS releases include the Cargo feature. The experiment still requires the compatible system described above and the runtime opt-in below. For a source build, build the product and its helpers:

```sh
cargo build --release --locked -p strands-box -p strands-box-containment --features native-filesystem-policy
```

Sign the product bundle with an identity and provisioning profile that permit `com.apple.developer.endpoint-security.client`. Add this table to `box.toml`:

```toml
[experimental-features]
native-filesystem-policy = true
```

Run the signed product with `run --config /absolute/path/box.toml`. An absent table or `false` leaves native interception disabled, including in an `--all-features` build. A selected but unavailable mechanism refuses startup. Box never silently disables the selected checks. Signed macOS release artifacts include the experiment’s code; unsigned build artifacts do not establish its signing requirements.

## Select workloads

The global experimental setting enables the mechanism and supplies the default for every workload. Add `native-filesystem-policy` to an existing `[agent]`, `[tool.<name>]`, or local `[mcp.<name>]` table to override that default. Only selection fields appear below. Retain each table’s required command and other settings.

```toml
[experimental-features]
native-filesystem-policy = true

[agent]
native-filesystem-policy = true

[tool.cargo]
native-filesystem-policy = false

[mcp.files]
native-filesystem-policy = true
```

An absent process setting inherits the global default, not the agent’s override. Children inherit their workload’s selection across forks and executable changes. A tool that Box launches through a declared table receives that table’s selection. Executing a program directly inside a workload does not select a different tool table.

An explicit `true` requires the global experimental setting. Remote MCP entries cannot select this feature because Box does not launch their processes. Changes apply on the next Box run.

Disabled workloads retain their sandbox restrictions and shutdown tracking. Their native filesystem operations do not produce Dogwood permission or outcome records. Later history-based rules cannot rely on observing those operations. Shell and network policy checks remain active. Kernel event delivery and trusted launcher setup can still add overhead.

## Coverage and limits

The adapter checks open, create, unlink, rename, truncate, and permission-change requests from selected descendants of the box’s trusted process. It uses the box’s existing durable Dogwood history. Filesystem grants still restrict each process through Seatbelt, the macOS process sandbox. A policy permit cannot expand those grants.

Permission-change events (`AUTH_SETMODE`) for regular files and directories require `fs:write` with the existing `set_permissions` operation. These events cover `chmod` and `fchmod`, including permission changes through an open file descriptor. Other target types are refused. The policy input identifies the path and operation, but does not include the requested permission bits.

For mediated workloads, the adapter disables authorization caching and requests kernel denial for missed deadlines or dropped authorization messages. Accepted authorization replies produce `indeterminate` outcomes. These records confirm authorization, not successful filesystem effects.

An existing open file descriptor can still carry later reads or writes without another open request. This experiment does not revoke existing descriptors or intercept every filesystem operation. Shutdown terminates tracked descendants, including detached children, before interception stops. It uses a five-second deadline for descendant cleanup and callback draining. Startup checks subscriptions and removes path mutes that would suppress required events. It refuses startup if required events remain muted or any process mute exists.

The signed tests cover detached-child cleanup and durable history across mode changes. They do not establish enforcement after the trusted Box process crashes or validate every shutdown failure. Production use still requires further review and tests for those failures.

## Stored configuration and rollback

When `limits.shell.timeout` is omitted, `file-attributes` is `false`, and MCP argument wildcards are disabled, configurations without process overrides retain version 21 when disabled and version 22 when enabled. An explicit process override requires record version 23. Two stdio MCP servers that share a program require record version 24. Setting [`file-attributes`](../../reference/configuration/index.md#file-attributes) to `true` requires record version 25. Enabling [MCP argument wildcards](../../guides/add-an-mcp-server/index.md#argument-wildcards) on any server requires version 26. An explicit `limits.shell.timeout` requires record version 27, including `30` and `false`. When a configuration selects more than one of these features, it uses the highest required version and retains every selection. Older binaries refuse unsupported versions.

To disable the experiment, change the global setting to `false`. Remove all process overrides and `limits.shell.timeout`, give each stdio MCP server its own program, and set `file-attributes` to `false` before returning to a binary that supports only version 21. If MCP argument wildcards are enabled, replace the stars with concrete arguments and disable `argument_wildcards` on each server too. Run once with the current build before switching binaries. This writes a version 21 record while retaining durable policy history. Changing TOML alone does not rewrite an existing version 22, 23, 24, 25, 26, or 27 record.

## FAQ

### Does this check every file access?

No. The adapter checks the operations listed in [Coverage and limits](#coverage-and-limits). A file descriptor is a process’s handle to an open file. Later reads or writes through that handle can occur without another open request or policy check. Changing policy does not revoke existing descriptors.

### Why add policy checks when containment already restricts files?

Containment restricts which paths a process can reach. Dogwood adds policy decisions, including rules that depend on prior events. Both restrictions apply. A policy permit cannot expand containment grants.

### Can I enable this through TOML alone?

Only if you already have the compatible, signed build described in [Enable the experiment](#enable-the-experiment). Signed macOS releases include the adapter, but leave it disabled until you select it. The Cargo feature includes the adapter in a build. The TOML setting activates it for a box.

### What happens if I enable it on an unsupported system?

Box refuses startup before the workload runs or the stored record changes. It does not silently disable the selected checks. An absent global setting or `false` keeps interception disabled. An absent process setting inherits the global default.

### Can I disable a tool while keeping the agent mediated?

Yes. Use the per-process settings in [Select workloads](#select-workloads). Tools and local MCP servers inherit the global default independently of the agent. Disabling a workload also excludes its native filesystem operations from policy history.

### Does this change where policy history lives?

No. The adapter uses the box’s existing durable Dogwood history, which survives restarts. Disabling and re-enabling interception does not erase that history. This feature adds no option to keep history only in memory.

### Why disable authorization caching?

The adapter disables kernel authorization caching so intercepted requests receive fresh policy decisions. Reusing an earlier decision could miss changes in policy history. Repeated checks add processing and storage work. Access through an existing descriptor remains subject to the limitation above.

### Does an allow record prove that the operation succeeded?

No. Accepted authorization replies produce `indeterminate` outcomes. These records confirm authorization, not successful filesystem effects. Do not interpret them as proof that a file operation completed.

### Can detached children survive normal Box shutdown?

The shutdown path terminates tracked descendants, including detached children, before interception stops. Descendant cleanup and callback draining share a five-second deadline. Tests cover normal detached-child cleanup, but not every shutdown failure or enforcement after the trusted process crashes.

### Can I immediately return to an older binary?

No, if the box has a version 22, 23, 24, 25, 26, or 27 record that the older binary does not support. Follow [Stored configuration and rollback](#stored-configuration-and-rollback) before starting an older binary. Changing TOML alone does not rewrite the stored record.

## Validate a signed build

Use the separate native test package after building and signing the current source:

```sh
STRANDS_BOX_SIGNED_TEST_BINARY=/absolute/path/KernelBox.app/Contents/MacOS/strands-box \
  cargo test --manifest-path test-native-filesystem/Cargo.toml --locked -- --nocapture
```

Record the source revision, source changes, and signed executable hash beside the test output. The test package requires the binary path and bounds each workload to 60 seconds. Ordinary workspace tests do not need a signing identity.

The required macOS unit-test job builds the feature and runs adapter and configuration tests. It tests the receipt checker and reports receipt freshness as informational. An outdated or invalid receipt does not fail the job. Its summary distinguishes the automated adapter and startup tests from the full signed native enforcement suite. That signed suite does not run in this job. Pull requests can merge without fresh signed native test evidence. The manual signed suite and receipt tool remain available. On a hosted runner with an older SDK, the build checks the unsupported-platform code. The signed macOS 27 run covers the active kernel bridge.

You can still record a manual receipt as additional evidence. Before building and signing, save the source snapshot:

```sh
python3 test-native-filesystem/receipt.py --snapshot /absolute/path/before.json
```

Capture the complete signed test output. Do not use a test filter:

```sh
STRANDS_BOX_SIGNED_TEST_BINARY=/absolute/path/KernelBox.app/Contents/MacOS/strands-box \
  cargo test --manifest-path test-native-filesystem/Cargo.toml --locked \
  -- --test-threads=1 > /absolute/path/native-tests.log 2>&1
python3 test-native-filesystem/receipt.py \
  --record /absolute/path/native-tests.log \
  --binary /absolute/path/KernelBox.app/Contents/MacOS/strands-box \
  --before /absolute/path/before.json
```

Review the receipt with the test log. If you need a current receipt, relevant source changes require a new build and signed run. The receipt covers workspace package sources and assets, build configuration, lockfiles, the native test package, its shared capture helper, and the unit-test workflow. Cargo supplies the workspace package list, including nested packages. Separate crate tests, examples, benchmarks, documentation, and unrelated workflows do not invalidate that receipt. The required macOS unit-test job also runs startup-refusal tests with and without the Cargo feature.

## Run real-agent workloads

Select `test-workload/workload-native-filesystem` explicitly. It is outside the default workload matrix. The case supports Claude Code and Codex on macOS 27 with a signed experimental build. It makes real model calls through the existing workload suite’s Bedrock gateway configuration. The isolated workload home needs an AWS `default` profile with valid credentials and model access. Do not grant the agent access to that profile.

Run from the repository root. Use a fresh run directory for each agent:

```sh
export WL_SRC="$(pwd -P)"
export WL_HOME_DIR=/absolute/path/workload-home
export WL_BOX_BINARY=/absolute/path/KernelBox.app/Contents/MacOS/strands-box
export WL_CLAUDE_BINARY=/absolute/path/claude
export WL_CODEX_BINARY=/absolute/path/codex
export AWS_REGION=us-west-2
export WL_CODEX_MODEL=your-enabled-mantle-model
export WL_DIMENSION=workload-native-filesystem
export WL_AGENT=claude
export WL_RUN_DIR="$WL_HOME_DIR/runs/claude-native-1"
mkdir -p "$WL_RUN_DIR"
case_dir="$WL_SRC/test-workload/$WL_DIMENSION"
bash "$case_dir/oracle.sh" start
bash "$case_dir/agent-a.sh" "$WL_RUN_DIR" </dev/null
bash "$case_dir/oracle.sh" stop
bash "$case_dir/agent-b.sh" "$WL_RUN_DIR"
cat "$WL_RUN_DIR/verdict.json"
```

Repeat with `WL_AGENT=codex` and a fresh `WL_RUN_DIR`. The explicit agent binary variables use existing installations. Without them, the suite resolves Claude and the Codex Node shim from its workload home. Keep the signed Box helpers beside `WL_BOX_BINARY`.

The host checks require an allowed edit, byte-exact protected contents, and a later continuation write. They also require a native Dogwood denial and exact-path policy records. Claude must use its native file tools; Codex must emit file-change events without command execution. Missing evidence, failed model runs, and unsupported platforms cannot pass. These tests do not prove structured policy errors reach the agent or that every native tool works.

Run the verdict regression tests without credentials or signing:

```sh
cargo test --manifest-path test-workload/verdict/Cargo.toml --locked --all-features
python3 test-workload/workload-native-filesystem/generator_test.py
```

The existing verdict CI job runs these regression tests. Live model runs remain explicitly selected.