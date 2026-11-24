Serverless: no GPU, no instance to reserve, nothing standing between requests. The SDK’s [`deploy/lambda/`](https://github.com/strands-labs/strands-decider/tree/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/deploy/lambda) CDK stack builds an arm64 image with the 2B Qwen3.5 Decider baked in (LoRA merged into the torso, quantized to Q8\_0 for [llama.cpp](https://github.com/ggml-org/llama.cpp)) and creates one Lambda function behind an IAM-authenticated Function URL. Requests take seconds.

-   **When to pick it:** triage, moderation, routing queues, batch scoring, pre-action checks — decisions that can wait seconds, at volumes where a GPU would sit idle. For a per-tool-call guard inside an agent loop, serve on a GPU instead.

## Deploy

Requires an AWS account, Node.js 22+, awscurl + AWS CLI v2 for testing.

```bash
git clone https://github.com/strands-labs/strands-decider
cd strands-decider/deploy/lambda
npm install
npx cdk bootstrap aws://<account>/<region>
npx cdk deploy
```

CDK builds the image in CodeBuild (~10 min) and publishes the function. The Function URL is in `cdk deploy`’s outputs.

## Call it

```bash
awscurl --service lambda --region <region> -X POST -H 'content-type: application/json' \
  -d '{"state": "Help! My payouts have been failing for 3 days!",
       "questions": {"is_urgent": {"type": "noul", "instructions": "Does this convey urgency?"}}}' \
  <FunctionUrl>v1/systemone
```

```json
{"model": "strands-decider-2B-qwen3.5-v1-2610-q8_0",
 "answers": {"is_urgent": {"type": "noul", "noul": 0.8634}},
 "usage": {"input_tokens": 86, "output_tokens": 1},
 "latency_ms": 1033.72}
```

The URL only accepts SigV4-signed requests from principals with `lambda:InvokeFunctionUrl`. Direct `aws lambda invoke` works too, with the request as the event payload.

## CDK context knobs

Set in `cdk.json`, or pass `-c key=value` to `cdk deploy`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `model` | `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610` | Any Qwen3.5 Decider Hub id; names the stack. |
| `model_revision` | `main` | Pin to a release tag (`YYMMDD`) for reproducibility. |
| `snapstart` | `false` | `true` → ~6 s cold starts instead of up to 30 s; ~$39.50/month for the snapshot cache. |
| `vision` | `false` | `true` adds the base model’s vision tower so requests may carry `images`. |
| `image_long_side` | `448` | Longest side an image is scaled to before token-gridding. |
| `decoder_precision` / `vision_precision` | `q8_0` / `f16` | `f16` / `f32` is closer to torch fp32, slower. |
| `max_request_tokens` | `24576` | Cap on one request’s state-plus-questions tokens. |

## Delete it

```bash
npx cdk destroy                    # the default model
npx cdk destroy -c model=<Hub id>  # any other deployed model
```

Removes the function, versions, snapshots, log group, ECR repo, CodeBuild project, and IAM roles.

## Lambda Managed Instances (GPU)

A separate CDK stack at [`deploy/lambda-gpu/`](https://github.com/strands-labs/strands-decider/tree/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/deploy/lambda-gpu) serves the same `POST /v1/systemone` API on a CUDA GPU under [Lambda Managed Instances](https://docs.aws.amazon.com/lambda/latest/dg/lambda-managed-instances-gpu.html). Same torch + CUDA code path as [SageMaker](/docs/labs/strands-decider/deployment/sagemaker/index.md), so the engine sees the model’s full weights and the GPU does the forward pass. The stack defaults to T4 (`g4dn`) for availability; switch to L4 with `-c instance_types=g6.xlarge,g6.2xlarge -c accelerator_memory_gb=24`.

-   **When to pick it:** Low-latency agent-loop guards, per-tool-call checks, and moderate-throughput classifiers behind SQS / EventBridge / direct `Invoke`. Requires an EC2 GPU vCPU quota; Event Functions only — no Function URL, no synchronous HTTP.

### Deploy

```bash
git clone https://github.com/strands-labs/strands-decider
cd strands-decider/deploy/lambda-gpu
npm install
npx cdk bootstrap aws://<account>/<region>
npx cdk deploy
```

CodeBuild builds the image (~15 min — torch + CUDA layers + model download), publishes to an ECR repository in the stack, and creates the function with a Lambda capacity provider over the configured GPU instance types.

### Call it

```bash
aws lambda invoke --function-name <FunctionArn> --cli-binary-format raw-in-base64-out \
  --payload '{"state": "Help! My payouts have been failing for 3 days!",
              "questions": {"is_urgent": {"type": "noul", "instructions": "Does this convey urgency?"}}}' \
  answer.json
cat answer.json
```

```json
{"model": "strands-decider-2B-qwen3.5-v1-2610",
 "answers": {"is_urgent": {"type": "noul", "noul": 0.86}},
 "usage": {"input_tokens": 86, "output_tokens": 1},
 "latency_ms": 42.5}
```

Same JSON works as an SQS message body or an EventBridge event `detail`.

### Delete it

```bash
npx cdk destroy                    # the default model
npx cdk destroy -c model=<Hub id>  # any other deployed model
```

Removes the function, capacity provider, VPC, ECR repository, CodeBuild project, log groups, and IAM roles. Log groups default to `RemovalPolicy.RETAIN`; delete them from the CloudWatch console if you want to drop their retained cost.

## See also

-   **CPU stack:** [`deploy/lambda/`](https://github.com/strands-labs/strands-decider/tree/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/deploy/lambda) — [full README](https://github.com/strands-labs/strands-decider/blob/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/deploy/lambda/README.md). Exhaustive measurements, precision notes, image-size tradeoffs, cost breakdown, and debugging.
-   **GPU stack:** [`deploy/lambda-gpu/`](https://github.com/strands-labs/strands-decider/tree/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/deploy/lambda-gpu) — [full README](https://github.com/strands-labs/strands-decider/blob/6d85079caf1f1906ebb0f1370b56ef28ba7aa93e/deploy/lambda-gpu/README.md). CDK context knobs, capacity-provider wiring, image-build caveats.