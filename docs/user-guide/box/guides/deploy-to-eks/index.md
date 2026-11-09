Amazon Elastic Kubernetes Service (EKS) runs these Box workloads as Kubernetes Jobs. Start with the fixed script to check project changes and protected-file refusals. Then run Claude Code against a mock deployment service to see Box block retries after repeated failures.

## Before you start

Use an EKS cluster with Linux ARM64 workers and pod user namespaces. ARM64 is the 64-bit Arm processor architecture. The worker and admission settings must permit `hostUsers: false`, `procMount: Unmasked`, and `seccompProfile: Unconfined`. These settings relax the outer container’s restrictions so Box can create its own sandboxes. The workload runs as user 991, drops capabilities, and disables privilege escalation.

Install Docker with an ARM64 builder, Python 3, and `kubectl`. Authenticate to a container registry that you can push to and your workers can pull from. Configure `kubectl` for your cluster. The [EKS connection guide](https://docs.aws.amazon.com/eks/latest/userguide/create-kubeconfig.html) explains that step. Cluster and registry usage can incur charges.

The [sample README](https://github.com/strands-agents/box/blob/f4180a035d2d164596135864604629529636bf1c/examples/cloud-deployments/eks/README.md#tested-configuration) lists the Box revision, platform versions, and results for each example. The coding and deployment examples passed on EKS, including checks through the full ten-minute cooldown. Test the deployment example on your cluster. The recorded versions are tested configurations, not minimum requirements.

## Build the image

Clone the repository and enter the sample directory:

```sh
git clone https://github.com/strands-agents/box.git
cd box/examples/cloud-deployments/eks
export IMAGE='YOUR_REGISTRY/box-example:scripted'
export NAMESPACE='box-example'
export KUBE_CONTEXT='YOUR_KUBERNETES_CONTEXT'
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

The runner creates a Job, waits for completion, and saves logs and a receipt under `evidence/JOB_NAME/`. A successful receipt contains `passed: true` and 11 successful checks. A failed workload or missing result returns a nonzero exit code. If polling fails after submission, the runner saves an incomplete receipt and prints the command to inspect the existing Job. The Job can continue running. Use its recorded name for inspection and cleanup.

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

`InstallAgent=false` uses an existing Pod Identity Agent addon. If your cluster lacks that addon, use `InstallAgent=true` and a compatible `AgentVersion` parameter. Follow the [Pod Identity setup requirements](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html), including the worker’s permission to assume pod identities. The trusted controller needs network access to the AWS endpoints used for credentials and model calls.

The runner selects `deployment-cooldown` by default for Claude and records the selected example in `receipt.json`. A successful result contains `passed: true`. The test checks for three failed deployments, at least two blocked retries, and a successful status check after the failures. The mock service returns HTTP 503 (service unavailable) for its first three deployment requests and HTTP 201 (created) afterward. Box enforces the cooldown.

The agent finishes after those checks. It does not wait for the cooldown to end. Run the [test without a model](https://github.com/strands-agents/box/blob/f4180a035d2d164596135864604629529636bf1c/examples/cloud-deployments/eks/claude/README.md#check-cooldown-expiry-without-a-model) to check that deployment becomes available again. That test waits through the full ten-minute cooldown and checks that Box permits the next deployment request. The supplied client makes sequential calls within one box. Requests already in flight and activity in other boxes remain outside this limit. Model responses can vary. Check `receipt.json` for the test result, even if the agent reports success.

To run the coding and file-permission example, select `boundaries`:

```sh
python3 run.py --mode claude --exercise boundaries \
  --image "$CLAUDE_IMAGE" --namespace "$NAMESPACE" --context "$KUBE_CONTEXT" \
  --service-account "$SERVICE_ACCOUNT" --region "$AWS_REGION" \
  --model us.anthropic.claude-sonnet-4-6
```

Its expected result is `passed: true` with 23 successful checks.

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