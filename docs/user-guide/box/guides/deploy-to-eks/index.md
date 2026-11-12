Amazon Elastic Kubernetes Service (EKS) runs these Box workloads as Kubernetes Jobs. Start with the fixed script to check project changes and protected-file refusals. Then run Claude Code against a mock deployment service to see Box block retries after repeated failures.

## Before you start

Use an EKS cluster with Linux ARM64 workers. ARM64 is the 64-bit Arm processor architecture. Install Docker with an ARM64 builder, Python 3, and `kubectl`. Authenticate to a container registry that you can push to and your workers can pull from. Configure `kubectl` for your cluster. The [EKS connection guide](https://docs.aws.amazon.com/eks/latest/userguide/create-kubeconfig.html) explains that step. Cluster and registry usage can incur charges.

## Check your cluster

The scripted example passed on EKS 1.33.13; the Claude examples were tested on EKS 1.35. The [tested configurations](https://github.com/strands-agents/box/blob/a2cf46ed6a9ea0a8144101bfdef3f2406390952b/examples/cloud-deployments/eks/README.md#tested-configuration) list worker versions and results. These are tested combinations, not minimum supported versions.

Your cluster must accept these settings, and its workers must support them:

| Setting in the generated Job | Why Box needs it |
| --- | --- |
| Pod `hostUsers: false` | Give the Pod user IDs that are separate from the worker node’s IDs. |
| Container `procMount: Unmasked` | Leave the outer container’s `/proc` unmasked so Box can mount this process-information filesystem inside its sandboxes. |
| Container `seccompProfile.type: Unconfined` | Allow the Linux system calls Box uses to create its sandboxes. |

Cluster admission rules, which can accept, reject, or change a Pod, must allow all three settings. Permission to create a Job does not ensure that its Pod will be accepted. These settings relax the outer container’s restrictions. The workload still runs as user 991, drops capabilities, and disables privilege escalation.

Select the Kubernetes context for the cluster where you will run the example, then inspect its versions. A context is a named `kubectl` configuration that selects a cluster and credentials.

```sh
export KUBE_CONTEXT='YOUR_KUBERNETES_CONTEXT'
kubectl --context "$KUBE_CONTEXT" version -o yaml
kubectl --context "$KUBE_CONTEXT" get nodes -o custom-columns='NAME:.metadata.name,KUBELET:.status.nodeInfo.kubeletVersion,KERNEL:.status.nodeInfo.kernelVersion,RUNTIME:.status.nodeInfo.containerRuntimeVersion,ARCH:.status.nodeInfo.architecture'
```

Check both the control plane and the workers. Upgrading the control plane alone does not establish that the workers can run this example.

Before creating a Job, `run.py` checks whether Kubernetes preserves the required settings. Your Kubernetes identity needs permission to create Jobs, even for this check. The script stops if a required setting changes. Passing the check does not verify worker support; the workload must still start and pass its checks. See [Troubleshoot startup](#troubleshoot-startup) if the run fails.

## Build the image

Clone the repository and enter the sample directory:

```sh
git clone https://github.com/strands-agents/box.git
cd box/examples/cloud-deployments/eks
export IMAGE='YOUR_REGISTRY/box-example:scripted'
export NAMESPACE='box-example'
docker build --platform linux/arm64 --target scripted -t "$IMAGE" .
docker push "$IMAGE"
```

The Dockerfile fetches and builds the pinned Box source. Build dependencies remain in the build stage. The runtime image contains Box, Python, Bash, and the exercise. Record the pushed image digest. For repeated runs, set `IMAGE` to that immutable digest.

## Submit the Job

Inspect the generated Job before submitting it:

```sh
python3 run.py --image "$IMAGE" --namespace "$NAMESPACE" --render
```

The output is a Job document with one workload container and an ARM64 node selector. The fixed script requires no model access or workload role.

```sh
kubectl --context "$KUBE_CONTEXT" create namespace "$NAMESPACE" --dry-run=client -o yaml | \
  kubectl --context "$KUBE_CONTEXT" apply -f -
python3 run.py --image "$IMAGE" --namespace "$NAMESPACE" --context "$KUBE_CONTEXT"
```

The script creates the Job, checks its Pod settings, and waits for completion. It saves logs and `receipt.json`, the run’s result record, under `evidence/JOB_NAME/`. A successful scripted run reports `passed: true` and 11 successful checks. A failed workload or missing result returns a nonzero exit code.

For a failed run, follow [Troubleshoot startup](#troubleshoot-startup). The script prints a command to inspect an existing Job if monitoring fails.

## Read the result

The workload corrects `add(a, b)` through Box’s shell. An independent check verifies three arithmetic cases and the exact resulting source. The remaining checks compare policy decisions, native access results, and protected-file hashes.

| Operation | Expected result |
| --- | --- |
| Read and change project files through Box’s shell | Permitted. |
| Read the private fixture directly or through the shell | Refused. |
| Change the read-only reference file | Refused. |
| Delete the protected project file | Refused by policy. |
| Request `https://example.com/` | Refused by policy. |

Use `receipt.json` for the outcome and `stdout.json` for individual checks. Use `pods.json` and `stderr.txt` to diagnose startup or admission failures. A client error alone does not establish a policy refusal. The verifier also checks the decision records.

## Run Claude Code

Claude Code uses an Amazon Bedrock model. Its tools send requests to a mock deployment service for a checkout application. The service simulates deployment failures. It does not deploy application code. After three failed responses within five minutes, Box blocks deployment retries for ten minutes. This pause is the cooldown. The agent can still check deployment status.

The agent uses Model Context Protocol (MCP) to call `deploy_checkout` and `deployment_status`. Box checks their HTTP requests before forwarding permitted requests to the mock service. Use `us-west-2` and access to the selected `us.anthropic.claude-sonnet-4-6` inference profile. The dedicated workload role grants invocation access to the selected model and the account’s default Bedrock project. It also grants `bedrock:CallWithBearerToken` for the temporary token.

Use EKS Pod Identity to connect the role to a separate Kubernetes service account. The trusted controller obtains credentials outside the agent’s sandbox and generates a short-lived Bedrock token. Box inserts the token into permitted model requests. The agent receives a substitute value. Direct credential retrieval from inside the agent’s sandbox requires separate validation.

Before running these commands, check the [Pod Identity setup requirements](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html), including the worker’s permission to assume pod identities. The commands set the `pod-identity.json` template’s `InstallAgent` parameter to `false`, which uses an existing Pod Identity Agent addon. If your cluster lacks that addon, set `InstallAgent=true` and supply a compatible `AgentVersion` parameter. The trusted controller needs network access to the AWS endpoints used for credentials and model calls.

```sh
export AWS_REGION='us-west-2'
export CLUSTER_NAME='YOUR_CLUSTER'
export SERVICE_ACCOUNT='box-example'
export IDENTITY_STACK='BoxExamplePodIdentity'
export CLAUDE_IMAGE='YOUR_REGISTRY/box-example:claude'
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" create serviceaccount "$SERVICE_ACCOUNT"
aws cloudformation deploy --region "$AWS_REGION" --stack-name "$IDENTITY_STACK" \
  --template-file pod-identity.json --capabilities CAPABILITY_IAM \
  --parameter-overrides ClusterName="$CLUSTER_NAME" Namespace="$NAMESPACE" \
    ServiceAccount="$SERVICE_ACCOUNT" InstallAgent=false
docker build --platform linux/arm64 --target claude -t "$CLAUDE_IMAGE" .
docker push "$CLAUDE_IMAGE"
python3 run.py --mode claude --exercise deployment-cooldown \
  --image "$CLAUDE_IMAGE" --namespace "$NAMESPACE" --context "$KUBE_CONTEXT" \
  --service-account "$SERVICE_ACCOUNT" --region "$AWS_REGION" \
  --model us.anthropic.claude-sonnet-4-6
```

The runner selects `deployment-cooldown` by default for Claude and records the selected example in `receipt.json`. A successful result contains `passed: true`. The test checks for three failed deployments, at least two blocked retries, and a successful status check after the failures. The mock service returns HTTP 503 (service unavailable) for its first three deployment requests and HTTP 201 (created) afterward. Box enforces the cooldown.

The agent finishes after those checks. It does not wait for the cooldown to end. Run the [test without a model](https://github.com/strands-agents/box/blob/a2cf46ed6a9ea0a8144101bfdef3f2406390952b/examples/cloud-deployments/eks/claude/README.md#check-cooldown-expiry-without-a-model) to check that deployment becomes available again. That test waits through the full ten-minute cooldown and checks that Box permits the next deployment request. The supplied client makes sequential calls within one box. Requests already in flight and activity in other boxes remain outside this limit. Model responses can vary. Check `receipt.json` for the test result, even if the agent reports success.

To run the coding and file-permission example, select `boundaries`:

```sh
python3 run.py --mode claude --exercise boundaries \
  --image "$CLAUDE_IMAGE" --namespace "$NAMESPACE" --context "$KUBE_CONTEXT" \
  --service-account "$SERVICE_ACCOUNT" --region "$AWS_REGION" \
  --model us.anthropic.claude-sonnet-4-6
```

Its expected result is `passed: true` with 23 successful checks.

## Troubleshoot startup

### Kubernetes changes a required setting

Before creating the Job, the script sends a server-side dry run: the Kubernetes API server validates and processes the request without saving it. If the returned settings differ from those Box requires, the script reports the mismatch and creates no Job:

```text
The cluster did not preserve required Box settings in the server dry-run Job; no Job was created:
  hostUsers: expected false; received null; check UserNamespacesSupport and admission rules
  procMount: expected Unmasked; received "Default"; check ProcMountType and admission rules
```

A feature gate is a switch that enables a Kubernetes feature. Kubernetes 1.31 has separate gates, `UserNamespacesSupport` for `hostUsers` and `ProcMountType` for `procMount`. When these API-server gates are disabled, Kubernetes can remove `hostUsers` or replace `procMount` with `Default` instead of rejecting the request. Both features became enabled by default in upstream Kubernetes 1.33. That default does not verify an EKS cluster’s workers or admission rules.

The error names these gates as troubleshooting hints. A changed seccomp profile points to Pod Security and other admission rules. The script does not inspect the gates or rules, so these hints do not confirm the cause.

Use the [tested configurations](https://github.com/strands-agents/box/blob/a2cf46ed6a9ea0a8144101bfdef3f2406390952b/examples/cloud-deployments/eks/README.md#tested-configuration) as a starting point when choosing cluster and worker versions. This guide does not provide a validated older-cluster opt-in procedure. Changing only `spec.kubelet.config.featureGates.UserNamespacesSupport` in an Amazon Linux 2023 node launch template does not enable an API-server feature or `ProcMountType`.

### The Job does not create a Pod

A Job can be accepted while its Pod is rejected. The script prints dry-run warnings and, until it first observes a Pod, reads the Job’s `FailedCreate` events to show why Pod creation failed. Your Kubernetes identity needs permission to list events in the namespace for this diagnostic. If the query fails, the script saves the error, prints a warning, and continues waiting until its deadline.

Pod-creation errors remain warnings while the controller retries. Quota exhaustion, webhook outages, and admission rules can change; the script accepts a later valid Pod. If the Job fails before creating a Pod or the wait expires, `receipt.json` includes the last creation error. See the [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/) if the error reports a Pod Security rejection.

### The Job or Pod settings change after submission

The script checks the created Job and its Pods because Pod admission can differ from Job admission. `pod-configuration.json` saves the last Pod configuration checked during polling. A mismatch produces a failed `receipt.json` and a command to inspect the existing Job. The Job remains available for inspection and cleanup.

A Pod might already have started before this check. The check diagnoses configuration changes; it is not a security boundary. Preserved settings do not prove that the workload can start and pass its checks.

### The worker cannot start the workload

Inspect `pods.json` and `stderr.txt` for startup errors. Pod user namespaces require support from the API server, kubelet, container runtime, and worker filesystems. A nonzero `/proc/sys/user/max_user_namespaces` does not prove that all of these support the required configuration. See the [Kubernetes user namespace requirements](https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/).

After saving the result, the script tries to record worker versions in `node-diagnostics.json`. If it cannot read this information, it prints a warning without changing the workload result. These diagnostics help investigate startup failures; they do not verify sandbox support.

The script records worker names while monitoring Pods, then reads each worker’s kubelet, kernel, container runtime, and architecture once. This optional lookup needs `get node NODE_NAME` permission, not permission to list nodes. Missing permission, a timeout, or an invalid response produces a warning. All lookups share a separate ten-second budget and cannot consume the Job monitoring deadline.

### The script stops monitoring an existing Job

If polling fails after submission, the script saves an incomplete `receipt.json` and prints the command to inspect the existing Job before looking up worker versions. The Job can continue running. Use its recorded name for inspection and [cleanup](#clean-up).

## Clean up

Use the Job name printed by the runner:

```sh
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" delete job JOB_NAME_FROM_RECEIPT
```

Repeat for each example Job you created. If you created the optional identity stack, delete it after its Jobs finish:

```sh
aws cloudformation delete-stack --region "$AWS_REGION" --stack-name "$IDENTITY_STACK"
aws cloudformation wait stack-delete-complete --region "$AWS_REGION" --stack-name "$IDENTITY_STACK"
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" delete serviceaccount "$SERVICE_ACCOUNT"
```

Delete the example images through your registry’s image-management tools when you finish. Retain shared cluster resources and any existing Pod Identity addon.