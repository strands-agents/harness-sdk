`SageMakerDecisionModel` answers questions with a decision model you deploy to an [Amazon SageMaker AI](https://docs.aws.amazon.com/sagemaker/latest/dg/realtime-endpoints.html) real-time endpoint in your own AWS account, such as [Strands Decider](https://github.com/strands-labs/strands-decider). It returns the same result as every other [decision model](/docs/user-guide/sdk/decision-models/models/index.md), plus a probability for each label and a confidence for each answer.

Choose it when the input must stay in your AWS account, or when you want to pick the model version and the instance it runs on. If you’d rather not run an endpoint, [TypeSafe Jev](/docs/user-guide/sdk/decision-models/models/typesafe/index.md) answers the same questions as a hosted API.

You need a deployed endpoint first. The [Strands Decider SageMaker guide](/docs/labs/strands-decider/deployment/sagemaker/index.md) deploys one from SageMaker JumpStart or with a CDK stack. The endpoint must accept the System One request that Strands Decider serves.

## Installation

(( tab "Python" ))
`SageMakerDecisionModel` ships with the SDK and uses boto3, which the SDK already depends on:

```bash
pip install strands-agents
```
(( /tab "Python" ))

(( tab "TypeScript" ))
`SageMakerDecisionModel` loads the AWS SDK’s SageMaker Runtime client, an optional peer dependency. Install it alongside the SDK:

```bash
npm install @strands-agents/sdk @aws-sdk/client-sagemaker-runtime
```

Import the class from `@strands-agents/sdk/decisions/sagemaker`, not the package root. The client loads on the first `ask`, so a missing package raises an error then, not when you construct the decision model.
(( /tab "TypeScript" ))

## Credentials

`SageMakerDecisionModel` signs each request with the standard AWS credential chain: environment variables, shared config and credentials files, and IAM roles. The credentials need `sagemaker:InvokeEndpoint` on the endpoint. The container behind the endpoint has no authentication of its own, so this IAM permission is the only access control. See [Setting up AWS credentials](/docs/user-guide/sdk/model-providers/amazon-bedrock/index.md#setting-up-aws-credentials) for shared setup.

(( tab "Python" ))
To use a named profile or assumed-role credentials, pass a boto3 session. The decision model calls the endpoint in the session’s region:

```python
import boto3

from strands.decisions import SageMakerDecisionModel

decisions = SageMakerDecisionModel(
    "strands-decider-2b-qwen3-5-v1-2610",
    boto_session=boto3.Session(profile_name="decisions", region_name="us-east-1"),
)
```

Without a session, pass `region_name`. If you set no region, the decision model uses the region from `boto_client_config`, then the session’s configured region, then `AWS_REGION`. With no region from any source, the constructor raises botocore’s `NoRegionError`.
(( /tab "Python" ))

(( tab "TypeScript" ))
To use a named profile, set `AWS_PROFILE` in the environment. For other credentials, pass them in `clientConfig`, or pass a `SageMakerRuntimeClient` you’ve built as `client`. If you don’t set `region`, the AWS SDK resolves the region from its usual sources, such as `AWS_REGION`.
(( /tab "TypeScript" ))

## Configuration

| Option | Description |
| --- | --- |
| `endpoint_name``endpointName` | Name of the SageMaker AI real-time endpoint. Required. |
| `region_name``region` | AWS region of the endpoint. |
| `boto_client_config``clientConfig` | Configuration for the SageMaker Runtime client, such as timeouts and retries. |
| `client` | A SageMaker Runtime client you’ve built, used as is. |
| `default_min_confidence``defaultMinConfidence` | Confidence below which an answer comes back `Uncertain`, in `[0.0, 1.0]`. Defaults to `0.5`. See [Confidence and uncertainty](#confidence-and-uncertainty). |

A prebuilt `client` can’t be combined with the region, session, or client configuration, and a session can’t be combined with a region. The constructor raises an error for those combinations and for an empty endpoint name.

See the [`SageMakerDecisionModel` API reference](/docs/api/python/strands.decisions.sagemaker_decision_model#strands.decisions.sagemaker_decision_model.SageMakerDecisionModel.__init__) for all constructor options.

## Ask questions

This example asks two questions about a support message and prints each answer with its confidence:

(( tab "Python" ))
```python
import asyncio

from strands.decisions import SageMakerDecisionModel

message = "I was charged twice for order 1182. Please refund one charge today."


async def main():
    decisions = SageMakerDecisionModel(
        "strands-decider-2b-qwen3-5-v1-2610", region_name="us-east-1"
    )
    result = await decisions.ask(
        message,
        {
            "urgent": {
                "question": "Does the customer need help today?",
                "choices": "boolean",
            },
            "team": {
                "question": "Which team should handle this message?",
                "choices": ["billing", "shipping", "technical"],
            },
        },
    )
    confidence = result.metadata.confidence
    print(result.answers["urgent"], f"{confidence['urgent']:.2f}")
    print(result.answers["team"], f"{confidence['team']:.2f}")


asyncio.run(main())

# Typical output:
# True 0.90
# billing 1.00
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { SageMakerDecisionModel } from '@strands-agents/sdk/decisions/sagemaker'

const message = 'I was charged twice for order 1182. Please refund one charge today.'

const decisions = new SageMakerDecisionModel({
  endpointName: 'strands-decider-2b-qwen3-5-v1-2610',
  region: 'us-east-1',
})
const { answers, metadata } = await decisions.ask(message, {
  urgent: {
    question: 'Does the customer need help today?',
    choices: 'boolean',
  },
  team: {
    question: 'Which team should handle this message?',
    choices: ['billing', 'shipping', 'technical'],
  },
})
console.log(answers.urgent, metadata.confidence?.urgent.toFixed(2))
console.log(answers.team, metadata.confidence?.team.toFixed(2))

// Typical output:
// true 0.90
// billing 1.00
```
(( /tab "TypeScript" ))

The request doesn’t name a model. The endpoint runs one, and `metadata.model_id``metadata.modelId` reports the name the endpoint returns. The decision model doesn’t cap the number of questions per call.

## Confidence and uncertainty

The model reports a confidence for every answer. An answer below the minimum comes back as `Uncertain`, and `metadata.confidence` and `metadata.probabilities` still show what the model leaned toward. [Confidence](/docs/user-guide/sdk/decision-models/questions/index.md#confidence) explains how it’s measured.

The default minimum of 0.5 suits most routing and triage questions. For a question where a wrong answer costs more than asking a person, raise the minimum on that question alone: set its `uncertainty` to `{"min_confidence": 0.8}``{ minConfidence: 0.8 }`.

## Timeouts and retries

(( tab "Python" ))
The call runs on botocore’s default timeouts and retries. Set your own with `boto_client_config`:

```python
from botocore.config import Config

from strands.decisions import SageMakerDecisionModel

decisions = SageMakerDecisionModel(
    "strands-decider-2b-qwen3-5-v1-2610",
    region_name="us-east-1",
    # Fail a slow read after five seconds and try the call at most twice
    boto_client_config=Config(read_timeout=5, retries={"total_max_attempts": 2}),
)
```

boto3 is synchronous, so the call runs on a worker thread. Cancelling the task that awaits `ask` stops the wait, not the call already sent to the endpoint.
(( /tab "Python" ))

(( tab "TypeScript" ))
Pass a `cancelSignal` to `ask` to bound how long a decision can take. The signal aborts the request to the endpoint:

```typescript
import { SageMakerDecisionModel } from '@strands-agents/sdk/decisions/sagemaker'

const decisions = new SageMakerDecisionModel({
  endpointName: 'strands-decider-2b-qwen3-5-v1-2610',
  region: 'us-east-1',
})
const { answers } = await decisions.ask(
  'My package never arrived.',
  {
    team: {
      question: 'Which team should handle this message?',
      choices: ['billing', 'shipping', 'technical'],
    },
  },
  // Give up on the decision after five seconds
  { cancelSignal: AbortSignal.timeout(5000) }
)
console.log(answers.team)

// Typical output:
// shipping
```

To change retries or the request handler, pass them in `clientConfig`.
(( /tab "TypeScript" ))

## Errors

Beyond the [validation errors](/docs/user-guide/sdk/decision-models/questions/index.md#validation), `ask` raises:

| Error | When |
| --- | --- |
| `ModelThrottledException``ModelThrottledError` | SageMaker is throttling or the endpoint isn’t ready (`ThrottlingException`, `ModelNotReadyException`, or `ServiceUnavailable`), or the container returned HTTP 429, 503, or 529. Retry with backoff. |
| `ContextWindowOverflowException``ContextWindowOverflowError` | The container returned HTTP 413, or HTTP 422 with a message about the context window, as Strands Decider does when deployed with `--strict-window`. Shorten the input, such as by sending only the latest messages of a conversation. |
| `botocore.exceptions.ClientError``ModelError` | Any other SageMaker error, such as `AccessDeniedException` for missing IAM permission or `ValidationError` for an endpoint that doesn’t exist. |
| `botocore.exceptions.BotoCoreError``ModelError` | The call didn’t complete, such as a read timeout, a network failure, or missing credentials. |
| `StructuredOutputException``ModelError` | The endpoint returned a response the decision model can’t read, such as an answer outside the question’s choices. |

The throttling errors keep the SageMaker error as their cause.

So do the context window errors. Read the error code from the cause's response.So does the generic ModelError. Check for the two specific errors first.

## Related pages

- [Decision models](/docs/user-guide/sdk/decision-models/index.md) (1 shared tag)
- [Decisions API](/docs/user-guide/sdk/decision-models/models/decisions-api/index.md) (1 shared tag)
- [Decisions in an agent](/docs/user-guide/sdk/decision-models/agents/index.md) (1 shared tag)
- [LLM decision model](/docs/user-guide/sdk/decision-models/models/llm/index.md) (1 shared tag)
- [Questions and answers](/docs/user-guide/sdk/decision-models/questions/index.md) (1 shared tag)
- [Supported decision models](/docs/user-guide/sdk/decision-models/models/index.md) (1 shared tag)
- [TypeSafe Jev](/docs/user-guide/sdk/decision-models/models/typesafe/index.md) (1 shared tag)
- [Model Routing](/docs/user-guide/sdk/model-providers/model-routing/index.md) (1 shared tag)
- [Decision model observability](/docs/user-guide/sdk/decision-models/observability/index.md) (1 shared tag)
- [Decision models quickstart](/docs/user-guide/sdk/decision-models/quickstart/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/decisions/sagemaker_decision_model.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/sagemaker_decision_model.py)
- [harness-sdk/strands-py/src/strands/decisions/_system_one_http_adapter.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/_system_one_http_adapter.py)

### TypeScript

- [harness-sdk/strands-ts/src/decisions/sagemaker.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/sagemaker.ts)
- [harness-sdk/strands-ts/src/decisions/system-one-http-adapter.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/system-one-http-adapter.ts)
