Run a Strands agent with Gemini on a Google Compute Engine Linux virtual machine (VM). The agent tries to deploy a checkout service that returns three failures. Box then blocks deployment retries for ten minutes while status checks remain available. The deployment service is a local mock. The agent makes real Gemini requests through the Vertex AI API. No AWS account or credentials are required.

## What runs

The VM builds Box from a pinned revision and installs the locked Python dependencies. A trusted controller starts the mock service and Box as an ordinary Linux user. Box starts the Strands agent with access to its Python runtime and a scratch directory.

The controller reads a short-lived token from the VM’s service account. The agent receives a placeholder. Box substitutes the token only on the permitted Gemini route. The agent cannot request arbitrary Google APIs through that route.

| Operation | What Box does |
| --- | --- |
| Request the first three deployments | Allows the requests. The mock service returns HTTP 503. |
| Retry after three failures within five minutes | Blocks the request before it reaches the service. |
| Read deployment status during the cooldown | Allows the request. |
| Request another deployment path | Refuses the request. |
| Retry after the ten-minute cooldown | Allows the request in the separate policy check. |
| Call Gemini | Allows streaming requests for the configured project, location, and model. |

Dogwood is Box’s policy language. The [policy](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/examples/cloud-deployments/eks/claude/deployment_policy.py) counts completed failure responses in this Box’s history. The tools contain no retry guard. The mock service accepts the first request that reaches it after those three failures.

## Before you start

Install Python 3.10 or later, Git, and the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install). Use a Google Cloud project with billing and access to your selected Gemini model. Your deployment account needs permission to:

-   Enable project APIs.
-   Inspect, create, and delete Compute Engine VMs, disks, networks, and subnets.
-   List, inspect, create, and delete service accounts.
-   Inspect, create, and delete custom Identity and Access Management (IAM) roles.
-   Read project IAM policy, and add and remove role bindings.
-   Attach the new service account to the VM with `iam.serviceAccounts.actAs`.

The VM service account receives only `aiplatform.endpoints.predict`.

The [sample README](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/examples/cloud-deployments/gcp/README.md#tested-configuration) records the tested image, source revision, and runtime versions.

The default deployment creates a billable `t2a-standard-4` VM and a 40 GB disk in `us-central1-a`. It creates a separate network with no incoming firewall rules. The VM uses an ephemeral external IP for outgoing downloads and model calls. No SSH access or downloaded service-account key is needed.

## Deploy

Clone the repository, then sign in and select your project:

```sh
git clone https://github.com/strands-agents/box.git
cd box
gcloud auth login
export GOOGLE_CLOUD_PROJECT="your-project-id"
```

Create the VM:

```sh
python3 examples/cloud-deployments/gcp/deploy.py deploy \
  --project "$GOOGLE_CLOUD_PROJECT" \
  --model gemini-3.8-flash
```

The helper enables the Compute Engine, IAM, and Vertex AI APIs.

Google notes that [new service accounts can take 60 seconds or more to become visible](https://cloud.google.com/iam/docs/service-accounts-create). The helper retries role binding and VM creation when Google explicitly reports that this account does not exist. It uses [increasing retry delays](https://cloud.google.com/iam/docs/retry-strategy), with at most 120 seconds of waiting per operation.

The VM builds Box and runs two checks. Allow time for the source build and the ten-minute cooldown check.

Read progress and save the results:

```sh
python3 examples/cloud-deployments/gcp/deploy.py status \
  --project "$GOOGLE_CLOUD_PROJECT"
```

Run `status` again until `phase` is `complete` or a setup error appears. A successful result has `probe.passed` and `demo.passed` set to `true`, with both exit codes equal to zero. The helper saves `deployment.json`, `serial.log`, and `results.json` under your local cache directory. Its output gives their paths.

Use `--name` for a separate deployment and `--state-dir` for another evidence directory. Supply those same values to `status` and `cleanup`. The receipt records the pinned Debian image, Box revision, and example payload checksum. Each result records the kernel, architecture, Python version, binary checksum, backend requests, and Box decisions.

## What the checks prove

The policy check uses fixed HTTP requests without a model. It waits through the full 600-second cooldown and confirms that refused retries do not extend it. It also verifies that diagnostics remain available after the five-minute failure window ends.

The agent check uses one Strands agent and eight live model turns. Fixed prompts request seven tool calls, including two deliberate retries during the cooldown. The final turn summarizes the observed results. The controller checks the service receipts and Box decisions independently. This is a policy demonstration with prescribed operations, not a test of autonomous incident recovery.

For the policy check without model calls, create a separate deployment:

```sh
python3 examples/cloud-deployments/gcp/deploy.py deploy \
  --project "$GOOGLE_CLOUD_PROJECT" \
  --name box-gcp-probe --probe-only
```

Use `--name box-gcp-probe` with its status and cleanup commands. This mode succeeds when `probe.passed` is `true` and `probe_exit_code` is zero. It creates the VM and waits through the full cooldown, but omits the agent check.

## Clean up

Save the results, then remove the resources:

```sh
python3 examples/cloud-deployments/gcp/deploy.py cleanup \
  --project "$GOOGLE_CLOUD_PROJECT"
```

Cleanup checks each resource’s ownership marker before removal. It continues if serial output is unavailable, so a stopped VM can still be removed. It removes the VM, boot disk, network, subnet, service account, custom role, and role binding. It keeps local evidence and leaves shared project APIs enabled. Use cleanup after a failed deployment too. Keep the deployment receipt until cleanup succeeds.

After cleanup succeeds, choose a new `--name` when you deploy again. Cleanup retains the old receipt and evidence. For example, add `--name box-gcp-demo-retry` to the deploy command. Use that name for its status and cleanup commands.

## Platform and limits

The deployment targets Debian 12 on an ARM64 Compute Engine VM. It requires unprivileged Linux user namespaces and Box’s experimental Linux support. User namespaces let Box create the workload’s isolated process environment without administrator privileges. The startup script checks namespace creation before the build. It does not disable a host security mechanism or require a privileged container.

Box uses native filesystem grants for Python libraries, example code, and the writable scratch directory. Python extension libraries also need executable mappings. The configuration grants execution to each imported library, or its containing directory when Debian installs the library without executable file permissions. Those grants bypass per-operation Dogwood filesystem checks. On Linux, writable mounts also allow reads. The temporal policy applies to HTTP requests through Box’s gateway.

Each run has separate Box history. The cooldown is not a shared quota across VMs or concurrent agents. The model check stops before cooldown expiry. The separate policy check verifies expiry. The controller does not refresh its token during a run and requires sufficient token lifetime before it starts. It retains up to 4 MiB of standard output and 1 MiB of standard error for each Box run. This example does not establish support for Google Kubernetes Engine, Cloud Run, x86-64 Linux, or other VM images.

The [source revision](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/examples/cloud-deployments/gcp/deploy.py), [dependency lock](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/examples/cloud-deployments/gcp/dependency-lock.txt), and [startup script](https://github.com/strands-agents/box/blob/fbe415cbdfec284bf608a46f125ff8e437a99bda/examples/cloud-deployments/gcp/setup-vm.sh) define the build. Model availability can change. Select another supported Gemini model with `--model` when needed. The default image is `debian-12-bookworm-arm64-v20261102` from `debian-cloud`. Use `--image` to select another Debian image and rerun the checks.