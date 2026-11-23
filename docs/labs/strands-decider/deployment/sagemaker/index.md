Host Strands Decider on a SageMaker real-time endpoint in your AWS account. Two paths: a one-click launch from **JumpStart**, or the Decider repo’s **CDK stack** for a repeatable, tunable deploy.

-   **When to pick it:** production traffic, GPU inference, multi-tenant services. Prefer [Local](/docs/labs/strands-decider/deployment/local/index.md) for dev or [Lambda](/docs/labs/strands-decider/deployment/lambda/index.md) when traffic is bursty and you want pay-per-request.

## JumpStart

The fastest path: open **[SageMaker Studio](https://aws.amazon.com/sagemaker/studio/) → JumpStart**, search for **Strands Decider**, pick a model variant and instance type, and click **Deploy**. JumpStart creates the SageMaker model, endpoint config, and endpoint for you; no CDK, no CodeBuild, no S3 copy to manage.

Good for:

-   a one-off eval on a specific checkpoint;
-   picking the instance type interactively while reading the published model card;
-   teams that prefer the console over Infrastructure-as-Code.

Trade-offs vs. CDK:

-   defaults only — no `max_concurrency`, `device_map`, or extra `serve_args` flags;
-   the endpoint lives outside your Terraform / CDK state, so lifecycle (updates, blue/green, teardown) is manual;
-   you can still call it the same way (`boto3 sagemaker-runtime`, [see below](#calling-the-endpoint)).

## CDK deploy

For repeatable deploys with every tuning knob exposed, use the CDK stack in [`deploy/sagemaker/`](https://github.com/strands-labs/strands-decider/tree/d427f3cfb43e22afbbfc2675c9df8dfdca739197/deploy/sagemaker) on the Decider repo. One stack copies the model to S3, picks (or builds) a serving image, and creates the endpoint; `cdk destroy` removes everything.

### Deploy it

```bash
git clone https://github.com/strands-labs/strands-decider
cd strands-decider/deploy/sagemaker
npm install
npx cdk bootstrap aws://<account>/<region>   # once per account/region
npx cdk deploy
```

The default stack creates an `ml.g6.xlarge` endpoint for `strands-decider-2B-qwen3.5-v1-2610` using the published Strands Decider [Deep Learning Container](https://gallery.ecr.aws/deep-learning-containers/strands-decider). Other instance types or `-c image=build` build the image from the folder’s `Dockerfile` in CodeBuild.

### Configuration

Every knob is a CDK context value: set in `cdk.json` or pass `-c key=value`:

| Setting | Default | What it controls |
| --- | --- | --- |
| `model` | `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610` | Hugging Face Hub id; also names the stack and endpoint |
| `model_revision` | `main` | Pin to a release’s date tag (`YYMMDD`) for a stable endpoint |
| `instance_type` | `ml.g6.xlarge` | SageMaker instance type (GPU or CPU) |
| `instance_count` | `1` | Instances behind the endpoint |
| `fallback_instance_types` | empty | Comma-separated list SageMaker tries when `instance_type` has no capacity |
| `image` | empty | `dlc` (published DLC) or `build` (CodeBuild from `Dockerfile`); empty auto-picks per instance family |
| `max_concurrency` | empty | In-flight requests per instance (`serve --max-concurrency`) |
| `device_map` | empty | `auto` splits a model larger than one GPU across the instance’s GPUs (needed for 26B-A4B on `ml.g6e.12xlarge`) |
| `serve_args` | empty | Extra `strands-decider serve` flags, e.g. `"--max-batch 8"` |

A setting change updates the endpoint in place (blue/green via SageMaker endpoint configs).

### Picking an instance

| Instance | GPU / CPU | Memory | Fits (bf16 / fp32) |
| --- | --- | --- | --- |
| `ml.g6.xlarge` (default) | one L4 | 24 GB | 2B, E2B, E4B |
| `ml.g6e.xlarge` | one L40S | 48 GB | up to 12B |
| `ml.p5.4xlarge` | one H100 | 80 GB | up to 26B-A4B |
| `ml.g6e.12xlarge` | four L40S | 192 GB | 26B-A4B with `device_map=auto` |
| `ml.m5.2xlarge` | 8 vCPU | 32 GB | 2B on CPU (about 2.5 s for three questions) |

GPU instances need quota; `InsufficientInstanceCapacity` means no free instance of that type in the region. Supply `fallback_instance_types` or try another region. Graviton, Inferentia, and Trainium are not supported.

### Deploying several models

Each `model` value gets its own stack and endpoint, named from the Hub id’s model slug. You can deploy several side by side:

```bash
npx cdk deploy                                                               # 2B Qwen3.5 (default)
npx cdk deploy -c model=StrandsAgents/strands-decider-E4B-gemma4-v1-2610     # E4B Gemma 4
```

### Deleting it

A SageMaker endpoint is billed per instance-hour whether it gets requests or not. When you’re done:

```bash
npx cdk destroy                    # the default model
npx cdk destroy -c model=<Hub id>  # any other model you deployed
```

Deletes the endpoint, endpoint config, SageMaker model, S3 bucket, ECR repository (if one was built), CodeBuild projects, and IAM roles.

## Calling the endpoint

Same for both paths. The request body matches `strands-decider serve`’s `POST /v1/systemone`, invoked through the SageMaker runtime:

```python
import json, boto3

runtime = boto3.client("sagemaker-runtime")
response = runtime.invoke_endpoint(
    EndpointName="strands-decider-2b-qwen3-5-v1-2610",
    ContentType="application/json",
    Body=json.dumps(
        {
            "state": "Help! My payouts have been failing for 3 days!",
            "questions": {
                "is_urgent": {"type": "noul", "instructions": "Does this convey urgency?"}
            },
        }
    ),
)
print(json.loads(response["Body"].read())["answers"])
```

Callers need IAM `sagemaker:InvokeEndpoint` on the endpoint. The container has no authentication of its own.

## See also

-   Source: [`deploy/sagemaker/`](https://github.com/strands-labs/strands-decider/tree/d427f3cfb43e22afbbfc2675c9df8dfdca739197/deploy/sagemaker)
-   Full README: [`deploy/sagemaker/README.md`](https://github.com/strands-labs/strands-decider/blob/d427f3cfb43e22afbbfc2675c9df8dfdca739197/deploy/sagemaker/README.md)