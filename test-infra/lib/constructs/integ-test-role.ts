import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

function requiredInternalEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set when STRANDS_TEST_INFRA_INTERNAL=true`);
  }
  return value;
}

export interface IntegTestRoleProps {
  /**
   * Attach the legacy internal base policy. Off for community deploys, which
   * leave the role with only the grants the deployed resources add to it.
   *
   * @default false
   */
  readonly internal?: boolean;
}

/**
 * Shared identity integration tests assume to exercise the deployed resources.
 * Feature constructs layer their own scoped grants onto this role.
 */
export class IntegTestRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: IntegTestRoleProps = {}) {
    super(scope, id);

    // Public repos that need to assume this role. Keep in sync with CI workflows.
    const publicRepos = [
      'harness-sdk',
      'tools',
      'agent-builder',
      'evals',
      'sdk-python',
      'sdk-typescript',
    ];
    const privateRepos = props.internal
      ? requiredInternalEnv('STRANDS_TEST_INFRA_PRIVATE_REPOS').split(',')
      : [];

    const account = cdk.Stack.of(this).account;
    const runnerRoleNames = process.env.STRANDS_TEST_INFRA_RUNNER_ROLES?.split(',') ?? [];

    const assumedBy = props.internal
      ? new iam.CompositePrincipal(
          new iam.FederatedPrincipal(
            `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`,
            {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              },
              StringLike: {
                'token.actions.githubusercontent.com:sub': [...publicRepos, ...privateRepos].map(
                  (repo) => `repo:strands-agents/${repo}:*`,
                ),
              },
            },
            'sts:AssumeRoleWithWebIdentity',
          ),
          ...runnerRoleNames.map(
            (name) => new iam.ArnPrincipal(`arn:aws:iam::${account}:role/${name}`),
          ),
        )
      : new iam.AccountPrincipal(account);

    this.role = new iam.Role(this, 'IntegRole', {
      assumedBy,
      maxSessionDuration: cdk.Duration.hours(1),
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:GetCallerIdentity'],
        resources: ['*'],
      }),
    );

    if (props.internal) {
      this.addLegacyBasePolicy();
    }
  }

  /** Legacy internal base policy; account-pinned ARNs use the deploy account. */
  private addLegacyBasePolicy(): void {
    const stack = cdk.Stack.of(this);

    const bucketNames = requiredInternalEnv('STRANDS_TEST_INFRA_BUCKET_NAMES').split(',');
    const persistentBucketNames = requiredInternalEnv('STRANDS_TEST_INFRA_PERSISTENT_BUCKET_NAMES').split(',');
    const secretNames = requiredInternalEnv('STRANDS_TEST_INFRA_SECRET_NAMES').split(',');

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:ListAsyncInvokes',
          'bedrock:GetAsyncInvoke',
        ],
        resources: [
          'arn:aws:bedrock:*:*:foundation-model/anthropic.claude-3-sonnet-20240229-v1:0',
          'arn:aws:bedrock:*:*:foundation-model/anthropic.claude-3-7-sonnet-20250219-v1:0',
          'arn:aws:bedrock:*:*:foundation-model/amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-3-7-sonnet-20250219-v1:0',
          'arn:aws:bedrock:*:*:foundation-model/anthropic.claude-sonnet-4-20250514-v1:0',
          'arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-sonnet-4-20250514-v1:0',
          'arn:aws:bedrock:*:*:foundation-model/anthropic.claude-3-haiku-20240307-v1:0',
          'arn:aws:bedrock:*:*:foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
          'arn:aws:bedrock:*:*:foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
          'arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0',
          'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
          'arn:aws:bedrock:*:*:foundation-model/meta.llama3-2-90b-instruct-v1:0',
          'arn:aws:bedrock:*:*:inference-profile/us.meta.llama3-2-90b-instruct-v1:0',
          'arn:aws:bedrock:*:*:foundation-model/mistral.voxtral-small-24b-2507',
          'arn:aws:bedrock:*:*:foundation-model/amazon.nova-reel-v1:1',
          'arn:aws:bedrock:*:*:foundation-model/amazon.nova-pro-v1:0',
          'arn:aws:bedrock:*:*:inference-profile/us.amazon.nova-pro-v1:0',
          'arn:aws:bedrock:*:*:foundation-model/amazon.nova-lite-v1:0',
          'arn:aws:bedrock:*:*:inference-profile/us.amazon.nova-2-lite-v1:0',
          'arn:aws:bedrock:*:*:inference-profile/us.amazon.nova-lite-v1:0',
          'arn:aws:bedrock:*:*:foundation-model/stability.stable-image-core-v1:1',
          'arn:aws:bedrock:*:*:foundation-model/stability.stable-image-ultra-v1:1',
          'arn:aws:bedrock:*:*:foundation-model/stability.sd3-5-large-v1:0',
          'arn:aws:bedrock:*:*:async-invoke/*',
          'arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0',
          'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-sonnet-4-6',
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
          'arn:aws:bedrock:*::foundation-model/amazon.nova-sonic-v1:0',
          'arn:aws:bedrock:*::foundation-model/amazon.nova-2-sonic-v1:0',
        ],
      }),
    );

    // Bidi integration tests use Polly to generate PCM audio input from test prompts.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['polly:SynthesizeSpeech'],
        resources: ['*'],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:ApplyGuardrail',
          'bedrock:CreateGuardrail',
          'bedrock:GetGuardrail',
          'bedrock:ListGuardrails',
          'bedrock:ListDataSources',
          'bedrock:GetDataSource',
          'bedrock:CreateDataSource',
          'bedrock:UpdateDataSource',
          'bedrock:DeleteDataSource',
          'bedrock:ListKnowledgeBases',
          'bedrock:CreateKnowledgeBase',
          'bedrock:DeleteKnowledgeBase',
          'bedrock:UpdateKnowledgeBase',
          'bedrock:StartIngestionJob',
          'bedrock:GetIngestionJob',
          'bedrock:ListIngestionJobs',
          'bedrock:IngestKnowledgeBaseDocuments',
          'bedrock:ListKnowledgeBaseDocuments',
          'bedrock:GetKnowledgeBase',
          'bedrock:GetKnowledgeBaseDocuments',
          'bedrock:DeleteKnowledgeBaseDocuments',
          'bedrock:UpdateAgentKnowledgeBase',
          'bedrock:Retrieve',
          'bedrock:RetrieveAndGenerate',
          'bedrock-mantle:CreateInference',
          'bedrock-mantle:CallWithBearerToken',
          // Lets the Mantle routing drift tests enumerate GET /v1/models; without it
          // they skip rather than run. See #3654.
          'bedrock-mantle:ListModels',
          'bedrock:CountTokens',
        ],
        resources: ['*'],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: secretNames.map((name) =>
          stack.formatArn({
            service: 'secretsmanager',
            region: 'us-east-1',
            resource: 'secret',
            resourceName: name,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ),
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'aoss:CreateSecurityPolicy',
          'aoss:CreateCollection',
          'aoss:ListCollections',
          'aoss:CreateAccessPolicy',
          'aoss:BatchGetCollection',
          'aoss:APIAccessAll',
          'aoss:UpdateCollection',
          'aoss:DeleteCollection',
          'aoss:CreateLifecyclePolicy',
          'aoss:UpdateAccessPolicy',
        ],
        resources: ['*'],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:CreateServiceLinkedRole'],
        resources: [
          stack.formatArn({
            service: 'iam',
            region: '',
            resource: 'role',
            resourceName:
              'aws-service-role/observability.aoss.amazonaws.com/AWSServiceRoleForAmazonOpenSearchServerless',
          }),
        ],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:CreateBucket',
          's3:ListBucket',
          's3:PutObject',
          's3:DeleteBucket',
          's3:DeleteObject',
          's3:GetObject',
        ],
        resources: bucketNames.map((name) => `arn:aws:s3:::${name}`),
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:PutObject',
          's3:GetObject',
          's3:CreateBucket',
          's3:ListBucket',
          's3:DeleteObject',
        ],
        resources: persistentBucketNames.map((name) => `arn:aws:s3:::${name}`),
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:GetRole', 'iam:CreateRole', 'iam:PutRolePolicy', 'iam:PassRole'],
        resources: [
          stack.formatArn({
            service: 'iam',
            region: '',
            resource: 'role',
            resourceName: 'StrandsMemoryIntegTestRole',
          }),
        ],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      }),
    );
  }
}
