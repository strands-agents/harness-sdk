Use these profiles to prepare Box for AgentCore Runtime managed code, customer containers, or Lambda MicroVM. Each profile lists what the cloud environment must provide and what to check after deployment.

## Install and configure Box

The service profiles below describe ARM64 deployments. Select an ARM64 runtime, container, or MicroVM and check that `uname -m` reports `aarch64`. [Download Box Core](/docs/user-guide/box/core/quickstart/index.md#step-1-download-box), keeping the main executable and both helpers from the same build together. Check the [Linux requirements](/docs/user-guide/box/reference/linux-requirements/index.md) for required libraries, permissions to create the sandbox, and architecture selection.

Use the [configuration reference](/docs/user-guide/box/reference/configuration/index.md) to configure Box.

[Native filesystem policy](/docs/user-guide/box/security/native-filesystem-policy/index.md) is macOS-only. A Linux build refuses a `box.toml` that enables it.

## Shared requirements

Use the shared [Linux requirements](/docs/user-guide/box/reference/linux-requirements/index.md) for libraries, namespaces, mounts, workload restrictions, private storage, and application dependencies. Check them inside the deployed service using the Linux user account that starts Box. The service supplies the kernel and controls which system calls and namespace and mount operations Box can use. If you use a container, its image supplies the libraries. If setup fails, use the [permission troubleshooting table](/docs/user-guide/box/reference/linux-requirements/index.md#operating-system-and-container-permissions).

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