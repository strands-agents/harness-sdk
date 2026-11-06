Use these profiles to prepare Box for AgentCore Runtime managed code, customer containers, or Lambda MicroVM. Each profile lists what the cloud environment must provide and what to check after deployment.

## Install and configure Box

Linux release packages target ARM64 (`aarch64-unknown-linux-gnu`), with executables built against Amazon Linux 2023. If a [release](https://github.com/strands-agents/box/releases) includes Linux, follow its Linux download and checksum instructions. Otherwise, [build from source](https://github.com/strands-agents/box/blob/e39544d49188b82933264b83159c7ccc278ced5a/README.md#build-from-source) on ARM64 Amazon Linux 2023. Use an ARM64 runtime, container, or MicroVM. Check that `uname -m` reports `aarch64`.

Keep the main executable and both helpers from the same build in one directory. Release packages call the main executable `box`; source builds call it `strands-box`. The helpers are `strands-box-contain-trampoline` and `strands-box-sock-alias`. Both helpers must be regular executable files. Box refuses helper symlinks and files without executable permissions.

Use the [configuration reference](../configuration/index.md) to configure Box.

[Native filesystem policy](../../security/native-filesystem-policy/index.md) is macOS-only. A Linux build refuses a `box.toml` that enables it.

## Shared requirements

The cloud service must permit Box to create its namespaces and mounts. Installing dependencies cannot overcome an outer service restriction on those operations.

| Requirement | Operator action | Reason |
| --- | --- | --- |
| Architecture | Select ARM64 for the service, Box executables, and application image. Check `uname -m`. | Executables and system-call filters depend on the architecture. |
| System libraries | Provide the dynamic loader and libraries required by your Box build. | A package name alone does not establish binary compatibility. |
| Namespaces | Permit user, mount, process, interprocess communication, and hostname namespaces. Permit a private network namespace for default networking. | A user-namespace probe alone does not test the full setup. |
| Identity and mounts | Permit identity mapping, bind mounts, private temporary filesystems, a process filesystem, and root replacement. | Box constructs a separate filesystem and process view. |
| Workload restrictions | Permit capability removal, `no_new_privs`, and seccomp filter installation. | Box removes setup privileges and restricts workload system calls. |
| Private state | Provide writable temporary storage and separate directories for Box state and task workspaces. | Box control state must remain outside workload-writable grants. |
| System interfaces | Provide `/dev/urandom`, `/dev/null`, required `/proc` interfaces, and Unix-domain sockets. | Setup uses these for process inspection, identity mapping, and local communication. |
| Application dependencies | Include interpreters, libraries, certificates, and tool dependencies. Test their contained execution. | A program that starts outside Box can still fail inside its sandbox. |

On Amazon Linux, record `rpm -q glibc` and `rpm -q libgcc` as part of the dependency inventory. Record `uname -r` separately from `/etc/os-release`: the cloud service supplies the kernel, even when you supply the image. These inventory commands do not establish a minimum package or kernel version.

How Box uses Linux capabilities during startup

Box uses temporary Linux capabilities while it constructs namespaces and mounts. `CAP_SYS_ADMIN` applies inside the new user namespace. It does not imply administrative access to the surrounding operating system. Box uses `CAP_SETPCAP` to remove setup capabilities before workload execution. The localhost relay uses `CAP_NET_ADMIN` to enable its private loopback interface. These operations do not constitute a general container `cap-add` recipe.

## AgentCore Runtime managed code

[Amazon Bedrock AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html) supplies the language runtime. Your deployment archive supplies the application, Box executables, policy, and workload dependencies.

| Configuration | Operator action |
| --- | --- |
| Service runtime | Select the service runtime and language version for your application. Check namespace setup inside that runtime. |
| Operator identity | Start Box under the service identity. Record its user ID, group ID, and effective capabilities. |
| Application endpoints | Start the HTTP application on port `8080`, with `GET /ping` and `POST /invocations`. |
| Payload | Extract bundled files into a private temporary directory. Check executable permissions and payload hashes. |
| Task state | Give each task its own workspace and Box state. Check the session filesystem settings before assuming state survives another invocation. |
| Dependencies | Inventory the service-controlled libraries. Bundle application dependencies that the service does not supply. |

## AgentCore Runtime customer container

Your ARM64 image supplies the application and its dependencies. AgentCore Runtime supplies the kernel and outer execution restrictions. Check the deployed image inside the service; a local container run cannot establish those restrictions.

| Configuration | Operator action |
| --- | --- |
| Image | Use a base image compatible with the Box executables and application. Record the immutable image digest. |
| Operator identity | Create a non-root application account and select it with the image’s `USER` instruction. Check namespace setup under that identity. |
| Application endpoints | Configure the entry point to start the HTTP application on port `8080`, with `GET /ping` and `POST /invocations`. |
| Files | Keep application files separate from private temporary task data. Give the operator access to its state and workspaces. |
| Dependencies | Install the application’s interpreters, libraries, certificates, and tool dependencies. Avoid treating probe-only packages as Box requirements. |

## Lambda MicroVM

A [Lambda MicroVM](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html) deployment supplies an application image and lifecycle hooks. Configure each listener to match the service settings and check the hooks inside the running MicroVM.

| Configuration | Operator action |
| --- | --- |
| Managed base | Record the managed base and its version separately from the application image digest. |
| Architecture | Select ARM64 for the MicroVM, application, and Box executables. |
| Identity and capabilities | Check namespace and mount setup under the selected user and capability profile. |
| Application | Configure the application listener and lifecycle-hook listener separately, for example on ports `8080` and `9000`. |
| Lifecycle hooks | Handle ready, validate, run, resume, suspend, and terminate transitions. Track the active task across them. |
| Files and capacity | Use separate private task directories, for example beneath `/work`. Measure memory and storage for the actual workload. |

Running as root with `additionalOsCapabilities: ["ALL"]` is a broad configuration choice, not a minimum-privilege recommendation. It does not replace Box’s workload restrictions. Test any narrower profile independently. Do not infer that a successful startup proves task cleanup or restoration works.

## Check the deployment

Keep results for each Box build, service configuration, image, and workload separate. Record their revisions and dependency versions in the deployment’s test evidence.

1.  Check startup under the actual service identity and capability profile.
2.  Run the application and its tools inside Box.
3.  Check permitted operations and required refusals, including filesystem and network access.
4.  Check normal completion, cancellation, timeout, and forced termination separately.
5.  Check for surviving task processes, continued writes, and retained task directories after each termination case.
6.  After restoration, check process identity, new model and tool operations, and cleanup when the restored task ends.

A completed run can fail these checks. Normal completion does not establish cancellation or timeout behavior. Deleting task directories does not prove that task processes stopped. Repeat the checks when Box, the service runtime, the image, or the workload changes.

## Terms

| Term | Definition | Notes |
| --- | --- | --- |
| Namespace | A Linux mechanism that gives processes a separate view of selected resources. | Examples include process IDs, mounts, and network interfaces. |
| Capability | A Linux privilege for a specific class of operations. | Its namespace scope matters. |
| Seccomp | A Linux mechanism that filters system calls. | Workload restrictions use filter mode. |
| `no_new_privs` | A Linux process setting that prevents execution from granting new privileges. | Process status reports it as `NoNewPrivs`. |
| Lifecycle hook | Application code that a service calls during an execution transition. | Examples include resume and terminate. |
| Qualification | Tests required to accept a candidate on a specified target. | A completed test run can fail qualification. |