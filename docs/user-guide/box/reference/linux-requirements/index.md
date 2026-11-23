Box needs executables that can load on your Linux system and permission to create its sandbox. Here, workload means the program you configure Box to run. These requirements apply when you run Box directly on Linux, in a virtual machine, or inside a container. Check them using the Linux user account and container settings that will start Box.

## Builds and architectures

Linux release executables are built on Amazon Linux 2023. Other distributions must provide the libraries and permissions below. Check them on the distribution you intend to use. Box does not specify a minimum kernel version. Check the required operations and your actual workload.

Use an ARM64 (64-bit Arm) or x86-64 build that matches your system. Neither architecture requires an environment opt-in. A release may omit an architecture. Check its archive and checksum before downloading, or [build from source](/docs/user-guide/box/core/quickstart/index.md#build-from-source). The [tested configurations](#tested-configurations) below record specific checks, not a promise about every distribution or container runtime.

## Requirements

Linux release packages contain three executables: `box`, `strands-box-contain-trampoline`, and `strands-box-sock-alias`. The latter two are helper programs used by Box. An executable’s loader loads the shared libraries it needs.

A namespace gives a process a separate view of resources such as process IDs, mounts, or networking. A Linux capability grants a specific privilege. A system call is a request from a program to the kernel. A seccomp filter restricts the system calls a process can use. Before starting the workload, Box must create its namespaces, remove setup privileges, and install the workload restrictions.

| Requirement | Required value or operation | How to check | What failure means |
| --- | --- | --- | --- |
| Architecture | A matching ARM64 or x86-64 build for Box and the workload. | Run `uname -m`; expect `aarch64` or `x86_64`, matching the archive. | A mismatched executable cannot start natively. |
| GNU C library (glibc) and loader | For release binaries, glibc 2.34 or newer and the matching loader. | Follow [Check the installed binaries](#check-the-installed-binaries). | The main executable or a helper cannot load. |
| GCC runtime library | `libgcc_s.so.1` for the executable’s architecture. | Check that `ldd` resolves every library for all three executables. | An executable with a missing library cannot load. |
| Namespaces | User, mount, process, interprocess communication, and hostname namespaces; a network namespace for default networking. | [Start the intended workload](#check-sandbox-startup) using the Linux user account that will run Box. | Box cannot create the sandbox and does not start the workload. |
| User IDs and file system setup | Map user and group IDs into the sandbox. Expose files with bind mounts, create private temporary file systems, mount process information at `/proc`, and replace the sandbox’s file system root. | Check sandbox startup in the service or container that will run Box. | Box cannot prepare the sandbox and does not start the workload. |
| Workload restrictions | Capability removal, `no_new_privs` to prevent privilege gains on execution, and seccomp filter installation. | Check sandbox startup; inspect any setup error. | Box does not start the workload without the required restrictions. |
| Box executables | Keep all three executables from the same build together on storage that allows execution. Helpers must be regular executable files. | Check file permissions and storage mounts. | Box cannot use a helper that is a symbolic link or lacks execution permission. |
| Private storage | Writable temporary storage and separate directories for Box state and task workspaces. | Check [state-directory ownership and permissions](/docs/user-guide/box/reference/configuration/index.md#keys), temporary storage, and workspace permissions. Keep Box state outside paths the workload can write. | Box cannot prepare its private state or workspace. |
| System interfaces | `/dev/urandom`, `/dev/null`, process and identity information in `/proc`, and Unix-domain sockets for local communication. | Check sandbox startup and the workload’s required operations. | Setup or local communication fails. |
| Application dependencies | The workload’s interpreters, libraries, certificates, and tools, with access permitted by `box.toml`. | Run the workload and its tools inside Box. | Box can start while an application operation still fails. |

The kernel must implement these operations, and the surrounding operating system must permit Box to use them. Installing packages cannot override an operating system or container permission restriction.

## Check the installed binaries

First [download Box and verify its release checksum](/docs/user-guide/box/core/quickstart/index.md#step-1-download-box). The commands here use the guide’s `./box-core` directory. By default, a source build names the main executable `strands-box`.

Record the architecture, kernel, and C library separately:

```sh
uname -m
uname -r
getconf GNU_LIBC_VERSION
```

`uname -m` must match the build. `getconf` must report `glibc 2.34` or newer for release binaries. `uname -r` identifies the kernel being tested; it does not establish that sandbox setup is permitted. In a container, the Linux machine or virtual machine supplies the kernel, while the image supplies the libraries.

Check that the system can find each executable’s required libraries:

```sh
ldd ./box-core/box
ldd ./box-core/strands-box-contain-trampoline
ldd ./box-core/strands-box-sock-alias
```

No required library should report `not found`. The release loader is `/lib/ld-linux-aarch64.so.1` on ARM64 or `/lib64/ld-linux-x86-64.so.2` on x86-64. These commands are diagnostic tools; they are not additional Box runtime dependencies. For a custom source build, inspect that build’s loader and library requirements.

Finally, run `./box-core/box --version`. It should print `strands-box` and the release version. This checks that the main executable loads. It does not create a sandbox or test helper execution.

## Check sandbox startup

Run Box with the configuration and Linux user account you intend to use. Use `box run --config` with your configuration file, as shown in the [Linux installation instructions](/docs/user-guide/box/core/quickstart/index.md#linux) and [configuration reference](/docs/user-guide/box/reference/configuration/index.md).

After the configured program starts inside Box, use that program to check its access. Use disposable files for these checks.

1.  Perform an operation that the configuration permits and check its output or file change.
2.  Attempt a file operation outside the program’s configured access and check that the operation fails.
3.  Check outside Box that files protected from writes retain their original contents.

A version check or a separate test of user namespace creation does not test Box’s complete setup. The operating system can also apply different security rules to a diagnostic program and Box’s launcher. For deployment checks that include cancellation, timeouts, and cleanup, use [Check the deployment](/docs/user-guide/box/reference/cloud-deployments/index.md#check-the-deployment).

### Run a native Linux example

Use this example to check startup and file access without a coding agent or model credentials. It runs the host OS’s Bash to count input lines and write a report.

First [download Box](/docs/user-guide/box/core/quickstart/index.md#step-1-download-box) and complete the binary checks above. Run the block below from the directory that contains `box-core`, using your normal account without `sudo`. You need Bash on `PATH` and the standard Linux utilities `cat`, `cmp`, `cp`, `id`, `mkdir`, and `mktemp`.

Each run creates a fresh directory under `/tmp` and prints its location. The fixed directory template keeps paths safe to insert into TOML, regardless of your account name or installation path. The example leaves its files in place for inspection and does not overwrite an earlier run.

In `box.toml`, the `[agent]` table’s `command` field selects Bash and the script it reads. The `[agent.filesystem]` lists grant reads to the script, input, and read-only control file, plus reads and writes to the output directory. The `config` subdirectory holds `box.toml` and Box’s private state, selected by `box_dir`. Bash receives no grants to this subdirectory. Bash opens the files itself, so this example needs no policy file or grants to other programs.

```sh
bash <<'SETUP'
set -eu
umask 077
if [ "$(id -u)" -eq 0 ]; then
  printf 'Run this example as your normal account, without sudo.\n' >&2
  exit 1
fi
test -x ./box-core/box
example_dir=$(mktemp -d /tmp/box-linux.XXXXXX)
printf 'Example files: %s\n' "$example_dir"
mkdir "$example_dir/config" "$example_dir/workspace" "$example_dir/output"
printf 'alpha\nbeta\ngamma\n' > "$example_dir/input.txt"
printf 'read-only original\n' > "$example_dir/read-only.txt"
printf 'ungranted original\n' > "$example_dir/ungranted.txt"
cp "$example_dir/read-only.txt" "$example_dir/read-only.before"
cp "$example_dir/ungranted.txt" "$example_dir/ungranted.before"
test -r "$example_dir/ungranted.txt"
test -w "$example_dir/read-only.txt"

cat > "$example_dir/workload.sh" <<'WORKLOAD'
set -eu
example_dir=$1
printf 'Workload started\n'
count=0
while IFS= read -r line; do
  count=$((count + 1))
done < "$example_dir/input.txt"
printf 'Input lines: %s\n' "$count" > "$example_dir/output/report.txt"
printf 'Allowed read and write: %s lines\n' "$count"
if IFS= read -r line < "$example_dir/ungranted.txt"; then
  printf 'ERROR: the ungranted read succeeded.\n' >&2
  exit 1
fi
printf 'Ungranted read failed as expected\n'
IFS= read -r line < "$example_dir/read-only.txt"
test "$line" = 'read-only original'
printf 'Read-only file read succeeded\n'
if printf 'changed\n' > "$example_dir/read-only.txt"; then
  printf 'ERROR: the read-only overwrite succeeded.\n' >&2
  exit 1
fi
printf 'Read-only overwrite failed as expected\n'
printf 'Workload completed\n'
WORKLOAD

cat > "$example_dir/config/box.toml" <<TOML
name = "linux-example"
box_dir = "$example_dir/config/state"

[agent]
command = ["bash", "--noprofile", "--norc", "$example_dir/workload.sh", "$example_dir"]
workspace = "$example_dir/workspace"

[agent.filesystem]
read_file = ["$example_dir/workload.sh", "$example_dir/input.txt", "$example_dir/read-only.txt"]
read = ["$example_dir/output"]
write = ["$example_dir/output"]
TOML

./box-core/box run --config "$example_dir/config/box.toml"
printf 'Input lines: 3\n' | cmp - "$example_dir/output/report.txt"
cmp "$example_dir/read-only.before" "$example_dir/read-only.txt"
cmp "$example_dir/ungranted.before" "$example_dir/ungranted.txt"
printf 'Outside checks passed: report matches and protected files are unchanged.\n'
SETUP
```

Alongside Box’s startup disclosure, expect these confirmation messages:

```text
Workload started
Allowed read and write: 3 lines
Ungranted read failed as expected
Read-only file read succeeded
Read-only overwrite failed as expected
Workload completed
Outside checks passed: report matches and protected files are unchanged.
```

Bash also prints an error for each failed file operation, such as `No such file or directory` and `Read-only file system`. The `Workload started` message must appear before those failures. A setup error without that message does not pass the check; use the troubleshooting table below. The final checks run outside Box: they verify the report and compare both protected files with their original contents. The block exits with a nonzero status if Box fails, an ungranted operation succeeds, or a file comparison fails. After the block finishes, you can remove the printed example directory.

## Operating system and container permissions

AppArmor profiles restrict what a Linux program may do. The operating system may restrict user namespace creation by accounts without administrator privileges. Its policy must permit Box’s `strands-box-contain-trampoline` launcher to create those namespaces. A permission for an unrelated diagnostic program does not establish that Box has that permission.

When Box runs inside a container, the container’s own seccomp and AppArmor policies apply before Box installs its restrictions. They must permit the system calls Box uses to create its namespaces and file system, including `unshare`, `mount`, `umount2`, and `pivot_root`. Container rules that hide paths under `/proc` or mount them read-only can also prevent Box from mounting its own process file system. Check these restrictions inside the deployed container, not only in its image definition. Box’s workload policy does not grant these operating system permissions. The [Amazon Elastic Kubernetes Service (Amazon EKS) example’s container settings](/docs/user-guide/box/guides/deploy-to-eks/index.md#cluster-baseline) show one tested configuration. Those settings are not minimum permissions for every container runtime.

Use the failed setup operation to identify what needs configuration:

| Error fragment | What failed | What to check |
| --- | --- | --- |
| `cannot run the Linux package` | Box’s download script could not run the downloaded main executable. | Read the preceding loader error. Check architecture, libraries, and execution permission on the file system where you installed Box. |
| `this identity may not create a user namespace` | The user account running the check could not create a user namespace. | Check operating system namespace policy and the container’s system-call filter using the Linux user account that will run Box. |
| `denying setgroups`, `writing the UID map`, or `writing the GID map` | Box could not prepare user and group ID mappings. | Check the launcher’s namespace permission and access to the new namespace’s identity files in `/proc`. |
| `mounting a fresh proc at` | Box could not mount the file system that provides process information. | Check mount permissions and the container’s hidden or read-only `/proc` paths. These restrictions were one cause in the container test below. |
| `installing the namespace permit filter` | Box could not install a required system-call filter. | Check kernel filter support and restrictions imposed by the service or container running Box. |

`EPERM` means an operation was not permitted; it does not identify which policy layer refused it. Check the surrounding operating system or container diagnostics before changing a permission.

## Tested configurations

These examples record settings and results for specific Box revisions and environments:

-   [Amazon Linux 2023 ARM64 on Amazon EKS](https://github.com/strands-agents/box/blob/91e56bddc102a0ebb44333b50ca5f8a2325092fa/examples/cloud-deployments/eks/README.md#tested-configuration).
-   [Debian 12 ARM64 on Google Compute Engine](https://github.com/strands-agents/box/blob/91e56bddc102a0ebb44333b50ca5f8a2325092fa/examples/cloud-deployments/gcp/README.md#tested-configuration).

Each record identifies the configuration and checks that passed. Repeat the checks for your Box build and deployment.

### Ubuntu and Colima compatibility checks

The following compatibility checks used Box v0.2.3 without changes to its executables. This table summarizes observed results; it does not provide a complete setup procedure or test harness. Both configurations used the same Ubuntu 24.04.4 ARM64 virtual machine, Linux `6.8.0-117-generic`, and Colima `0.10.3`. Colima manages the Linux virtual machine on the Mac used for these checks.

| Execution environment | Configuration needed for startup | Observed result |
| --- | --- | --- |
| Directly in the Ubuntu virtual machine | An executable-specific AppArmor permission for Box’s launcher to create user namespaces. | Startup, Bash, Ubuntu’s Python, and the file access checks described below passed. |
| Ubuntu 24.04 ARM64 container using Docker `29.5.2` in the same virtual machine | Adjusted Docker’s system-call filter, AppArmor profile, and system-path restrictions to permit Box’s setup operations. AppArmor remained enforced. The adjusted security profiles restricted system-call arguments and mount destinations. | The same checks passed without privileged mode or added container capabilities. |

Box could not start a sandbox with the default Ubuntu or Docker configuration. The configured runs read and wrote permitted test files. Reads from the ungranted test files and writes to the read-only test files failed. Checks outside Box confirmed that those protected files retained their original contents. A later run without a grant to an earlier run’s output file could not read that file. These checks did not cover Claude, Codex, interactive sessions, networking, long-running workloads, or other kernels. They establish compatibility for the listed configurations, not a minimum kernel version or a complete deployment test.