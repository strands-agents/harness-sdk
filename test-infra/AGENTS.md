# Test Infrastructure — Agent Guidance

**You almost certainly do not need to deploy or modify this stack.**

This CDK stack provisions AWS resources (Bedrock knowledge bases, EC2 instances) that a small subset of integration tests depend on. The vast majority of tests — including most integration tests — work without it.

## When to deploy this stack

Only if you are:
- Modifying the test infrastructure CDK code itself
- Iterating on the specific tests that resolve SSM parameters from this stack (KB ingestion, SSH sandbox)

## When NOT to deploy this stack

- Running unit tests (`npm test` in any package)
- Running most integration tests (they don't need provisioned infra)
- Reviewing or modifying SDK code, docs, tools, or CLI
- Opening a PR — CI runs infrastructure-dependent tests automatically against pre-provisioned resources

## Never set `STRANDS_TEST_INFRA_INTERNAL=true`

This flag attaches a broad internal IAM policy and GitHub OIDC trust that only makes sense in the Strands team's own test account. Setting it in any other account creates a role with permissions to resources that don't exist.

## If you do need to deploy

See `README.md` in this directory for setup instructions. The default `npx cdk deploy` with your AWS credentials configured is all most cases need.

## Convention: always set removal policy DESTROY

All resources in this stack must specify `removalPolicy: cdk.RemovalPolicy.DESTROY` (or `applyRemovalPolicy(DESTROY)` for L1 constructs). This is test infrastructure — it must tear down cleanly on `cdk destroy` with no orphaned resources or naming collisions on redeploy. Never use RETAIN here.
