Box supports macOS on Apple silicon. Here, workload means the program you configure Box to run. Check the release package and the workload’s access using the macOS account that will run Box.

## Requirements

The release package contains `Box.app`, the `box` launcher, and two helper links: `strands-box-contain-trampoline` and `strands-box-sock-alias`.

| Requirement | Required value or configuration | How to check | What failure means |
| --- | --- | --- | --- |
| Architecture | Apple silicon, using the ARM64 (64-bit Arm) macOS release. | Run `uname -m`; expect `arm64`. | Box’s download script stops if it does not support the operating system and architecture. |
| Release package | Keep `Box.app`, the `box` launcher, and both helper links from the same release together. The helper links point into `Box.app/Contents/MacOS`. | Download and extract the complete package, then [check that Box loads](#check-the-installed-package). | Missing or moved files can prevent Box or a helper from starting. |
| Private state | In `box.toml`, `box_dir` names an absolute path for Box’s private state. Keep the state outside the workspace and paths the workload can write. | Follow the [state-directory requirements](/docs/user-guide/box/reference/configuration/index.md#keys) for creating or reusing the directory. | Box does not start the workload if it cannot create the directory or accept its path, owner, or permissions. |
| Workload dependencies and access | Supply the program, its interpreters, libraries, certificates, and tools. Configure their access in `box.toml`, including writes the workload needs in its workspace. | Run the workload and its tools inside Box. | The program can fail to load, or an operation can fail after Box starts. |

The [Strands command-line walkthrough prerequisites](/docs/user-guide/box/quickstart/index.md#before-you-start) apply to that example. Check the requirements of the workload you intend to run.

## Check the installed package

First [download Box and verify its release checksum](/docs/user-guide/box/quickstart/index.md#step-1-download-box). These commands use the guide’s `./box-core` directory.

Record the architecture and macOS version:

```sh
uname -m
sw_vers -productVersion
```

Run these checks and the download script in a terminal running without Rosetta. Confirm that `uname -m` prints `arm64`. Rosetta translates Intel applications on Apple silicon; a terminal running under Rosetta can report `x86_64`. Record the macOS version with your workload’s check results; the version alone does not establish compatibility.

Run the installed launcher directly:

```sh
./box-core/box --version
```

The command must exit successfully and print `strands-box` followed by its version. This checks that the main executable loads. It does not test helper execution, sandbox startup, or the workload. Check this command’s output and exit status even if the downloader completed.

The release’s signed and notarized `Box.app` contains its executables. Keep the complete downloaded directory intact. Do not move individual executables out of `Box.app`. For a source build, follow [Build from source](/docs/user-guide/box/quickstart/index.md#build-from-source).

## Check sandbox startup and the workload

Use your intended `box.toml` configuration and macOS account. The [configuration reference](/docs/user-guide/box/reference/configuration/index.md) describes the program, workspace, and access settings. Replace `/absolute/path/box.toml` with the absolute path to your configuration:

```sh
./box-core/box run --config /absolute/path/box.toml
```

Box applies its macOS process sandbox before starting the configured program. If applying those restrictions fails, Box does not start that program. After the configured program starts inside Box, use that program to check its access. Use disposable files for these checks.

1.  Perform an operation that the configuration permits and check its output or file change.
2.  Attempt a file operation outside the program’s configured access and check that the operation fails.
3.  Check outside Box that files protected from writes retain their original contents.

Run these checks for the application and tools you intend to use. A program that starts outside Box can still fail inside its sandbox. Repeat the checks when Box, macOS, the workload, or its configuration changes.

## Optional native filesystem policy

Signed macOS releases include [experimental native filesystem policy](/docs/user-guide/box/security/native-filesystem-policy/index.md), which checks selected file operations against Box’s configured access policy. It is disabled by default. This feature requires macOS 27 or later and a compatible signed build. Follow [Enable the experiment](/docs/user-guide/box/security/native-filesystem-policy/index.md#enable-the-experiment) for its build and signing requirements and the `box.toml` setting that enables it. If you enable the feature without meeting its requirements, Box does not start the configured program.