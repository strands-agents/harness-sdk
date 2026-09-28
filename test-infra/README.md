# Strands Test Infrastructure

## Who this is for (and who it's not for)

This CDK stack provisions shared AWS resources (Bedrock knowledge bases, EC2 instances, etc.) that a **small subset** of Strands integration tests run against — specifically, tests that exercise infrastructure-dependent features like RAG knowledge bases and SSH sandboxes. The vast majority of integration tests do not require these resources.

**Most contributors do not need to deploy this.** If you just want to run integration tests:

- **Open a PR** — the Strands CI GitHub Action runs all integration tests (including the infrastructure-dependent ones) automatically against the team's pre-provisioned resources. No AWS account required on your end.
- **Run locally without this stack** — most integration tests work with just AWS credentials and model access. Only the tests that explicitly resolve SSM parameters from this stack need it deployed.

Deploy this stack only if you:
- Are developing or modifying the test infrastructure itself
- Are working on the specific features (KB ingestion, SSH sandbox) that depend on these resources and want to iterate locally
- Are setting up a new AWS account to run the full test suite independently

## Features

The stack provisions independently-toggleable features:

| Feature | What it deploys | SSM parameters |
|---|---|---|
| `bedrock-knowledge-base` | Bedrock KB + S3 Vectors index + S3 and CUSTOM data sources + source bucket | `/strands/test-infra/bedrock-knowledge-base/{knowledge-base-id, s3-data-source-id, custom-data-source-id, s3-source-bucket-name}` |
| `ssh-ec2` | t4g.nano EC2 instance (private, SSM-only access) + VPC + interface endpoints + ED25519 key pair | `/strands/test-infra/ssh-ec2/{instance-id, private-key-parameter-name}` |

By default all features deploy. Use `-c testFeatures=bedrock-knowledge-base` to deploy a subset.

## Quick start

### Prerequisites

- Node.js 22+
- AWS CLI configured with credentials for the target account
- CDK bootstrapped in the target account/region (`npx cdk bootstrap`)

### Install

```sh
cd test-infra
npm install
```

### Deploy

```sh
npx cdk deploy
```

This deploys all features with a test role your account can assume. Account and region are inferred from your AWS CLI profile.

### Deploy a single feature

```sh
npx cdk deploy -c testFeatures=bedrock-knowledge-base
```

### Deploy with explicit account/region

```sh
export STRANDS_TEST_INFRA_DEPLOYMENT_ACCOUNT=123456789012
export STRANDS_TEST_INFRA_DEPLOYMENT_REGION=us-east-1
npx cdk deploy
```

### Run tests against the deployed stack

Integration tests import `ssmParameterPath` from `lib/constants.ts` and resolve resource IDs at runtime:

```ts
import { ssmParameterPath } from 'test-infra/lib/constants';

const kbId = await ssm.getParameter({ Name: ssmParameterPath('bedrock-knowledge-base', 'knowledge-base-id') });
```

No hardcoded IDs — tests work against any deployed instance of this stack.

### Type-check and unit tests

```sh
npm run build   # type-check only (noEmit)
npm test        # 15 assertions covering all features, toggling, IAM
```

### Destroy

```sh
npx cdk destroy
```

All resources use `DESTROY` removal policies — `cdk destroy` cleans up everything.

## Configuration reference

| Input | Channel | Purpose | Default |
|---|---|---|---|
| `testFeatures` | CDK context (`-c testFeatures=a,b`) | Which features to provision | `all` |
| `STRANDS_TEST_INFRA_INTERNAL` | Env var (`=true`) | Attach internal legacy policy + GitHub OIDC trust | `false` |
| `STRANDS_TEST_INFRA_DEPLOYMENT_ACCOUNT` | Env var | Target AWS account | Inferred from CLI profile |
| `STRANDS_TEST_INFRA_DEPLOYMENT_REGION` | Env var | Target AWS region | Inferred from CLI profile |

## Internal mode

> **Do not set `STRANDS_TEST_INFRA_INTERNAL=true` unless you are deploying to the Strands team's own test account.** This mode attaches a broad legacy policy (model invocation, KB management, secrets access, AOSS, CloudWatch) and configures the role trust for Strands GitHub Actions OIDC. It is not meaningful outside the internal account and will create a role with permissions to resources that don't exist in your account.

```sh
STRANDS_TEST_INFRA_INTERNAL=true npx cdk deploy
```

## Architecture

```
bin/test-infra.ts                          Entry point, env resolution, feature validation
lib/
  constants.ts                             TestFeature type, VALID_TEST_FEATURES, ssmParameterPath()
  stacks/test-infra-stack.ts               Thin orchestrator: feature gating + role
  constructs/
    test-feature-construct.ts              Base class: ssmPath() + grantSsmParameterRead()
    integ-test-role.ts                     Shared test role (OIDC trust in internal mode)
    bedrock-knowledge-base-test-resources  KB + S3 Vectors + data sources + SSM + grants
    ssh-ec2-test-resources.ts              EC2 + VPC + endpoints + key pair + SSM + grants
test/test-infra.test.ts                    15 unit tests (CDK assertions)
```

## Adding a new feature

1. Add the feature name to `TestFeature` type and `VALID_TEST_FEATURES` in `lib/constants.ts`
2. Create a construct in `lib/constructs/` extending `TestFeatureConstruct`
3. Set `readonly featureName = 'your-feature' as const`
4. Publish SSM params via `this.ssmPath('param-name')`
5. Implement `grantUsage(role)` and call `this.grantSsmParameterRead(role)` at the end
6. Wire it into `lib/stacks/test-infra-stack.ts` with `if (enabled('your-feature'))`
7. Add tests
