This experimental feature adds Dogwood checks to selected native file operations on macOS and Linux ARM64.

### macOS requirements

It requires macOS 27 or later and a binary built with the macOS 27 SDK or later. The binary must carry Apple’s Endpoint Security entitlement and a valid signature. Endpoint Security is the macOS interface that lets a client decide selected operating system requests.

## Enable native filesystem policy

Signed macOS releases include the Cargo feature. The experiment still requires the compatible system described above and the runtime opt-in below. For a source build, build the product and its helpers:

```sh
cargo build --release --locked -p strands-box -p strands-box-containment --features native-filesystem-policy
```

On macOS, sign the product bundle with an identity and provisioning profile that permit `com.apple.developer.endpoint-security.client`. Add this table to `box.toml`:

```toml
[experimental-features]
native-filesystem-policy = true
```

Run the product with `run --config /absolute/path/box.toml`. Linux launches also need the capabilities described below. An absent table or `false` leaves native interception disabled, including in an `--all-features` build. A selected but unavailable mechanism refuses startup. Box never silently disables the selected checks. Signed macOS release artifacts include the experiment’s code; unsigned build artifacts do not establish its signing requirements.

### Linux ARM64 requirements

Linux x86-64 builds refuse this feature during configuration validation, before creating Box state or starting a workload.

The host must support seccomp user notifications, descriptor injection, BPF Linux Security Module hooks, and BPF type information. BPF lets Box attach the checks that prevent delete and rename from affecting a replacement file. The checks use the kernel’s file identity while the filesystem operation holds its locks. Testing used Amazon Linux 2023 on ARM64 with kernel `6.12.111-136.204.amzn2023.aarch64`. Other kernels and distributions need qualification.

Start the trusted Box process with `CAP_BPF` and `CAP_PERFMON` when any workload selects native checks. These are Linux capabilities for loading BPF programs and accessing the required tracing hooks. The Box process need not run as root. It loads its checks and drops these capabilities before creating runtime threads or launching workloads. It preserves other inherited capabilities, including the authority root needs to create its user namespace. Inherited `CAP_SYS_ADMIN` remains baseline host authority and can also authorize BPF operations. Use the restricted capability set below to avoid retaining `CAP_SYS_ADMIN` after native setup. Missing capabilities or kernel support stop launch. For a command-line run, Box does not load these checks if every workload opts out. A library caller can create its configuration in `RunOptions::on_ready`. For that callback path, Box prepares available checks before runtime startup and reads configuration after the callback. It discards unused checks when the resulting configuration opts out. An opted-out run does not require these capabilities. These requirements apply to native interception; they do not change the prerequisites for ordinary Linux containment.

For a development run, an administrator can supply only these capabilities:

```sh
sudo setpriv --reuid="$(id -u)" --regid="$(id -g)" --clear-groups \
  --bounding-set=-all,+bpf,+perfmon --inh-caps=-all,+bpf,+perfmon \
  --ambient-caps=-all,+bpf,+perfmon --no-new-privs \
  /absolute/path/strands-box run --config /absolute/path/box.toml
```

Keep `strands-box-contain-trampoline` and `strands-box-sock-alias` beside the Box binary. The example launches the workload as the caller’s user, with no supplementary groups. It does not install capabilities on any executable or configure the host’s BPF support.

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

### macOS

The adapter checks open, create, unlink, rename, truncate, and permission-change requests from selected descendants of the box’s trusted process. It uses the box’s existing durable Dogwood history. Filesystem grants still restrict each process through Seatbelt, the macOS process sandbox. A policy permit cannot expand those grants.

Permission-change events (`AUTH_SETMODE`) for regular files and directories require `fs:write` with the existing `set_permissions` operation. These events cover `chmod` and `fchmod`, including permission changes through an open file descriptor. Other target types are refused. The policy input identifies the path and operation, but does not include the requested permission bits.

For mediated workloads, the adapter disables authorization caching and requests kernel denial for missed deadlines or dropped authorization messages. Accepted authorization replies produce `indeterminate` outcomes. These records confirm authorization, not successful filesystem effects.

An existing open file descriptor can still carry later reads or writes without another open request. This feature does not revoke existing descriptors or intercept every filesystem operation. Shutdown terminates tracked descendants, including detached children, before interception stops. It uses a five-second deadline for descendant cleanup and callback draining. Startup checks subscriptions and removes path mutes that would suppress required events. It refuses startup if required events remain muted or any process mute exists.

Native policy requires the trusted Box process to remain alive. On macOS, an uncatchable termination such as `SIGKILL` can leave a descendant running. That descendant can perform new file operations within its filesystem grants without Dogwood checks, even when policy denied those operations before Box stopped. Normal shutdown cleanup does not protect this case.

The signed tests cover normal detached-child cleanup and durable history across mode changes. Standard-release support still requires the remaining failure review and tests.

### Linux ARM64

The adapter checks file opens, creation, unlink, rename, directory creation and removal, symbolic-link creation, and path-based truncation. Tests cover allowed and denied operations through agents, declared tools, and local MCP servers. Mount restrictions still apply beneath Dogwood policy. The adapter uses durable Dogwood history; this feature does not enable history skipping or batching.

For file opens, Box opens the approved file and transfers that descriptor into the workload. For delete and rename, kernel checks restrict the worker to the approved file identities. Tests replace files and directories after authorization and after final user-space verification. The replacement survives those tests.

At startup, Box probes whether the running kernel can transfer `O_PATH` handles. These handles identify a file or directory without allowing content reads or writes. A successful probe enables path-only opens with a metadata policy check. An unsupported transfer disables only these opens and produces a startup disclosure. An unexpected probe error stops startup. Box never substitutes a readable descriptor.

Ordinary symbolic links and parent components (`..`) resolve inside the captured workload filesystem view. Policy checks use the resolved object, and effects use its pinned descriptor or parent directory. `O_NOFOLLOW` preserves the final-link restriction. Kernel magic links remain restricted. Other unsupported open flags and file kinds receive a refusal.

Hard links are different names for the same file contents. Box checks the requested name against filesystem grants and policy. Denying one name does not deny every link to that file. An allowed write through another name changes the shared contents, including contents visible through a denied name or a name outside the workload grants. Those other names do not become accessible.

Native entry handling has these limits in addition to baseline containment:

-   `renameat2` is supported only with zero flags. Box refuses nonzero flags, including `RENAME_NOREPLACE` (refuse an existing destination), even when ordinary containment permits them. GNU `mv` can request `RENAME_NOREPLACE` even for a plain move to a new name. With native filesystem policy enabled, Box refuses that request with a permission error even when filesystem grants and policy would permit the move.
-   A rename cannot replace an existing directory, including an empty directory. Moving a directory to a new name is supported.
-   File and directory creation accept only the ordinary permission bits (`0000` through `0777`). Native checks refuse creation with the sticky bit. Baseline containment already refuses the set-group-ID and set-user-ID bits, whether native checks are enabled or disabled.

These operations are refused before a Dogwood decision or file effect. The workload receives an operating-system permission error; the source and destination entries remain unchanged.

For native rename cases, the [comparison suite](https://github.com/strands-agents/box/blob/a2a97eede44b01f536faa4ada8c3085f97634681/docs/dev/linux-native-tests.md#compare-shell-and-native-policy-events) uses a test program that calls `renameat` directly; it does not execute GNU `mv`. Its permitted rename cases do not establish that GNU `mv` works with native filesystem policy.

An existing descriptor can carry later reads, writes, or directory listings without another Dogwood check. Linux permission changes remain subject to filesystem grants, without a fresh Dogwood permission-change check. The Linux adapter does not mediate standalone metadata queries or link-target reads. Outcome records distinguish descriptor delivery from later file effects. A descriptor’s delivery does not prove that a subsequent write succeeded. Policy storage errors, worker failures, and expired processing deadlines stop Box. The kernel tests cover pending requests, process termination, detached descendants, and concurrent writes. Telemetry remains best effort: its bounded exporter queue can lose records under sustained load. Use the durable policy history and saved file effects when assessing enforcement.

## Filesystem operation meanings

Native rename checks `fs:move` on both the source and destination, plus `fs:read` on the source. The source read check uses `context.input.operation == Box::FsReadOperation::"read_content"` for both files and directories on Linux and macOS. For example, denying `read_content` blocks a directory rename even when directory listing through `enumerate` is permitted. Linux outcome records use the same path spelling as their policy requests, including `~/` for paths under the workload home. A successful Linux rename records one completed `fs:move` on the destination, matching Shell. The source move check remains in history without a completion record; every permission check still runs. When Linux policy denies a required check, earlier checks remain without outcome records. Actual filesystem failures retain their error records. Replacing an existing destination also requires `fs:delete` and `fs:write` on that destination. Moving to a new name does not require destination `fs:write`. Filesystem grants still restrict every operation independently of these policy checks.

A readable directory open uses `fs:read` with `context.input.operation == Box::FsReadOperation::"enumerate"`. A regular-file read uses the same action with `context.input.operation == Box::FsReadOperation::"read_content"`. The directory-open check authorizes subsequent listing; it does not confirm that listing occurred. Policies that select directory opens by operation must use `enumerate` on both Linux and macOS.

## Stored configuration and rollback

When `[limits]` has no explicit settings, `monty` is `true`, `file-attributes` is `false`, MCP argument wildcards are disabled, MCP executable names are bare, the agent declares no `[[agent.ingress]]`, no egress destination has a backend, `[gateway] upgrade_http` is empty, the box ID is `box-` and 16 hexadecimal digits, every process leaves `file-watching` disabled, and each telemetry target uses only the settings an earlier build reads, configurations without process overrides retain version 21 when disabled and version 22 when enabled. An explicit process override requires record version 23. Two stdio MCP servers that share a program require record version 24. Setting [`file-attributes`](/docs/user-guide/box/reference/configuration/index.md#file-attributes) to `true` requires record version 25. Enabling [MCP argument wildcards](/docs/user-guide/box/guides/add-an-mcp-server/index.md#argument-wildcards) on any server requires version 26. An explicit `limits.shell.timeout` requires record version 27, including `30` and `false`. An [absolute MCP executable path](/docs/user-guide/box/guides/add-an-mcp-server/index.md#select-an-executable-by-path) requires record version 28. A box whose agent declares `[[agent.ingress]]` requires record version 29. A box whose egress re-routes a destination to a [backend](/docs/user-guide/box/guides/network-and-credentials/index.md) requires record version 30. An explicit `limits.shell.max_input` or `limits.shell.max_output` requires record version 31, including values equal to the defaults. A non-empty [`[gateway] upgrade_http`](/docs/user-guide/box/reference/configuration/index.md#gateway) requires record version 32. An explicit `limits.shell.max_stdin` requires record version 33. A box ID that a library caller supplied, other than `box-` and 16 hexadecimal digits, requires record version 34. Enabling [`file-watching`](/docs/user-guide/box/reference/configuration/index.md#file-watching) for any process requires record version 35. A [telemetry target](/docs/user-guide/box/reference/configuration/index.md#telemetrylabel) that uses `accepts`, `headers`, `secret.prefix`, `secret.placement`, a vendor kind, or an `aws://` or `credsd://` secret requires record version 36. Setting [`monty`](/docs/user-guide/box/reference/configuration/index.md#monty) to `false` requires record version 37. A box whose agent, tool, or local MCP server declares a [`deny_write`](/docs/user-guide/box/reference/configuration/index.md#agentfilesystem-and-toolnamefilesystem) list requires record version 38. A [`[secret-source.<scheme>]`](/docs/user-guide/box/reference/configuration/index.md#secret-sourcescheme) table, or a `secret.env` key on a route or a remote MCP server, requires record version 39. A [telemetry target](/docs/user-guide/box/guides/record-telemetry/index.md#include) that names `mcp_tool_calls` requires record version 40. When a configuration selects more than one of these features, it uses the highest required version and retains every selection. Older binaries refuse unsupported versions.

To disable the experiment, change the global setting to `false`. Set `monty` to `true` before returning to a binary that supports only version 21. Remove all process overrides and `[limits]` settings, give each stdio MCP server its own program, set `file-attributes` to `false`, remove `file-watching` from every process, remove `[gateway] upgrade_http`, and give each telemetry target only `env://` or `secret://` bearer settings before returning to a binary that supports only version 21. If MCP argument wildcards are enabled, replace the stars with concrete arguments and disable `argument_wildcards` on each server too. Replace each absolute MCP executable path with a bare program name that the server’s `PATH` resolves to the intended executable. Remove all `[[agent.ingress]]` entries and egress backends before returning to a binary that supports only version 21. Before switching binaries, check that the older build can read both the configuration record and policy history. If both builds support the same policy history format, run once with the current build. This writes a version 21 record while retaining that history. Changing TOML alone does not rewrite an existing record.

The [Dogwood 1.1.2 upgrade](/docs/user-guide/box/reference/policy/index.md#start-with-fresh-history-after-a-dogwood-upgrade) requires a new box directory. To return to the earlier build, use its preserved configuration and box directory. Keep the old and new directories separate. Activity recorded in the new directory does not carry back; Box does not convert that history.

## FAQ

### Does this check every file access?

No. The adapter checks the operations listed in [Coverage and limits](#coverage-and-limits). A file descriptor is a process’s handle to an open file. Later reads or writes through that handle can occur without another open request or policy check. Changing policy does not revoke existing descriptors.

### Why add policy checks when containment already restricts files?

Containment restricts which paths a process can reach. Dogwood adds policy decisions, including rules that depend on prior events. Both restrictions apply. A policy permit cannot expand containment grants.

### Can I enable this through TOML alone?

Only if you already have the compatible build and platform prerequisites described in [Enable native filesystem policy](#enable-native-filesystem-policy). Signed macOS releases include the adapter, but leave it disabled until you select it. The Cargo feature includes the adapter in a build. The TOML setting activates it for a box.

### What happens if I enable it on an unsupported system?

Box refuses startup before the workload runs or the stored record changes. It does not silently disable the selected checks. An absent global setting or `false` keeps interception disabled. An absent process setting inherits the global default.

### Can I disable a tool while keeping the agent mediated?

Yes. Use the per-process settings in [Select workloads](#select-workloads). Tools and local MCP servers inherit the global default independently of the agent. Disabling a workload also excludes its native filesystem operations from policy history.

### Does this change where policy history lives?

No. The adapter uses the box’s existing Dogwood history file. Persisted history survives restarts, but a process crash can lose recent events; see [history persistence](/docs/user-guide/box/reference/policy/index.md#history-persistence-and-process-crashes). Disabling and re-enabling interception does not erase that history. This feature adds no option to keep history only in memory.

### Why disable authorization caching?

The macOS adapter disables kernel authorization caching so intercepted requests receive fresh policy decisions. Reusing an earlier decision could miss changes in policy history. Repeated checks add processing and storage work. Access through an existing descriptor remains subject to the limitation above.

### Does an allow record prove that the operation succeeded?

No. macOS authorization replies produce `indeterminate` outcomes. Linux records the operation performed by its worker; descriptor delivery still precedes later reads or writes through that descriptor. Read the recorded operation and outcome instead of treating every allow as a completed file change.

### Can detached children survive normal Box shutdown?

The shutdown path terminates tracked descendants, including detached children, before interception stops. On macOS, descendant cleanup and callback draining share a five-second deadline. This describes normal shutdown. On macOS, an uncatchable termination such as `SIGKILL` can leave a descendant running without native policy checks; its filesystem grants still apply.

### Can I immediately return to an older binary?

Only when both the stored configuration record and policy history are compatible with the older binary. Follow [Stored configuration and rollback](#stored-configuration-and-rollback) before starting an older binary. Changing TOML alone does not rewrite the stored record.

## Validate the Linux build

Run the kernel suite on a qualified ARM64 Linux host with passwordless `sudo`:

```sh
bash test-native-filesystem/run-linux.sh
```

The script builds the product and helpers before it launches tests. Only test processes receive `CAP_BPF` and `CAP_PERFMON`; compilers keep the caller’s privileges. It runs policy decisions, file effects, workload selection, capability removal, concurrency, shutdown, and file-replacement races. A second build enables deliberate storage, registration, deadline, and worker faults. The script stops on a failed build or test and prints the directory containing retained fixtures.

Privileged tests require the private `box_native_kernel_tests` build setting. Deliberate faults also require `box_native_test_faults`. The script sets these values; ordinary `cargo test --all-features` runs the unprivileged unit tests without enabling them. Ordinary unit-test success does not replace this kernel suite. Neither setting is required to build or use the feature. Do not distribute a build with deliberate faults enabled.

## Validate a signed build

Use the separate native test package after building and signing the current source:

```sh
STRANDS_BOX_SIGNED_TEST_BINARY=/absolute/path/KernelBox.app/Contents/MacOS/strands-box \
  cargo test --manifest-path test-native-filesystem/Cargo.toml --locked -- --nocapture
```

Record the source revision, source changes, and signed executable hash beside the test output. The test package requires the binary path and bounds each workload to 60 seconds. Ordinary workspace tests do not need a signing identity.

The required macOS unit-test jobs build the feature. `Unit Tests (box, macos-latest)` runs the adapter and configuration tests. `Unit Tests (others, macos-latest)` tests the receipt checker and reports receipt freshness as informational. An outdated or invalid receipt does not fail the job. Its summary distinguishes the automated startup tests from the full signed native enforcement suite. That signed suite does not run in this job. Pull requests can merge without fresh signed native test evidence. The manual signed suite and receipt tool remain available. On a hosted runner with an older SDK, the build checks the unsupported-platform code. The signed macOS 27 run covers the active kernel bridge.

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

Review the receipt with the test log. If you need a current receipt, relevant source changes require a new build and signed run. The receipt covers workspace package sources and assets, build configuration, lockfiles, the native test package, its shared capture helper, and the unit-test workflow. Cargo supplies the workspace package list, including nested packages. Separate crate tests, examples, benchmarks, documentation, and unrelated workflows do not invalidate that receipt. `Unit Tests (others, macos-latest)` also runs startup-refusal tests with and without the Cargo feature.

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