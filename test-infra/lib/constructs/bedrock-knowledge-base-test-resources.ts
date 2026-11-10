import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { TestFeatureConstruct, TestFeatureConstructProps } from './test-feature-construct';

/**
 * Titan Text Embeddings v2 produces 1024-dimensional vectors and Bedrock
 * compares them with cosine distance. The S3 vector index must match both,
 * and S3 Vectors currently only stores float32 components.
 */
const EMBEDDING_MODEL = bedrock.FoundationModelIdentifier.AMAZON_TITAN_EMBED_TEXT_V2_0;
const EMBEDDING_DIMENSION = 1024;

/**
 * Reserved metadata keys Bedrock writes into every vector. They hold the
 * source chunk text and the chunk's metadata blob, so they must be excluded
 * from the filterable set or ingestion fails.
 */
const NON_FILTERABLE_METADATA_KEYS = ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'];

export interface BedrockKnowledgeBaseTestResourcesProps extends TestFeatureConstructProps {}

/**
 * A Bedrock knowledge base backed by an S3 Vectors index, its source bucket,
 * and the service role Bedrock assumes to populate it. Integration tests query
 * this knowledge base and ingest documents directly into it via both supported
 * direct-ingestion paths, each with its own data source on the shared index:
 *
 *  - S3: stage an object in the source bucket, then ingest it by S3 URI.
 *  - CUSTOM: push document content inline through the API, no backing store.
 *
 * The knowledge base and data source ids are assigned by Bedrock at deploy
 * time, so they are published to SSM under stable paths that tests resolve at
 * runtime.
 */
export class BedrockKnowledgeBaseTestResources extends TestFeatureConstruct {
  readonly featureName = 'bedrock-knowledge-base' as const;

  /** The knowledge base consumers query and ingest documents into. */
  public readonly knowledgeBase: bedrock.CfnKnowledgeBase;

  /**
   * The S3 data source. Direct ingestion against it points at an object by its
   * S3 URI; the test stages that object in {@link sourceBucket} first.
   */
  public readonly s3DataSource: bedrock.CfnDataSource;

  /**
   * The CUSTOM data source. Direct ingestion against it pushes document content
   * inline through the API, with no backing bucket.
   */
  public readonly customDataSource: bedrock.CfnDataSource;

  /** Bucket backing the S3 ingestion path; tests stage objects here. */
  public readonly sourceBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: BedrockKnowledgeBaseTestResourcesProps = {}) {
    super(scope, id);

    const model = bedrock.FoundationModel.fromFoundationModelId(this, 'EmbeddingModel', EMBEDDING_MODEL);
    this.sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const { vectorBucket, vectorIndex } = this.createVectorIndex();
    const serviceRole = this.createServiceRole(model, this.sourceBucket, vectorBucket, vectorIndex);

    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `${cdk.Stack.of(this).stackName}-kb`,
      roleArn: serviceRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: model.modelArn,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: EMBEDDING_DIMENSION,
              embeddingDataType: 'FLOAT32',
            },
          },
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          indexArn: vectorIndex.attrIndexArn,
        },
      },
    });

    this.knowledgeBase.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // The role policy must exist before Bedrock validates access during
    // knowledge base creation; the index must exist before it is referenced.
    this.knowledgeBase.node.addDependency(serviceRole);
    this.knowledgeBase.node.addDependency(vectorIndex);

    this.s3DataSource = new bedrock.CfnDataSource(this, 'S3DataSource', {
      name: 'S3DataSource',
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      dataDeletionPolicy: 'DELETE',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: this.sourceBucket.bucketArn,
        },
      },
    });
    this.s3DataSource.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // A CUSTOM data source has no connection config: documents are pushed in
    // directly through the ingestion API rather than crawled from a source.
    this.customDataSource = new bedrock.CfnDataSource(this, 'CustomDataSource', {
      name: 'CustomDataSource',
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      dataDeletionPolicy: 'DELETE',
      dataSourceConfiguration: {
        type: 'CUSTOM',
      },
    });
    this.customDataSource.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    this.publishIdsToSsm();

    if (props.role) {
      this.grantUsage(props.role);
    }
  }

  /**
   * Publish the deploy-time ids to SSM so tests can resolve them by their
   * stable path rather than scanning by name.
   */
  private publishIdsToSsm(): void {
    new ssm.StringParameter(this, 'KnowledgeBaseIdParameter', {
      parameterName: this.ssmPath('knowledge-base-id'),
      stringValue: this.knowledgeBase.attrKnowledgeBaseId,
    });
    new ssm.StringParameter(this, 'S3DataSourceIdParameter', {
      parameterName: this.ssmPath('s3-data-source-id'),
      stringValue: this.s3DataSource.attrDataSourceId,
    });
    new ssm.StringParameter(this, 'CustomDataSourceIdParameter', {
      parameterName: this.ssmPath('custom-data-source-id'),
      stringValue: this.customDataSource.attrDataSourceId,
    });
    new ssm.StringParameter(this, 'SourceBucketNameParameter', {
      parameterName: this.ssmPath('s3-source-bucket-name'),
      stringValue: this.sourceBucket.bucketName,
    });
  }

  /**
   * Grant a consumer (the integration-test role) permission to query the
   * knowledge base and ingest documents directly into it via
   * IngestKnowledgeBaseDocuments. Intentionally excludes bedrock:StartIngestionJob;
   * these tests validate only the synchronous direct-ingestion APIs.
   */
  private grantUsage(role: iam.IRole): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:Retrieve',
          'bedrock:IngestKnowledgeBaseDocuments',
          'bedrock:GetKnowledgeBaseDocuments',
          'bedrock:ListKnowledgeBaseDocuments',
          'bedrock:DeleteKnowledgeBaseDocuments',
        ],
        resources: [this.knowledgeBase.attrKnowledgeBaseArn],
      }),
    );

    // The S3 ingestion path stages the object in the source bucket, then points
    // IngestKnowledgeBaseDocuments at its URI.
    this.sourceBucket.grantReadWrite(role);

    this.grantSsmParameterRead(role);
  }

  /** S3 Vectors store backing the knowledge base. */
  private createVectorIndex(): {
    vectorBucket: s3vectors.CfnVectorBucket;
    vectorIndex: s3vectors.CfnIndex;
  } {
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {});
    vectorBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      dataType: 'float32',
      dimension: EMBEDDING_DIMENSION,
      distanceMetric: 'cosine',
      metadataConfiguration: {
        nonFilterableMetadataKeys: NON_FILTERABLE_METADATA_KEYS,
      },
    });
    vectorIndex.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    return { vectorBucket, vectorIndex };
  }

  /**
   * Service role Bedrock assumes to read source docs, invoke the embedding
   * model, and write into the S3 vector index. Scoped to this account and
   * knowledge bases in it via the confused-deputy conditions.
   */
  private createServiceRole(
    model: bedrock.IModel,
    sourceBucket: s3.IBucket,
    vectorBucket: s3vectors.CfnVectorBucket,
    vectorIndex: s3vectors.CfnIndex,
  ): iam.Role {
    const stack = cdk.Stack.of(this);
    const role = new iam.Role(this, 'ServiceRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: {
            'aws:SourceArn': stack.formatArn({
              service: 'bedrock',
              resource: 'knowledge-base',
              resourceName: '*',
            }),
          },
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:ListFoundationModels', 'bedrock:ListCustomModels'],
        resources: ['*'],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [model.modelArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3vectors:GetIndex',
          's3vectors:QueryVectors',
          's3vectors:PutVectors',
          's3vectors:GetVectors',
          's3vectors:ListVectors',
          's3vectors:DeleteVectors',
        ],
        resources: [vectorBucket.attrVectorBucketArn, vectorIndex.attrIndexArn],
      }),
    );
    sourceBucket.grantRead(role);

    return role;
  }
}
