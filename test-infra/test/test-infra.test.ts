import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { StrandsTestInfraStack } from '../lib/stacks/test-infra-stack';

let originalEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  originalEnv = { ...process.env };
  process.env.STRANDS_TEST_INFRA_PRIVATE_REPOS = 'repo-a,repo-b';
  process.env.STRANDS_TEST_INFRA_BUCKET_NAMES = 'test-bucket-*';
  process.env.STRANDS_TEST_INFRA_PERSISTENT_BUCKET_NAMES = 'test-persistent-bucket-*,test-session-bucket-*';
  process.env.STRANDS_TEST_INFRA_SECRET_NAMES = 'test-secret';
});

afterAll(() => {
  process.env = originalEnv;
});

function synth(props?: Partial<ConstructorParameters<typeof StrandsTestInfraStack>[2]>): Template {
  const app = new cdk.App();
  const stack = new StrandsTestInfraStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return Template.fromStack(stack);
}

// --- Knowledge Base ---

test('creates an S3 vectors index matching Titan v2 (1024 dims, cosine, float32)', () => {
  const template = synth();

  template.hasResourceProperties('AWS::S3Vectors::Index', {
    DataType: 'float32',
    Dimension: 1024,
    DistanceMetric: 'cosine',
    MetadataConfiguration: {
      NonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
    },
  });
  template.resourceCountIs('AWS::S3Vectors::VectorBucket', 1);
});

test('knowledge base uses the S3 vectors store and Titan v2 embeddings', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
    KnowledgeBaseConfiguration: {
      Type: 'VECTOR',
      VectorKnowledgeBaseConfiguration: {
        // ARN resolves to an Fn::Join whose final literal carries the model id.
        EmbeddingModelArn: {
          'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('amazon.titan-embed-text-v2:0$')])],
        },
        EmbeddingModelConfiguration: {
          BedrockEmbeddingModelConfiguration: { Dimensions: 1024, EmbeddingDataType: 'FLOAT32' },
        },
      },
    },
    StorageConfiguration: { Type: 'S3_VECTORS' },
  });
});

test('S3 data source points at the source bucket and retains data on deletion', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Bedrock::DataSource', {
    Name: 'S3DataSource',
    DataDeletionPolicy: 'DELETE',
    DataSourceConfiguration: { Type: 'S3' },
  });
});

test('CUSTOM data source exists with no connection config', () => {
  const template = synth();

  template.hasResourceProperties('AWS::Bedrock::DataSource', {
    Name: 'CustomDataSource',
    DataDeletionPolicy: 'DELETE',
    DataSourceConfiguration: { Type: 'CUSTOM' },
  });
});

test('knowledge base service role can be assumed only by Bedrock in this account', () => {
  const template = synth();

  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'bedrock.amazonaws.com' },
          Condition: {
            StringEquals: { 'aws:SourceAccount': '123456789012' },
          },
        }),
      ]),
    },
  });
});

// --- SSH EC2 ---

test('SSH instance is t4g.nano with no public IP association', () => {
  const template = synth({ testFeatures: ['ssh-ec2'] });

  const instances = template.findResources('AWS::EC2::Instance');
  const props = (Object.values(instances)[0] as any).Properties;
  expect(props.InstanceType).toBe('t4g.nano');
  expect(props).not.toHaveProperty('NetworkInterfaces');
});

test('SSH VPC has three SSM interface endpoints and no NAT gateway', () => {
  const template = synth({ testFeatures: ['ssh-ec2'] });

  template.resourceCountIs('AWS::EC2::VPCEndpoint', 3);
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
});

test('SSH grants StartSession, TerminateSession, OpenDataChannel, and private key read', () => {
  const template = synth({ internal: true, testFeatures: ['ssh-ec2'] });

  const policies = template.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap(
    (p: any) => p.Properties?.PolicyDocument?.Statement ?? [],
  );
  const actions = statements.flatMap((s: any) =>
    Array.isArray(s.Action) ? s.Action : [s.Action],
  );
  expect(actions).toEqual(expect.arrayContaining([
    'ssm:StartSession',
    'ssm:TerminateSession',
    'ssmmessages:OpenDataChannel',
    'ssm:GetParameter',
  ]));
});

test('SSH instance has no inbound security group rules', () => {
  const template = synth({ testFeatures: ['ssh-ec2'] });

  const ingress = template.findResources('AWS::EC2::SecurityGroupIngress');
  // The only SG ingress rules should be on the VPC endpoint SGs (self-referencing
  // for HTTPS), not custom rules we added for port 22.
  for (const rule of Object.values(ingress) as any[]) {
    expect(rule.Properties.FromPort).not.toBe(22);
  }
});

// --- Test Role ---

test('internal mode uses GitHub OIDC trust', () => {
  const template = synth({ internal: true, testFeatures: ['bedrock-knowledge-base'] });

  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'sts:AssumeRoleWithWebIdentity',
          Principal: {
            Federated: Match.stringLikeRegexp('oidc-provider/token.actions.githubusercontent.com$'),
          },
        }),
      ]),
    },
  });
});

test('community mode uses AccountPrincipal trust', () => {
  const template = synth({ internal: false, testFeatures: ['bedrock-knowledge-base'] });

  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { AWS: Match.objectLike({}) },
        }),
      ]),
    },
  });
});

test('internal mode with RUNNER_ROLES adds AssumeRole trust for those roles', () => {
  process.env.STRANDS_TEST_INFRA_RUNNER_ROLES = 'MyTestRunner';
  try {
    const template = synth({ internal: true, testFeatures: ['bedrock-knowledge-base'] });

    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Principal: {
              AWS: Match.stringLikeRegexp(':role/MyTestRunner$'),
            },
          }),
        ]),
      },
    });
  } finally {
    delete process.env.STRANDS_TEST_INFRA_RUNNER_ROLES;
  }
});

test('internal mode grants the Mantle actions the base-path drift tests need', () => {
  const template = synth({ internal: true });

  const policies = template.findResources('AWS::IAM::Policy');
  const actions = Object.values(policies).flatMap((p: any) =>
    (p.Properties?.PolicyDocument?.Statement ?? []).flatMap((s: any) => s.Action ?? []),
  );

  // The Mantle routing drift tests skip without ListModels. See #3654.
  expect(actions).toEqual(
    expect.arrayContaining([
      'bedrock-mantle:CreateInference',
      'bedrock-mantle:CallWithBearerToken',
      'bedrock-mantle:ListModels',
    ]),
  );
});

test('internal mode grants the permissions Bidi integration tests need', () => {
  const template = synth({ internal: true });

  const policies = template.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap(
    (p: any) => p.Properties?.PolicyDocument?.Statement ?? [],
  );
  const novaSonicStatement = statements.find((statement: any) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];

    return (
      actions.includes('bedrock:InvokeModel') &&
      resources.includes('arn:aws:bedrock:*::foundation-model/amazon.nova-sonic-v1:0') &&
      resources.includes('arn:aws:bedrock:*::foundation-model/amazon.nova-2-sonic-v1:0')
    );
  });
  const pollyStatement = statements.find(
    (statement: any) => statement.Action === 'polly:SynthesizeSpeech',
  );

  expect(novaSonicStatement).toBeDefined();
  expect(pollyStatement?.Resource).toBe('*');
});

test('community mode does not attach the legacy broad policy', () => {
  const template = synth({ internal: false });

  const policies = template.findResources('AWS::IAM::Policy');
  for (const policy of Object.values(policies) as any[]) {
    const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
    for (const stmt of statements) {
      expect(stmt.Action).not.toEqual(expect.arrayContaining(['aoss:CreateSecurityPolicy']));
    }
  }
});

test('persistent bucket policy grants access without DeleteBucket', () => {
  const template = synth({ internal: true });

  const policies = template.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap(
    (p: any) => p.Properties?.PolicyDocument?.Statement ?? [],
  );
  const persistentStmt = statements.find(
    (s: any) =>
      Array.isArray(s.Action) &&
      s.Action.includes('s3:PutObject') &&
      !s.Action.includes('s3:DeleteBucket') &&
      JSON.stringify(s.Resource).includes('test-persistent-bucket-*'),
  );
  expect(persistentStmt).toBeDefined();
  expect(persistentStmt.Action).toEqual(
    expect.arrayContaining(['s3:PutObject', 's3:GetObject', 's3:CreateBucket', 's3:ListBucket', 's3:DeleteObject']),
  );
  expect(persistentStmt.Action).not.toContain('s3:DeleteBucket');
});

// --- Feature Toggling ---

test('selecting only bedrock-knowledge-base excludes EC2 resources', () => {
  const template = synth({ testFeatures: ['bedrock-knowledge-base'] });

  template.resourceCountIs('AWS::EC2::Instance', 0);
  template.resourceCountIs('AWS::Bedrock::KnowledgeBase', 1);
});

test('selecting only ssh-ec2 excludes KB resources', () => {
  const template = synth({ testFeatures: ['ssh-ec2'] });

  template.resourceCountIs('AWS::Bedrock::KnowledgeBase', 0);
  template.resourceCountIs('AWS::EC2::Instance', 1);
});

test('all (default) provisions both features', () => {
  const template = synth();

  template.resourceCountIs('AWS::Bedrock::KnowledgeBase', 1);
  template.resourceCountIs('AWS::EC2::Instance', 1);
});

// --- SSM Parameters ---

test('KB publishes ids and bucket name to SSM under its feature namespace', () => {
  const template = synth({ testFeatures: ['bedrock-knowledge-base'] });

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/strands/test-infra/bedrock-knowledge-base/knowledge-base-id',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/strands/test-infra/bedrock-knowledge-base/s3-data-source-id',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/strands/test-infra/bedrock-knowledge-base/custom-data-source-id',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/strands/test-infra/bedrock-knowledge-base/s3-source-bucket-name',
  });
});

test('SSH publishes instance-id and private-key-parameter-name to SSM under its feature namespace', () => {
  const template = synth({ testFeatures: ['ssh-ec2'] });

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/strands/test-infra/ssh-ec2/instance-id',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/strands/test-infra/ssh-ec2/private-key-parameter-name',
  });
});
